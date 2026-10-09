"""Read the public price of a 1.5 ml variant; no login or AI required.

Run: python scripts/probe_randewoo.py
This is a feasibility probe, not a scheduler or an account integration.
"""

import argparse
from datetime import datetime, timezone
from decimal import Decimal
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import subprocess


class StructuredDataParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.capturing = False
        self.parts = []
        self.documents = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self.capturing = True
            self.parts = []

    def handle_data(self, data):
        if self.capturing:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.capturing:
            self.documents.append(json.loads("".join(self.parts)))
            self.capturing = False


def find_offers(value):
    if isinstance(value, dict):
        if value.get("@type") == "Offer":
            yield value
        for child in value.values():
            yield from find_offers(child)
    elif isinstance(value, list):
        for child in value:
            yield from find_offers(child)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", default="https://randewoo.ru/product/alfred-dunhill-icon")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.url.startswith("https://randewoo.ru/product/"):
        parser.error("Expected an HTTPS Randewoo product URL")

    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        parser.error("curl is required for this probe")
    response = subprocess.run(
        [curl, "--fail", "--silent", "--show-error", "--location", "--max-time", "30",
         "--user-agent", "PriceCheckerProbe/0.1", args.url],
        capture_output=True, check=True,
    )
    structured = StructuredDataParser()
    structured.feed(response.stdout.decode("utf-8"))
    matches = [offer for doc in structured.documents for offer in find_offers(doc)
               if re.search(r"(?<![\d.,])1[.,]5\s*(?:\u043c\u043b|ml)\b", offer.get("name", ""), re.I)]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one 1.5 ml offer, found {len(matches)}")
    offer = matches[0]
    if offer.get("priceCurrency") != "RUB" or not offer.get("sku"):
        raise ValueError("Missing SKU or unexpected currency")
    minor_units = Decimal(str(offer["price"])) * 100
    if minor_units <= 0 or minor_units != minor_units.to_integral_value():
        raise ValueError("Unexpected price")
    result = {
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "url": args.url,
        "name": offer["name"],
        "sku": str(offer["sku"]),
        "volume_ml": "1.5",
        "price_kopecks": int(minor_units),
        "currency": "RUB",
        "availability": offer.get("availability"),
        "price_context": "public_without_login",
        "source": "page_json_ld",
    }
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
