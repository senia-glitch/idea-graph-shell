/* Вкладка «Документ»: собранный пакетами документ для разработки. Правок здесь нет: меняются карточки на холсте. */

import {$, S, act, api, esc, toast} from "./core.js";

let loaded = -1, markdown = "";

function inline(text) {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, "$1<i>$2</i>");
}

/* Очень маленький рендер markdown: заголовки, списки, таблицы, блоки кода, абзацы. */
export function renderMarkdown(text) {
  const lines = text.split("\n"), out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim(), code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      out.push(`<pre class="md-code" data-lang="${esc(lang)}">${esc(code.join("\n"))}</pre>`);
    } else if (/^#{1,6} /.test(line)) {
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level + 1}>${inline(line.slice(level + 1))}</h${level + 1}>`);
      i++;
    } else if (line.startsWith("|") && lines[i + 1]?.startsWith("|---")) {
      const row = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(line);
      const body = [];
      for (i += 2; i < lines.length && lines[i].startsWith("|"); i++) body.push(row(lines[i]));
      out.push(`<table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (/^- /.test(line)) {
      const items = [];
      for (; i < lines.length && /^- /.test(lines[i]); i++) items.push(lines[i].slice(2));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
    } else if (!line.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(#{1,6} |- |```|\|)/.test(lines[i]); i++) para.push(lines[i]);
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("");
}

export async function renderDocument(force = false) {
  const page = $("docPage");
  if (!S.project || (!force && loaded === S.project.revision && page.dataset.ready)) return;
  const data = await act(() => api("/api/document"));
  if (!data) return;
  loaded = S.project.revision;
  markdown = data.markdown;
  page.dataset.ready = "1";
  page.innerHTML = `<div class="doc-bar"><span class="hint">Документ собирается из карточек и банков и обновляется сам. Всё предложенное, но не принятое, помечено «(предложено)».</span><span class="spacer"></span>
      <button id="docCopy">Копировать</button><button id="docDownload">Скачать .md</button><button class="primary" id="docSave" title="Записать файл «Документ.md» в папку проекта">Сохранить в папку проекта</button></div>
    <article class="doc">${markdown.trim() ? renderMarkdown(markdown) : '<div class="empty">Документ пока пуст: он заполнится по мере работы на холсте.</div>'}</article>`;
  $("docCopy").onclick = () => navigator.clipboard.writeText(markdown).then(() => toast("Скопировано"), () => toast("Не удалось скопировать"));
  $("docDownload").onclick = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([markdown], {type: "text/markdown;charset=utf-8"}));
    link.download = "Документ.md";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  $("docSave").onclick = () => act(async () => { const r = await api("/api/document/save", {}); toast("Сохранено: " + r.path); });
}

export function resetDocument() {
  loaded = -1;
  const page = $("docPage");
  if (page) page.dataset.ready = "";
}
