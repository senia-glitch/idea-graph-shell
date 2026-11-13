"""Открытая идея: граф, работа пакетов, вопросы и ответы, чат.

Главный цикл работы пакета-скилла (:meth:`Project._work`):

1. Если есть неотвеченный вопрос — решить, кто отвечает: человек (ждём), решатель (спрашиваем
   сразу) или «отложить до человека» (вопрос затрагивает решение человека, а включена автоматика).
2. Если пакет вызвал ``finish`` — подвести итог и остановиться.
3. Иначе собрать вводные хода и запустить агента на один ход.

Пакет всегда только задаёт вопрос. Кто на него отвечает, определяет переключатель оболочки.
"""

from __future__ import annotations

import copy
import json
import os
import secrets
import threading
import time
from pathlib import Path

from idea_graph_core import HUMAN, GraphError, Store, author_name, views

from .agents import Adapters, TurnRequest, TurnResult
from .config import Settings
from .packages import Registry
from .tools import COMMON_RULES, DECIDER_RULES, DECIDER_TOOLS, PACKAGE_TOOLS

BUSY = ("running", "deciding")
WAITING = ("asking", "paused")
CHAT_KEEP = 400


class ShellError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self) -> dict:
        return {"error": self.code, "message": self.message}


class PackageContext:
    """То, что получает код пакета (``prepare``, ``conclude``, ``run``)."""

    def __init__(self, project: "Project", package_id: str):
        self.store = project.store
        self.folder = project.folder
        self.author = f"package:{package_id}"
        self.registry = project.registry
        self._path = project.dir / "packages" / f"{package_id}.json"
        try:
            self.state = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.state = {}
        self.host = project

    def save_state(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(self.state, ensure_ascii=False, indent=1), encoding="utf-8")


class Run:
    """Состояние работы одного пакета над этой идеей."""

    SAVED = ("package", "status", "session_id", "turn", "last_read", "question", "deferred", "inbox",
             "outcome", "summary", "error", "cost", "auto_streak", "auto_cost", "last_answer",
             "answerer", "pause_reason", "finished")

    def __init__(self, package: str):
        self.package = package
        self.status = "idle"
        self.session_id = ""
        self.turn = 0
        self.last_read = 0
        self.question: dict | None = None
        self.deferred: list[dict] = []
        self.inbox: list[str] = []
        self.outcome = ""
        self.summary = ""
        self.error = ""
        self.cost = 0.0
        self.auto_streak = 0
        self.auto_cost = 0.0
        self.last_answer: dict | None = None
        self.answerer = ""             # "human" | "decider" | "" (взять из настроек идеи)
        self.pause_reason = ""
        self.finished = False
        # не сохраняется:
        self.thread: threading.Thread | None = None
        self.proc = None
        self.stop_flag = False
        self.asked_this_turn = False
        self.note = ""

    def dump(self) -> dict:
        return {key: getattr(self, key) for key in self.SAVED}

    @classmethod
    def load(cls, data: dict) -> "Run":
        run = cls(str(data.get("package")))
        for key in cls.SAVED:
            if key in data:
                setattr(run, key, data[key])
        if run.status in BUSY:            # оболочку закрыли посреди хода
            run.status = "asking" if run.question else "idle"
        return run

    def public(self) -> dict:
        return {
            "package": self.package, "status": self.status, "turn": self.turn,
            "cost": round(self.cost, 4), "question": self.question, "deferred": self.deferred,
            "outcome": self.outcome, "summary": self.summary, "error": self.error,
            "answerer": self.answerer, "pause_reason": self.pause_reason,
            "has_session": bool(self.session_id),
        }


