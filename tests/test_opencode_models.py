import json

from idea_graph_shell import agents
from idea_graph_shell.agents import OpenCodeAdapter

VERBOSE = "\n".join([
    "opencode-go/kimi-k3",
    json.dumps({"id": "kimi-k3", "name": "Kimi K3", "status": "active", "variants": {"max": {}}}, indent=2),
    "opencode-go/mimo-v2.5",
    json.dumps({"id": "mimo-v2.5", "name": "MiMo V2.5", "status": "active", "variants": {}}, indent=2),
    "opencode-go/old-model",
    json.dumps({"id": "old-model", "name": "Old", "status": "deprecated", "variants": {"low": {}}}, indent=2),
    "opencode-go/no-tools",
    json.dumps({"id": "no-tools", "name": "NoTools", "status": "active", "capabilities": {"toolcall": False}}, indent=2),
    "opencode-go/glm-5.3",
    json.dumps({"id": "glm-5.3", "name": "GLM-5.3", "status": "active", "variants": {"low": {}, "high": {}, "max": {}}}, indent=2),
])


def adapter(monkeypatch, verbose=VERBOSE, plain=""):
    item = OpenCodeAdapter()
    monkeypatch.setattr(OpenCodeAdapter, "found", lambda self: "opencode")
    monkeypatch.setattr(OpenCodeAdapter, "_list", staticmethod(lambda exe, *args: verbose if args else plain))
    return item


def test_only_go_models_with_their_own_efforts(monkeypatch):
    models = adapter(monkeypatch).models()
    assert [m["id"] for m in models] == ["opencode-go/kimi-k3", "opencode-go/mimo-v2.5", "opencode-go/glm-5.3"]
    assert models[0]["efforts"] == ["max"] and models[1]["efforts"] == [] and models[2]["efforts"] == ["low", "high", "max"]
    assert models[0]["name"] == "Kimi K3 (kimi-k3)"
    assert all(m["id"].startswith(agents.OPENCODE_PROVIDER + "/") for m in models)


def test_falls_back_to_plain_list_and_ignores_other_providers(monkeypatch):
    plain = "opencode-go/kimi-k3\nopencode/gpt-5\nopenai/gpt-5\nnot a model\n"
    models = adapter(monkeypatch, verbose="", plain=plain).models()
    assert models == [{"id": "opencode-go/kimi-k3", "name": "opencode-go/kimi-k3", "efforts": []}]


def test_models_are_cached(monkeypatch):
    item = adapter(monkeypatch)
    first = item.models()
    monkeypatch.setattr(OpenCodeAdapter, "_list", staticmethod(lambda exe, *args: ""))
    assert item.models() == first
