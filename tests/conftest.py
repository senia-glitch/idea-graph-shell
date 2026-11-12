"""Общее для тестов оболочки: «агент» без модели, который ходит по сценарию."""

import time

import pytest

from idea_graph_core import Store
from idea_graph_shell.agents import Adapter, Adapters, TurnResult
from idea_graph_shell.config import Settings
from idea_graph_shell.packages import Registry
from idea_graph_shell.runtime import GraphError, Project, ShellError


class ScriptAdapter(Adapter):
    """Вместо запуска командной строки вызывает функцию-сценарий ``script(note, call, request)``."""

    name = "script"
    label = "Сценарий"

    def __init__(self, script):
        self.script = script
        self.notes = []

    def found(self):
        return "script"

    def run(self, request):
        project, token = request.extra["project"], request.extra["token"]
        self.notes.append(request.note)

        def call(tool, **args):
            try:
                return project.tool_call(token, tool, args)
            except (ShellError, GraphError) as error:
                return "ОТКАЗ " + error.code + ": " + error.message

        text = self.script(request.note, call, request) or ""
        return TurnResult(session_id=request.session_id or "s1", text=text, cost=0.01)


def wait_for(run_getter, statuses, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        run = run_getter()
        if run is not None and run.status in statuses:
            return run
        time.sleep(0.01)
    raise AssertionError(f"статус не стал {statuses}: {getattr(run_getter(), 'status', None)}")


@pytest.fixture
def make(tmp_path):
    def build(script, manifests=(), decider_script=None):
        Store.create(tmp_path / "idea", "Запись к врачу без звонков", "Пациент выбирает время сам")
        settings = Settings(tmp_path / "settings.json")
        settings.data["default_slot"]["agent"] = "script"
        settings.data["deciders"] = [{"agent": "decider-script", "model": "", "effort": ""}] * 2
        registry = Registry(discover=False)
        registry.register({"id": "clarify", "name": "Уточнение", "kind": "agent", "skill": "Уточняй идею.",
                           "asks": True, "outcomes": ["готово"]})
        for manifest in manifests:
            registry.register(manifest)
        adapters = Adapters()
        adapter = ScriptAdapter(script)
        adapters.add(adapter)
        if decider_script is not None:
            second = ScriptAdapter(decider_script)
            second.name = "decider-script"
            adapters.add(second)
        project = Project(tmp_path / "idea", settings, registry, adapters)
        project.test_adapter = adapter
        return project

    return build
