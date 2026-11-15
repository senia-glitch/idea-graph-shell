/* Вкладка «Карта этапа»: цепочка шагов этапа, ворота «утвердить», помощник на каждом шаге.
 *
 * Всё, что показано, объявил сам пакет-этап (шаги, виды карточек, банки, диаграммы): здесь нет ничего про
 * конкретные этапы. Помощник вызывается в любой момент и ничего не диктует: решает человек.
 */

import {$, S, act, api, emit, esc, on, stagePackages, stepVisual, toast} from "./core.js";
import {graphIndex, loadGraph} from "./graph.js";

const M = {pkg: "", step: "", target: {}, bank: null, bankFetch: 0};
const ACTIONS = {suggest: "Предложить", review: "Проверить", clarify: "Уточнить", generate: "Сгенерировать"};
const ACTION_HINTS = {
  suggest: "Помощник предложит варианты и создаст предложенные карточки",
  review: "Независимый ревьюер оставит замечания карточками; ничего не правит",
  clarify: "Помощник найдёт неточности и задаст вопросы с вариантами",
  generate: "Помощник построит результат из вашего текста (например, диаграмму)",
};
const BUSY = ["running", "deciding", "researching"];
const RUN_TEXT = {running: "помощник работает…", deciding: "совет решает…", researching: "исследователи ищут…", asking: "ждёт вашего ответа в чате справа",
  finished: "закончил", error: "ошибка", stopped: "остановлен", idle: ""};
let lastHtml = "";

const cardsOf = (kind) => [...graphIndex().cards.values()].filter((c) => c.kind === kind).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
const stateOf = (pkg, id) => (S.project?.stages?.[pkg.id]?.steps || []).find((s) => s.id === id) || {};
const targetKind = (pkg, step) => step.target_kind || pkg.stage.roots;

function currentPackage() {
  const list = stagePackages();
  if (!list.length) return null;
  if (!list.some((p) => p.id === M.pkg)) { M.pkg = list[0].id; M.step = ""; M.bank = null; }
  if (S.pkg !== M.pkg && M.synced !== M.pkg) { S.pkg = M.pkg; M.synced = M.pkg; emit("state"); }   // правая панель показывает чат этого же этапа
  return list.find((p) => p.id === M.pkg);
}

function targetValue(pkg, step) {
  const kind = targetKind(pkg, step), cards = cardsOf(kind);
  if (M.target[step.id] !== undefined && (M.target[step.id] === "" || cards.some((c) => c.id === M.target[step.id]))) return M.target[step.id];
  return kind === pkg.stage.roots && cards.length ? cards[0].id : "";
}

function targetSelect(pkg, step) {
  const kind = targetKind(pkg, step), cards = cardsOf(kind), value = targetValue(pkg, step);
  if (!cards.length) return `<div class="hint">Нужна карточка «${esc(kind)}»</div>`;
  return `<select data-target="${step.id}" title="Для какой карточки «${esc(kind)}» действовать">${kind === pkg.stage.roots ? "" : '<option value="">все подходящие</option>'}${cards.map((c) =>
    `<option value="${c.id}"${c.id === value ? " selected" : ""}>${esc(c.title.slice(0, 50))}</option>`).join("")}</select>`;
}

function stepMeta(step, st) {
  const bits = [];
  if (step.produces_bank) bits.push(`записей: ${st.records ?? 0}` + (st.records_proposed ? ` (предложено ${st.records_proposed})` : ""));
  if (step.produces.length) bits.push(`карточек: ${st.cards ?? 0}` + (st.proposed ? ` (предложено ${st.proposed})` : ""));
  if (step.requires && st.required) bits.push(`отмечено: ${st.required.count} из ${st.required.min}`);
  return bits.join(" · ");
}

