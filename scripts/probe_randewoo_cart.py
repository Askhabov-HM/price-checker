"""Read the authorized Randewoo cart without printing session credentials.

Run: python scripts/probe_randewoo_cart.py --output scratch/cart-first-observation.json
Session JSON is read from .secrets/randewoo-session.json by default.
Only read requests are made. This probe does not refresh authentication.
"""

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import urljoin, urlsplit


ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://randewoo.ru"
VOLUME_PATTERN = re.compile(r"(?<![\d.,])1[.,]5\s*(?:\u043c\u043b|ml)\b", re.I)


def config_quote(value):
    if not isinstance(value, str) or any(c in value for c in "\r\n\x00"):
        raise ValueError("Invalid request configuration")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def get(path, session, accept):
    if path not in ("/cart", "/front_api/cart/new_cart"):
        raise ValueError("Only the two known cart read endpoints are allowed")
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("curl is required")
    # Credentials go through stdin, never shell commands or process arguments.
    # Redirects are deliberately not followed with this cookie header.
    config = "\n".join([
        "url = " + config_quote(ORIGIN + path),
        "silent", "show-error", "max-time = 30", "proto = \"=https\"",
        "cookie = " + config_quote(session["cookie"]),
        "user-agent = " + config_quote(session["user_agent"]),
        "header = " + config_quote("Accept: " + accept),
        'write-out = "\\nPROBE_HTTP_STATUS:%{http_code}"',
    ])
    response = subprocess.run(
        [curl, "-q", "--config", "-"], input=config.encode("utf-8"),
        capture_output=True, timeout=40,
    )
    if response.returncode:
        raise RuntimeError(f"Request failed (curl exit code {response.returncode})")
    body, marker, status = response.stdout.rpartition(b"\nPROBE_HTTP_STATUS:")
    if not marker or status != b"200":
        code = status.decode("ascii", "replace") if marker else "unknown"
        raise RuntimeError(f"Unexpected HTTP status: {code}; check the session")
    return body


def check_authorized(html):
    match = re.search(r"gon\.user\s*=\s*", html)
    if not match:
        raise RuntimeError("Cannot verify authorization from the cart page")
    try:
        user, _ = json.JSONDecoder().raw_decode(html[match.end():])
    except ValueError:
        raise RuntimeError("Unexpected authorization data format") from None
    if not isinstance(user, dict) or user.get("is_authorized") is not True:
        raise RuntimeError("Session is not authorized; refusing to treat this as an empty cart")


def kopecks(value):
    if isinstance(value, bool) or value is None:
        raise ValueError("Missing or invalid price")
    result = Decimal(str(value)) * 100
    if not result.is_finite() or result < 0 or result != result.to_integral_value():
        raise ValueError("Invalid price")
    return int(result)


def summarize(data):
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError("Unexpected cart response; no empty snapshot will be saved")
    items = []
    for item in data["items"]:
        product = item["product"]
        sku = str(product["sku"])
        if not sku or not isinstance(product.get("can_buy"), bool):
            raise ValueError("Missing SKU or availability")
        url = urljoin(ORIGIN, product["href"])
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "randewoo.ru" or not parsed.path.startswith("/product/"):
            raise ValueError("Unexpected product URL")
        is_target = bool(VOLUME_PATTERN.search(product.get("subtitle", "")))
        items.append({
            "sku": sku,
            "brand": product["brand_title"],
            "name": product["title"],
            "variant": product["subtitle"],
            "url": url,
            "quantity": item["count"],
            "matches_target_volume": is_target,
            "price_kopecks": kopecks(product.get("price")),
            "original_price_kopecks": kopecks(product.get("price_original")),
            "in_stock": product["can_buy"],
        })
    return {
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "list": "cart",
        "authorized": True,
        "price_context": "authorized_cart_product_price",
        "currency": "RUB",
        "target_volume_ml": "1.5",
        "item_count": len(items),
        "matching_volume_count": sum(item["matches_target_volume"] for item in items),
        "items": items,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", type=Path, default=ROOT / ".secrets/randewoo-session.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        session = json.loads(args.session.read_text(encoding="utf-8"))
        if not session.get("cookie") or not session.get("user_agent"):
            raise ValueError("Session cookie or user agent is missing")
        page = get("/cart", session, "text/html").decode("utf-8")
        check_authorized(page)
        raw = get("/front_api/cart/new_cart", session, "application/json")
        result = summarize(json.loads(raw))
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.TimeoutExpired):
        # Do not print response bodies, session values, or exception payloads.
        parser.exit(1, "Cart check failed; verify the session, connection, and response format. No snapshot saved.\n")
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in [
        "checked_at_utc", "authorized", "item_count", "matching_volume_count",
    ]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
