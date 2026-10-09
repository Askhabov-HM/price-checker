"""Shared products, list memberships, and price observations in SQLite."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3

MOSCOW = timezone(timedelta(hours=3), "Europe/Moscow")
CONTEXTS = {"public": "Цена на сайте", "cart": "Цена в корзине"}
LISTS = {"favorites": "Избранное", "cart": "Корзина", "watching": "Наблюдение"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as con:
            con.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS products(
                    id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, brand TEXT NOT NULL DEFAULT '',
                    name TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS variants(
                    id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
                    volume_ml TEXT NOT NULL DEFAULT '1.5', sku TEXT, label TEXT NOT NULL DEFAULT '1,5 мл',
                    UNIQUE(product_id,sku));
                CREATE TABLE IF NOT EXISTS lists(id TEXT PRIMARY KEY, name TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS memberships(
                    id INTEGER PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id),
                    variant_id INTEGER NOT NULL REFERENCES variants(id), joined_at TEXT NOT NULL,
                    left_at TEXT, quantity INTEGER NOT NULL DEFAULT 1);
                CREATE UNIQUE INDEX IF NOT EXISTS active_membership ON memberships(list_id,variant_id) WHERE left_at IS NULL;
                CREATE TABLE IF NOT EXISTS checks(
                    id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
                    trigger TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', message TEXT NOT NULL DEFAULT '',
                    completed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS observations(
                    id INTEGER PRIMARY KEY, variant_id INTEGER NOT NULL REFERENCES variants(id),
                    check_id INTEGER REFERENCES checks(id), checked_at TEXT NOT NULL, context TEXT NOT NULL,
                    price INTEGER, original_price INTEGER, in_stock INTEGER, status TEXT NOT NULL,
                    message TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
                    UNIQUE(variant_id,checked_at,context));
                CREATE INDEX IF NOT EXISTS observation_lookup ON observations(variant_id,context,checked_at DESC,id DESC);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
            schema = con.execute("SELECT sql FROM sqlite_master WHERE name='variants'").fetchone()[0]
            if "UNIQUE(product_id,volume_ml)" in schema:
                con.executescript("""
                    PRAGMA foreign_keys=OFF;
                    CREATE TABLE variants_new(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),
                        volume_ml TEXT NOT NULL DEFAULT '1.5',sku TEXT,label TEXT NOT NULL DEFAULT '1,5 мл',UNIQUE(product_id,sku));
                    INSERT INTO variants_new SELECT * FROM variants;
                    DROP TABLE variants;
                    ALTER TABLE variants_new RENAME TO variants;
                    PRAGMA foreign_keys=ON;
                """)
            for key, label in LISTS.items():
                con.execute("INSERT OR IGNORE INTO lists VALUES(?,?)", (key, label))
            con.execute("UPDATE checks SET status='interrupted',finished_at=?,message='Приложение было закрыто во время проверки' WHERE status='running'", (now(),))
            defaults = {"schedule": ["00:30", "09:00", "14:00", "20:00"], "schedule_enabled": True}
            for key, value in defaults.items():
                con.execute("INSERT OR IGNORE INTO settings VALUES(?,?)", (key, json.dumps(value)))

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.path, timeout=30)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        try:
            with con:
                yield con
        finally:
            con.close()

    def setting(self, key, default=None):
        with self.connect() as con:
            row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def set_setting(self, key, value):
        with self.connect() as con:
            con.execute("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))

    def variant(self, item):
        with self.connect() as con:
            con.execute("""INSERT INTO products(url,brand,name,image) VALUES(?,?,?,?)
                ON CONFLICT(url) DO UPDATE SET brand=CASE WHEN excluded.brand!='' THEN excluded.brand ELSE products.brand END,
                name=CASE WHEN excluded.name!='' THEN excluded.name ELSE products.name END,
                image=CASE WHEN excluded.image!='' THEN excluded.image ELSE products.image END""",
                        (item["url"], item.get("brand", ""), item.get("name", ""), item.get("image", "")))
            product_id = con.execute("SELECT id FROM products WHERE url=?", (item["url"],)).fetchone()[0]
            sku = item.get("sku")
            row = con.execute("SELECT id FROM variants WHERE product_id=? AND sku IS ?", (product_id, sku)).fetchone()
            if not row and sku:
                row = con.execute("SELECT id FROM variants WHERE product_id=? AND sku IS NULL LIMIT 1", (product_id,)).fetchone()
            if row:
                if sku:
                    con.execute("UPDATE variants SET sku=?,label=? WHERE id=?", (sku, item.get("variant", "1,5 мл"), row[0]))
                return row[0]
            if not sku:
                row = con.execute("SELECT id FROM variants WHERE product_id=? ORDER BY id LIMIT 1", (product_id,)).fetchone()
                if row:
                    return row[0]
            return con.execute("INSERT INTO variants(product_id,sku,label) VALUES(?,?,?)", (product_id, sku, item.get("variant", "1,5 мл"))).lastrowid

    def product_variants(self, url):
        with self.connect() as con:
            return [dict(r) for r in con.execute("SELECT v.* FROM variants v JOIN products p ON p.id=v.product_id WHERE p.url=?", (url,))]

    def add_members(self, list_id, variant_ids):
        with self.connect() as con:
            for variant_id in variant_ids:
                con.execute("INSERT OR IGNORE INTO memberships(list_id,variant_id,joined_at) VALUES(?,?,?)", (list_id, variant_id, now()))

    def sync_list(self, list_id, entries, timestamp=None):
        timestamp = timestamp or now()
        expected = {int(variant_id): quantity for variant_id, quantity in entries}
        with self.connect() as con:
            existing = {r["variant_id"]: r for r in con.execute("SELECT * FROM memberships WHERE list_id=? AND left_at IS NULL", (list_id,))}
            for variant_id in existing.keys() - expected.keys():
                con.execute("UPDATE memberships SET left_at=? WHERE id=?", (timestamp, existing[variant_id]["id"]))
            for variant_id, quantity in expected.items():
                if variant_id in existing:
                    con.execute("UPDATE memberships SET quantity=? WHERE id=?", (quantity, existing[variant_id]["id"]))
                else:
                    con.execute("INSERT INTO memberships(list_id,variant_id,joined_at,quantity) VALUES(?,?,?,?)", (list_id, variant_id, timestamp, quantity))

    def watch(self, variant_id, active=True):
        with self.connect() as con:
            row = con.execute("SELECT id FROM variants WHERE id=?", (variant_id,)).fetchone()
            if not row:
                raise ValueError("Товар не найден")
            if active:
                con.execute("INSERT OR IGNORE INTO memberships(list_id,variant_id,joined_at) VALUES('watching',?,?)", (variant_id, now()))
            else:
                con.execute("UPDATE memberships SET left_at=? WHERE list_id='watching' AND variant_id=? AND left_at IS NULL", (now(), variant_id))

    def active_variants(self):
        with self.connect() as con:
            return [dict(r) for r in con.execute("""SELECT DISTINCT v.id,v.sku,p.url,p.brand,p.name,p.image,v.label
                FROM variants v JOIN products p ON p.id=v.product_id JOIN memberships m ON m.variant_id=v.id WHERE m.left_at IS NULL""")]

    def observation(self, variant_id, item, context, check_id=None, timestamp=None, source="Randewoo"):
        status = item.get("status", "ok")
        price = item.get("price_kopecks") if status == "ok" else None
        stock = item.get("in_stock") if status != "error" else None
        with self.connect() as con:
            con.execute("""INSERT OR IGNORE INTO observations(variant_id,check_id,checked_at,context,price,original_price,in_stock,status,message,source)
                VALUES(?,?,?,?,?,?,?,?,?,?)""", (variant_id, check_id, timestamp or now(), context, price,
                item.get("original_price_kopecks"), stock, status, item.get("message", ""), source))

    def start_check(self, trigger, timestamp=None):
        with self.connect() as con:
            return con.execute("INSERT INTO checks(started_at,trigger) VALUES(?,?)", (timestamp or now(), trigger)).lastrowid

    def update_check(self, check_id, **fields):
        allowed = {"status", "message", "completed", "total", "finished_at"}
        if not fields or not set(fields) <= allowed:
            raise ValueError("Invalid check update")
        with self.connect() as con:
            con.execute("UPDATE checks SET " + ",".join(k + "=?" for k in fields) + " WHERE id=?", (*fields.values(), check_id))

    def checks(self, limit=12):
        with self.connect() as con:
            return [dict(row) for row in con.execute("SELECT * FROM checks ORDER BY id DESC LIMIT ?", (limit,))]

    def rows(self, list_id, context="public"):
        if list_id not in LISTS or context not in CONTEXTS:
            raise ValueError("Неизвестный список или тип цены")
        result = []
        with self.connect() as con:
            variants = con.execute("""SELECT v.id,v.sku,v.label,p.brand,p.name,p.url,p.image,m.quantity,m.joined_at
                FROM memberships m JOIN variants v ON v.id=m.variant_id JOIN products p ON p.id=v.product_id
                WHERE m.list_id=? AND m.left_at IS NULL ORDER BY p.brand,p.name""", (list_id,)).fetchall()
            for variant in variants:
                row = dict(variant)
                observations = con.execute("SELECT * FROM observations WHERE variant_id=? AND context=? ORDER BY checked_at DESC,id DESC LIMIT 1", (row["id"], context)).fetchall()
                successful = con.execute("SELECT * FROM observations WHERE variant_id=? AND context=? AND status='ok' AND price IS NOT NULL ORDER BY checked_at DESC,id DESC LIMIT 2", (row["id"], context)).fetchall()
                latest = observations[0] if observations else None
                last = successful[0] if successful else None
                unavailable = bool(latest and latest["status"] == "missing")
                row.update({"status": latest["status"] if latest else "pending", "price": last["price"] if last and not unavailable else None,
                            "previous_price": successful[1]["price"] if len(successful) > 1 else None,
                            "in_stock": bool(latest["in_stock"]) if latest and latest["status"] != "error" else (bool(last["in_stock"]) if last else None),
                            "checked_at": latest["checked_at"] if latest else None, "price_at": last["checked_at"] if last else None,
                            "message": latest["message"] if latest else "", "observations": con.execute("SELECT COUNT(*) FROM observations WHERE variant_id=? AND context=? AND status='ok'", (row["id"], context)).fetchone()[0],
                            "minimum": con.execute("SELECT MIN(price) FROM observations WHERE variant_id=? AND context=? AND status='ok'", (row["id"], context)).fetchone()[0],
                            "watching": bool(con.execute("SELECT 1 FROM memberships WHERE variant_id=? AND list_id='watching' AND left_at IS NULL", (row["id"],)).fetchone())})
                row["delta"] = row["price"] - row["previous_price"] if row["price"] is not None and row["previous_price"] is not None else None
                points = con.execute("SELECT checked_at,price,status FROM observations WHERE variant_id=? AND context=? ORDER BY checked_at DESC,id DESC LIMIT 24", (row["id"], context)).fetchall()
                row["sparkline"] = [dict(p) for p in reversed(points)]
                result.append(row)
        return result

    def detail(self, variant_id, context="public", days=30):
        if context not in CONTEXTS:
            raise ValueError("Неизвестный тип цены")
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds") if days else ""
        with self.connect() as con:
            row = con.execute("SELECT v.id,v.sku,v.label,p.brand,p.name,p.url FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?", (variant_id,)).fetchone()
            if not row:
                raise ValueError("Товар не найден")
            points = [dict(p) for p in con.execute("SELECT checked_at,price,in_stock,status,message,source FROM observations WHERE variant_id=? AND context=? AND checked_at>=? ORDER BY checked_at,id", (variant_id, context, since))]
            return {"product": dict(row), "points": points, "context": context}

    def list_history(self, list_id, context="public", days=30):
        """One unit per member; missing prices stay incomplete, not zero-priced."""
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds") if days else ""
        with self.connect() as con:
            runs = con.execute("""SELECT DISTINCT o.check_id,MAX(o.checked_at) AS checked_at FROM observations o
                JOIN memberships m ON m.variant_id=o.variant_id WHERE m.list_id=? AND o.context=? AND o.checked_at>=?
                AND o.checked_at>=m.joined_at AND (m.left_at IS NULL OR o.checked_at<m.left_at)
                GROUP BY o.check_id,CASE WHEN o.check_id IS NULL THEN o.checked_at END ORDER BY checked_at""", (list_id, context, since)).fetchall()
            points = []
            for run in runs:
                stamp = run["checked_at"]
                rows = con.execute("""SELECT o.* FROM observations o JOIN memberships m ON m.variant_id=o.variant_id
                    WHERE m.list_id=? AND o.context=? AND o.check_id IS ? AND o.checked_at>=m.joined_at
                    AND (m.left_at IS NULL OR o.checked_at<m.left_at)
                    AND (o.check_id IS NOT NULL OR o.checked_at=?)""", (list_id, context, run["check_id"], stamp)).fetchall()
                members = [r[0] for r in con.execute("SELECT variant_id FROM memberships WHERE list_id=? AND joined_at<=? AND (left_at IS NULL OR left_at>?) ORDER BY variant_id", (list_id, stamp, stamp))]
                count = len(members)
                known = [r for r in rows if r["status"] == "ok" and r["price"] is not None and r["in_stock"]]
                complete = len(known) == count and count > 0
                points.append({"checked_at": stamp, "price": sum(r["price"] for r in known) if complete else None,
                               "known_total": sum(r["price"] for r in known), "count": count, "priced_count": len(known), "complete": complete,
                               "composition": json.dumps([members, sorted(r["variant_id"] for r in known)])})
            return points

    def backup(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / ("prices-" + datetime.now(MOSCOW).strftime("%Y-%m-%d") + ".sqlite3")
        with self.connect() as source:
            destination = sqlite3.connect(target)
            try:
                source.backup(destination)
            finally:
                destination.close()
        return target
