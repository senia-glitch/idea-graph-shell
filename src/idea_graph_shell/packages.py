"""Как оболочка узнаёт об установленных пакетах.

Пакет ставится через pip в то же окружение и объявляет точку входа в группе
``idea_graph.packages``. Точка входа — функция без аргументов, которая возвращает манифест
(обычный словарь). Импортировать оболочку пакету не нужно.

Поля манифеста
--------------
``id``, ``name``, ``description`` — обязательные.
``kind``:
    ``agent``   — пакет-скилл: оболочка запускает агента с текстом ``skill``;
    ``code``    — пакет без модели: оболочка вызывает ``run(ctx)``;
    ``decider`` — решатель: ``skill`` и функция ``resolve(question, env)``;
    ``view``    — добавляет экран в оболочку (``tab``, ``static``, ``api``).
``reads`` / ``writes`` — виды карточек, которые пакет читает и создаёт (для проверки карты).
``asks`` — задаёт ли вопросы. ``web_search`` — нужен ли веб-поиск.
``model_level`` — рекомендуемый уровень модели: «сильная», «средняя», «лёгкая».
``outcomes`` — возможные итоги работы; по ним компоновщик выбирает следующую стрелку.
``order`` — место пакета в списке оболочки (меньше — раньше).
``fresh_session`` — каждый запуск пакета начинает новую сессию агента.
``prepare(ctx) -> str`` — код перед сессией агента; возвращает вводные для агента.
``conclude(ctx, outcome) -> str`` — код после завершения; может уточнить итог.

``ctx`` — объект с полями ``store`` (граф), ``folder``, ``author``, ``state`` (словарь пакета,
сохраняется в папке идеи) и методом ``save_state()``.
"""

from __future__ import annotations

from importlib import metadata

GROUP = "idea_graph.packages"
KINDS = ("agent", "code", "decider", "view")
PUBLIC = ("id", "name", "description", "kind", "reads", "writes", "asks", "web_search",
          "model_level", "outcomes", "tab", "version", "order", "card_fields")


def normalize(raw: dict) -> dict:
    if not isinstance(raw, dict) or not raw.get("id") or not raw.get("name"):
        raise ValueError("манифест должен быть словарём с полями id и name")
    manifest = dict(raw)
    manifest["id"] = str(manifest["id"])
    manifest.setdefault("description", "")
    manifest.setdefault("kind", "agent")
    if manifest["kind"] not in KINDS:
        raise ValueError(f"неизвестный kind: {manifest['kind']}")
    manifest["reads"] = list(manifest.get("reads") or [])
    manifest["writes"] = list(manifest.get("writes") or [])
    manifest["asks"] = bool(manifest.get("asks"))
    manifest["web_search"] = bool(manifest.get("web_search"))
    manifest.setdefault("model_level", "средняя")
    manifest["outcomes"] = list(manifest.get("outcomes") or ["готово"])
    if manifest["kind"] in ("agent", "decider") and not manifest.get("skill"):
        raise ValueError("у пакета-скилла должен быть текст skill")
    if manifest["kind"] == "code" and not callable(manifest.get("run")):
        raise ValueError("у пакета без модели должна быть функция run")
    return manifest


class Registry:
    def __init__(self, discover: bool = True):
        self.items: dict[str, dict] = {}
        self.errors: list[str] = []
        if discover:
            self.discover()

    def discover(self) -> None:
        for point in metadata.entry_points(group=GROUP):
            try:
                manifest = normalize(point.load()())
                manifest.setdefault("version", point.dist.version if point.dist else "")
                self.items[manifest["id"]] = manifest
            except Exception as error:  # noqa: BLE001 — сломанный пакет не должен ронять оболочку
                self.errors.append(f"{point.name}: {error}")

    def register(self, manifest: dict) -> dict:
        manifest = normalize(manifest)
        self.items[manifest["id"]] = manifest
        return manifest

    def get(self, package_id: str) -> dict | None:
        return self.items.get(package_id)

    def decider(self) -> dict | None:
        return next((m for m in self.items.values() if m["kind"] == "decider"), None)

    def public(self) -> list[dict]:
        ordered = sorted(self.items.values(), key=lambda m: (m.get("order") or 100, m["name"]))
        out = []
        for m in ordered:
            item = {key: m.get(key) for key in PUBLIC}
            auto = m.get("auto")
            if isinstance(auto, dict):          # функцию-«вводные» наружу не отдаём
                item["auto"] = {"targets": auto.get("targets"), "limits": list(auto.get("limits") or [])}
            item["research"] = isinstance(m.get("research"), dict)
            out.append(item)
        return out
