"""HTTP-слой и MCP-мост: то, чем пользуются интерфейс и настоящий агент."""

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from idea_graph_engine import Adapters, Registry, Settings, mcp_proxy
from idea_graph_engine.agents import Adapter, TurnResult
from idea_graph_shell.server import App, make_server


class ScriptAdapter(Adapter):
    name = "script"
    label = "Сценарий"

    def found(self):
        return "script"

    def run(self, request):
        project, token = request.extra["project"], request.extra["token"]
        project.tool_call(token, "finish", {"outcome": "готово", "summary": request.note.replace("\n", " ")})
        return TurnResult(session_id="s1", text="", cost=0.0)


def stage_manifest():
    return {
        "id": "st", "name": "Этап", "kind": "agent", "skill": "Строй.", "outcomes": ["готово"],
        "banks": {"reads": ["comp"], "writes": ["comp"]},
        "stage": {
            "roots": "сфера", "hidden_edges": ["участвует"],
            "kinds": [{"kind": "роль", "title": "Роль", "color": "#e8833a", "fields": [{"name": "Важность", "values": ["низкая", "высокая"]}]}],
            "steps": [{"id": "roles", "title": "Роли", "question": "Кто?", "produces": ["роль"], "needs": [],
                       "prompts": {"suggest": "ПРЕДЛОЖИ-РОЛИ"}},
                      {"id": "comp", "title": "Конкуренты", "question": "Кто?", "produces": [], "produces_bank": "comp",
                       "needs": [], "prompts": {"suggest": "ПРЕДЛОЖИ"}, "bank": {"name": "comp", "type": "competitor"}}],
            "auto": {"targets": "сфера", "limits": [{"key": "n", "name": "Сколько", "default": 3}],
                     "note": lambda ctx, targets, limits, **kw: ""},
        },
    }


