"""HTTP-слой и MCP-мост: то, чем пользуются интерфейс и настоящий агент."""

import json
import threading
import urllib.error
import urllib.request

import pytest

from idea_graph_shell import mcp_proxy
from idea_graph_shell.agents import Adapters
from idea_graph_shell.config import Settings
from idea_graph_shell.packages import Registry
from idea_graph_shell.server import App, make_server


@pytest.fixture
def served(tmp_path):
    registry = Registry(discover=False)
    registry.register({"id": "clarify", "name": "Уточнение", "kind": "agent", "skill": "Уточняй.", "asks": True})
    app = App(Settings(tmp_path / "settings.json"), registry, Adapters())
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


def test_project_graph_history_undo(served, tmp_path):
    boot = http(served, "/api/boot")[1]
    assert boot["project"] is None and boot["projects"] == []
    assert http(served, "/api/graph")[0] == 400
    code, state = create_project(served, tmp_path)
    assert code == 200 and state["title"] == "Запись к врачу" and state["revision"] == 0
    assert state["folder"] == str((tmp_path / "root" / "Запись к врачу").resolve()) or state["folder"].endswith("Запись к врачу")
    assert http(served, "/api/graph")[1]["cards"] == []                 # граф начинается пустым, без корня
    code, result = http(served, "/api/ops", {"ops": [{"op": "add_card", "kind": "домен", "title": "Пациенты частных клиник"}]})
    assert code == 200 and result["ids"] == ["c1"]
    code, result = http(served, "/api/ops", {"ops": [{"op": "add_card", "kind": "ветка", "title": "Функции", "parent": "c1"}]})
    assert code == 200 and result["ids"] == ["c2"]
    http(served, "/api/layout", {"positions": {"c2": {"x": 400, "y": 80}}})
    graph = http(served, "/api/graph")[1]
    assert len(graph["cards"]) == 2 and graph["layout"]["positions"]["c2"]["x"] == 400
    http(served, "/api/ops", {"ops": [{"op": "delete_card", "id": "c2"}]})
    history = http(served, "/api/history")[1]
    assert history["deleted"][0]["title"] == "Функции" and history["entries"][0]["rev"] == 3
    assert http(served, "/api/undo", {"rev": 3})[0] == 200
    assert len(http(served, "/api/graph")[1]["cards"]) == 2
    assert http(served, "/api/history")[1]["deleted"] == []
    code, _ = http(served, "/api/ops", {"ops": [{"op": "delete_card", "id": "c1"}]})
    assert code == 200                                                    # корня нет: удалить можно любую карточку


def test_projects_root_listing_and_creation(served, tmp_path):
    root = tmp_path / "all"
    http(served, "/api/settings", {"projects_root": str(root)})
    assert http(served, "/api/boot")[1]["projects_root"] == str(root)
    assert http(served, "/api/boot")[1]["projects"] == []
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


def test_static_and_settings(served):
    with urllib.request.urlopen(served.base_url + "/", timeout=10) as response:
        assert "<title>" in response.read().decode("utf-8")
    code, data = http(served, "/api/settings", {"slots": {"clarify": {"agent": "opencode", "model": "x/y"}},
                                                "automation": {"rounds": 4}})
    assert code == 200 and data["settings"]["automation"]["rounds"] == 4
    assert served.settings.slot("clarify") == {"agent": "opencode", "model": "x/y", "effort": ""}
    assert data["settings"]["automation"]["fuse_decisions"] == 15
    agents = http(served, "/api/agents")[1]["agents"]
    assert {a["id"] for a in agents} == {"claude", "opencode"}


def test_mcp_bridge(served, tmp_path, monkeypatch):
    create_project(served, tmp_path, "Идея")
    served.project.store.apply([{"op": "add_card", "kind": "домен", "title": "Пациенты"}], "human")
    project = served.project
    from idea_graph_shell.runtime import Run

    run = project.runs["clarify"] = Run("clarify")
    run.note = "вводные хода"
    project.tokens["tok"] = {"kind": "package", "run": run, "manifest": project.registry.get("clarify")}
    monkeypatch.setenv("IDEA_GRAPH_URL", served.base_url)
    monkeypatch.setenv("IDEA_GRAPH_TOKEN", "tok")

    init = mcp_proxy.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})
    assert init["result"]["protocolVersion"] == "2025-03-26"
    assert mcp_proxy.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    tools = mcp_proxy.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
    assert [t["name"] for t in tools] == ["turn_info", "graph_read", "graph_apply", "ask", "finish"]

    def call(name, **args):
        return mcp_proxy.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                 "params": {"name": name, "arguments": args}})["result"]

    assert call("turn_info")["content"][0]["text"] == "вводные хода"
    assert "[c1] домен · Пациенты" in call("graph_read", mode="outline")["content"][0]["text"]
    done = call("graph_apply", ops=[{"op": "add_card", "kind": "ветка", "title": "Функции", "parent": "c1"}])
    assert done["isError"] is False and project.store.cards["c2"]["author"] == "package:clarify"
    bad = call("graph_apply", ops=[{"op": "delete_card", "id": "c99"}])
    assert bad["isError"] is True
    monkeypatch.setenv("IDEA_GRAPH_TOKEN", "чужой")
    assert call("graph_read", mode="outline")["isError"] is True


def test_auto_mode_public_manifest_and_limits(served):
    served.registry.register({"id": "problem", "name": "Проблема", "kind": "agent", "skill": "Строй.",
                              "card_fields": [{"kind": "проблема", "name": "Важность", "values": ["низкая"]}],
                              "auto": {"targets": "домен", "limits": [{"key": "n", "name": "Сколько", "default": 3}],
                                       "note": lambda ctx, targets, limits: ""}})
    item = next(p for p in http(served, "/api/boot")[1]["packages"] if p["id"] == "problem")
    assert item["auto"] == {"targets": "домен", "limits": [{"key": "n", "name": "Сколько", "default": 3}]}
    assert item["card_fields"][0]["name"] == "Важность"
    code, data = http(served, "/api/settings", {"auto_limits": {"problem": {"n": 99, "x": "zz"}}})
    assert code == 200 and data["settings"]["auto_limits"] == {"problem": {"n": 20}}
    assert served.settings.auto_limits(served.registry.get("problem")) == {"n": 20}


def test_resources_api_and_researcher_settings(served, tmp_path):
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
    d = served.settings.data
    assert len(d["researchers"]) == 3 and d["auto_research"] is True
    code, data = http(served, "/api/settings", {"auto_research": False, "researchers": [
        {"agent": "claude", "model": "opus"}, {"agent": "opencode", "model": "x/y"}, {"agent": "claude", "model": "haiku"}]})
    assert code == 200 and data["settings"]["auto_research"] is False
    assert data["settings"]["researchers"][1] == {"agent": "opencode", "model": "x/y", "effort": ""}
    http(served, "/api/settings", {"researchers": [{"agent": "claude"}]})                     # неверная длина — игнор
    assert len(served.settings.data["researchers"]) == 3


def test_unlimited_flag_reaches_the_note(served, tmp_path):
    assert served.settings.data["auto_unlimited"] is False
    code, data = http(served, "/api/settings", {"auto_unlimited": 1})
    assert code == 200 and data["settings"]["auto_unlimited"] is True
