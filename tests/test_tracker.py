import json
from pathlib import Path
import tempfile
import unittest
from contextlib import closing
from datetime import datetime
from unittest.mock import patch

from price_checker.client import AuthError, FavoritesPage, FetchError, parse_products, product_url
from price_checker.database import Database, MOSCOW
from price_checker.service import Tracker, next_check, schedule_slot
from price_checker.instance import AlreadyRunning, instance_lock


def item(sku="123", price=15000):
    return {"url": "https://randewoo.ru/product/test-fragrance", "sku": sku, "brand": "Brand", "name": "Fragrance",
            "variant": "парфюмерная вода 1,5мл", "price_kopecks": price, "in_stock": True, "status": "ok"}


class ProductParsingTests(unittest.TestCase):
    def html(self, offers):
        return '<script type="application/ld+json">' + json.dumps({"@type": "Product", "name": "Brand Fragrance", "brand": {"name": "Brand"}, "offers": offers}) + '</script>'

    def test_only_exact_volume_and_separate_concentrations(self):
        offers = [{"@type": "Offer", "sku": str(i), "name": name, "price": price, "priceCurrency": "RUB", "availability": "https://schema.org/InStock"} for i, (name, price) in enumerate([
            ("Brand Fragrance туалетная вода 1,5мл", 100), ("Brand Fragrance духи 1.5 мл", 200),
            ("Brand Fragrance 15мл", 999), ("Brand Fragrance 11,5мл", 888)])]
        rows = parse_products(self.html(offers), item()["url"])
        self.assertEqual([r["sku"] for r in rows], ["0", "1"])
        self.assertEqual([r["price_kopecks"] for r in rows], [10000, 20000])

    def test_missing_volume_is_not_zero_price(self):
        rows = parse_products(self.html([]), item()["url"])
        self.assertEqual(rows[0]["status"], "missing")
        self.assertIsNone(rows[0]["price_kopecks"])

    def test_zero_and_invalid_prices_are_rejected(self):
        for price in (0, -1, "NaN", "invalid"):
            with self.subTest(price=price), self.assertRaises(FetchError):
                parse_products(self.html([{"@type": "Offer", "sku": "1", "name": "Fragrance 1,5мл", "price": price, "priceCurrency": "RUB"}]), item()["url"])

    def test_arbitrary_hosts_and_credentials_in_url_are_rejected(self):
        for url in ("https://example.com/product/a", "https://randewoo.ru@evil.example/product/a", "file:///product/a", "https://randewoo.ru:443/product/a"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                product_url(url)

    def test_recommendations_do_not_become_favorites(self):
        html = '<div class="b-cabinetProductList__productsItem"><a class="s-productItem__brand">Brand</a><a class="s-productItem__titleLink" href="/product/a">Name</a><button data-product-id="7"></button></div><div class="s-productItem"><a href="/product/recommendation">Other</a></div><a href="/cabinet/favorites?page=2">Next</a>'
        page = FavoritesPage()
        page.feed(html)
        self.assertEqual(len(page.items), 1)
        self.assertEqual(page.items[0]["parent_id"], 7)
        self.assertEqual(page.pages, {2})


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.directory.name) / "prices.sqlite3")
        self.variant = self.db.variant(item())

    def tearDown(self):
        self.directory.cleanup()

    def join(self, list_id="cart", ids=None):
        self.db.sync_list(list_id, [(v, 1) for v in (ids or [self.variant])], "2026-10-01T00:00:00+00:00")

    def test_lists_share_observations(self):
        self.join("cart")
        self.join("favorites")
        self.db.observation(self.variant, item(), "public", timestamp="2026-10-02T10:00:00+00:00")
        self.assertEqual(self.db.rows("cart")[0]["price"], self.db.rows("favorites")[0]["price"])
        with self.db.connect() as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 1)

    def test_removal_keeps_history(self):
        self.join()
        self.db.observation(self.variant, item(), "public")
        self.db.sync_list("cart", [])
        self.assertEqual(self.db.rows("cart"), [])
        self.assertEqual(len(self.db.detail(self.variant, days=0)["points"]), 1)

    def test_errors_keep_last_price_and_do_not_count_as_zero(self):
        self.join()
        self.db.observation(self.variant, item(price=15000), "public", timestamp="2026-10-02T10:00:00+00:00")
        self.db.observation(self.variant, {"status": "error", "message": "Network error"}, "public", timestamp="2026-10-02T11:00:00+00:00")
        row = self.db.rows("cart")[0]
        self.assertEqual(row["price"], 15000)
        self.assertEqual(row["status"], "error")
        self.assertEqual(row["minimum"], 15000)
        self.assertIsNone(self.db.detail(self.variant, days=0)["points"][-1]["price"])

    def test_price_contexts_are_never_mixed(self):
        self.join()
        self.db.observation(self.variant, item(price=15000), "public", timestamp="2026-10-02T10:00:00+00:00")
        self.db.observation(self.variant, item(price=10000), "cart", timestamp="2026-10-02T10:00:00+00:00")
        self.assertEqual(self.db.rows("cart", "public")[0]["price"], 15000)
        self.assertEqual(self.db.rows("cart", "cart")[0]["price"], 10000)
        self.assertIsNone(self.db.rows("cart", "public")[0]["delta"])

    def test_different_concentrations_get_separate_variants(self):
        other = self.db.variant(item(sku="456", price=25000))
        self.assertNotEqual(other, self.variant)
        self.join(ids=[self.variant, other])
        self.assertEqual(len(self.db.rows("cart")), 2)

    def test_unavailable_product_does_not_create_fake_total(self):
        self.join()
        check = self.db.start_check("manual")
        self.db.observation(self.variant, dict(item(), in_stock=False), "public", check, "2026-10-02T10:00:00+00:00")
        history = self.db.list_history("cart", days=0)
        self.assertIsNone(history[0]["price"])
        self.assertFalse(history[0]["complete"])

    def test_backup_is_readable_and_contains_real_observations(self):
        self.db.observation(self.variant, item(), "public")
        target = self.db.backup(Path(self.directory.name) / "backups")
        import sqlite3
        with closing(sqlite3.connect(target)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0], 1)

    def test_same_count_different_products_breaks_overview_line(self):
        self.join()
        first = self.db.start_check("manual")
        self.db.observation(self.variant, item(), "public", first, "2026-10-02T10:00:00+00:00")
        other = self.db.variant(dict(item(sku="456"), url="https://randewoo.ru/product/another"))
        self.db.sync_list("cart", [(other, 1)], "2026-10-03T00:00:00+00:00")
        second = self.db.start_check("manual")
        self.db.observation(other, item(), "public", second, "2026-10-03T10:00:00+00:00")
        points = self.db.list_history("cart", days=0)
        self.assertEqual([p["count"] for p in points], [1, 1])
        self.assertNotEqual(points[0]["composition"], points[1]["composition"])

    def test_manual_observations_at_different_times_are_not_one_check(self):
        self.join()
        self.db.observation(self.variant, item(), "public", timestamp="2026-10-02T10:00:00+00:00")
        self.db.observation(self.variant, item(price=20000), "public", timestamp="2026-10-03T10:00:00+00:00")
        points = self.db.list_history("cart", days=0)
        self.assertEqual([p["price"] for p in points], [15000, 20000])

    def test_only_one_process_can_hold_the_database_lock(self):
        import subprocess
        import sys
        path = Path(self.directory.name) / "app.lock"
        code = "from pathlib import Path; from price_checker.instance import instance_lock; import sys;\nwith instance_lock(Path(sys.argv[1])): pass"
        with instance_lock(path):
            result = subprocess.run([sys.executable, "-c", code, str(path)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"AlreadyRunning", result.stderr)
        result = subprocess.run([sys.executable, "-c", code, str(path)], capture_output=True)
        self.assertEqual(result.returncode, 0)


class SchedulerAndServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.tracker = Tracker(Path(self.directory.name))

    def tearDown(self):
        self.directory.cleanup()

    def test_schedule_handles_midnight_in_moscow(self):
        current = datetime(2026, 10, 9, 0, 10, tzinfo=MOSCOW)
        times = ["00:30", "09:00", "14:00", "20:00"]
        self.assertEqual(schedule_slot(times, current), "2026-10-08T20:00:00+03:00")
        self.assertEqual(next_check(times, current), "2026-10-09T00:30:00+03:00")

    def test_catchup_runs_once_and_pause_is_respected(self):
        current = datetime(2026, 10, 9, 15, 0, tzinfo=MOSCOW)
        with patch.object(self.tracker, "start_refresh", return_value=True) as start:
            self.assertTrue(self.tracker.scheduler_tick(current))
            self.assertFalse(self.tracker.scheduler_tick(current))
            self.assertEqual(start.call_count, 1)
        self.tracker.db.set_setting("schedule_enabled", False)
        with patch.object(self.tracker, "start_refresh") as start:
            self.assertFalse(self.tracker.scheduler_tick(current + __import__('datetime').timedelta(days=1)))
            start.assert_not_called()

    def test_invalid_schedule_does_not_replace_good_settings(self):
        before = self.tracker.db.setting("schedule")
        with self.assertRaises(ValueError):
            self.tracker.save_settings({"schedule": ["25:00"], "schedule_enabled": True})
        self.assertEqual(self.tracker.db.setting("schedule"), before)

    def test_restart_retries_an_unfinished_slot(self):
        current = datetime(2026, 10, 9, 15, 0, tzinfo=MOSCOW)
        self.tracker.db.set_setting("last_started_slot", schedule_slot(self.tracker.db.setting("schedule"), current))
        restarted = Tracker(Path(self.directory.name))
        with patch.object(restarted, "start_refresh", return_value=True) as start:
            self.assertTrue(restarted.scheduler_tick(current))
            start.assert_called_once_with("schedule")

    def test_authentication_failure_keeps_lists_and_public_checks_work(self):
        variant = self.tracker.db.variant(item())
        self.tracker.db.sync_list("cart", [(variant, 1)])
        with patch.object(self.tracker.client, "authorized_user", side_effect=AuthError("Сессия истекла")), patch.object(self.tracker.client, "products", return_value=[item(price=12300)]):
            result = self.tracker.refresh_now("test")
        self.assertEqual(result["errors"], 1)
        self.assertEqual(len(self.tracker.db.rows("cart")), 1)
        self.assertEqual(self.tracker.db.rows("cart")[0]["price"], 12300)
        self.assertEqual(self.tracker.db.setting("auth_status"), "expired")


if __name__ == "__main__":
    unittest.main()