@pytest.fixture
def served(tmp_path):
    registry = Registry(discover=False)
    registry.register({"id": "clarify", "name": "Уточнение", "kind": "agent", "skill": "Уточняй."})
    registry.register(stage_manifest())
    adapters = Adapters()
    adapters.add(ScriptAdapter())
    settings = Settings(tmp_path / "settings.json")
    settings.data["default_slot"] = {"agent": "script", "model": "", "effort": ""}
    app = App(settings, registry, adapters)
    server = make_server(app, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield app
    server.shutdown()
    server.server_close()


def http(app, path, data=None, headers=None):
    request = urllib.request.Request(
        app.base_url + path, data=None if data is None else json.dumps(data).encode("utf-8"),
        method="GET" if data is None else "POST",
        headers={"Content-Type": "application/json", "X-Idea-Graph": "1", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def create_project(served, tmp_path, title="Запись к врачу"):
    return http(served, "/api/project/create", {"title": title, "parent": str(tmp_path / "root")})


def ops(served, *items):
    return http(served, "/api/ops", {"ops": list(items)})


def test_project_graph_history_undo(served, tmp_path):
    boot = http(served, "/api/boot")[1]
    assert boot["project"] is None and boot["projects"] == []
    assert http(served, "/api/graph")[0] == 400
    code, state = create_project(served, tmp_path)
    assert code == 200 and state["title"] == "Запись к врачу" and state["revision"] == 0
    assert state["folder"].endswith("Запись к врачу")
    assert http(served, "/api/graph")[1]["cards"] == []                 # граф начинается пустым, без корня
    code, result = ops(served, {"op": "add_card", "kind": "сфера", "title": "Клиники"})
    assert code == 200 and result["ids"] == ["c1"]
    code, result = ops(served, {"op": "add_card", "kind": "роль", "title": "Врач", "parent": "c1"})
    assert code == 200 and result["ids"] == ["c2"]
    http(served, "/api/layout", {"positions": {"c2": {"x": 400, "y": 80}}})
    graph = http(served, "/api/graph")[1]
    assert len(graph["cards"]) == 2 and graph["layout"]["positions"]["c2"]["x"] == 400
    ops(served, {"op": "delete_card", "id": "c2"})
    history = http(served, "/api/history")[1]
    assert history["deleted"][0]["title"] == "Врач" and history["entries"][0]["rev"] == 3
    assert http(served, "/api/undo", {"rev": 3})[0] == 200
    assert len(http(served, "/api/graph")[1]["cards"]) == 2
    assert ops(served, {"op": "delete_card", "id": "c1"})[0] == 200      # корня нет: удалить можно любую карточку


def test_projects_root_listing_and_creation(served, tmp_path):
    root = tmp_path / "all"
    http(served, "/api/settings", {"projects_root": str(root)})
    assert http(served, "/api/boot")[1]["projects_root"] == str(root)
    code, state = http(served, "/api/project/create", {"title": "Первый: проект?"})      # в корневой папке из настроек
    assert code == 200 and state["title"] == "Первый: проект?" and (root / "Первый проект").is_dir()
    other = tmp_path / "elsewhere"
    code, _ = http(served, "/api/project/create", {"title": "Второй", "parent": str(other)})   # переопределение папки
    assert code == 200 and (other / "Второй").is_dir()
    projects = http(served, "/api/boot")[1]["projects"]
    assert [p["title"] for p in projects] == ["Первый: проект?"]                          # список — только корневая папка
    assert http(served, "/api/project/create", {"title": "Первый: проект?"})[1]["error"] == "already_exists"
    assert http(served, "/api/project/create", {"title": "  "})[1]["error"] == "invalid_input"
    assert http(served, "/api/project/open", {"folder": projects[0]["folder"]})[0] == 200


def test_foreign_site_cannot_post(served, tmp_path):
    code, error = http(served, "/api/project/create", {"title": "t", "parent": str(tmp_path / "x")},
                       headers={"X-Idea-Graph": "0"})
    assert code == 403 and error["error"] == "forbidden"


def test_static_settings_and_agents(served):
    with urllib.request.urlopen(served.base_url + "/", timeout=10) as response:
        assert "<title>" in response.read().decode("utf-8")
    code, data = http(served, "/api/settings", {"slots": {"clarify": {"agent": "opencode", "model": "x/y"}},
                                                "advisers": [{"agent": "claude", "model": "a"}, {"agent": "claude", "model": "b"},
                                                             {"agent": "claude", "model": "c"}],
                                                "reviewer": {"agent": "opencode", "model": "r/1"},
                                                "auto_propagate": False})
    assert code == 200 and data["settings"]["reviewer"]["model"] == "r/1" and data["settings"]["auto_propagate"] is False
    assert [s["model"] for s in data["settings"]["advisers"]] == ["a", "b", "c"]
    assert served.settings.slot("clarify") == {"agent": "opencode", "model": "x/y", "effort": ""}
    assert {a["id"] for a in http(served, "/api/agents")[1]["agents"]} >= {"claude", "opencode"}


def test_mcp_bridge(served, tmp_path, monkeypatch):
    create_project(served, tmp_path, "Идея")
    served.project.store.apply([{"op": "add_card", "kind": "сфера", "title": "Клиники"}], "human")
    project = served.project
    from idea_graph_engine.runtime import Run

    run = project.runs["clarify"] = Run("clarify")
    run.note = "вводные хода"
    project.tokens["tok"] = {"kind": "package", "run": run, "manifest": project.registry.get("clarify")}
    monkeypatch.setenv("IDEA_GRAPH_URL", served.base_url)
    monkeypatch.setenv("IDEA_GRAPH_TOKEN", "tok")

    init = mcp_proxy.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})
    assert init["result"]["protocolVersion"] == "2025-03-26"
    assert mcp_proxy.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    tools = mcp_proxy.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
    assert [t["name"] for t in tools] == ["turn_info", "graph_read", "graph_apply", "bank_read", "bank_write", "ask", "finish"]

    def call(tool, **args):
        return mcp_proxy.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                 "params": {"name": tool, "arguments": args}})["result"]

    assert call("turn_info")["content"][0]["text"] == "вводные хода"
    assert "[c1] сфера · Клиники" in call("graph_read", mode="outline")["content"][0]["text"]
    done = call("graph_apply", ops=[{"op": "add_card", "kind": "роль", "title": "Врач", "parent": "c1"}])
    assert done["isError"] is False and project.store.cards["c2"]["author"] == "package:clarify"
    assert call("graph_apply", ops=[{"op": "delete_card", "id": "c99"}])["isError"] is True
    assert call("bank_read", name="comp")["isError"] is True              # у этого пакета нет доступа к банку
    monkeypatch.setenv("IDEA_GRAPH_TOKEN", "чужой")
    assert call("graph_read", mode="outline")["isError"] is True


def test_public_manifest_exposes_stage_without_functions(served):
    item = next(p for p in http(served, "/api/boot")[1]["packages"] if p["id"] == "st")
    assert [s["id"] for s in item["stage"]["steps"]] == ["roles", "comp"]
    assert item["stage"]["steps"][0]["actions"] == ["suggest"] and item["stage"]["steps"][1]["bank"]["name"] == "comp"
    assert item["stage"]["kinds"][0]["fields"][0]["name"] == "Важность" and item["stage"]["hidden_edges"] == ["участвует"]
    assert item["auto"] == {"targets": "сфера", "limits": [{"key": "n", "name": "Сколько", "default": 3}]}
    json.dumps(item)                                                      # ни одной функции в ответе