function stepCard(pkg, step, index, busy) {
  const st = stateOf(pkg, step.id);
  const status = st.status || "open";
  const stale = st.stale;
  const blocked = busy ? " disabled" : "";
  const noTarget = !cardsOf(targetKind(pkg, step)).length && targetKind(pkg, step) !== "";
  const actions = step.actions.map((a) => `<button data-act="${a}" data-step-id="${step.id}" title="${esc(ACTION_HINTS[a])}"${blocked}${noTarget ? " disabled" : ""}>${ACTIONS[a]}</button>`).join("");
  const gate = status === "approved"
    ? `<button data-gate="reopen" data-step-id="${step.id}" title="Снять утверждение, чтобы править шаг">Вернуть в работу</button>`
    : `<button class="primary" data-gate="approve" data-step-id="${step.id}"${step.requires && st.required && !st.required.ok ? ' disabled title="Сначала отметьте нужное в карточках"' : ' title="Утвердить результат шага"'}>Утвердить</button>`;
  return `<div class="step ${status}${M.step === step.id ? " sel" : ""}${stale ? " stale" : ""}" data-step="${step.id}">
    <div class="step-head"><span class="step-n">${index + 1}</span><b>${esc(step.title)}</b>
      <span class="step-badge ${stale ? "warn" : status}">${stale ? "требует пересмотра" : status === "approved" ? "утверждён" : "в работе"}</span></div>
    <div class="step-q">${esc(step.question)}</div>
    <div class="step-meta">${esc(stepMeta(step, st)) || "&nbsp;"}</div>
    ${stale ? `<div class="step-stale">⚠ ${esc(stale.reason)}<div class="row-actions"><button data-stale="propose" data-step-id="${step.id}"${blocked}>Предложить правки</button><button data-stale="clear" data-step-id="${step.id}">Пересмотрено</button></div></div>` : ""}
    ${actions ? `<div class="step-target">${targetSelect(pkg, step)}</div><div class="step-actions">${actions}</div>` : ""}
    <div class="step-gate">${gate}</div>
  </div>`;
}

