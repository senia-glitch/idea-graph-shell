import http.server
import ssl
import urllib.error
import threading

import pytest

from idea_graph_shell import resources

PAGE = """<html><head><title>Т</title><style>p{color:red}</style><script>var x = 1;</script></head>
<body><h1>Запись к врачу</h1><p>Пациенты жалуются: не дозвониться.</p><div>Очередь &amp; ожидание</div></body></html>"""


@pytest.fixture
def site():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/page":
                body, kind = PAGE.encode("utf-8"), "text/html; charset=utf-8"
            elif self.path == "/image":
                body, kind = b"\x89PNG", "image/png"
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def test_html_page_becomes_clean_text(site):
    text = resources.read(site + "/page")
    assert "Запись к врачу" in text and "не дозвониться" in text and "Очередь & ожидание" in text
    assert "var x" not in text and "color:red" not in text and "<" not in text


def test_bad_resources_are_explained(site, tmp_path):
    for value, part in ((site + "/image", "не текст"), (site + "/missing", "ошибкой 404"), ("ftp://x/y", "http"),
                        ("file:///etc/passwd", "http"), (str(tmp_path / "нет.txt"), "Файла нет"), ("  ", "Пустая")):
        with pytest.raises(resources.ResourceError, match=part):
            resources.read(value)
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(b"%PDF")
    with pytest.raises(resources.ResourceError, match="Поддерживаются текстовые"):
        resources.read(str(pdf))


def test_list_add_remove_and_texts(site, tmp_path):
    note = tmp_path / "заметки.md"
    note.write_text("Пациенты ждут по часу", encoding="utf-8")
    item = resources.add(tmp_path, str(note))
    assert item["id"] == "r1" and item["kind"] == "file" and item["chars"] == len("Пациенты ждут по часу")
    assert resources.add(tmp_path, site + "/page")["kind"] == "url"
    with pytest.raises(resources.ResourceError, match="уже в списке"):
        resources.add(tmp_path, str(note))
    texts, errors = resources.texts(tmp_path)
    assert [t["title"] for t in texts] == [str(note), site + "/page"] and errors == []
    note.unlink()                                                     # ресурс пропал: исследование не падает
    texts, errors = resources.texts(tmp_path)
    assert len(texts) == 1 and "Файла нет" in errors[0]
    resources.remove(tmp_path, "r1")
    assert [i["id"] for i in resources.load(tmp_path)["items"]] == ["r2"]
    with pytest.raises(resources.ResourceError):
        resources.remove(tmp_path, "r9")


def test_long_text_is_clipped(tmp_path):
    big = tmp_path / "big.txt"
    big.write_text("слово " * 10000, encoding="utf-8")
    resources.add(tmp_path, str(big))
    texts, _ = resources.texts(tmp_path)
    assert len(texts[0]["text"]) == resources.MAX_CHARS

def test_certificate_problem_is_explained(monkeypatch):
    def broken(*args, **kwargs):
        raise urllib.error.URLError(ssl.SSLCertVerificationError("certificate verify failed"))

    monkeypatch.setattr(resources.urllib.request, "urlopen", broken)
    with pytest.raises(resources.ResourceError, match="сертификат"):
        resources.read("https://example.com")