def test_stage_gates_banks_and_proposals_through_http(served, tmp_path):
    create_project(served, tmp_path)
    ops(served, {"op": "add_card", "kind": "сфера", "title": "Клиники"})
    ops(served, {"op": "add_card", "kind": "роль", "title": "Врач", "status": "proposed", "parent": "c1"})
    state = http(served, "/api/stage?package=st")[1]
    assert state["steps"][0]["proposed"] == 1 and state["steps"][0]["status"] == "open"
    assert http(served, "/api/stage/approve", {"package": "st", "step": "roles"})[1]["error"] == "pending"
    approved = http(served, "/api/stage/approve", {"package": "st", "step": "roles", "accept_all": True})[1]
    assert approved["steps"][0]["status"] == "approved"
    ops(served, {"op": "update_card", "id": "c2", "title": "Терапевт"})
    assert http(served, "/api/state")[1]["stages"]["st"]["steps"][1]["status"] == "open"
    assert http(served, "/api/stage/reopen", {"package": "st", "step": "roles"})[1]["steps"][0]["status"] == "open"
    assert http(served, "/api/stage/clear-stale", {"package": "st", "step": "roles"})[0] == 200
    assert http(served, "/api/stage?package=none")[0] == 400

    code, saved = http(served, "/api/bank/save", {"name": "comp", "type": "competitor", "key": "a.example",
                                                   "data": {"name": "Докдок"}, "sources": ["https://a.example"]})
    assert code == 200 and saved["record"]["data"]["state"] == "accepted" and saved["record"]["author"] == "human"
    code, edited = http(served, "/api/bank/save", {"name": "comp", "id": saved["record"]["id"], "data": {"name": "Докдок 2", "state": "proposed"}})
    assert edited["record"]["data"]["name"] == "Докдок 2"
    assert http(served, "/api/bank?name=comp")[1]["records"][0]["data"]["state"] == "proposed"
    assert http(served, "/api/bank?name=comp&type=other")[1]["records"] == []
    assert http(served, "/api/bank/remove", {"name": "comp", "id": saved["record"]["id"]})[0] == 200
    assert http(served, "/api/bank?name=comp")[1]["records"] == []
    assert http(served, "/api/bank?name=Bad%20name")[0] == 400

    ops(served, {"op": "add_card", "kind": "правка", "title": "Правка: Терапевт", "status": "proposed",
                 "attrs": {"target": "c2", "field": "title", "new": "Лор", "reason": "тест"}})
    right = http(served, "/api/graph")[1]["cards"][-1]["id"]
    assert http(served, "/api/proposals/apply", {"id": right})[0] == 200
    titles = {c["id"]: c["title"] for c in http(served, "/api/graph")[1]["cards"]}
    assert titles["c2"] == "Лор" and right not in titles


def test_run_start_with_step_action_and_auto_through_http(served, tmp_path):
    create_project(served, tmp_path)
    ops(served, {"op": "add_card", "kind": "сфера", "title": "Клиники"})
    assert http(served, "/api/run/start", {"package": "st", "step": "roles", "action": "suggest", "target": "c1"})[0] == 200
    deadline = time.time() + 5
    while time.time() < deadline and http(served, "/api/state")[1]["runs"]["st"]["status"] != "finished":
        time.sleep(0.02)
    run = http(served, "/api/state")[1]["runs"]["st"]
    assert run["status"] == "finished" and run["step"] == "roles" and run["action"] == "suggest" and "ПРЕДЛОЖИ-РОЛИ" in run["summary"]
    assert http(served, "/api/run/start", {"package": "st", "step": "roles", "action": "review"})[1]["error"] == "no_action"
    assert http(served, "/api/run/start", {"package": "st", "auto": {"targets": ["c9"]}})[1]["error"] == "unknown_target"
    assert http(served, "/api/run/stop", {"package": "st"})[0] == 200
    assert http(served, "/api/run/propose", {"package": "st"})[0] == 200


def test_resources_api(served, tmp_path):
    create_project(served, tmp_path)
    note = tmp_path / "заметки.txt"
    note.write_text("Пациенты ждут по часу", encoding="utf-8")
    code, data = http(served, "/api/resources/add", {"value": str(note)})
    assert code == 200 and data["item"]["id"] == "r1"
    assert http(served, "/api/resources")[1]["items"][0]["value"] == str(note)
    code, error = http(served, "/api/resources/add", {"value": str(tmp_path / "нет.txt")})
    assert code == 400 and error["error"] == "bad_resource"
    assert http(served, "/api/resources/remove", {"id": "r1"})[0] == 200
    assert http(served, "/api/resources")[1]["items"] == []


def test_skip_part_goal_and_issues_through_http(served, tmp_path):
    create_project(served, tmp_path)
    ops(served, {"op": "add_card", "kind": "сфера", "title": "Клиники"})
    state = http(served, "/api/state")[1]["stages"]["st"]
    assert state["skipped"] is False and state["steps"][0]["issues"] == [] and state["steps"][0]["runs"] == 0
    assert http(served, "/api/stage/skip", {"package": "st", "skipped": True})[1]["skipped"] is True
    assert http(served, "/api/state")[1]["stages"]["st"]["skipped"] is True
    assert http(served, "/api/stage/skip", {"package": "none", "skipped": True})[0] == 400
    assert http(served, "/api/run/start", {"package": "st", "step": "roles", "action": "suggest", "target": "c1",
                                           "goal": "добавь врача"})[0] == 200
    deadline = time.time() + 5
    while time.time() < deadline and http(served, "/api/state")[1]["runs"]["st"]["status"] != "finished":
        time.sleep(0.02)
    run = http(served, "/api/state")[1]["runs"]["st"]
    assert "ЧТО УЛУЧШИТЬ (задача человека): добавь врача" in run["summary"]
    assert http(served, "/api/state")[1]["stages"]["st"]["steps"][0]["runs"] == 1
