/* Вкладка «Банк»: общий список знаний проекта — конкуренты, факты из анализа с источниками и ваши требования. */

import {$, S, act, api, emit, esc, records} from "./core.js";

const link = (text) => (/^https?:/i.test(text) ? `<a href="${esc(text)}" target="_blank" rel="noopener">${esc(text.replace(/^https?:\/\/(www\.)?/i, "").slice(0, 40))}</a>` : esc(text));

function section(title, hint, body, form) {
  return `<h2>${title}</h2><p class="hint">${hint}</p>${body}${form}`;
}

let last = "";
export function renderBank(force = false) {
  const page = $("bankPage");
  if (!page || !S.project) return;
  if (!force && page.contains(document.activeElement) && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  const comps = records("competitor"), facts = records("fact"), reqs = records("requirement");
  const compRows = comps.map((r) => `<tr><td>${r.data.url ? `<a href="${esc(r.data.url)}" target="_blank" rel="noopener">${esc(r.data.name || r.key)}</a>` : esc(r.data.name || r.key)}</td>
    <td>${esc(r.data.why || "")}</td><td>${r.data.state === "proposed" ? '<span class="tag warn">предложен</span>' : '<span class="tag ok">принят</span>'}</td>
    <td class="acts">${r.data.state === "proposed" ? `<button data-b="bank_update" data-id="${r.id}" data-state="accepted">Принять</button>` : ""}<button class="danger" data-b="bank_remove" data-id="${r.id}">Удалить</button></td></tr>`).join("");
  const factRows = facts.map((r) => {
    const owner = comps.find((c) => c.key === r.data.competitor);
    return `<tr><td><span class="chip">${esc(r.data.kind || "факт")}</span></td><td><input data-edit="${r.id}" value="${esc(r.data.text || "")}"></td>
      <td>${owner ? esc(owner.data.name) : '<span class="hint">вручную</span>'}</td><td>${(r.sources || []).slice(0, 2).map(link).join("<br>") || ""}</td>
      <td class="acts"><button class="danger" data-b="bank_remove" data-id="${r.id}">Удалить</button></td></tr>`;
  }).join("");
  const reqRows = reqs.map((r) => `<tr><td><input data-edit="${r.id}" value="${esc(r.data.text || "")}"></td>
    <td class="acts"><button class="danger" data-b="bank_remove" data-id="${r.id}">Удалить</button></td></tr>`).join("");
  const html = `<div class="page">
    ${section("Требования", "Что важно для будущей автоматизации. Агенты учитывают это на всех шагах. Можно дописать в любой момент.",
      `<table class="bank">${reqRows || '<tr><td class="hint">Требований пока нет.</td></tr>'}</table>`,
      '<form class="add" data-bform="requirement"><input name="text" placeholder="Например: нужна интеграция с 1С" autocomplete="off"><button>Добавить</button></form>')}
    ${section("Конкуренты", "Сайты бизнесов этой сферы. Удалили конкурента — вместе с ним уходят его факты.",
      `<table class="bank"><tr><th>Бизнес</th><th>Чем занимается</th><th></th><th></th></tr>${compRows || '<tr><td colspan="4" class="hint">Конкурентов пока нет.</td></tr>'}</table>`, "")}
    ${section("Факты", "Что исследователи нашли на сайтах конкурентов, с источниками. Можно править и дописывать.",
      `<table class="bank"><tr><th></th><th>Факт</th><th>Конкурент</th><th>Источник</th><th></th></tr>${factRows || '<tr><td colspan="5" class="hint">Фактов пока нет: они появятся после шага «Анализ».</td></tr>'}</table>`,
      '<form class="add" data-bform="fact"><input name="text" placeholder="Свой факт" autocomplete="off"><button>Добавить</button></form>')}</div>`;
  if (html === last && !force) return;
  last = html;
  page.innerHTML = html;
}

export function initBank() {
  const page = $("bankPage");
  page.addEventListener("click", (e) => {
    const el = e.target.closest("[data-b]");
    if (!el) return;
    const {b: action, ...rest} = el.dataset;
    act(async () => { await api("/api/act", {action, ...rest}); emit("poll"); });
  });
  page.addEventListener("change", (e) => {
    const id = e.target.dataset.edit;
    if (id) act(async () => { await api("/api/act", {action: "bank_update", id, text: e.target.value}); emit("poll"); });
  });
  page.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-bform]");
    if (!form) return;
    e.preventDefault();
    const text = new FormData(form).get("text").trim();
    if (text) act(async () => { await api("/api/act", {action: "bank_add", type: form.dataset.bform, text}); form.reset(); emit("poll"); });
  });
}
