"""Работа пакета: ходы, вопросы, ответы человека и решателя, предохранитель."""

import pytest
from conftest import wait_for

from idea_graph_core import ACCEPTED, HUMAN
from idea_graph_shell.runtime import ShellError


def clarify_script(note, call, request):
    """Ход 1 — вопрос; после ответа — карточка с решением и второй вопрос; затем finish."""
    if "Начало работы" in note:
        assert "Граф целиком" in note and "[c1] ИДЕЯ" in note
        call("ask", question="Кто пользователь?", cards=["c1"], recommended=1, reason="их больше",
             options=[{"title": "Пациенты", "consequence": "нужен простой вход"}, {"title": "Регистраторы"}])
        assert call("ask", question="ещё?", options=["а", "б"]).startswith("ОТКАЗ one_question")
        return ""
    if "Кто пользователь" in note and "Ответ на твой вопрос" in note:
        out = call("graph_apply", ops=[
            {"op": "add_card", "kind": "ветка", "title": "Пользователи", "parent": "c1", "ref": "b"},
            {"op": "add_card", "kind": "решение", "title": "Пользователь — пациент", "parent": "@b",
             "status": "accepted", "decision": "last"}])
        assert "Ревизия графа" in out
        call("ask", question="Нужна ли оплата?", options=["Да", "Нет"], cards=["c3"])
        return ""
    call("finish", outcome="готово", summary="Уточнено два решения")
    return ""


def test_human_flow(make):
    project = make(clarify_script)
    project.start("clarify")
    run = wait_for(lambda: project.runs.get("clarify"), ("asking",))
    question = run.question
    assert question["question"] == "Кто пользователь?" and question["important"] is True  # затронут корень
    project.answer("clarify", question["id"], {"type": "choice", "indexes": [1]})
    run = wait_for(lambda: project.runs["clarify"] if project.runs["clarify"].question
                   and project.runs["clarify"].question["id"] != question["id"] else None, ("asking",))
    card = project.store.cards["c3"]
    assert card["status"] == ACCEPTED and card["decision"]["by"] == HUMAN
    assert card["decision"]["chosen"] == {"type": "choice", "indexes": [1], "values": ["Пациенты"], "text": "",
                                          "value": "Пациенты"}
    assert card["decision"]["options"] == ["Пациенты", "Регистраторы"]
    project.answer("clarify", run.question["id"], {"type": "rejected"})
    run = wait_for(lambda: project.runs["clarify"], ("finished",))
    assert run.outcome == "готово" and run.turn == 3 and run.cost > 0
    kinds = [m["kind"] for m in project.chat]
    assert kinds.count("question") == 2 and kinds.count("answer") == 2 and kinds[-1] == "finish"
    # вторая сессия не получает граф целиком, а только чужие изменения
    assert "Граф целиком" not in project.test_adapter.notes[1]


def test_human_edit_wins_and_changes_reach_agent(make):
    seen = {}

    def script(note, call, request):
        if "Начало работы" in note:
            call("graph_apply", ops=[{"op": "add_card", "kind": "решение", "title": "Оплата картой", "parent": "c1"}])
            call("ask", question="Что дальше?", options=["А", "Б"])
            return ""
        seen["note"] = note
        # человек успел поправить карточку уже после того, как агент получил вводные
        request.extra["project"].human_ops([{"op": "update_card", "id": "c2", "body": "только СБП"}])
        seen["refused"] = call("graph_apply", ops=[{"op": "update_card", "id": "c2", "title": "Оплата"}])
        seen["changes"] = call("graph_read", mode="changes")
        seen["ok"] = call("graph_apply", ops=[{"op": "update_card", "id": "c2", "title": "Оплата"}])
        call("finish", summary="готово")
        return ""

    project = make(script)
    project.start("clarify")
    run = wait_for(lambda: project.runs.get("clarify"), ("asking",))
    project.human_ops([{"op": "update_card", "id": "c2", "title": "Оплата по СБП"}])
    project.answer("clarify", run.question["id"], {"type": "choice", "text": "своё"})
    wait_for(lambda: project.runs["clarify"], ("finished",))
    assert "Оплата по СБП" in seen["note"] and "человек" in seen["note"]
    assert seen["refused"].startswith("ОТКАЗ human_changed")
    assert "только СБП" in seen["changes"] and seen["ok"].startswith("Готово")
    assert project.store.cards["c2"]["body"] == "только СБП"


