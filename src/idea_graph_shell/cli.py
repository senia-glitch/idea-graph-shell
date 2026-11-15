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
        description="Граф идеи: от сферы бизнеса к проблемам для автоматизации и решению.",
    )
    parser.add_argument("folder", nargs="?", help="папка проекта (если не указана — откроется экран проектов)")
    parser.add_argument("--port", type=int, default=8765, help="порт (по умолчанию 8765; 0 — любой свободный)")
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    app = App()
    try:
        server = make_server(app, args.port)
    except OSError as error:
        print(f"Порт {args.port} занят ({error}). Укажите другой: idea-graph --port 8770")
        return 2
    if args.folder:
        if Store.exists(args.folder):
            app.open(args.folder)
        else:
            print(f"В папке {args.folder} ещё нет проекта — создайте его в интерфейсе.")

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
