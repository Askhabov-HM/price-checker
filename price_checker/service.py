"""Synchronization, history import, and a catch-up daily scheduler."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import threading
import time

from .client import AuthError, FetchError, Randewoo, product_url, quote
from .database import Database, MOSCOW, now


def schedule_slot(times, current=None):
    current = current or datetime.now(MOSCOW)
    slots = []
    for offset in (-1, 0):
        day = (current + timedelta(days=offset)).date()
        for value in times:
            hour, minute = map(int, value.split(":"))
            slot = datetime(day.year, day.month, day.day, hour, minute, tzinfo=MOSCOW)
            if slot <= current:
                slots.append(slot)
    return max(slots).isoformat() if slots else None


def next_check(times, current=None):
    current = current or datetime.now(MOSCOW)
    slots = []
    for offset in (0, 1):
        day = (current + timedelta(days=offset)).date()
        for value in times:
            hour, minute = map(int, value.split(":"))
            slot = datetime(day.year, day.month, day.day, hour, minute, tzinfo=MOSCOW)
            if slot > current:
                slots.append(slot)
    return min(slots).isoformat() if slots else None


class Tracker:
    def __init__(self, root, database_path=None):
        self.root = Path(root)
        self.db = Database(database_path or self.root / ".data/prices.sqlite3")
        # A restarted process may retry a check that was interrupted before completion.
        self.db.set_setting("last_started_slot", None)
        self.client = Randewoo(self.root / ".secrets/randewoo-session.json")
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.import_history()

    def import_history(self):
        if self.db.setting("history_imported", False):
            return
        snapshots = []
        for path in (self.root / "scratch").glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                stamp = datetime.fromisoformat(data["checked_at_utc"]).astimezone(timezone.utc).isoformat(timespec="seconds")
                if data.get("list") == "cart" and data.get("authorized") is True and isinstance(data.get("items"), list):
                    snapshots.append((stamp, data["items"], path.name))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        for stamp, items, filename in sorted(snapshots, key=lambda x: x[0]):
            normalized = []
            try:
                for item in items:
                    if not item.get("matches_target_volume"):
                        continue
                    item = dict(item, url=product_url(item["url"]))
                    if not isinstance(item.get("price_kopecks"), int) or item["price_kopecks"] <= 0:
                        raise ValueError()
                    normalized.append(item)
            except (ValueError, KeyError, TypeError):
                continue
            check_id = self.db.start_check("import", stamp)
            entries = []
            for item in normalized:
                variant_id = self.db.variant(item)
                self.db.observation(variant_id, item, "cart", check_id, stamp, "Сохранённый реальный снимок: " + filename)
                entries.append((variant_id, item.get("quantity", 1)))
            self.db.sync_list("cart", entries, stamp)
            self.db.update_check(check_id, status="imported", total=len(entries), completed=len(entries), finished_at=stamp,
                                 message="Импорт ранее полученного реального снимка")
        icon_path = self.root / "scratch/icon-first-observation.json"
        try:
            item = json.loads(icon_path.read_text(encoding="utf-8"))
            if item.get("sku") == "446826" and item.get("price_context") == "public_without_login" and item.get("volume_ml") == "1.5":
                item["url"] = product_url(item["url"])
                item.update(brand="Alfred Dunhill", name="Icon", variant="парфюмерная вода 1,5мл", in_stock=item.get("availability", "").endswith("/InStock"))
                stamp = datetime.fromisoformat(item["checked_at_utc"]).astimezone(timezone.utc).isoformat(timespec="seconds")
                variant_id = self.db.variant(item)
                check_id = self.db.start_check("import", stamp)
                self.db.observation(variant_id, item, "public", check_id, stamp, "Первый реальный тест карточки")
                self.db.sync_list("watching", [(variant_id, 1)], stamp)
                self.db.update_check(check_id, status="imported", total=1, completed=1, finished_at=stamp, message="Импорт первого теста Alfred Dunhill Icon")
        except (OSError, ValueError, KeyError, TypeError):
            pass
        self.db.set_setting("history_imported", True)

    def status(self):
        times = self.db.setting("schedule")
        enabled = self.db.setting("schedule_enabled")
        return {"running": self.lock.locked(), "checks": self.db.checks(), "schedule": times,
                "schedule_enabled": enabled, "timezone": "Europe/Moscow", "next_check": next_check(times) if enabled else None,
                "session_present": self.client.session_path.exists(), "auth_status": self.db.setting("auth_status", "unknown"),
                "auth_message": self.db.setting("auth_message", ""), "csrf_token": None}

    def start_refresh(self, trigger="manual"):
        if not self.lock.acquire(blocking=False):
            return False
        threading.Thread(target=self._guarded_refresh, args=(trigger,), daemon=True, name="price-refresh").start()
        return True

    def refresh_now(self, trigger="manual"):
        if not self.lock.acquire(blocking=False):
            raise ValueError("Проверка уже выполняется")
        return self._guarded_refresh(trigger)

    def _guarded_refresh(self, trigger):
        try:
            return self._refresh(trigger)
        finally:
            self.lock.release()

    def _refresh(self, trigger):
        check_id = self.db.start_check(trigger)
        errors = []
        favorite_urls = set()
        cart_fallback_urls = set()
        try:
            try:
                self.client.authorized_user()
                self.db.set_setting("auth_status", "ok")
                self.db.set_setting("auth_message", "Сессия Randewoo действует")
                authorized = True
            except (AuthError, FetchError) as exc:
                authorized = False
                errors.append(str(exc))
                self.db.set_setting("auth_status", "expired" if isinstance(exc, AuthError) else "error")
                self.db.set_setting("auth_message", str(exc))
            if authorized:
                try:
                    cart = self.client.cart()
                    entries = []
                    for item in cart:
                        meta = dict(item)
                        if not item["matches_target_volume"]:
                            meta.update(sku=None, variant="1,5 мл")
                            cart_fallback_urls.add(item["url"])
                        variant_id = self.db.variant(meta)
                        entries.append((variant_id, item["quantity"]))
                        if item["matches_target_volume"]:
                            self.db.observation(variant_id, item, "cart", check_id)
                    self.db.sync_list("cart", entries)
                except FetchError as exc:
                    errors.append("Корзина: " + str(exc))
                try:
                    favorites = self.client.favorites()
                    favorite_urls = {item["url"] for item in favorites}
                    entries = []
                    for item in favorites:
                        self.db.variant(item)
                        entries.extend((v["id"], 1) for v in self.db.product_variants(item["url"]))
                    self.db.sync_list("favorites", entries)
                except FetchError as exc:
                    errors.append("Избранное: " + str(exc))
            variants = self.db.active_variants()
            unique_products = {v["url"]: v for v in variants}
            self.db.update_check(check_id, total=len(unique_products), message="Получение цен вариантов 1,5 мл")

            def collect(variant):
                time.sleep(0.15)
                try:
                    return variant, self.client.products(variant["url"])
                except FetchError as exc:
                    return variant, [{"status": "error", "message": str(exc)}]
                except Exception:
                    return variant, [{"status": "error", "message": "Не удалось обработать карточку товара"}]

            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="randewoo-read") as pool:
                futures = [pool.submit(collect, v) for v in unique_products.values()]
                for completed, future in enumerate(as_completed(futures), 1):
                    variant, items = future.result()
                    known_variants = self.db.product_variants(variant["url"])
                    if items[0]["status"] == "error":
                        errors.append(f"{variant['brand']} {variant['name']}: {items[0]['message']}")
                        for known in known_variants:
                            self.db.observation(known["id"], items[0], "public", check_id)
                    else:
                        resolved = [(self.db.variant(item), item) for item in items]
                        observed = {variant_id for variant_id, _ in resolved}
                        if variant["url"] in favorite_urls:
                            self.db.add_members("favorites", observed)
                        if variant["url"] in cart_fallback_urls:
                            self.db.add_members("cart", observed)
                        for variant_id, item in resolved:
                            self.db.observation(variant_id, item, "public", check_id)
                        for known in known_variants:
                            if known["id"] not in observed:
                                self.db.observation(known["id"], {"status": "missing", "in_stock": False, "message": "Вариант временно отсутствует на странице"}, "public", check_id)
                    self.db.update_check(check_id, completed=completed)
            message = "Проверено товаров: " + str(len(unique_products))
            if errors:
                message += ". " + "; ".join(errors[:5])
                if len(errors) > 5:
                    message += f". Ещё ошибок: {len(errors) - 5}"
            self.db.update_check(check_id, status="partial" if errors else "success", message=message, finished_at=now())
            self.db.backup(self.root / ".data/backups")
            self.db.set_setting("last_completed_slot", schedule_slot(self.db.setting("schedule")))
            return {"check_id": check_id, "count": len(unique_products), "errors": len(errors)}
        except Exception:
            self.db.update_check(check_id, status="error", message="Проверка прервана. Предыдущие данные сохранены", finished_at=now())
            return {"check_id": check_id, "errors": 1}

    def add_url(self, url):
        variant_id = None
        for item in self.client.products(product_url(url)):
            variant_id = self.db.variant(item)
            self.db.watch(variant_id)
            self.db.observation(variant_id, item, "public")
        return variant_id

    def save_settings(self, data):
        times = data.get("schedule")
        if not isinstance(times, list) or not 1 <= len(times) <= 24 or any(not isinstance(t, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", t) for t in times):
            raise ValueError("Укажите от 1 до 24 времён в формате ЧЧ:ММ")
        if not isinstance(data.get("schedule_enabled"), bool):
            raise ValueError("Некорректное состояние расписания")
        self.db.set_setting("schedule", sorted(set(times)))
        self.db.set_setting("schedule_enabled", data["schedule_enabled"])
        self.db.set_setting("last_completed_slot", schedule_slot(times))

    def save_session(self, data):
        cookie, agent = data.get("cookie", "").strip(), data.get("user_agent", "").strip()
        if not cookie or len(cookie) > 50000 or not agent or len(agent) > 1000:
            raise ValueError("Нужны Cookie и User-Agent из запроса Randewoo")
        quote(cookie)
        quote(agent)
        path = self.client.session_path
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"cookie": cookie, "user_agent": agent}), encoding="utf-8")
        temporary.replace(path)
        self.db.set_setting("auth_status", "unknown")
        self.db.set_setting("auth_message", "Сессия сохранена. Запустите проверку")

    def scheduler_tick(self, current=None):
        if not self.db.setting("schedule_enabled", True):
            return False
        slot = schedule_slot(self.db.setting("schedule"), current)
        if slot and self.db.setting("last_completed_slot") != slot and self.db.setting("last_started_slot") != slot:
            if self.start_refresh("schedule"):
                self.db.set_setting("last_started_slot", slot)
                return True
        return False

    def start_scheduler(self):
        def loop():
            while not self.stop.is_set():
                try:
                    self.scheduler_tick()
                except Exception:
                    pass
                self.stop.wait(15)
        threading.Thread(target=loop, daemon=True, name="price-schedule").start()
