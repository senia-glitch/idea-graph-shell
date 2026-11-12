"""Команда ``idea-graph``: запустить оболочку и открыть её в браузере."""

from __future__ import annotations

import argparse
import sys
import webbrowser

from idea_graph_core import Store

from .server import App, make_server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="idea-graph",
        description="Оболочка графа идеи: холст, чат, настройки агентов и запуск пакетов.",
    )
    parser.add_argument("folder", nargs="?", help="папка идеи (можно выбрать позже в интерфейсе)")
    parser.add_argument("--port", type=int, default=8765, help="порт (по умолчанию 8765; 0 — любой свободный)")
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    parser.add_argument("--packages", action="store_true", help="показать установленные пакеты и выйти")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    app = App()
    if args.packages:
        for item in app.registry.public():
            print(f"{item['id']:<12} {item['kind']:<8} {item['name']} — {item['description']}")
        for error in app.registry.errors:
            print("ошибка пакета:", error)
        return 0
    try:
        server = make_server(app, args.port)
    except OSError as error:
        print(f"Порт {args.port} занят ({error}). Укажите другой: idea-graph --port 8770")
        return 2
    if args.folder:
        if Store.exists(args.folder):
            app.open(args.folder)
        else:
            print(f"В папке {args.folder} ещё нет идеи — создайте её в интерфейсе.")
    print(f"Оболочка запущена: {app.base_url}  (Ctrl+C — остановить)")
    if not args.no_browser:
        webbrowser.open(app.base_url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
