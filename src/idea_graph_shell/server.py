"""Локальный веб-сервер оболочки: интерфейс для человека и мост для инструментов агента.

Вся работа с агентами, графом и банком — в ``idea-graph-engine``; здесь только HTTP и статические файлы.

Слушает только 127.0.0.1. Запросы человека, которые что-то меняют, обязаны нести заголовок
``X-Idea-Graph`` (его не может поставить чужой сайт), запросы агента — ключ хода.
"""

from __future__ import annotations

import json
import mimetypes
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from idea_graph_core import GraphError, Store

from idea_graph_engine import Adapters, EngineError, Project, Settings
from idea_graph_engine.flow import STEPS

STATIC = Path(__file__).parent / "static"
MAX_BODY = 4_000_000


class App:
    """Одна запущенная оболочка: настройки и открытый проект."""

    def __init__(self, settings: Settings | None = None, adapters: Adapters | None = None):
        self.settings = settings or Settings()
        self.adapters = adapters or Adapters()
        self.project: Project | None = None
        self.base_url = ""
        self.lock = threading.Lock()

    # ---------------------------------------------------------------- проекты

    def open(self, folder: str) -> Project:
        path = Path(folder).expanduser()
        if not path.is_dir() or not Store.exists(path):
            raise EngineError("no_folder", f"В папке нет проекта: {path}")
        with self.lock:
            project = Project(path, self.settings, self.adapters)
            project.base_url = self.base_url
            self.project = project
        self.settings.remember(str(project.folder))
        return project

    def projects_root(self) -> Path:
        chosen = str(self.settings.data.get("projects_root") or "").strip()
        return Path(chosen).expanduser() if chosen else Path.home() / "Documents" / "Граф идеи"

    def projects(self) -> list[dict]:
        root = self.projects_root()
        found = []
        try:
            folders = sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name.lower())
        except OSError:
            return []
        for folder in folders:
            if Store.exists(folder):
                try:
                    title = Store.open(folder).title
                except GraphError:
                    continue
                found.append({"folder": str(folder), "name": folder.name, "title": title or folder.name})
        return found

    def create(self, title: str, parent: str = "") -> Project:
        title = title.strip()
        name = " ".join(re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", title).strip(" .").split())
        if not name:
            raise EngineError("invalid_input", "Введите название проекта")
        base = Path(parent).expanduser() if parent.strip() else self.projects_root()
        path = base / name
        if Store.exists(path):
            raise EngineError("already_exists", f"Проект «{name}» уже есть в папке {base}")
        path.mkdir(parents=True, exist_ok=True)
        Store.create(path, title)
        return self.open(str(path))

    def need(self) -> Project:
        if self.project is None:
            raise EngineError("no_project", "Сначала откройте или создайте проект")
        return self.project

    # ---------------------------------------------------------------- ответы на запросы

    def agents(self) -> dict:
        items = self.adapters.describe()
        for item in items:
            adapter = self.adapters.get(item["id"])
            item["models"] = adapter.models() if item["found"] else []
        return {"agents": items}

    def boot(self) -> dict:
        return {"project": self.project.state() if self.project else None, "steps": STEPS, "settings": self.settings.data,
                "projects_root": str(self.projects_root()), "projects": self.projects()}

    def get(self, path: str, query: dict) -> dict:
        if path == "/api/boot":
            return self.boot()
        if path == "/api/state":
            return self.need().state()
        if path == "/api/graph":
            return self.need().graph()
        if path == "/api/bank":
            return {"records": self.need().records()}
        if path == "/api/agents":
            return self.agents()
        raise EngineError("not_found", "Нет такого адреса")

    def post(self, path: str, data: dict) -> dict:
        if path == "/api/project/open":
            return self.open(str(data.get("folder") or "")).state()
        if path == "/api/project/create":
            return self.create(str(data.get("title") or ""), str(data.get("parent") or "")).state()
        if path == "/api/settings":
            return {"settings": self.settings.update(data)}
        if path == "/api/agents/check":
            adapter = self.adapters.get(str(data.get("agent") or ""))
            if adapter is None:
                raise EngineError("invalid_input", "Нет такого агента")
            return {"found": bool(adapter.found()), "version": adapter.version(), "path": adapter.found()}
        project = self.need()
        if path == "/api/act":
            return project.act(str(data.get("action") or ""), data)
        if path == "/api/start":
            ids = data.get("ids")
            return project.start(str(data.get("kind") or ""), ids if isinstance(ids, list) else None, bool(data.get("redo")))
        if path == "/api/stop":
            return project.stop()
        if path == "/api/answer":
            choice = data.get("choice")
            return project.answer(str(data.get("question") or ""), choice if isinstance(choice, dict) else {})
        if path == "/api/layout":
            project.store.save_layout(data)
            return {"ok": True}
        raise EngineError("not_found", "Нет такого адреса")

    def agent_call(self, token: str, path: str, data: dict) -> dict:
        project = self.need()
        if path == "/agent/tools":
            return {"tools": project.tools_for(token)}
        return {"text": project.tool_call(token, str(data.get("tool") or ""), data.get("args") or {})}


class Handler(BaseHTTPRequestHandler):
    app: App
    server_version = "idea-graph"

    def log_message(self, *_args):   # тишина в консоли
        return

    def _send(self, code: int, body: bytes, kind: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data: dict, code: int = 200) -> None:
        self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _local(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost", "[::1]")

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise EngineError("too_large", "Слишком большой запрос")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            raise EngineError("invalid_input", "Ожидался JSON") from None
        if not isinstance(data, dict):
            raise EngineError("invalid_input", "Ожидался объект JSON")
        return data

    def _drain(self) -> None:
        """Дочитать тело отклонённого запроса, иначе клиент увидит обрыв связи вместо ответа."""
        left = min(int(self.headers.get("Content-Length") or 0), MAX_BODY)
        while left > 0:
            chunk = self.rfile.read(min(left, 65536))
            if not chunk:
                break
            left -= len(chunk)

    def _run(self, work) -> None:
        try:
            self._json(work())
        except (EngineError, GraphError) as error:
            self._json(error.as_dict(), 400)
        except Exception as error:  # noqa: BLE001
            self._json({"error": "internal", "message": f"Внутренняя ошибка: {error}"}, 500)

    def _static(self, rest: str) -> None:
        target = (STATIC / rest).resolve()
        if not str(target).startswith(str(STATIC.resolve())) or not target.is_file():
            self._send(404, b"not found", "text/plain")
            return
        kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js":
            kind = "text/javascript"
        if kind.startswith("text/") or kind.endswith("javascript"):
            kind += "; charset=utf-8"
        self._send(200, target.read_bytes(), kind)

    def do_GET(self):  # noqa: N802
        if not self._local():
            return self._send(403, b"forbidden", "text/plain")
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self._run(lambda: self.app.get(url.path, parse_qs(url.query)))
        return self._static("index.html" if url.path in ("/", "") else url.path.lstrip("/"))

    def do_POST(self):  # noqa: N802
        if not self._local():
            return self._send(403, b"forbidden", "text/plain")
        path = urlparse(self.path).path
        if path.startswith("/agent/"):
            token = self.headers.get("X-Idea-Graph-Token") or ""
            return self._run(lambda: self.app.agent_call(token, path, self._body()))
        if self.headers.get("X-Idea-Graph") != "1":
            self._drain()
            return self._json({"error": "forbidden", "message": "Запрос не из интерфейса оболочки"}, 403)
        return self._run(lambda: self.app.post(path, self._body()))


def make_server(app: App, port: int = 0) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"app": app})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    app.base_url = f"http://127.0.0.1:{server.server_address[1]}"
    if app.project is not None:
        app.project.base_url = app.base_url
    return server
