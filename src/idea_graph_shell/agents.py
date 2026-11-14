"""Запуск агентов: один ход — один запуск командной строки агента с продолжением сессии.

Оболочка — единственная, кто запускает агентов. Она даёт агенту только свои инструменты
(через MCP-сервер ``idea_graph_shell.mcp_proxy``) и текст скилла как системную инструкцию.
Файлы, терминал и остальное агенту закрыто; веб-поиск открывается, если пакет заявил его.

Способ запуска спрятан за адаптером: постоянно живущий процесс можно будет добавить,
не трогая остальную оболочку.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

OPENCODE_PROVIDER = "opencode-go"        # модели подписки OpenCode Go / Go Plus
_MODELS_TTL = 600
SERVER_NAME = "idea-graph"
TURN_TIMEOUT = 900
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

CLAUDE_MODELS = [
    {"id": "", "name": "по умолчанию"},
    {"id": "opus", "name": "Opus — сильная"},
    {"id": "sonnet", "name": "Sonnet — средняя"},
    {"id": "haiku", "name": "Haiku — лёгкая"},
    {"id": "fable", "name": "Fable — самая сильная"},
]
CLAUDE_EFFORTS = ["", "low", "medium", "high", "xhigh", "max"]
# Встроенные инструменты OpenCode, которые агенту не нужны.
OPENCODE_BUILTINS = ["bash", "edit", "write", "read", "grep", "glob", "list", "patch", "task",
                     "todowrite", "todoread", "skill", "lsp"]


@dataclass
class TurnResult:
    session_id: str = ""
    error: str = ""
    text: str = ""
    cost: float = 0.0


@dataclass
class TurnRequest:
    workdir: Path                 # своя папка агента внутри .idea-graph: там нет чужих инструкций
    system_text: str              # скилл пакета + общие правила оболочки
    note: str                     # вводные этого хода
    env: dict                     # адрес и ключ оболочки для MCP-сервера
    session_id: str = ""
    model: str = ""
    effort: str = ""
    web_search: bool = False
    on_process: object = None     # вызывается с запущенным процессом, чтобы его можно было остановить
    extra: dict = field(default_factory=dict)


def _json_lines(text: str):
    for line in (text or "").splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            with contextlib.suppress(ValueError):
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    yield parsed


def _server_command() -> list[str]:
    return [sys.executable, "-m", "idea_graph_shell.mcp_proxy"]


def _execute(argv: list[str], request: TurnRequest, stdin_text: str | None, env: dict,
             fatal: re.Pattern | None = None) -> tuple[str, str, int]:
    """Запустить агента и дождаться конца хода.

    ``fatal`` — признак неустранимой ошибки в выводе (нет денег, лимит): некоторые агенты после
    неё молча ждут, поэтому процесс останавливаем сами, не дожидаясь общего предела времени.
    """
    request.workdir.mkdir(parents=True, exist_ok=True)
    full_env = {**os.environ, **env, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    full_env.pop("CLAUDECODE", None)          # оболочку могли запустить из сессии Claude Code
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.Popen(  # noqa: S603 — команда собрана оболочкой, без пользовательского ввода
        argv, cwd=str(request.workdir), env=full_env,
        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags,
    )
    if callable(request.on_process):
        request.on_process(proc)
    chunks: dict[str, list[str]] = {"out": [], "err": []}
    stopped = threading.Event()

    def pump(stream, key):
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", "replace")
            chunks[key].append(line)
            if fatal is not None and fatal.search(_ANSI.sub("", line)) and not stopped.is_set():
                stopped.set()
                threading.Timer(2.0, proc.kill).start()      # даём дописать сообщение и останавливаем
        stream.close()

    readers = [threading.Thread(target=pump, args=(proc.stdout, "out"), daemon=True),
               threading.Thread(target=pump, args=(proc.stderr, "err"), daemon=True)]
    for reader in readers:
        reader.start()
    if stdin_text is not None:
        try:
            proc.stdin.write(stdin_text.encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass
    timed_out = False
    try:
        proc.wait(timeout=TURN_TIMEOUT)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        proc.wait()
    for reader in readers:
        reader.join(timeout=5)
    out, err = "".join(chunks["out"]), "".join(chunks["err"])
    if timed_out:
        return out, f"Ход длился дольше {TURN_TIMEOUT} с и был остановлен", -1
    return out, err, proc.returncode


class Adapter:
    name = ""
    label = ""
    exe = ""

    def found(self) -> str:
        return shutil.which(self.exe) or ""

    def version(self) -> str:
        exe = self.found()
        if not exe:
            return ""
        try:
            done = subprocess.run(  # noqa: S603
                [exe, "--version"], capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=30, stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return (done.stdout or done.stderr or "").strip().splitlines()[0][:80] if (done.stdout or done.stderr) else ""

    def models(self) -> list[dict]:
        return []

    def efforts(self) -> list[str]:
        return [""]

    def run(self, request: TurnRequest) -> TurnResult:
        raise NotImplementedError


class ClaudeAdapter(Adapter):
    name = "claude"
    label = "Claude Code"
    exe = "claude"

    def models(self):
        return list(CLAUDE_MODELS)

    def efforts(self):
        return list(CLAUDE_EFFORTS)

    def run(self, request):
        exe = self.found()
        if not exe:
            return TurnResult(error="Команда claude не найдена. Установите Claude Code и войдите в него.")
        work = request.workdir
        work.mkdir(parents=True, exist_ok=True)
        system = work / "system.md"
        system.write_text(request.system_text, encoding="utf-8")
        mcp = work / "mcp.json"
        command = _server_command()
        mcp.write_text(json.dumps({"mcpServers": {SERVER_NAME: {
            "command": command[0], "args": command[1:], "env": request.env}}}, ensure_ascii=False), encoding="utf-8")
        web = ["WebSearch", "WebFetch"] if request.web_search else []
        argv = [
            exe, "-p", "--output-format", "json",
            "--mcp-config", str(mcp), "--strict-mcp-config",
            "--tools", ",".join(web),
            "--allowedTools", f"mcp__{SERVER_NAME}", *web,
            "--system-prompt-file", str(system),
            "--disable-slash-commands",
        ]
        if request.model:
            argv += ["--model", request.model]
        if request.effort:
            argv += ["--effort", request.effort]
        if request.session_id:
            argv += ["--resume", request.session_id]
        out, err, code = _execute(argv, request, request.note, {})
        found: dict = {}
        for parsed in _json_lines(out):
            found = parsed
        result = TurnResult(
            session_id=found.get("session_id") if isinstance(found.get("session_id"), str) else "",
            text=found.get("result") if isinstance(found.get("result"), str) else "",
            cost=float(found.get("total_cost_usd") or 0),
        )
        if found.get("is_error") or (code != 0 and not found):
            result.error = (result.text or _ANSI.sub("", err).strip() or f"claude завершился с кодом {code}")[:1500]
            result.text = ""
        return result


class OpenCodeAdapter(Adapter):
    name = "opencode"
    label = "OpenCode"
    exe = "opencode"
    # Вводные хода агент забирает инструментом: длинный текст с переводами строк нельзя
    # надёжно передать аргументом через opencode.cmd в Windows.
    PROMPT = "New turn. Call the idea-graph tool turn_info and do exactly what it returns."

    def models(self):
        """Модели подписки Go (провайдер ``opencode-go``) и усилия, которые каждая из них поддерживает.

        Усилие в OpenCode — «вариант» модели (``--variant``): у каждой модели свой набор, у части его нет совсем.
        """
        now = time.time()
        cached = getattr(self, "_models_cache", None)
        if cached and now - cached[0] < _MODELS_TTL:
            return [dict(m) for m in cached[1]]
        exe = self.found()
        if not exe:
            return []
        models = self._verbose_models(exe) or self._plain_models(exe)
        if models:
            self._models_cache = (now, models)
        return [dict(m) for m in models]

    @staticmethod
    def _list(exe: str, *args: str) -> str:
        try:
            done = subprocess.run(  # noqa: S603
                [exe, "models", OPENCODE_PROVIDER, *args], capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=90, stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return _ANSI.sub("", done.stdout or "")

    def _verbose_models(self, exe: str) -> list[dict]:
        text = self._list(exe, "--verbose")
        decoder = json.JSONDecoder()
        models, pos = [], 0
        while True:
            found = re.compile(rf"^({re.escape(OPENCODE_PROVIDER)}/\S+)[ \t]*\r?\n", re.M).search(text, pos)
            if not found:
                break
            try:
                data, end = decoder.raw_decode(text, found.end())
            except ValueError:
                break
            pos = end
            if not isinstance(data, dict) or data.get("status", "active") != "active":
                continue
            # Веб-поиск OpenCode даёт провайдеру opencode-go целиком, а вызвать его (и наши инструменты) может
            # только модель с вызовом инструментов: остальные исследователю и агенту не подходят.
            if (data.get("capabilities") or {}).get("toolcall") is False:
                continue
            variants = [v for v in (data.get("variants") or {}) if isinstance(v, str)]
            title = str(data.get("name") or found.group(1).split("/", 1)[1])
            models.append({"id": found.group(1), "name": f"{title} ({found.group(1).split('/', 1)[1]})",
                           "efforts": variants})
        return models

    def _plain_models(self, exe: str) -> list[dict]:
        names = [line.strip() for line in self._list(exe).splitlines()]
        return [{"id": n, "name": n, "efforts": []} for n in names
                if re.fullmatch(rf"{re.escape(OPENCODE_PROVIDER)}/[\w.:@+/-]+", n)]

    def run(self, request):
        exe = self.found()
        if not exe:
            return TurnResult(error="Команда opencode не найдена. Установите OpenCode и войдите в провайдера.")
        work = request.workdir
        work.mkdir(parents=True, exist_ok=True)
        system = work / "system.md"
        system.write_text(request.system_text, encoding="utf-8")
        tools = {name: False for name in OPENCODE_BUILTINS}
        tools["webfetch"] = bool(request.web_search)
        tools["websearch"] = bool(request.web_search)
        config = {
            "$schema": "https://opencode.ai/config.json",
            "share": "disabled",
            "autoupdate": False,
            "instructions": [str(system)],
            "mcp": {SERVER_NAME: {"type": "local", "command": _server_command(),
                                  "environment": request.env, "enabled": True}},
            "tools": tools,
            "permission": {"edit": "deny", "bash": "deny",
                           "webfetch": "allow" if request.web_search else "deny"},
        }
        if request.model:
            config["small_model"] = request.model
        path = work / "opencode.json"
        path.write_text(json.dumps(config, ensure_ascii=False, indent=1), encoding="utf-8")
        argv = [exe, "run", self.PROMPT, "--format", "json", "--print-logs", "--log-level", "ERROR"]
        if request.model:
            argv += ["--model", request.model]
        if request.effort:
            argv += ["--variant", request.effort]
        if request.session_id:
            argv += ["--session", request.session_id]
        out, err, code = _execute(argv, request, None, {"OPENCODE_CONFIG": str(path)},
                                  fatal=re.compile(r"level=ERROR.*error\.error="))
        result = TurnResult()
        texts = []
        for parsed in _json_lines(out):
            if not result.session_id and isinstance(parsed.get("sessionID"), str):
                result.session_id = parsed["sessionID"]
            part = parsed.get("part")
            if parsed.get("type") == "text" and isinstance(part, dict) and isinstance(part.get("text"), str):
                texts.append(part["text"])
            if parsed.get("type") == "error":
                detail = parsed.get("error")
                if isinstance(detail, dict):
                    data = detail.get("data")
                    detail = (data.get("message") if isinstance(data, dict) else "") or detail.get("name")
                result.error = str(detail or "ошибка OpenCode")[:1500]
        result.text = "\n".join(texts).strip()
        if not result.error:
            fatal = re.findall(r"level=ERROR.*?error\.error=(.+)$", _ANSI.sub("", out + "\n" + err), re.MULTILINE)
            if fatal:
                result.error = fatal[-1].strip().strip('"')[:1500]
            elif code != 0:
                result.error = (_ANSI.sub("", err).strip() or f"opencode завершился с кодом {code}")[:1500]
        return result


class Adapters:
    """Набор доступных агентов. Тесты подкладывают сюда своего «агента» без модели."""

    def __init__(self):
        self._items: dict[str, Adapter] = {a.name: a for a in (ClaudeAdapter(), OpenCodeAdapter())}
        self._lock = threading.Lock()

    def add(self, adapter: Adapter) -> None:
        with self._lock:
            self._items[adapter.name] = adapter

    def get(self, name: str) -> Adapter | None:
        return self._items.get(name)

    def names(self) -> list[str]:
        return list(self._items)

    def describe(self) -> list[dict]:
        out = []
        for adapter in self._items.values():
            exe = adapter.found()
            out.append({"id": adapter.name, "name": adapter.label, "found": bool(exe), "path": exe,
                        "efforts": adapter.efforts()})
        return out
