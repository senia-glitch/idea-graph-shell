"""Ресурсы проекта: ссылки и файлы пользователя, из которых исследователи берут материал.

Список хранится в ``.idea-graph/resources.json``. «Парсинг» — это чтение страницы или файла и перевод
в чистый текст (без разметки, скриптов и стилей); длинное обрезается, чтобы не раздувать запрос агентам.
"""

from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

MAX_BYTES = 2_000_000          # больше этого не скачиваем и не читаем
MAX_CHARS = 12_000             # сколько текста одного ресурса отдаём исследователям
MAX_TOTAL = 40_000             # и всех ресурсов вместе
TIMEOUT = 15
TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".rst", ".csv", ".json", ".log", ".html", ".htm"}
USER_AGENT = "idea-graph/0.1 (local research helper)"
_BLOCKS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "ul", "ol", "table"}
_SKIP = {"script", "style", "noscript", "template", "svg", "head"}


class ResourceError(Exception):
    """Ресурс нельзя прочитать; текст понятен человеку."""


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self.skip += 1
        elif tag in _BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP and self.skip:
            self.skip -= 1
        elif tag in _BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(raw: str) -> str:
    parser = _Text()
    parser.feed(raw)
    parser.close()
    text = "".join(parser.parts)
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def _decode(data: bytes, charset: str | None) -> str:
    for name in (charset, "utf-8", "cp1251"):
        if not name:
            continue
        try:
            return data.decode(name)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


def read(value: str) -> str:
    """Прочитать ресурс целиком (в пределах ``MAX_BYTES``) и вернуть чистый текст."""
    value = value.strip()
    if not value:
        raise ResourceError("Пустая ссылка или путь")
    if re.match(r"(?i)https?://", value):
        request = urllib.request.Request(value, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:   # noqa: S310 — только http(s)
                kind = (response.headers.get("Content-Type") or "").lower()
                charset = response.headers.get_content_charset()
                data = response.read(MAX_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise ResourceError(f"Страница ответила ошибкой {error.code}") from None
        except (urllib.error.URLError, OSError, ValueError) as error:
            reason = getattr(error, "reason", error)
            if isinstance(reason, ssl.SSLError):
                raise ResourceError("Не удалось проверить сертификат сайта (проверку я не отключаю). Сохраните страницу "
                                    "как .html или .txt и добавьте её файлом") from None
            raise ResourceError(f"Страница недоступна: {reason}") from None
        if len(data) > MAX_BYTES:
            raise ResourceError("Страница слишком большая (больше 2 МБ)")
        if kind and not (kind.startswith("text/") or "json" in kind or "xml" in kind):
            raise ResourceError(f"Это не текст ({kind.split(';')[0]}): добавьте страницу с текстом")
        text = _decode(data, charset)
        return html_to_text(text) if "html" in kind or text.lstrip().lower().startswith(("<!doctype", "<html")) else text
    if re.match(r"(?i)[a-z][a-z0-9+.-]*:(//|[^\\/])", value) and not re.match(r"(?i)^[a-z]:[\\/]", value):
        raise ResourceError("Поддерживаются ссылки http(s) и пути к текстовым файлам")
    path = Path(value).expanduser()
    if not path.is_file():
        raise ResourceError(f"Файла нет: {path}")
    if path.suffix.lower() not in TEXT_SUFFIXES:
        raise ResourceError("Поддерживаются текстовые файлы: " + ", ".join(sorted(TEXT_SUFFIXES))
                            + ". Для PDF и Word сохраните текст отдельным файлом")
    if path.stat().st_size > MAX_BYTES:
        raise ResourceError("Файл слишком большой (больше 2 МБ)")
    text = _decode(path.read_bytes(), None)
    return html_to_text(text) if path.suffix.lower() in (".html", ".htm") else text


# ---------------------------------------------------------------------- список в папке проекта


def _file(folder: Path) -> Path:
    return folder / "resources.json"


def load(folder: Path) -> dict:
    try:
        data = json.loads(_file(folder).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    items = [i for i in data.get("items", []) if isinstance(i, dict) and i.get("value")]
    return {"next": int(data.get("next") or len(items) + 1), "items": items}


def _save(folder: Path, data: dict) -> None:
    _file(folder).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def add(folder: Path, value: str) -> dict:
    """Добавить ресурс. Сразу читаем его: человек увидит, получилось ли."""
    value = value.strip()
    data = load(folder)
    if any(item["value"] == value for item in data["items"]):
        raise ResourceError("Этот ресурс уже в списке")
    text = read(value)
    if not text.strip():
        raise ResourceError("В ресурсе не нашлось текста")
    item = {"id": f"r{data['next']}", "kind": "url" if re.match(r"(?i)https?://", value) else "file",
            "value": value, "chars": len(text)}
    data["items"].append(item)
    data["next"] += 1
    _save(folder, data)
    return item


def remove(folder: Path, item_id: str) -> None:
    data = load(folder)
    left = [i for i in data["items"] if i["id"] != item_id]
    if len(left) == len(data["items"]):
        raise ResourceError("Такого ресурса нет в списке")
    data["items"] = left
    _save(folder, data)


def texts(folder: Path) -> tuple[list[dict], list[str]]:
    """Тексты всех ресурсов для исследователей и список ошибок чтения (ресурс мог пропасть)."""
    out, errors, total = [], [], 0
    for item in load(folder)["items"]:
        try:
            text = read(item["value"])
        except ResourceError as error:
            errors.append(f"{item['value']}: {error}")
            continue
        room = MAX_TOTAL - total
        if room <= 0:
            errors.append(f"{item['value']}: не поместилось в общий объём материалов")
            continue
        text = text[:min(MAX_CHARS, room)]
        total += len(text)
        out.append({"title": item["value"], "text": text})
    return out, errors
