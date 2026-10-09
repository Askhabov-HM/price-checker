"""Read-only Randewoo HTTP client. Credentials never enter process arguments."""

from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import urljoin, urlsplit

ORIGIN = "https://randewoo.ru"
VOLUME = re.compile(r"(?<![\d.,])1[.,]5\s*(?:мл|ml)\b", re.I)


class FetchError(Exception):
    pass


class AuthError(FetchError):
    pass


def product_url(value):
    url = urljoin(ORIGIN, value or "")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != "randewoo.ru" or not parsed.path.startswith("/product/") or parsed.username:
        raise ValueError("Нужна ссылка на товар https://randewoo.ru/product/…")
    return ORIGIN + parsed.path.rstrip("/")


def money(value):
    try:
        if value is None or isinstance(value, bool):
            raise ValueError()
        result = Decimal(str(value)) * 100
        if not result.is_finite() or result <= 0 or result != result.to_integral_value():
            raise ValueError()
        return int(result)
    except (InvalidOperation, ValueError):
        raise FetchError("Сайт вернул некорректную цену") from None


def quote(value):
    if not isinstance(value, str) or any(c in value for c in "\r\n\x00"):
        raise ValueError("Некорректные заголовки сессии")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class PageData(HTMLParser):
    def __init__(self):
        super().__init__()
        self.capture = False
        self.parts = []
        self.documents = []
        self.cards = []
        self.images = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and a.get("type") == "application/ld+json":
            self.capture, self.parts = True, []
        if tag == "li" and "data-product-sku" in a and a.get("data-variant"):
            self.cards.append(a)
        if tag == "meta" and a.get("property") == "og:image":
            self.images.append(a.get("content", ""))

    def handle_data(self, data):
        if self.capture:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.capture:
            try:
                self.documents.append(json.loads("".join(self.parts)))
            except ValueError:
                pass
            self.capture = False


class FavoritesPage(HTMLParser):
    """Read only favorite-list cards, excluding recommendation carousels."""
    VOID = {"img", "input", "br", "hr", "meta", "link", "source", "wbr", "area", "embed", "param", "col", "base"}

    def __init__(self):
        super().__init__()
        self.stack = []
        self.current = None
        self.root_depth = None
        self.items = []
        self.pages = set()

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = a.get("class", "").split()
        if "b-cabinetProductList__productsItem" in classes:
            self.current = {"url": "", "brand": "", "name": "", "image": "", "parent_id": None}
            self.root_depth = len(self.stack)
        field = None
        if self.current is not None:
            if a.get("href", "").startswith("/product/"):
                self.current["url"] = product_url(a["href"])
            if a.get("data-product-id"):
                self.current["parent_id"] = int(a["data-product-id"])
            if tag == "img" and not self.current["image"]:
                self.current["image"] = a.get("src", "")
            if "s-productItem__brand" in classes:
                field = "brand"
            if "s-productItem__titleLink" in classes:
                field = "name"
        href = a.get("href", "")
        if tag == "a" and href.startswith("/cabinet/favorites?"):
            from urllib.parse import parse_qs
            page = parse_qs(urlsplit(href).query).get("page", [""])[0]
            if page.isdigit():
                self.pages.add(int(page))
        if tag not in self.VOID:
            self.stack.append((tag, field))

    def handle_data(self, data):
        if self.current is not None:
            field = next((field for _, field in reversed(self.stack) if field), None)
            if field:
                self.current[field] += data

    def handle_endtag(self, tag):
        index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i][0] == tag), None)
        if index is None:
            return
        if self.current is not None and index == self.root_depth:
            if self.current["url"] and self.current["parent_id"]:
                self.current["name"] = self.current["name"].strip()
                self.current["brand"] = self.current["brand"].strip()
                self.items.append(self.current)
            self.current, self.root_depth = None, None
        del self.stack[index:]


