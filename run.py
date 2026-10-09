"""Start the local tracker: python run.py [--no-browser] [--once]."""

import argparse
import json
import os
from pathlib import Path
import threading
import webbrowser

from price_checker.service import Tracker
from price_checker.web import make_server
from price_checker.instance import AlreadyRunning, instance_lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--once", action="store_true", help="Получить актуальные данные и завершить работу")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Укажите порт от 1024 до 65535")
    root = Path(__file__).resolve().parent
    try:
        with instance_lock(root / ".data/app.lock"):
            return run(args, root)
    except AlreadyRunning:
        print("Приложение уже запущено. Откройте http://127.0.0.1:8000 или остановите предыдущий экземпляр.")
        return 1


def run(args, root):
    tracker = Tracker(root)
    if args.once:
        result = tracker.refresh_now("cli")
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get("errors") else 0
    try:
        server = make_server(tracker, args.port)
    except OSError:
        parser.exit(1, f"Порт {args.port} занят. Возможно, приложение уже открыто: http://127.0.0.1:{args.port}\n")
    url = f"http://127.0.0.1:{server.server_port}"
    pid_file = root / ".data/server.pid"
    pid_file.write_text(str(os.getpid()), encoding="ascii")
    tracker.start_scheduler()
    print(f"Price Checker: {url}\nРасписание: Москва. Для остановки нажмите Ctrl+C.", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        tracker.stop.set()
        server.server_close()
        pid_file.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