function bankTable(step) {
  const spec = step.bank, data = M.bank && M.bank.name === spec.name ? M.bank.records : null;
  if (!data) return '<div class="hint">Загружаю банк…</div>';
  const fields = spec.fields || [];
  const cell = (record, f) => {
    const value = (record.data || {})[f.key];
    if (f.list) return `<span class="hint">${esc((Array.isArray(value) ? value : []).map((x) => (typeof x === "object" ? x.name : x)).join(", ").slice(0, 160) || "—")}</span>`;
    if (f.values) return `<select data-bank-field="${f.key}" data-id="${record.id}">${["", ...f.values].map((v) => `<option${(value || "") === v ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
    return `<input data-bank-field="${f.key}" data-id="${record.id}" value="${esc(value ?? "")}">`;
  };
  const rows = data.map((r) => `<tr class="${(r.data || {}).state === "proposed" ? "proposed" : ""}">
    ${fields.map((f) => `<td>${cell(r, f)}</td>`).join("")}
    <td class="bank-src">${(r.sources || []).slice(0, 3).map((s) => (/^https?:/i.test(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener">источник</a>` : esc(s))).join(" ") || '<span class="hint">без источника</span>'}</td>
    <td class="bank-act">${(r.data || {}).state === "proposed" ? `<button data-bank-accept="${r.id}" title="Принять запись">✓</button>` : '<span class="hint">принято</span>'}<button class="danger" data-bank-del="${r.id}" title="Удалить запись">✕</button></td></tr>`).join("");
  const add = fields.filter((f) => !f.list).map((f) => f.values
    ? `<select data-new="${f.key}">${f.values.map((v) => `<option>${esc(v)}</option>`).join("")}</select>`
    : `<input data-new="${f.key}" placeholder="${esc(f.title)}">`).join("");
  return `<table class="bank"><thead><tr>${fields.map((f) => `<th>${esc(f.title)}</th>`).join("")}<th>Источники</th><th></th></tr></thead><tbody>${rows
    || `<tr><td colspan="${fields.length + 2}" class="hint">Записей пока нет. Нажмите «Предложить» или добавьте вручную.</td></tr>`}</tbody></table>
    ${fields.some((f) => !f.list) ? `<form class="bank-add" data-bank-form>${add}<button class="primary">Добавить</button></form>` : ""}`;
}

function producedList(pkg, step) {
  const cards = step.produces.flatMap((k) => cardsOf(k)).slice(0, 60);
  if (!cards.length) return step.produces.length ? '<div class="hint">Карточек этого шага пока нет.</div>' : "";
  return `<div class="lbl">Карточки шага</div><div class="produced">${cards.map((c) => `
    <div class="prow"><span class="chip">${esc(c.kind)}</span>
      <a href="#" data-show="${c.id}" title="Показать на графе">${esc(c.title)}</a>
      ${c.status === "proposed" ? '<span class="chip todo">предложена</span>' : ""}
      <span class="spacer"></span>
      ${c.status === "proposed" ? `<button data-accept-card="${c.id}" title="Принять">✓</button>` : ""}<button class="danger" data-del-card="${c.id}" title="Удалить">✕</button></div>`).join("")}</div>`;
}

function remarks() {
  const items = [...cardsOf("замечание"), ...cardsOf("правка")];
  if (!items.length) return "";
  return `<h3>Замечания и предложенные правки · ${items.length}</h3><div class="produced">${items.map((c) => `
    <div class="prow remark"><span class="chip ${c.kind === "правка" ? "agent" : "warn"}">${esc(c.kind)}</span>
      <div class="rtext"><a href="#" data-show="${c.id}"><b>${esc(c.title)}</b></a><div class="hint">${esc(c.kind === "правка" ? (c.attrs?.reason || "") + " → " + String(c.attrs?.new || "").slice(0, 100) : (c.body || "").slice(0, 200))}</div></div>
      ${c.kind === "правка" ? `<button data-apply="${c.id}" title="Применить правку к карточке">✓ Применить</button>` : ""}<button class="danger" data-del-card="${c.id}" title="${c.kind === "правка" ? "Отклонить" : "Учтено / убрать"}">✕</button></div>`).join("")}</div>`;
}

function runLine(pkg) {
  const run = S.project?.runs?.[pkg.id];
  if (!run || run.status === "idle") return "";
  const step = run.step ? pkg.stage.steps.find((s) => s.id === run.step) : null;
  const what = run.auto ? "автоматический режим" : run.role === "proposer" ? "предложение правок" : run.action ? (ACTIONS[run.action] || run.action).toLowerCase() : "диалог";
  const busy = BUSY.includes(run.status);
  return `<div class="runline s-${run.status}"><span class="status s-${run.status}">${esc(RUN_TEXT[run.status] || run.status)}</span>
    <span class="hint">${esc(what)}${step ? ` · шаг «${esc(step.title)}»` : ""}${run.cost ? ` · $${run.cost.toFixed(3)}` : ""}</span>
    ${run.error ? `<span class="err-inline">${esc(run.error)}</span>` : ""}
    ${run.status === "finished" && run.summary ? `<span class="hint">— ${esc(run.summary.slice(0, 200))}</span>` : ""}
    <span class="spacer"></span>${busy ? '<button data-stop>■ Стоп</button>' : ""}</div>`;
}

function autoBar(pkg, busy) {
  if (!pkg.auto) return "";
  const roots = cardsOf(pkg.auto.targets);
  return `<div class="auto-bar"><b>Автоматический режим</b>
    <span class="hint">все шаги без вопросов: на развилках решает совет из трёх агентов; результат остаётся предложенным</span>
    <span class="spacer"></span>
    <select data-auto-target ${roots.length ? "" : "disabled"}><option value="">все (${roots.length})</option>${roots.map((c) => `<option value="${c.id}"${M.autoTarget === c.id ? " selected" : ""}>${esc(c.title.slice(0, 40))}</option>`).join("")}</select>
    <button data-auto ${roots.length && !busy ? "" : "disabled"}>⚡ Авто</button></div>`;
}

export function renderMap(force = false) {
  const root = $("mapPage");
  if (!root || !S.project) return;
  const active = document.activeElement;
  if (!force && root.contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;   // не сбиваем ввод
  const pkg = currentPackage();
  if (!pkg) { root.innerHTML = '<div class="empty">Пакеты-этапы не установлены.</div>'; return; }
  const run = S.project.runs?.[pkg.id];
  const busy = !!run && BUSY.includes(run.status);
  const steps = pkg.stage.steps;
  if (!M.step || !steps.some((s) => s.id === M.step)) M.step = steps[0].id;
  const step = steps.find((s) => s.id === M.step);
  needBank(step);
  const html = `
    <div class="map-top">
      ${stagePackages().length > 1 ? `<div class="pkgtabs">${stagePackages().map((p) => `<button data-pkg="${p.id}" class="${p.id === pkg.id ? "on" : ""}">${esc(p.name)}</button>`).join("")}</div>` : ""}
      <div class="map-title"><h2>${esc(pkg.name)}</h2><div class="hint">${esc(pkg.description)}</div></div>
    </div>
    ${autoBar(pkg, busy)}
    ${runLine(pkg)}
    <div class="steps">${steps.map((s, i) => (i ? '<span class="step-arrow">→</span>' : "") + stepCard(pkg, s, i, busy)).join("")}</div>
    <section class="step-detail"><h3>${esc(step.title)}</h3><div class="hint">${esc(step.question)}</div>
      ${step.bank ? `<div class="lbl">${step.bank.type === "competitor" ? "Список конкурентов" : "Записи банка"}</div>${bankTable(step)}` : ""}
      ${stepVisual(pkg.id, step.id) ? `<div class="lbl">${esc(stepVisual(pkg.id, step.id).title || "Диаграмма")}</div><div id="visualBox" class="visual-box"></div>` : ""}
      ${producedList(pkg, step)}
    </section>
    ${remarks()}`;
  if (html === lastHtml && !force) return;
  lastHtml = html;
  root.innerHTML = html;
  const visual = stepVisual(pkg.id, step.id);
  if (visual?.module?.visual && $("visualBox")) visual.module.visual($("visualBox"), {graph: S.graph, esc});
}

/* Записи банка шага: подгружаем, когда они нужны, и обновляем при изменениях проекта. */
function needBank(step) {
  if (!step.bank) return;
  const stamp = S.project.seq;
  if (M.bank && M.bank.name === step.bank.name && M.bankFetch === stamp) return;
  M.bankFetch = stamp;
  api("/api/bank?name=" + encodeURIComponent(step.bank.name)).then((data) => {
    M.bank = {name: step.bank.name, records: data.records};
    renderMap(true);
  }).catch(() => {});
}

async function run(body) {
  await api("/api/run/start", body);
  emit("poll");
}

async function approve(pkg, stepId) {
  try {
    await api("/api/stage/approve", {package: pkg.id, step: stepId});
  } catch (error) {
    if (error.code === "pending" && confirm(error.message + "\n\nПринять всё предложенное и утвердить шаг?")) {
      await api("/api/stage/approve", {package: pkg.id, step: stepId, accept_all: true});
    } else {
      throw error;
    }
  }
  await loadGraph();
  emit("poll");
}

function bind() {
  const root = $("mapPage");
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.target !== undefined) { M.target[t.dataset.target] = t.value; return; }
    if (t.dataset.autoTarget !== undefined) { M.autoTarget = t.value; return; }
    if (t.dataset.bankField) {
      const record = M.bank?.records.find((r) => r.id === t.dataset.id);
      if (!record) return;
      act(async () => {
        await api("/api/bank/save", {name: M.bank.name, id: record.id, data: {...record.data, [t.dataset.bankField]: t.value}});
        emit("poll");
      });
    }
  });
  root.addEventListener("submit", (e) => {
    if (!e.target.matches("[data-bank-form]")) return;
    e.preventDefault();
    const pkg = currentPackage(), step = pkg.stage.steps.find((s) => s.id === M.step), data = {};
    e.target.querySelectorAll("[data-new]").forEach((el) => { data[el.dataset.new] = el.value.trim(); });
    if (!Object.values(data).some(Boolean)) return;
    const key = String(data.url || data.name || "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    act(async () => { await api("/api/bank/save", {name: step.bank.name, type: step.bank.type, key, data}); emit("poll"); });
  });
  root.addEventListener("click", (e) => {
    if (e.target.closest("select, input, textarea, option")) return;      // выбор в списках не должен перерисовывать карту
    const el = e.target.closest("button, a[data-show], [data-step]");
    if (!el) return;
    const pkg = currentPackage();
    if (el.matches("a[data-show]")) { e.preventDefault(); emit("goto-graph", el.dataset.show); return; }
    if (el.dataset.pkg) { M.pkg = el.dataset.pkg; M.step = ""; M.bank = null; renderMap(true); return; }
    if (el.dataset.act) {
      const step = pkg.stage.steps.find((s) => s.id === el.dataset.stepId);
      const target = targetValue(pkg, step);
      M.step = step.id;
      act(() => run({package: pkg.id, step: step.id, action: el.dataset.act, target}));
      return;
    }
    if (el.dataset.gate) {
      act(async () => {
        if (el.dataset.gate === "approve") await approve(pkg, el.dataset.stepId);
        else { await api("/api/stage/reopen", {package: pkg.id, step: el.dataset.stepId}); emit("poll"); }
      });
      return;
    }
    if (el.dataset.stale) {
      act(async () => {
        if (el.dataset.stale === "propose") await api("/api/run/propose", {package: pkg.id});
        else await api("/api/stage/clear-stale", {package: pkg.id, step: el.dataset.stepId});
        emit("poll");
      });
      return;
    }
    if ("auto" in el.dataset) { act(() => run({package: pkg.id, auto: {targets: M.autoTarget ? [M.autoTarget] : []}})); return; }
    if ("stop" in el.dataset) { act(async () => { await api("/api/run/stop", {package: pkg.id}); emit("poll"); }); return; }
    if (el.dataset.apply) { act(async () => { await api("/api/proposals/apply", {id: el.dataset.apply}); await loadGraph(); toast("Правка применена"); emit("poll"); }); return; }
    if (el.dataset.acceptCard) { act(async () => { await api("/api/ops", {ops: [{op: "update_card", id: el.dataset.acceptCard, status: "accepted"}]}); await loadGraph(); emit("poll"); }); return; }
    if (el.dataset.delCard) { act(async () => { await api("/api/ops", {ops: [{op: "delete_card", id: el.dataset.delCard}]}); await loadGraph(); emit("poll"); }); return; }
    if (el.dataset.bankAccept) {
      const record = M.bank?.records.find((r) => r.id === el.dataset.bankAccept);
      if (record) act(async () => { await api("/api/bank/save", {name: M.bank.name, id: record.id, data: {...record.data, state: "accepted"}}); emit("poll"); });
      return;
    }
    if (el.dataset.bankDel) { act(async () => { await api("/api/bank/remove", {name: M.bank.name, id: el.dataset.bankDel}); emit("poll"); }); return; }
    const card = e.target.closest("[data-step]");
    if (card && !el.matches("button")) { M.step = card.dataset.step; M.bank = null; renderMap(true); }
  });
  on("graph", () => renderMap());
}

let bound = false;
export function initMap() {
  if (bound) return;
  bound = true;
  bind();
}