def test_message_and_idle(make):
    def script(note, call, request):
        return "Понял: " + ("сообщение" if "Сообщение человека" in note else "старт")

    project = make(script)
    project.start("clarify")
    wait_for(lambda: project.runs.get("clarify"), ("idle",))
    project.message("clarify", "Добавь ветку про оплату")
    wait_for(lambda: project.runs["clarify"] if project.runs["clarify"].turn == 2 else None, ("idle",))
    texts = [m["text"] for m in project.chat if m["who"] == "agent"]
    assert texts == ["Понял: старт", "Понял: сообщение"]


def decider_manifest(calls):
    def resolve(question, env):
        calls.append(question["question"])
        decision, _session = env.ask(0, "Реши вопрос: " + question["question"])
        return {"chosen": decision["chosen"], "rationale": decision["rationale"],
                "assumption": decision["assumption"], "disputed": False}

    return {"id": "decider", "name": "Решатель", "kind": "decider", "skill": "Решай критично.", "resolve": resolve}


def decider_script(note, call, request):
    assert "ОТКАЗ" in call("graph_apply", ops=[])            # решателю граф менять нельзя
    call("decide", choice="choice", options=[2], rationale="дешевле отменить", assumption=True)
    return ""


def endless_script(note, call, request):
    if "Ответ на твой вопрос" in note:
        call("graph_apply", ops=[{"op": "add_card", "kind": "решение", "title": "Решение", "parent": "c1",
                                  "status": "accepted", "decision": "last"}])
    number = len(request.extra["project"].store.cards)
    call("ask", question=f"Вопрос {number}?", options=["Да", "Нет"])
    return ""


def test_decider_answers_and_fuse_pauses(make):
    calls = []
    project = make(endless_script, [decider_manifest(calls)], decider_script)
    project.settings.data["automation"]["fuse_decisions"] = 3
    project.set_answerer("clarify", "decider")
    project.start("clarify")
    run = wait_for(lambda: project.runs.get("clarify"), ("paused",))
    assert len(calls) == 3 and "Предохранитель" in run.pause_reason and run.question is not None
    decision = project.store.cards["c2"]["decision"]
    assert decision["by"] == "decider" and decision["assumption"] is True
    assert decision["chosen"]["value"] == "Нет"
    assert run.cost > 0.03                                   # ходы пакета и решателя
    project.resume("clarify")
    wait_for(lambda: project.runs["clarify"] if len(calls) >= 6 else None, ("paused",))
    project.set_answerer("clarify", "human")
    assert project.answerer(project.runs["clarify"]) == "human"


def test_human_decisions_are_untouchable(make):
    def script(note, call, request):
        if "Начало работы" in note:
            call("ask", question="Отменить решение c2?", options=["Да", "Нет"], revisits=["c2"])
        elif "Ответ на отложенный вопрос" in note:
            call("graph_apply", ops=[{"op": "update_card", "id": "c2", "decision": "last"}])
            call("finish", summary="Учёл ответ")
        elif "отложен" in note:
            call("finish", summary="Остался отложенный вопрос")
        return ""

    calls = []
    project = make(script, [decider_manifest(calls)], decider_script)
    project.human_ops([{"op": "add_card", "kind": "решение", "title": "Только веб", "parent": "c1",
                        "decision": {"question": "Платформа?", "by": HUMAN, "chosen": {"type": "choice", "indexes": [], "values": [], "text": "веб", "value": "веб"}}}])
    project.set_answerer("clarify", "decider")
    project.start("clarify")
    run = wait_for(lambda: project.runs.get("clarify"), ("finished",))
    assert calls == [] and len(run.deferred) == 1 and run.question is None
    project.answer("clarify", run.deferred[0]["id"], {"type": "choice", "indexes": [2]})
    wait_for(lambda: project.runs["clarify"] if not project.runs["clarify"].deferred
             and project.runs["clarify"].turn == 3 else None, ("finished",))
    assert project.store.cards["c2"]["decision"]["chosen"]["value"] == "Нет"


def test_code_package_and_wait(make):
    def run_export(ctx):
        ctx.state["runs"] = ctx.state.get("runs", 0) + 1
        ctx.save_state()
        return {"outcome": "готово", "summary": f"карточек: {len(ctx.store.cards)}", "files": ["doc.md"]}

    project = make(lambda *a: "", [{"id": "export", "name": "Выгрузка", "kind": "code", "run": run_export}])
    project.start("export")
    done = project.wait("export", timeout=5)
    assert done["status"] == "finished" and done["summary"] == "карточек: 1"
    assert project.chat[-1]["files"] == ["doc.md"]


