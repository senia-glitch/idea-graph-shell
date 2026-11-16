"""HTTP-слой: то, чем пользуются интерфейс и настоящий агент (через MCP-мост)."""

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from idea_graph_engine import Adapters, Settings, mcp_proxy
from idea_graph_engine.agents import Adapter, TurnResult
from idea_graph_shell.server import App, make_server


class ScriptAdapter(Adapter):
    name = "script"
    label = "Сценарий"

    def found(self):
        return "script"

    def run(self, request):
        project, token = request.extra["project"], request.extra["token"]
        project.tool_call(token, "graph_apply", {"ops": [{"op": "add_card", "kind": "роль", "title": "Клиент", "body": "записывается", "attrs": {"type": "человек"}}]})
        project.tool_call(token, "finish", {"summary": "готово"})
        return TurnResult(session_id="s1", text="", cost=0.0)


@pytest.fixture
def served(tmp_path):
    adapters = Adapters()
    adapters.add(ScriptAdapter())
    settings = Settings(tmp_path / "settings.json")
    settings.data["helper"] = {"agent": "script", "model": "", "effort": ""}
    settings.data["projects_root"] = str(tmp_path / "root")
    app = App(settings, adapters)
    server = make_server(app, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield app
    server.shutdown()
    server.server_close()


def http(app, path, data=None, headers=None):
    request = urllib.request.Request(app.base_url + path, method="POST" if data is not None else "GET",
                                     data=json.dumps(data).encode("utf-8") if data is not None else None,
                                     headers={"Content-Type": "application/json", **({"X-Idea-Graph": "1"} if data is not None else {}), **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def test_project_flow_through_http(served):
    assert http(served, "/api/boot")[1]["project"] is None
    assert http(served, "/api/state")[0] == 400                                     # проекта ещё нет
    code, state = http(served, "/api/project/create", {"title": "Парикмахерская"})
    assert code == 200 and state["title"] == "Парикмахерская" and state["run"] is None
    assert [p["title"] for p in http(served, "/api/boot")[1]["projects"]] == ["Парикмахерская"]

    assert http(served, "/api/start", {"kind": "roles"})[1]["error"] == "no_sphere"
    assert http(served, "/api/act", {"action": "set_sphere", "title": "парикмахерская"})[0] == 200
    assert http(served, "/api/act", {"action": "нет такого"})[1]["error"] == "unknown_action"
    assert http(served, "/api/start", {"kind": "roles"})[0] == 200
    deadline = time.time() + 5
    while time.time() < deadline and http(served, "/api/state")[1]["run"]["status"] != "done":
        time.sleep(0.02)
    assert http(served, "/api/state")[1]["run"]["summary"] == "готово"
    cards = http(served, "/api/graph")[1]["cards"]
    assert [(c["kind"], c["status"]) for c in cards] == [("сфера", "accepted"), ("роль", "proposed")]

    card = cards[1]["id"]
    assert http(served, "/api/act", {"action": "accept", "id": card})[0] == 200
    assert http(served, "/api/act", {"action": "bank_add", "type": "requirement", "text": "Нужна 1С"})[0] == 200
    assert http(served, "/api/bank")[1]["records"][0]["data"]["text"] == "Нужна 1С"
    assert http(served, "/api/layout", {"positions": {}})[0] == 200
    assert http(served, "/api/settings", {"helper": {"agent": "script", "model": "m", "effort": ""}})[1]["settings"]["helper"]["model"] == "m"


def test_security_headers_and_agent_bridge(served):
    http(served, "/api/project/create", {"title": "Проект"})
    request = urllib.request.Request(served.base_url + "/api/act", method="POST", data=b"{}", headers={"Content-Type": "application/json"})
    with pytest.raises(urllib.error.HTTPError) as info:
        urllib.request.urlopen(request, timeout=5)
    assert info.value.code == 403                                                   # без заголовка интерфейса запрос не принимается
    code, body = http(served, "/agent/tools", {}, {"X-Idea-Graph-Token": "wrong"})
    assert code == 400 and body["error"] == "bad_token"
    assert http(served, "/api/stop", {})[0] == 200


def test_mcp_bridge_reaches_the_project(served, monkeypatch):
    http(served, "/api/project/create", {"title": "Проект"})
    served.project.tokens["t0"] = {"kind": "researcher", "note": "задание", "report": None}
    monkeypatch.setenv("IDEA_GRAPH_URL", served.base_url)
    monkeypatch.setenv("IDEA_GRAPH_TOKEN", "t0")
    tools = mcp_proxy.handle({"id": 1, "method": "tools/list"})["result"]["tools"]
    assert [t["name"] for t in tools] == ["turn_info", "report"]
    answer = mcp_proxy.handle({"id": 2, "method": "tools/call", "params": {"name": "turn_info", "arguments": {}}})
    assert answer["result"]["content"][0]["text"] == "задание" and not answer["result"]["isError"]
    report = mcp_proxy.handle({"id": 3, "method": "tools/call", "params": {"name": "report", "arguments": {
        "findings": [{"title": "Салон", "sources": ["https://a.ru"]}]}}})
    assert not report["result"]["isError"] and served.project.tokens["t0"]["report"]["findings"][0]["title"] == "Салон"
