"""Настройки оболочки: какой агент и какая модель у каждого пакета, решатели, автоматика.

Лежат в домашней папке пользователя (``~/.ideagraph/settings.json``) и общие для всех идей.
Сам граф идеи хранится в папке идеи, оболочка помнит только список недавних папок.
"""

from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path

DEFAULTS = {
    "slots": {},                       # id пакета -> {"agent", "model", "effort"}
    "default_slot": {"agent": "claude", "model": "", "effort": ""},
    "deciders": [                      # два решателя: им стоит дать разные модели
        {"agent": "claude", "model": "opus", "effort": ""},
        {"agent": "claude", "model": "sonnet", "effort": ""},
    ],
    "automation": {
        "rounds": 2,                   # сколько кругов спора у пары решателей
        "fuse_decisions": 15,          # пауза после стольких решений подряд без человека (0 — выкл.)
        "fuse_cost": 0.0,              # пауза после такой суммы расходов без человека, $ (0 — выкл.)
        "important_dependents": 3,     # вопрос важный, если от его карточки зависит столько карточек
    },
    "recent": [],
}


def home() -> Path:
    return Path(os.environ.get("IDEAGRAPH_HOME") or Path.home() / ".ideagraph")


def _merge(base: dict, extra: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (extra or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


class Settings:
    def __init__(self, path: Path | None = None):
        self.path = path or home() / "settings.json"
        self.lock = threading.Lock()
        self.data = copy.deepcopy(DEFAULTS)
        self.load()

    def load(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        if isinstance(raw, dict):
            self.data = _merge(DEFAULTS, raw)

    def save(self) -> None:
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(tmp, self.path)

    def update(self, patch: dict) -> dict:
        allowed = {k: v for k, v in (patch or {}).items()
                   if k in ("slots", "default_slot", "deciders", "automation")}
        deciders = allowed.get("deciders")
        self.data = _merge(self.data, {k: v for k, v in allowed.items() if k != "deciders"})
        if isinstance(deciders, list) and len(deciders) == 2:
            self.data["deciders"] = [
                {"agent": str(d.get("agent") or ""), "model": str(d.get("model") or ""),
                 "effort": str(d.get("effort") or "")} for d in deciders
            ]
        self.save()
        return self.data

    def slot(self, package_id: str) -> dict:
        slot = self.data["slots"].get(package_id) or {}
        base = self.data["default_slot"]
        return {"agent": slot.get("agent") or base.get("agent") or "claude",
                "model": slot.get("model", base.get("model", "")) or "",
                "effort": slot.get("effort", base.get("effort", "")) or ""}

    def remember(self, folder: str) -> None:
        recent = [f for f in self.data.get("recent", []) if f != folder]
        self.data["recent"] = [folder, *recent][:12]
        self.save()