def test_state_survives_reopen(make, tmp_path):
    project = make(clarify_script)
    project.start("clarify")
    wait_for(lambda: project.runs.get("clarify"), ("asking",))
    from idea_graph_shell.runtime import Project

    again = Project(project.folder, project.settings, project.registry, project.adapters)
    assert again.runs["clarify"].status == "asking"
    assert again.runs["clarify"].question["question"] == "Кто пользователь?"
    assert [m["kind"] for m in again.chat] == [m["kind"] for m in project.chat]


def test_failed_turn_keeps_its_inputs(make):
    """Агент упёрся в лимит: ответ человека не теряется и сессия не сбрасывается."""
    state = {"fail": False, "notes": []}

    def script(note, call, request):
        state["notes"].append(note)
        if "Начало работы" in note:
            call("ask", question="Кто пользователь?", options=["Пациент", "Клиника"])
        elif "Ответ на твой вопрос" in note:
            call("finish", summary="готово")
        return ""

    project = make(script)
    adapter = project.test_adapter
    original = adapter.run

    def flaky(request):
        if state["fail"]:
            state["fail"] = False
            from idea_graph_shell.agents import TurnResult
            return TurnResult(error="You've hit your 5-hour limit")
        return original(request)

    adapter.run = flaky
    project.start("clarify")
    run = wait_for(lambda: project.runs.get("clarify"), ("asking",))
    state["fail"] = True
    project.answer("clarify", run.question["id"], {"type": "choice", "indexes": [1]})
    run = wait_for(lambda: project.runs["clarify"], ("error",))
    assert "5-hour limit" in run.error and run.session_id == "s1" and run.turn == 1
    project.start("clarify")
    run = wait_for(lambda: project.runs["clarify"], ("finished",))
    assert "Ответ на твой вопрос" in state["notes"][-1] and "Граф целиком" not in state["notes"][-1]


def choice_script(note, call, request):
    if "Начало работы" in note:
        call("ask", question="Что учесть?", recommended=[1, 3], reason="важнее всего", options=["А", "Б", "В"])
        return ""
    if "Ответ на твой вопрос" in note:
        call("graph_apply", ops=[{"op": "add_card", "kind": "решение", "title": "Итог", "parent": "c1",
                                  "status": "accepted", "decision": "last"}])
    call("finish", outcome="готово", summary="ок")
    return ""


def test_several_options_and_own_text(make):
    project = make(choice_script)
    project.start("clarify")
    run = wait_for(lambda: project.runs.get("clarify"), ("asking",))
    question = run.question
    assert question["recommended"] == [1, 3]
    project.answer("clarify", question["id"], {"type": "choice", "indexes": [3, 1, 3], "text": "и ещё Г"})
    wait_for(lambda: project.runs["clarify"], ("finished",))
    chosen = project.store.cards["c2"]["decision"]["chosen"]
    assert chosen == {"type": "choice", "indexes": [1, 3], "values": ["А", "В"], "text": "и ещё Г",
                      "value": "А; В; и ещё Г"}
    assert "Выбраны варианты 1, 3" in project.chat[-2]["text"] and "и своё дополнение" in project.chat[-2]["text"]


def test_answer_is_checked(make):
    clean = make(choice_script)._clean_choice
    question = {"options": [{"title": "А"}, {"title": "Б"}]}
    assert clean(question, {"type": "choice", "indexes": [2]})["values"] == ["Б"]
    assert clean(question, {"type": "choice", "text": "своё"}) == {
        "type": "choice", "indexes": [], "values": [], "text": "своё", "value": "своё"}
    assert clean(question, {"type": "rejected"}) == {"type": "rejected", "value": ""}
    for bad in ({"type": "choice"}, {"type": "choice", "indexes": [3]}, {"type": "choice", "indexes": ["x"]},
                {"type": "option", "index": 1}, {"type": "custom", "value": "x"}):
        with pytest.raises(ShellError):
            clean(question, bad)


def test_decider_gets_question_through_turn_info(make):
    seen = {}

    def decider(note, call, request):
        seen["info"] = call("turn_info")
        call("decide", choice="choice", options=[1, 2], text="плюс своё", rationale="оба важны")
        return ""

    def agent(note, call, request):
        if "Начало работы" in note:
            call("ask", question="Что учесть?", options=["А", "Б", "В"])
            return ""
        call("finish", outcome="готово", summary="ок")
        return ""

    project = make(agent, [decider_manifest([])], decider)
    project.set_answerer("clarify", "decider")
    project.start("clarify")
    wait_for(lambda: project.runs.get("clarify"), ("finished",))
    assert "Реши вопрос: Что учесть?" in seen["info"]                       # вопрос пришёл через turn_info
    chosen = project.store.cards["c1"]  # граф не тронут решателем
    assert chosen["kind"] == "идея"
