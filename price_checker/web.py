"""Loopback-only HTTP interface; no framework or external frontend CDN."""

import csv
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import secrets
from urllib.parse import parse_qs, urlsplit

from .client import FetchError
from .database import CONTEXTS, LISTS


def make_server(tracker, port=8000):
    static = Path(__file__).parent / "static"
    csrf = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never put request data or credentials in access logs.

        def send(self, status, body, content_type="application/json; charset=utf-8", headers=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            elif isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://*.randewoo.ru; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def valid_host(self):
            return self.headers.get("Host") in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

        def do_GET(self):
            if not self.valid_host():
                return self.send(403, {"error": "Недопустимый адрес приложения"})
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query)
            section = query.get("list", ["cart"])[0]
            context = query.get("context", ["public"])[0]
            try:
                if parsed.path == "/api/status":
                    result = tracker.status()
                    result["csrf_token"] = csrf
                    return self.send(200, result)
                if parsed.path == "/api/dashboard":
                    rows = tracker.db.rows(section, context)
                    counts = {key: len(tracker.db.rows(key)) for key in LISTS}
                    return self.send(200, {"items": rows, "counts": counts, "list": section, "context": context,
                                           "history": tracker.db.list_history(section, context), "status": tracker.status()})
                if parsed.path.startswith("/api/product/"):
                    variant_id = int(parsed.path.rsplit("/", 1)[1])
                    days = int(query.get("days", ["30"])[0])
                    if days not in (0, 7, 30, 90, 365):
                        raise ValueError("Неизвестный период")
                    return self.send(200, tracker.db.detail(variant_id, context, days))
                if parsed.path == "/api/export":
                    rows = tracker.db.rows(section, context)
                    output = io.StringIO(newline="")
                    writer = csv.writer(output, delimiter=";")
                    writer.writerow(["Бренд", "Товар", "Вариант", "Артикул", "Цена, руб.", "Изменение, руб.", "Наличие", "Проверено UTC", "Тип цены", "Ссылка"])
                    def cell(value):
                        value = str(value or "")
                        return "'" + value if value.startswith(("=", "+", "-", "@")) else value
                    for row in rows:
                        writer.writerow([cell(row["brand"]), cell(row["name"]), cell(row["label"]), cell(row["sku"]),
                                         str(row["price"] / 100).replace(".", ",") if row["price"] is not None else "",
                                         str(row["delta"] / 100).replace(".", ",") if row["delta"] is not None else "",
                                         "Да" if row["in_stock"] else "Нет", row["checked_at"], CONTEXTS[context], row["url"]])
                    return self.send(200, b"\xef\xbb\xbf" + output.getvalue().encode("utf-8"), "text/csv; charset=utf-8",
                                     {"Content-Disposition": f'attachment; filename="prices-{section}-{context}.csv"'})
                files = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                         "/styles.css": ("styles.css", "text/css; charset=utf-8"), "/favicon.ico": (None, "image/x-icon")}
                if parsed.path in files:
                    filename, content_type = files[parsed.path]
                    return self.send(200 if filename else 204, (static / filename).read_bytes() if filename else b"", content_type)
                return self.send(404, {"error": "Страница не найдена"})
            except (ValueError, KeyError):
                return self.send(400, {"error": "Некорректный список, товар или период"})
            except Exception:
                return self.send(500, {"error": "Не удалось прочитать данные приложения"})

        def do_POST(self):
            origin = self.headers.get("Origin")
            allowed_origins = (f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}")
            if not self.valid_host() or (origin and origin not in allowed_origins) or self.headers.get("X-CSRF-Token") != csrf:
                return self.send(403, {"error": "Обновите страницу приложения и повторите действие"})
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                return self.send(415, {"error": "Ожидается JSON"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 100000:
                    raise ValueError("Некорректный размер запроса")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("Некорректный запрос")
                path = urlsplit(self.path).path
                if path == "/api/refresh":
                    if not tracker.start_refresh():
                        return self.send(409, {"error": "Проверка уже выполняется"})
                    return self.send(202, {"started": True})
                if path == "/api/watch":
                    if not isinstance(data.get("active"), bool):
                        raise ValueError("Некорректное действие")
                    tracker.db.watch(int(data["id"]), data["active"])
                    return self.send(200, {"ok": True})
                if path == "/api/watch/add":
                    return self.send(200, {"id": tracker.add_url(data.get("url", ""))})
                if path == "/api/settings":
                    tracker.save_settings(data)
                    return self.send(200, {"ok": True})
                if path == "/api/session":
                    tracker.save_session(data)
                    return self.send(200, {"ok": True})
                return self.send(404, {"error": "Действие не найдено"})
            except (ValueError, KeyError, TypeError) as exc:
                # Validation messages are ours; JSON parser payloads are not echoed.
                message = str(exc) if isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError) else "Некорректные параметры запроса"
                return self.send(400, {"error": message})
            except FetchError as exc:
                return self.send(502, {"error": str(exc)})
            except Exception:
                return self.send(500, {"error": "Не удалось выполнить действие"})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server
