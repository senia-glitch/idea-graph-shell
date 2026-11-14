"""Локальный веб-сервер оболочки: интерфейс для человека и мост для инструментов агента.

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

from idea_graph_core import GraphError, Store, author_name, views

from .agents import Adapters
from .config import Settings
from . import resources
from .packages import Registry
from .runtime import Project, ShellError

STATIC = Path(__file__).parent / "static"
MAX_BODY = 4_000_000


class App:
    """Одна запущенная оболочка: настройки, пакеты и открытая идея."""

    def __init__(self, settings: Settings | None = None, registry: Registry | None = None,
                 adapters: Adapters | None = None):
        self.settings = settings or Settings()
        self.registry = registry or Registry()
        self.adapters = adapters or Adapters()
        self.project: Project | None = None
        self.base_url = ""
        self.lock = threading.Lock()

    # ---------------------------------------------------------------- проекты

    def open(self, folder: str) -> Project:
        path = Path(folder).expanduser()
        if not path.is_dir():
            raise ShellError("no_folder", f"Папки нет: {path}")
        with self.lock:
            project = Project(path, self.settings, self.registry, self.adapters)
            project.base_url = self.base_url
            self.project = project
        self.settings.remember(str(project.folder))
        return project

    def projects_root(self) -> Path:
        """Корневая папка проектов из настроек; по умолчанию «Документы\\Граф идеи»."""
        chosen = str(self.settings.data.get("projects_root") or "").strip()
        return Path(chosen).expanduser() if chosen else Path.home() / "Documents" / "Граф идеи"

    def projects(self) -> list[dict]:
        """Проекты в корневой папке: её подпапки, где есть граф."""
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
        """Новый проект: подпапка с именем проекта в корневой папке (или в указанной)."""
        title = title.strip()
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", title).strip(" .")
        name = " ".join(name.split())
        if not name:
            raise ShellError("invalid_input", "Введите название проекта")
        base = Path(parent).expanduser() if parent.strip() else self.projects_root()
        path = base / name
        if Store.exists(path):
            raise ShellError("already_exists", f"Проект «{name}» уже есть в папке {base}")
        path.mkdir(parents=True, exist_ok=True)
        Store.create(path, title)
        return self.open(str(path))

    def need(self) -> Project:
        if self.project is None:
            raise ShellError("no_project", "Сначала откройте или создайте проект")
        return self.project

    # ---------------------------------------------------------------- ответы на запросы

    def history(self) -> dict:
        project = self.need()
        store = project.store
        undone = store.undone_revisions()
        entries = []
        for entry in reversed(store.journal()[-300:]):
            lines = []
            for change in entry["changes"]:
                before, after = change["before"], change["after"]
                if change["type"] == "card":
                    lines.append(views._card_change(before, after))
                elif before is None:
                    lines.append(f"добавлена связь {after['from']} —{after['kind']}→ {after['to']}")
                elif after is None:
                    lines.append(f"удалена связь {before['from']} —{before['kind']}→ {before['to']}")
                else:
                    lines.append(f"изменена связь {after['id']}: {after['from']} —{after['kind']}→ {after['to']}")
            entries.append({"rev": entry["rev"], "ts": entry["ts"], "author": entry["author"],
                            "author_name": author_name(entry["author"]), "note": entry.get("note", ""),
                            "lines": lines, "undone": entry["rev"] in undone,
                            "undo_of": entry.get("undo_of")})
        deleted = [{"id": d["card"]["id"], "kind": d["card"]["kind"], "title": d["card"]["title"],
                    "body": d["card"].get("body", ""), "rev": d["rev"], "ts": d["ts"],
                    "author_name": author_name(d["author"])} for d in store.deleted_cards()]
        return {"entries": entries, "deleted": deleted}

    def agents(self) -> dict:
        items = self.adapters.describe()
        for item in items:
            adapter = self.adapters.get(item["id"])
            item["models"] = adapter.models() if item["found"] else []
        return {"agents": items}

    def boot(self) -> dict:
        return {
            "project": self.project.state() if self.project else None,
            "packages": self.registry.public(),
            "package_errors": self.registry.errors,
            "settings": self.settings.data,
            "projects_root": str(self.projects_root()),
            "projects": self.projects(),
            "views": [{"id": m["id"], "tab": m.get("tab") or m["name"]} for m in self.registry.items.values()
                      if m["kind"] == "view"],
        }

    def get(self, path: str, query: dict) -> dict:
        if path == "/api/boot":
            return self.boot()
        if path == "/api/state":
            project = self.need()
            return project.state(int(query.get("chat", ["0"])[0] or 0))
        if path == "/api/graph":
            project = self.need()
            return {**project.store.snapshot(), "layout": project.store.layout()}
        if path == "/api/history":
            return self.history()
        if path == "/api/agents":
            return self.agents()
        if path == "/api/resources":
            return {"items": resources.load(self.need().dir)["items"]}
        if path == "/api/card-history":
            project = self.need()
            return {"items": project.store.card_history(query.get("id", [""])[0])}
        raise ShellError("not_found", "Нет такого адреса")

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
                raise ShellError("invalid_input", "Нет такого агента")
            version = adapter.version()
            return {"found": bool(adapter.found()), "version": version, "path": adapter.found()}
        project = self.need()
        if path == "/api/resources/add":
            try:
                return {"item": resources.add(project.dir, str(data.get("value") or ""))}
            except resources.ResourceError as error:
                raise ShellError("bad_resource", str(error)) from None
        if path == "/api/resources/remove":
            try:
                resources.remove(project.dir, str(data.get("id") or ""))
            except resources.ResourceError as error:
                raise ShellError("bad_resource", str(error)) from None
            return {"ok": True}
        if path == "/api/ops":
            return project.human_ops(data.get("ops"), str(data.get("note") or ""))
        if path == "/api/layout":
            project.store.save_layout(data)
            return {"ok": True}
        if path == "/api/undo":
            return project.undo(data.get("rev"))
        if path == "/api/run/start":
            auto = data.get("auto")
            return project.start(str(data.get("package") or ""), bool(data.get("fresh")),
                                 auto=auto if isinstance(auto, dict) else None)
        if path == "/api/run/stop":
            return project.stop(str(data.get("package") or ""))
        if path == "/api/run/resume":
            return project.resume(str(data.get("package") or ""))
        if path == "/api/run/answer":
            return project.answer(str(data.get("package") or ""), str(data.get("question") or ""),
                                  data.get("choice") or {})
        if path == "/api/run/message":
            return project.message(str(data.get("package") or ""), str(data.get("text") or ""))
        if path == "/api/run/answerer":
            project.set_answerer(str(data.get("package") or ""), str(data.get("answerer") or ""))
            return {"ok": True}
        raise ShellError("not_found", "Нет такого адреса")

    def view_call(self, package_id: str, method: str, rest: str, data: dict) -> dict:
        manifest = self.registry.get(package_id)
        if manifest is None or not callable(manifest.get("api")):
            raise ShellError("not_found", "У пакета нет своего экрана")
        return manifest["api"](self, method, rest, data)

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
            raise ShellError("too_large", "Слишком большой запрос")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            raise ShellError("invalid_input", "Ожидался JSON") from None
        if not isinstance(data, dict):
            raise ShellError("invalid_input", "Ожидался объект JSON")
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
        except (ShellError, GraphError) as error:
            self._json(error.as_dict(), 409 if getattr(error, "code", "") == "human_changed" else 400)
        except Exception as error:  # noqa: BLE001
            if callable(getattr(error, "as_dict", None)):      # ошибка пакета, понятная человеку
                self._json(error.as_dict(), 400)
            else:
                self._json({"error": "internal", "message": f"Внутренняя ошибка: {error}"}, 500)

    def _static(self, root: Path, rest: str) -> None:
        target = (root / rest).resolve()
        if not str(target).startswith(str(root.resolve())) or not target.is_file():
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
        path = url.path
        if path.startswith("/api/"):
            return self._run(lambda: self.app.get(path, parse_qs(url.query)))
        if path.startswith("/pkg/"):
            _, _, package_id, kind, *rest = path.split("/") + [""]
            manifest = self.app.registry.get(package_id)
            if kind == "static" and manifest and manifest.get("static"):
                return self._static(Path(manifest["static"]), "/".join(p for p in rest if p))
            if kind == "api":
                return self._run(lambda: self.app.view_call(package_id, "GET", "/".join(p for p in rest if p), {}))
            return self._send(404, b"not found", "text/plain")
        return self._static(STATIC, "index.html" if path in ("/", "") else path.lstrip("/"))

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
        if path.startswith("/pkg/"):
            _, _, package_id, kind, *rest = path.split("/") + [""]
            return self._run(lambda: self.app.view_call(package_id, "POST", "/".join(p for p in rest if p), self._body()))
        return self._run(lambda: self.app.post(path, self._body()))


def make_server(app: App, port: int = 0) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"app": app})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    app.base_url = f"http://127.0.0.1:{server.server_address[1]}"
    if app.project is not None:
        app.project.base_url = app.base_url
    return server