class Project:
    def __init__(self, folder: str | os.PathLike, settings: Settings, registry: Registry,
                 adapters: Adapters | None = None):
        self.folder = Path(folder).resolve()
        self.store = Store.open(self.folder)
        self.dir = self.store.dir
        self.settings = settings
        self.registry = registry
        self.adapters = adapters or Adapters()
        self.base_url = ""
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.seq = 0                         # растёт при любом изменении состояния — для опроса из UI
        self.tokens: dict[str, dict] = {}
        self.runs: dict[str, Run] = {}
        self.chat: list[dict] = []
        self._load()

    # ------------------------------------------------------------------ хранение

    def _load(self) -> None:
        try:
            self.local = json.loads((self.dir / "shell.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.local = {}
        self.local.setdefault("answerers", {})
        for path in sorted((self.dir / "runs").glob("*.json")) if (self.dir / "runs").is_dir() else []:
            try:
                run = Run.load(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
            self.runs[run.package] = run
        try:
            lines = (self.dir / "chat.jsonl").read_text(encoding="utf-8").splitlines()
        except OSError:
            lines = []
        for line in lines[-CHAT_KEEP:]:
            try:
                self.chat.append(json.loads(line))
            except ValueError:
                continue
        self.seq = max([m.get("seq", 0) for m in self.chat] + [0])

    def _touch(self, run: Run | None = None) -> None:
        with self.lock:
            self.seq += 1
            if run is not None:
                path = self.dir / "runs" / f"{run.package}.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(run.dump(), ensure_ascii=False, indent=1), encoding="utf-8")
            self.changed.notify_all()

    def say(self, who: str, text: str, package: str = "", kind: str = "message", **extra) -> None:
        with self.lock:
            self.seq += 1
            entry = {"seq": self.seq, "ts": time.time(), "who": who, "package": package,
                     "kind": kind, "text": text, **extra}
            self.chat.append(entry)
            del self.chat[:-CHAT_KEEP]
            with open(self.dir / "chat.jsonl", "a", encoding="utf-8") as stream:
                stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self.changed.notify_all()

    # ------------------------------------------------------------------ состояние для UI

    def state(self, chat_after: int = 0) -> dict:
        with self.lock:
            return {
                "folder": str(self.folder),
                "title": self.store.cards[self.store.root_id]["title"],
                "revision": self.store.revision,
                "seq": self.seq,
                "runs": {key: run.public() for key, run in self.runs.items()},
                "answerers": dict(self.local["answerers"]),
                "chat": [m for m in self.chat if m["seq"] > chat_after],
            }

    def set_answerer(self, package_id: str, who: str) -> None:
        if who not in ("human", "decider"):
            raise ShellError("invalid_input", "Отвечает либо человек (human), либо решатель (decider)")
        with self.lock:
            self.local["answerers"][package_id] = who
            (self.dir / "shell.json").write_text(json.dumps(self.local, ensure_ascii=False, indent=1), encoding="utf-8")
            run = self.runs.get(package_id)
            if run is not None:
                run.answerer = ""
                run.auto_streak = 0
                run.auto_cost = 0.0
            self._touch(run)
        if run is not None and run.status in WAITING and who == "decider":
            self._kick(run)

    def answerer(self, run: Run) -> str:
        return run.answerer or self.local["answerers"].get(run.package) or "human"

    # ------------------------------------------------------------------ запуск и остановка

    def _manifest(self, package_id: str) -> dict:
        manifest = self.registry.get(package_id)
        if manifest is None:
            raise ShellError("unknown_package", f"Пакет «{package_id}» не установлен")
        return manifest

    def start(self, package_id: str, fresh: bool = False, answerer: str = "") -> dict:
        """Запустить пакет или продолжить его работу. ``fresh`` — начать с новой сессией агента."""
        manifest = self._manifest(package_id)
        if manifest["kind"] not in ("agent", "code"):
            raise ShellError("not_runnable", f"Пакет «{manifest['name']}» не запускается как шаг")
        with self.lock:
            run = self.runs.get(package_id)
            if run is not None and run.status in BUSY:
                raise ShellError("busy", f"Пакет «{manifest['name']}» уже работает")
            if run is None or fresh or (manifest.get("fresh_session") and run.question is None):
                old = run
                run = Run(package_id)
                if old is not None:
                    run.cost = old.cost
                    run.deferred = old.deferred
                self.runs[package_id] = run
            run.answerer = answerer
            run.stop_flag = False
            run.finished = False
            run.error = run.outcome = run.summary = run.pause_reason = ""
            run.auto_streak = 0
            run.auto_cost = 0.0
            if manifest["kind"] == "agent" and run.question is None and not run.inbox:
                run.inbox.append("Начало работы пакета." if run.turn == 0 else "Человек попросил продолжить работу.")
            run.status = "running"
            self._touch(run)
        self.say("system", f"Запущен пакет «{manifest['name']}»", package_id, "start")
        target = self._work if manifest["kind"] == "agent" else self._run_code
        self._spawn(run, target, prepare=manifest["kind"] == "agent")
        return run.public()

    def _spawn(self, run: Run, target, **kwargs) -> None:
        thread = threading.Thread(target=self._guard, args=(run, target), kwargs=kwargs, daemon=True,
                                  name=f"run-{run.package}")
        run.thread = thread
        thread.start()

    def _guard(self, run: Run, target, **kwargs) -> None:
        try:
            target(run, **kwargs)
        except Exception as error:  # noqa: BLE001 — ошибка пакета не должна ронять оболочку
            self._fail(run, f"Внутренняя ошибка: {error}")

    def _kick(self, run: Run) -> None:
        with self.lock:
            if run.thread is not None and run.thread.is_alive():
                return
            run.stop_flag = False
            run.status = "running"
            run.error = ""
            self._touch(run)
            self._spawn(run, self._work)

    def stop(self, package_id: str) -> dict:
        with self.lock:
            run = self.runs.get(package_id)
            if run is None:
                raise ShellError("not_started", "Пакет не запускался")
            run.stop_flag = True
            proc = run.proc
            if run.status not in BUSY:
                run.status = "stopped"
                self._touch(run)
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass
        return run.public()

    def wait(self, package_id: str, timeout: float | None = None) -> dict:
        """Дождаться, пока пакет закончит (успехом, ошибкой или остановкой). Для компоновщика."""
        deadline = None if timeout is None else time.time() + timeout
        with self.changed:
            while True:
                run = self.runs.get(package_id)
                if run is None or run.status in ("finished", "error", "stopped", "idle"):
                    return run.public() if run else {"status": "idle"}
                left = None if deadline is None else deadline - time.time()
                if left is not None and left <= 0:
                    return run.public()
                self.changed.wait(left if left is not None else 5)

    def _fail(self, run: Run, message: str) -> None:
        with self.lock:
            run.status = "error"
            run.error = message
            run.proc = None
            self._touch(run)
        self.say("system", message, run.package, "error")

    # ------------------------------------------------------------------ пакет без модели

    def _run_code(self, run: Run, **_ignored) -> None:
        manifest = self._manifest(run.package)
        ctx = PackageContext(self, run.package)
        result = manifest["run"](ctx) or {}
        outcome = str(result.get("outcome") or manifest["outcomes"][0])
        with self.lock:
            run.turn += 1
            run.status = "finished"
            run.finished = True
            run.outcome = outcome
            run.summary = str(result.get("summary") or "")
            self._touch(run)
        self.say("system", f"«{manifest['name']}»: {run.summary or outcome}", run.package, "finish",
                 outcome=outcome, files=result.get("files") or [])

    # ------------------------------------------------------------------ главный цикл пакета-скилла

    def _work(self, run: Run, prepare: bool = False) -> None:
        manifest = self._manifest(run.package)
        if prepare and callable(manifest.get("prepare")):
            text = manifest["prepare"](PackageContext(self, run.package))
            if text:
                with self.lock:
                    run.inbox.append(str(text))
        retried = False
        while True:
            with self.lock:
                if run.stop_flag:
                    run.status = "stopped"
                    run.proc = None
                    self._touch(run)
                    return
                question = run.question
            if question is not None:
                route = self._route(run, question)
                if route == "human":
                    with self.lock:
                        run.status = "asking"
                        self._touch(run)
                    return
                if route == "paused":
                    with self.lock:
                        run.status = "paused"
                        self._touch(run)
                    self.say("system", run.pause_reason, run.package, "pause")
                    return
                if route == "defer":
                    with self.lock:
                        question["state"] = "deferred"
                        run.deferred.append(question)
                        run.question = None
                        run.inbox.append(
                            f"Вопрос «{question['question']}» затрагивает решение, которое принял человек, "
                            "поэтому отложен до его ответа. Не жди: продолжай с другим вопросом. "
                            "Если других вопросов нет — заверши работу через finish и упомяни отложенный вопрос."
                        )
                        self._touch(run)
                    self.say("system", "Вопрос затрагивает ваше решение и ждёт вас в очереди: "
                             + question["question"], run.package, "deferred")
                    continue
                with self.lock:
                    run.status = "deciding"
                    self._touch(run)
                answer = self._auto_answer(run, question)
                if run.stop_flag:
                    continue
                if answer is None:
                    with self.lock:
                        run.status = "asking"
                        self._touch(run)
                    return
                self._deliver(run, question, answer)
                continue
            if run.finished and not run.inbox:
                self._conclude(run, manifest)
                return
            with self.lock:
                if not run.inbox:
                    run.status = "idle"
                    self._touch(run)
                    return
                run.status = "running"
                run.finished = False
                events = list(run.inbox)
                note = self._note(run, manifest)
                self._touch(run)
            result = self._turn(run, manifest, note)
            if run.stop_flag or result.error:
                with self.lock:                      # ход не состоялся: его вводные не должны пропасть
                    run.inbox = events + run.inbox
                    self._touch(run)
            if run.stop_flag:
                continue
            if result.error:
                lost = any(mark in result.error.lower() for mark in ("no conversation found", "session not found", "session id"))
                if run.session_id and lost and not retried:
                    # Сессию агента удалили: начинаем новую и отдаём весь граф заново.
                    retried = True
                    with self.lock:
                        run.session_id = ""
                        run.inbox.insert(0, "Прошлая сессия недоступна, это новая сессия: продолжай работу по графу.")
                        self._touch(run)
                    continue
                self._fail(run, f"Агент не смог выполнить ход: {result.error}")
                return
            retried = False
            with self.lock:
                run.session_id = result.session_id or run.session_id
                run.turn += 1
                run.cost += result.cost
                run.auto_cost += result.cost
                silent = run.question is None and not run.finished
                self._touch(run)
            if silent and result.text.strip():
                self.say("agent", result.text.strip(), run.package)

    def _slot_request(self, slot: dict, workdir: Path, system_text: str, note: str, token: str,
                      session: str, web: bool, run: Run | None) -> TurnResult:
        adapter = self.adapters.get(slot.get("agent") or "")
        if adapter is None:
            return TurnResult(error=f"Агент «{slot.get('agent')}» не настроен. Откройте «Настройки».")

        def remember(proc):
            if run is not None:
                run.proc = proc

        request = TurnRequest(
            workdir=workdir, system_text=system_text, note=note,
            env={"IDEA_GRAPH_URL": self.base_url, "IDEA_GRAPH_TOKEN": token},
            session_id=session, model=slot.get("model") or "", effort=slot.get("effort") or "",
            web_search=web, on_process=remember, extra={"token": token, "project": self},
        )
        try:
            return adapter.run(request)
        finally:
            if run is not None:
                run.proc = None

    def _turn(self, run: Run, manifest: dict, note: str) -> TurnResult:
        token = secrets.token_urlsafe(24)
        with self.lock:
            run.asked_this_turn = False
            run.note = note
            self.tokens[token] = {"kind": "package", "run": run, "manifest": manifest}
        try:
            return self._slot_request(
                self.settings.slot(run.package), self.dir / "agent" / run.package,
                manifest["skill"].strip() + "\n\n" + COMMON_RULES, note, token, run.session_id,
                manifest["web_search"], run,
            )
        finally:
            with self.lock:
                self.tokens.pop(token, None)

    def _note(self, run: Run, manifest: dict) -> str:
        """Вводные хода: события, чужие изменения графа, а в первом ходе сессии — весь граф."""
        parts = [f"ХОД {run.turn + 1} пакета «{manifest['name']}»."]
        parts.extend(run.inbox)
        run.inbox = []
        if not run.session_id:
            parts.append("Граф целиком:\n" + views.outline(self.store))
        else:
            changes = views.changes_text(self.store, run.last_read, exclude_author=f"package:{run.package}")
            parts.append("Изменения графа с твоего прошлого хода, сделанные не тобой:\n" + changes
                         if changes else "Чужих изменений графа с твоего прошлого хода нет.")
        if run.deferred:
            parts.append("Отложенные до человека вопросы (не задавай их снова): "
                         + "; ".join(q["question"] for q in run.deferred))
        parts.append(f"Текущая ревизия графа: {self.store.revision}. Возможные итоги для finish: "
                     + ", ".join(manifest["outcomes"]) + ".")
        run.last_read = self.store.revision
        return "\n\n".join(parts)

    def _conclude(self, run: Run, manifest: dict) -> None:
        outcome = run.outcome or manifest["outcomes"][0]
        if callable(manifest.get("conclude")):
            outcome = manifest["conclude"](PackageContext(self, run.package), outcome) or outcome
        with self.lock:
            run.outcome = outcome
            run.status = "finished"
            self._touch(run)
        self.say("agent", run.summary or "Работа закончена.", run.package, "finish", outcome=outcome)

    # ------------------------------------------------------------------ кто отвечает на вопрос

    def important(self, question: dict) -> bool:
        """Важный ли вопрос: считается по графу, без модели."""
        cards = {c for c in question.get("cards", []) + question.get("revisits", []) if c in self.store.cards}
        if self.store.root_id in cards or len(cards) >= 3:
            return True
        limit = int(self.settings.data["automation"].get("important_dependents") or 3)
        return any(len(views.dependents(self.store, c)) >= limit for c in cards)

    def _route(self, run: Run, question: dict) -> str:
        if self.answerer(run) != "decider":
            return "human"
        if self.registry.decider() is None:
            self.say("system", "Пакет-решатель не установлен: на вопрос отвечаете вы.", run.package)
            return "human"
        for card_id in question.get("revisits", []):
            decision = (self.store.cards.get(card_id) or {}).get("decision")
            if isinstance(decision, dict) and decision.get("by") == HUMAN:
                return "defer"                      # решения человека неприкосновенны
        auto = self.settings.data["automation"]
        limit, budget = int(auto.get("fuse_decisions") or 0), float(auto.get("fuse_cost") or 0)
        if limit and run.auto_streak >= limit:
            run.pause_reason = (f"Предохранитель: решатель принял {run.auto_streak} решений подряд без вас. "
                                "Просмотрите «Решения агента» и нажмите «Продолжить».")
            return "paused"
        if budget and run.auto_cost >= budget:
            run.pause_reason = (f"Предохранитель: без вас потрачено ${run.auto_cost:.2f}. "
                                "Просмотрите «Решения агента» и нажмите «Продолжить».")
            return "paused"
        return "decider"

    def resume(self, package_id: str) -> dict:
        """Снять паузу предохранителя или продолжить после остановки."""
        with self.lock:
            run = self.runs.get(package_id)
            if run is None:
                raise ShellError("not_started", "Пакет не запускался")
            if run.status in BUSY:
                raise ShellError("busy", "Пакет уже работает")
            run.auto_streak = 0
            run.auto_cost = 0.0
            run.pause_reason = ""
            run.error = ""
            if run.question is None and not run.inbox and not run.finished:
                run.inbox.append("Человек попросил продолжить работу.")
        self._kick(run)
        return run.public()

    def _auto_answer(self, run: Run, question: dict) -> dict | None:
        decider = self.registry.decider()
        env = DeciderEnv(self, run, question, decider)
        try:
            final = decider["resolve"](copy.deepcopy(question), env)
        except Exception as error:  # noqa: BLE001
            final = None
            self.say("system", f"Решатель не справился ({error}): на вопрос отвечаете вы.", run.package, "error")
        with self.lock:
            run.cost += env.cost
            run.auto_cost += env.cost
        if not final or not isinstance(final.get("chosen"), dict):
            if not run.stop_flag:
                self.say("system", "Решатель не вынес решение: на вопрос отвечаете вы.", run.package)
            return None
        return {
            "chosen": self._clean_choice(question, final["chosen"]),
            "by": "decider", "rationale": str(final.get("rationale") or ""),
            "assumption": bool(final.get("assumption")), "disputed": bool(final.get("disputed")),
            "positions": final.get("positions") or [],
        }

    @staticmethod
    def _clean_choice(question: dict, choice: dict) -> dict:
        kind = choice.get("type")
        if kind == "option":
            try:
                index = int(choice.get("index"))
            except (TypeError, ValueError):
                raise ShellError("invalid_input", "Не указан номер варианта") from None
            if not 1 <= index <= len(question["options"]):
                raise ShellError("invalid_input", "Такого варианта нет")
            return {"type": "option", "index": index, "value": question["options"][index - 1]["title"]}
        if kind == "custom":
            text = str(choice.get("value") or choice.get("text") or "").strip()
            if not text:
                raise ShellError("invalid_input", "Свой ответ не может быть пустым")
            return {"type": "custom", "value": text[:4000]}
        if kind == "rejected":
            return {"type": "rejected", "value": str(choice.get("value") or "").strip()[:2000]}
        if kind == "multi":
            if not question.get("multiple"):
                raise ShellError("invalid_input", "На этот вопрос можно выбрать только один вариант")
            return Project._clean_multi(question, choice)
        raise ShellError("invalid_input", "Ответ: вариант (option), своё (custom), несколько (multi) "
                                          "или отклонить (rejected)")

    @staticmethod
    def _clean_multi(question: dict, choice: dict) -> dict:
        """Несколько вариантов и/или своё. Сводится к простому виду, если выбрано что-то одно."""
        raw = choice.get("indexes")
        if raw is None:
            raw = []
        if not isinstance(raw, list):
            raise ShellError("invalid_input", "indexes — список номеров вариантов")
        indexes: list[int] = []
        for item in raw:
            try:
                index = int(item)
            except (TypeError, ValueError):
                raise ShellError("invalid_input", "Номер варианта должен быть числом") from None
            if not 1 <= index <= len(question["options"]):
                raise ShellError("invalid_input", "Такого варианта нет")
            if index not in indexes:
                indexes.append(index)
        indexes.sort()
        text = str(choice.get("text") or choice.get("value") or "").strip()[:4000]
        if not indexes and not text:
            raise ShellError("invalid_input", "Не выбран ни один вариант и нет своего текста")
        if not indexes:
            return {"type": "custom", "value": text}
        titles = [question["options"][i - 1]["title"] for i in indexes]
        if len(indexes) == 1 and not text:
            return {"type": "option", "index": indexes[0], "value": titles[0]}
        return {"type": "multi", "indexes": indexes, "values": titles, "text": text,
                "value": "; ".join(titles + ([text] if text else []))}

    def _deliver(self, run: Run, question: dict, answer: dict, deferred: bool = False) -> None:
        chosen = answer["chosen"]
        if chosen["type"] == "option":
            what = f"выбран вариант {chosen['index']} — «{chosen['value']}»"
        elif chosen["type"] == "custom":
            what = f"свой ответ: «{chosen['value']}»"
        elif chosen["type"] == "multi":
            what = ("выбраны варианты " + ", ".join(str(i) for i in chosen["indexes"]) + " — "
                    + "; ".join(f"«{v}»" for v in chosen["values"])
                    + (f"; и своё дополнение: «{chosen['text']}»" if chosen.get("text") else ""))
        else:
            what = "все варианты отклонены" + (f" ({chosen['value']})" if chosen.get("value") else "")
        who = "человек" if answer["by"] == HUMAN else "решатель"
        marks = [m for m, on in (("это допущение: фактов не хватило", answer.get("assumption")),
                                 ("решено после спора двух решателей", answer.get("disputed"))) if on]
        note = (("Ответ на отложенный вопрос" if deferred else "Ответ на твой вопрос")
                + f" «{question['question']}»: {what}. Ответил {who}"
                + (" (" + "; ".join(marks) + ")" if marks else "") + "."
                + (f" Обоснование: {answer['rationale']}" if answer.get("rationale") else "")
                + ' Запиши результат в граф (у карточки-решения передай "decision":"last") и двигайся дальше.')
        decision = {
            "question": question["question"],
            "options": [o["title"] for o in question["options"]],
            "chosen": chosen, "by": answer["by"], "rationale": answer.get("rationale", ""),
            "assumption": bool(answer.get("assumption")), "disputed": bool(answer.get("disputed")),
        }
        if answer.get("positions"):
            decision["positions"] = answer["positions"]
        with self.lock:
            if deferred:
                run.deferred = [q for q in run.deferred if q["id"] != question["id"]]
            else:
                run.question = None
            run.last_answer = decision
            run.inbox.append(note)
            if answer["by"] == HUMAN:
                run.auto_streak = 0
                run.auto_cost = 0.0
            else:
                run.auto_streak += 1
            self._touch(run)
        self.say("human" if answer["by"] == HUMAN else "decider", what[0].upper() + what[1:], run.package,
                 "answer", question=question["question"], rationale=answer.get("rationale", ""),
                 assumption=bool(answer.get("assumption")), disputed=bool(answer.get("disputed")))

    # ------------------------------------------------------------------ действия человека

    def answer(self, package_id: str, question_id: str, choice: dict) -> dict:
        with self.lock:
            run = self.runs.get(package_id)
            if run is None:
                raise ShellError("not_started", "Пакет не запускался")
            current = run.question if run.question and run.question["id"] == question_id else None
            waiting = next((q for q in run.deferred if q["id"] == question_id), None)
            question = current or waiting
            if question is None:
                raise ShellError("no_question", "Этот вопрос уже закрыт")
            if current is not None and run.status in BUSY:
                raise ShellError("busy", "На этот вопрос сейчас отвечает решатель")
            chosen = self._clean_choice(question, choice or {})
        self._deliver(run, question, {"chosen": chosen, "by": HUMAN}, deferred=current is None)
        self._kick(run)
        return run.public()

    def message(self, package_id: str, text: str) -> dict:
        """Свободное сообщение человека пакету: станет вводной следующего хода."""
        text = str(text or "").strip()
        if not text:
            raise ShellError("invalid_input", "Пустое сообщение")
        self._manifest(package_id)
        with self.lock:
            run = self.runs.get(package_id)
            if run is None:
                run = self.runs[package_id] = Run(package_id)
            run.inbox.append("Сообщение человека: " + text[:6000])
            if run.question is not None and run.status not in BUSY:
                run.inbox.append("Твой вопрос «" + run.question["question"] + "» снят: человек написал сообщение "
                                 "вместо ответа. Учти его и, если нужно, задай вопрос заново.")
                run.question = None
            run.auto_streak = 0
            run.auto_cost = 0.0
            run.finished = False
            self._touch(run)
        self.say("human", text, package_id)
        self._kick(run)
        return run.public()

    def human_ops(self, ops: list[dict], note: str = "") -> dict:
        result = self.store.apply(ops, HUMAN, note=note)
        self._touch()
        return result

    def undo(self, revision: int) -> dict:
        result = self.store.undo(int(revision))
        self._touch()
        return result

    # ------------------------------------------------------------------ вызовы инструментов агентом

    def tools_for(self, token: str) -> list[dict]:
        ctx = self.tokens.get(token)
        if ctx is None:
            raise ShellError("bad_token", "Ход уже закончен: инструменты недоступны")
        return DECIDER_TOOLS if ctx["kind"] == "decider" else PACKAGE_TOOLS

    def tool_call(self, token: str, tool: str, args: dict) -> str:
        ctx = self.tokens.get(token)
        if ctx is None:
            raise ShellError("bad_token", "Ход уже закончен: инструменты недоступны")
        args = args if isinstance(args, dict) else {}
        if tool == "graph_read":
            return self._tool_read(ctx, args)
        if ctx["kind"] == "decider":
            if tool == "decide":
                return self._tool_decide(ctx, args)
            raise ShellError("unknown_tool", "У решателя есть только graph_read и decide")
        handler = {"turn_info": self._tool_turn, "graph_apply": self._tool_apply, "ask": self._tool_ask,
                   "finish": self._tool_finish}.get(tool)
        if handler is None:
            raise ShellError("unknown_tool", f"Нет инструмента {tool}")
        return handler(ctx, args)

    def _tool_turn(self, ctx: dict, _args: dict) -> str:
        return ctx["run"].note

    def _tool_read(self, ctx: dict, args: dict) -> str:
        mode = args.get("mode") or "outline"
        run: Run | None = ctx.get("run") if ctx["kind"] == "package" else None
        if mode == "card":
            return views.card_view(self.store, str(args.get("id") or ""))
        if mode == "deleted":
            return views.deleted_text(self.store)
        if mode == "changes":
            if run is None:
                return views.outline(self.store)
            text = views.changes_text(self.store, run.last_read, exclude_author=f"package:{run.package}")
            run.last_read = self.store.revision
            return text or "Чужих изменений с твоего прошлого чтения нет."
        if mode == "outline":
            if run is not None:
                run.last_read = self.store.revision
            return views.outline(self.store)
        raise ShellError("invalid_input", "mode: outline, card, changes или deleted")

    def _tool_apply(self, ctx: dict, args: dict) -> str:
        run: Run = ctx["run"]
        ops = args.get("ops")
        if isinstance(ops, str):                 # некоторые модели присылают список строкой
            try:
                ops = json.loads(ops)
            except ValueError:
                raise ShellError("invalid_ops", "ops должен быть списком объектов") from None
        if not isinstance(ops, list):
            raise ShellError("invalid_ops", "ops должен быть списком объектов")
        ops = copy.deepcopy(ops)
        for op in ops:
            if isinstance(op, dict) and op.get("decision") == "last":
                if run.last_answer is None:
                    raise ShellError("no_answer", 'Нет ответа, который можно записать как "decision":"last"')
                op["decision"] = copy.deepcopy(run.last_answer)
        result = self.store.apply(ops, f"package:{run.package}", base_revision=run.last_read,
                                  note=str(args.get("note") or ""))
        self._touch()
        created = ", ".join(f"{ref} → {card}" for ref, card in result.get("created", {}).items())
        ids = ", ".join(result.get("ids", []))
        return (f"Готово. Ревизия графа: {result['revision']}."
                + (f" Новые объекты: {ids}." if ids else "") + (f" Имена: {created}." if created else ""))

    def _tool_ask(self, ctx: dict, args: dict) -> str:
        run: Run = ctx["run"]
        if run.asked_this_turn or run.question is not None:
            raise ShellError("one_question", "За ход — один вопрос. Вопрос уже задан: заканчивай ход.")
        text = str(args.get("question") or "").strip()
        raw = args.get("options")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = None
        if not text or not isinstance(raw, list) or not 2 <= len(raw) <= 4:
            raise ShellError("invalid_question", "Нужен текст вопроса и от 2 до 4 готовых вариантов решения")
        options = []
        for item in raw:
            if isinstance(item, str):
                item = {"title": item}
            title = str((item or {}).get("title") or "").strip()
            if not title:
                raise ShellError("invalid_question", "У каждого варианта должен быть title")
            options.append({"title": title[:300], "consequence": str(item.get("consequence") or "").strip()[:400]})
        known = self.store.cards

        def ids(key):
            value = args.get(key) or []
            return [c for c in value if isinstance(c, str) and c in known] if isinstance(value, list) else []

        raw_rec = args.get("recommended")
        if not isinstance(raw_rec, list):
            raw_rec = [] if raw_rec is None else [raw_rec]
        multiple = bool(args.get("multiple"))
        rec_list: list[int] = []
        for item in raw_rec:
            try:
                number = int(item)
            except (TypeError, ValueError):
                continue
            if 1 <= number <= len(options) and number not in rec_list:
                rec_list.append(number)
        if not multiple:
            rec_list = rec_list[:1]
        recommended = rec_list[0] if rec_list else None
        question = {
            "id": secrets.token_hex(6), "package": run.package, "question": text[:1000], "options": options,
            "recommended": recommended, "recommended_list": rec_list, "multiple": multiple,
            "reason": str(args.get("reason") or "").strip()[:800],
            "comment": str(args.get("comment") or "").strip()[:1500],
            "cards": ids("cards"), "revisits": ids("revisits"), "asked_rev": self.store.revision,
            "state": "open",
        }
        question["important"] = self.important(question)
        with self.lock:
            run.asked_this_turn = True
            run.question = question
            self._touch(run)
        self.say("agent", text, run.package, "question", qid=question["id"], comment=question["comment"])
        return "Вопрос передан. Сейчас заверши ход: ответ придёт во вводных следующего хода."

    def _tool_finish(self, ctx: dict, args: dict) -> str:
        run: Run = ctx["run"]
        manifest = ctx["manifest"]
        outcome = str(args.get("outcome") or "").strip() or manifest["outcomes"][0]
        if outcome not in manifest["outcomes"]:
            raise ShellError("invalid_outcome", "Итог — один из: " + ", ".join(manifest["outcomes"]))
        if run.question is not None:
            raise ShellError("question_open", "Ты задал вопрос в этом ходе: дождись ответа, потом завершай работу")
        with self.lock:
            run.finished = True
            run.outcome = outcome
            run.summary = str(args.get("summary") or "").strip()[:3000]
            self._touch(run)
        return "Принято. Заверши ход."

    def _tool_decide(self, ctx: dict, args: dict) -> str:
        if ctx.get("decision") is not None:
            raise ShellError("already_decided", "Решение уже вынесено")
        choice = args.get("choice")
        question = ctx["question"]
        if choice == "option":
            chosen = self._clean_choice(question, {"type": "option", "index": args.get("option")})
        elif choice == "custom":
            chosen = self._clean_choice(question, {"type": "custom", "value": args.get("text")})
        elif choice == "multi":
            chosen = self._clean_choice(question, {"type": "multi", "indexes": args.get("options"),
                                                   "text": args.get("text")})
        elif choice == "rejected":
            chosen = {"type": "rejected", "value": ""}
        elif choice == "agree" and ctx.get("allow_agree"):
            chosen = {"type": "agree"}
        else:
            raise ShellError("invalid_input", "choice: option, custom, multi или rejected"
                             + (", agree" if ctx.get("allow_agree") else ""))
        rationale = str(args.get("rationale") or "").strip()
        if not rationale:
            raise ShellError("invalid_input", "Нужно обоснование (rationale)")

        def cost(key):
            try:
                return min(5, max(1, int(args.get(key))))
            except (TypeError, ValueError):
                return 3

        ctx["decision"] = {"chosen": chosen, "rationale": rationale[:2000],
                           "assumption": bool(args.get("assumption")), "undo_cost": cost("undo_cost"),
                           "undo_cost_other": cost("undo_cost_other")}
        return "Решение принято. Заверши ход."


class DeciderEnv:
    """Что оболочка даёт пакету-решателю: вопрос, граф и возможность спросить каждого из двух решателей."""

    def __init__(self, project: Project, run: Run, question: dict, manifest: dict):
        self.project = project
        self.run = run
        self.question = question
        self.manifest = manifest
        self.store = project.store
        self.important = bool(question.get("important"))
        self.rounds = max(0, int(project.settings.data["automation"].get("rounds") or 0))
        self.cost = 0.0
        self.failed = False

    def outline(self) -> str:
        return views.outline(self.store)

    def card(self, card_id: str) -> str:
        return views.card_view(self.store, card_id)

    def deleted(self) -> str:
        return views.deleted_text(self.store, limit=20)

    def past_decisions(self, limit: int = 15) -> str:
        """Прошлые решения решателей по этой идее — чтобы не противоречить самим себе."""
        items = [c for c in self.store.cards.values()
                 if isinstance(c.get("decision"), dict) and str(c["decision"].get("by", "")).startswith("decider")]
        items.sort(key=lambda c: -c.get("updated_rev", 0))
        lines = []
        for card in items[:limit]:
            chosen = card["decision"].get("chosen") or {}
            lines.append(f"- [{card['id']}] {card['title']}: {chosen.get('value') or chosen.get('type')}")
        return "\n".join(lines)

    def ask(self, slot: int, note: str, session: str = "", allow_agree: bool = False) -> tuple[dict | None, str]:
        """Спросить решателя ``slot`` (0 или 1). Возвращает его решение и сессию для продолжения спора."""
        project = self.project
        slots = project.settings.data["deciders"]
        config = slots[slot] if slot < len(slots) else slots[0]
        token = secrets.token_urlsafe(24)
        ctx = {"kind": "decider", "question": self.question, "decision": None, "allow_agree": allow_agree}
        with project.lock:
            project.tokens[token] = ctx
        try:
            result = project._slot_request(
                config, project.dir / "agent" / f"decider-{slot + 1}",
                self.manifest["skill"].strip() + "\n\n" + DECIDER_RULES, note, token, session, False, self.run,
            )
        finally:
            with project.lock:
                project.tokens.pop(token, None)
        self.cost += result.cost
        if result.error or ctx["decision"] is None:
            self.failed = True
            if result.error:
                project.say("system", f"Решатель {slot + 1}: {result.error}", self.run.package, "error")
            return None, result.session_id or session
        return ctx["decision"], result.session_id or session


__all__ = ["DeciderEnv", "GraphError", "PackageContext", "Project", "Run", "ShellError", "author_name"]
