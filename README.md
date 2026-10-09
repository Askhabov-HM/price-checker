# Price Checker

Repository: [Askhabov-HM/price-checker](https://github.com/Askhabov-HM/price-checker).

Prototype scripts for tracking Randewoo perfume prices, initially for 1.5 ml
variants. Price collection uses ordinary HTTP requests and does not require AI.

## Requirements

- Python 3.10 or newer.
- `curl` available on PATH. On Windows the scripts use `curl.exe`.

Only the Python standard library is used; no Python packages need installing.

## Public product price

```powershell
python scripts/probe_randewoo.py --output scratch/icon-first-observation.json
```

An optional positional argument selects another Randewoo product URL. The script
requires exactly one 1.5 ml offer and records its SKU, price, and availability.
Prices are stored as integer kopecks.

## Authorized cart

Create `.secrets/randewoo-session.json` locally with the following structure,
replacing the placeholders with values from your own Randewoo session:

```json
{
  "cookie": "<Cookie request header>",
  "user_agent": "<User-Agent request header>"
}
```

Then run:

```powershell
python scripts/probe_randewoo_cart.py --output scratch/cart-first-observation.json
```

The script verifies that the session is authorized and reads the cart without
modifying its contents. It records the cart variants and flags those matching
1.5 ml. An unauthorized response or unexpected format causes a failure instead
of an empty snapshot. Cart prices and public product prices are recorded with
different price contexts.

Session credentials are passed to curl through stdin and are not printed.
The `.secrets/` and `scratch/` directories are excluded from Git. Authentication
may expire; automatic session refresh is not implemented.

## Planned application

- Run on a server and check prices four times daily on a configurable schedule.
- Keep favorites, cart, and manually tracked items as lists sharing products,
  variants, and price history.
- Store observations in a database and display tables and price charts.

The current repository contains feasibility probes. Favorites import, a
scheduler, a database, a web interface, and server deployment are not implemented.