def objects(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def parse_products(html, url):
    page = PageData()
    page.feed(html)
    nodes = [node for document in page.documents for node in objects(document)]
    parent = next((n for n in nodes if n.get("@type") == "Product"), {})
    offers = {str(n.get("sku")): n for n in nodes if n.get("@type") == "Offer" and n.get("sku") and VOLUME.search(n.get("name", ""))}
    brand = parent.get("brand", {})
    brand = brand.get("name", "") if isinstance(brand, dict) else str(brand)
    title = parent.get("name", "")
    if brand and title.startswith(brand):
        title = title[len(brand):].strip()
    result = []
    for sku, offer in offers.items():
        if offer.get("priceCurrency") != "RUB":
            raise FetchError("Сайт вернул цену в другой валюте")
        card = next((c for c in page.cards if c.get("data-product-sku") == sku), {})
        result.append({
            "sku": sku, "brand": brand or card.get("data-brand", ""),
            "name": title or card.get("data-name") or offer["name"], "url": product_url(url),
            "variant": card.get("data-variant") or offer["name"], "volume_ml": "1.5",
            "price_kopecks": money(offer.get("price")), "original_price_kopecks": None,
            "in_stock": offer.get("availability", "").endswith("/InStock"),
            "image": page.images[0] if page.images else "", "status": "ok",
        })
    if result:
        return result
    # Missing variant is an explicit state, never the price of another volume.
    if not parent:
        raise FetchError("Не удалось распознать карточку товара")
    return [{"sku": None, "brand": brand, "name": title, "url": product_url(url),
            "variant": "Вариант 1,5 мл не найден", "volume_ml": "1.5",
            "price_kopecks": None, "original_price_kopecks": None,
            "in_stock": False, "image": page.images[0] if page.images else "", "status": "missing"}]


def parse_product(html, url):
    result = parse_products(html, url)
    if len(result) != 1:
        raise FetchError("У товара несколько вариантов 1,5 мл")
    return result[0]


class Randewoo:
    def __init__(self, session_path):
        self.session_path = Path(session_path)

    def session(self):
        try:
            session = json.loads(self.session_path.read_text(encoding="utf-8"))
            if not session.get("cookie") or not session.get("user_agent"):
                raise ValueError()
            quote(session["cookie"])
            quote(session["user_agent"])
            return session
        except (OSError, ValueError, TypeError, KeyError):
            raise AuthError("Добавьте действующую сессию Randewoo в настройках") from None

    def get(self, path, authorized=False, json_response=False):
        parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc or not path.startswith("/") or path.startswith("//"):
            raise ValueError("Недопустимый адрес запроса")
        allowed = path.split("?", 1)[0]
        if allowed not in ("/cart", "/favorites", "/cabinet/favorites", "/front_api/cart/new_cart") and not allowed.startswith("/product/"):
            raise ValueError("Запрос не относится к спискам или товарам")
        curl = shutil.which("curl.exe") or shutil.which("curl")
        if not curl:
            raise FetchError("Не найдена программа curl")
        config = ["url = " + quote(ORIGIN + path), "silent", "show-error", "max-time = 30",
                  'proto = "=https"', 'write-out = "\\nPRICE_CHECKER_STATUS:%{http_code}"']
        if authorized:
            session = self.session()
            config += ["cookie = " + quote(session["cookie"]), "user-agent = " + quote(session["user_agent"])]
        else:
            config += ['user-agent = "PriceChecker/1.0"']
        config += ["header = " + quote("Accept: " + ("application/json" if json_response else "text/html"))]
        if path.startswith("/favorites"):
            config += ['header = "Content-Type: application/json"']
        try:
            response = subprocess.run([curl, "-q", "--config", "-"], input="\n".join(config).encode(),
                                      capture_output=True, timeout=40)
        except (OSError, subprocess.TimeoutExpired):
            raise FetchError("Не удалось связаться с Randewoo") from None
        if response.returncode:
            raise FetchError("Ошибка соединения с Randewoo")
        body, marker, status = response.stdout.rpartition(b"\nPRICE_CHECKER_STATUS:")
        if not marker or status != b"200":
            if authorized and status in (b"301", b"302", b"303", b"401"):
                raise AuthError("Сессия истекла: обновите вход в Randewoo")
            code = status.decode("ascii", "replace") if marker else "неизвестен"
            raise FetchError("Randewoo вернул HTTP " + code)
        try:
            return json.loads(body) if json_response else body.decode("utf-8")
        except (ValueError, UnicodeError):
            raise FetchError("Неожиданный формат ответа Randewoo") from None

    def authorized_user(self):
        html = self.get("/cart", authorized=True)
        match = re.search(r"gon\.user\s*=\s*", html)
        try:
            user = json.JSONDecoder().raw_decode(html[match.end():])[0] if match else {}
        except (ValueError, TypeError):
            user = {}
        if not isinstance(user, dict) or user.get("is_authorized") is not True:
            raise AuthError("Сессия истекла: обновите вход в Randewoo")
        return {"favorites_count": user.get("favorite_products_count")}

    def cart(self):
        data = self.get("/front_api/cart/new_cart", authorized=True, json_response=True)
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            raise FetchError("Не удалось распознать корзину; предыдущий список сохранён")
        result = []
        for item in data["items"]:
            try:
                p = item["product"]
                result.append({"url": product_url(p["href"]), "sku": str(p["sku"]),
                               "brand": p["brand_title"], "name": p["title"], "variant": p["subtitle"],
                               "quantity": item["count"], "matches_target_volume": bool(VOLUME.search(p["subtitle"])),
                               "price_kopecks": money(p["price"]), "original_price_kopecks": money(p["price_original"]),
                               "in_stock": bool(p["can_buy"])})
            except (KeyError, TypeError, ValueError):
                raise FetchError("Изменился формат товара корзины; список сохранён") from None
        return result

    def favorites(self):
        stats = self.get("/favorites", authorized=True, json_response=True)
        if not isinstance(stats, dict) or not isinstance(stats.get("ids"), list):
            raise FetchError("Не удалось распознать избранное; предыдущий список сохранён")
        expected = set(stats["ids"])
        results = {}
        pending, visited = {1}, set()
        while pending:
            number = min(pending)
            pending.remove(number)
            if number in visited:
                continue
            if number > 100 or len(visited) >= 100:
                raise FetchError("Слишком много страниц избранного")
            path = "/cabinet/favorites" + (f"?page={number}" if number > 1 else "")
            page = FavoritesPage()
            page.feed(self.get(path, authorized=True))
            visited.add(number)
            for item in page.items:
                if item["parent_id"] in expected:
                    results[item["parent_id"]] = item
            pending.update(page.pages - visited)
        if set(results) != expected:
            raise FetchError("Избранное получено не полностью; предыдущий список сохранён")
        return list(results.values())

    def product(self, url):
        url = product_url(url)
        return parse_product(self.get(urlsplit(url).path), url)

    def products(self, url):
        url = product_url(url)
        return parse_products(self.get(urlsplit(url).path), url)
