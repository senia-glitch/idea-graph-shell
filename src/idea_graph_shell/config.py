"""Настройки оболочки: какой агент и какая модель у каждого пакета, решатели, автоматика.

Лежат в домашней папке пользователя (``~/.idea-graph/settings.json``) и общие для всех идей.
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
    "researchers": [                   # три исследователя области: им стоит дать разные модели
        {"agent": "claude", "model": "opus", "effort": ""},
        {"agent": "claude", "model": "sonnet", "effort": ""},
        {"agent": "claude", "model": "haiku", "effort": ""},
    ],
    "auto_unlimited": False,           # не ограничивать автоматический режим числом карточек
    "auto_research": True,             # в автоматическом режиме сначала исследовать область
    "auto_limits": {},                 # id пакета -> {ключ лимита: число} для автоматического режима
    "projects_root": "",               # корневая папка проектов; пусто — «Документы\\Граф идеи»
}


def home() -> Path:
    return Path(os.environ.get("IDEA_GRAPH_HOME") or Path.home() / ".idea-graph")


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
                   if k in ("slots", "default_slot", "deciders", "automation", "projects_root", "auto_limits", "researchers", "auto_research", "auto_unlimited")}
        deciders = allowed.get("deciders")
        researchers = allowed.pop("researchers", None)
        for flag in ("auto_research", "auto_unlimited"):
            if flag in allowed:
                allowed[flag] = bool(allowed[flag])
        if "auto_limits" in allowed:
            clean: dict = {}
            for package, limits in (allowed["auto_limits"] or {}).items() if isinstance(allowed["auto_limits"], dict) else []:
                if isinstance(limits, dict):
                    clean[str(package)] = {str(k): max(1, min(20, int(v))) for k, v in limits.items()
                                           if str(v).lstrip("-").isdigit()}
            allowed["auto_limits"] = clean
        if "projects_root" in allowed:
            allowed["projects_root"] = str(allowed["projects_root"] or "").strip()
        self.data = _merge(self.data, {k: v for k, v in allowed.items() if k != "deciders"})
        if isinstance(deciders, list) and len(deciders) == 2:
            self.data["deciders"] = [
                {"agent": str(d.get("agent") or ""), "model": str(d.get("model") or ""),
                 "effort": str(d.get("effort") or "")} for d in deciders
            ]
        if isinstance(researchers, list) and len(researchers) == 3:
            self.data["researchers"] = [
                {"agent": str(d.get("agent") or ""), "model": str(d.get("model") or ""),
                 "effort": str(d.get("effort") or "")} for d in researchers
            ]
        self.save()
        return self.data

    def slot(self, package_id: str) -> dict:
        slot = self.data["slots"].get(package_id) or {}
        base = self.data["default_slot"]
        return {"agent": slot.get("agent") or base.get("agent") or "claude",
                "model": slot.get("model", base.get("model", "")) or "",
                "effort": slot.get("effort", base.get("effort", "")) or ""}

    def auto_limits(self, manifest: dict) -> dict:
        """Лимиты автоматического режима пакета: значения из настроек поверх умолчаний пакета."""
        saved = (self.data.get("auto_limits") or {}).get(manifest["id"]) or {}
        spec = (manifest.get("auto") or {}).get("limits") or []
        return {item["key"]: int(saved.get(item["key"], item.get("default", 3))) for item in spec}

    def remember(self, folder: str) -> None:
        recent = [f for f in self.data.get("recent", []) if f != folder]
        self.data["recent"] = [folder, *recent][:12]
        self.save()
