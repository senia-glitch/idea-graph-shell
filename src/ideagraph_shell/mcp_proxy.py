"""MCP-сервер, который агент запускает сам: тонкий мост к работающей оболочке.

Говорит с агентом по стандартному вводу-выводу (JSON-RPC, по сообщению в строке) и
пересылает вызовы инструментов оболочке по HTTP. Список инструментов тоже даёт оболочка:
у пакета-скилла и у решателя он разный.

Адрес и ключ приходят в переменных окружения ``IDEAGRAPH_URL`` и ``IDEAGRAPH_TOKEN``.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

PROTOCOL = "2024-11-05"


def _call(path: str, payload: dict | None = None) -> dict:
    url = os.environ.get("IDEAGRAPH_URL", "").rstrip("/") + path
    data = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "X-Ideagraph-Token": os.environ.get("IDEAGRAPH_TOKEN", "")},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 — локальный адрес оболочки
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read().decode("utf-8"))
        except ValueError:
            return {"error": "http", "message": f"Оболочка ответила {error.code}"}
    except (OSError, ValueError) as error:
        return {"error": "unreachable", "message": f"Оболочка недоступна: {error}"}


def handle(message: dict) -> dict | None:
    method = message.get("method")
    ident = message.get("id")
    if ident is None:                      # уведомление — ответа не ждут
        return None
    if method == "initialize":
        version = (message.get("params") or {}).get("protocolVersion") or PROTOCOL
        result = {"protocolVersion": version, "capabilities": {"tools": {}},
                  "serverInfo": {"name": "ideagraph", "version": "0.1.0"}}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": _call("/agent/tools").get("tools", [])}
    elif method == "tools/call":
        params = message.get("params") or {}
        answer = _call("/agent/call", {"tool": params.get("name"), "args": params.get("arguments") or {}})
        failed = "error" in answer
        text = answer.get("message") if failed else answer.get("text", "")
        result = {"content": [{"type": "text", "text": str(text)}], "isError": failed}
    else:
        return {"jsonrpc": "2.0", "id": ident,
                "error": {"code": -32601, "message": f"Метод не поддерживается: {method}"}}
    return {"jsonrpc": "2.0", "id": ident, "result": result}


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        answer = handle(message) if isinstance(message, dict) else None
        if answer is not None:
            sys.stdout.write(json.dumps(answer, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
