/* Вкладка «Карта этапа»: одна цепочка шагов (чек-лист слева) и рабочая область выбранного шага (справа).
 *
 * Работа итеративная: любой шаг можно запускать сколько угодно раз, в том числе поверх готового; помощник улучшает и дополняет,
 * а не создаёт заново. Всё, что показано, объявили пакеты-этапы (шаги, виды карточек, банки, диаграммы, проверки):
 * здесь нет ничего про конкретные этапы.
 */

import {$, S, act, api, emit, esc, on, stagePackages, stepVisual, toast} from "./core.js";
import {bindQuestions, questionHtml} from "./dock.js";
import {graphIndex, loadGraph} from "./graph.js";

const M = {sel: "", target: {}, goal: {}, bank: null, bankFetch: 0};
const BUSY = ["running", "deciding", "researching"];
const ACTION_LABEL = {review: "Проверить (ревью)", clarify: "Уточнить неточности", generate: "Построить из текста"};
const ACTION_HINT = {
  review: "Независимый ревьюер оставит замечания карточками; ничего не правит",
  clarify: "Помощник найдёт неточности и задаст вопросы с вариантами",
  generate: "Помощник построит результат из вашего текста (например, диаграмму)",
};
const STATUS = {
  new: ["○", "не начат"], progress: ["◐", "в работе"], asking: ["💬", "ждёт ответа"], working: ["⏳", "работает"],
  approved: ["✓", "утверждён"], stale: ["⚠", "требует пересмотра"], skipped: ["–", "пропущен"],
};
const ISSUE_ICON = {pending: "◔", check: "•", remark: "✎", proposal: "↻", stale: "⚠"};
const RUN_TEXT = {running: "помощник работает…", deciding: "совет решает…", researching: "исследователи ищут…",
  asking: "ждёт вашего ответа", finished: "закончил", error: "ошибка", stopped: "остановлен", idle: ""};

const cardsOf = (kind) => [...graphIndex().cards.values()].filter((c) => c.kind === kind).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
const runOf = (pkg) => S.project?.runs?.[pkg.id];
const isBusy = (pkg) => BUSY.includes(runOf(pkg)?.status);

/* Все шаги всех этапов одной цепочкой, по порядку пакетов. */
function chain() {
  const parts = [...stagePackages()].sort((a, b) => (a.order || 100) - (b.order || 100));
  let n = 0;
  return parts.map((pkg) => {
    const state = S.project?.stages?.[pkg.id] || {steps: []};
    return {
      pkg, skipped: !!state.skipped,
      steps: pkg.stage.steps.map((step) => ({pkg, step, n: ++n, key: pkg.id + ":" + step.id, st: state.steps.find((s) => s.id === step.id) || {}})),
    };
  });
}

function statusOf(item, part) {
  const run = runOf(item.pkg), mine = run && run.step === item.step.id;
  if (part.skipped) return "skipped";
  if (mine && run.status === "asking") return "asking";
  if (mine && BUSY.includes(run.status)) return "working";
  if (item.st.stale) return "stale";
  if (item.st.status === "approved") return "approved";
  return (item.st.cards || item.st.records) ? "progress" : "new";
}

const hasResult = (item) => !!(item.st.cards || item.st.records);
const pendingCount = (item) => (item.st.proposed || 0) + (item.st.records_proposed || 0);
const issuesOf = (item) => item.st.issues || [];

function nextStep(parts) {
  for (const part of parts) {
    if (part.skipped) continue;
    for (const item of part.steps) {
      const status = statusOf(item, part);
      if (status === "approved") continue;
      const title = `«${item.step.title}»`;
      const text = status === "stale" ? `Шаг ${title} требует пересмотра: после ваших правок он мог устареть`
        : status === "asking" ? `Агент ждёт вашего ответа на шаге ${title}`
        : status === "working" ? `Идёт работа над шагом ${title}`
        : status === "new" ? (item.step.actions.includes("suggest") ? `Дальше: ${title} — нажмите «Предложить»`
          : `Дальше: ${title} — ${item.step.produces.includes(item.pkg.stage.roots) ? "нажмите «+ Сфера» вверху и напишите сферу" : "заполните шаг вручную"}`)
        : pendingCount(item) ? `Проверьте и утвердите шаг ${title}`
        : `Шаг ${title} в работе: улучшайте или утверждайте`;
      return {item, text};
    }
  }
  return null;
}

const targetKind = (item) => item.step.target_kind || item.pkg.stage.roots;

function targetValue(item) {
  const cards = cardsOf(targetKind(item)), current = M.target[item.key];
  if (current !== undefined && (current === "" || cards.some((c) => c.id === current))) return current;
  return targetKind(item) === item.pkg.stage.roots && cards.length ? cards[0].id : "";
}

function targetSelect(item) {
  const kind = targetKind(item), cards = cardsOf(kind), value = targetValue(item);
  if (!cards.length) return `<div class="ws-warn">Нужна карточка «${esc(kind)}»: ${kind === item.pkg.stage.roots ? "нажмите «+ Сфера» вверху" : "сначала создайте такие карточки"}.</div>`;
  return `<label class="ws-target">Для чего: ${esc(kind)}<select data-target="${esc(item.key)}">${kind === item.pkg.stage.roots ? "" : '<option value="">все подходящие</option>'}${cards.map((c) =>
    `<option value="${c.id}"${c.id === value ? " selected" : ""}>${esc(c.title.slice(0, 60))}</option>`).join("")}</select></label>`;
}

function warnings(parts, part, item) {
  const out = [];
  for (const need of item.step.needs) {
    const dep = part.steps.find((s) => s.step.id === need);
    if (dep && statusOf(dep, part) !== "approved") out.push(`Желательно сначала утвердить шаг «${esc(dep.step.title)}» <a href="#" data-open="${esc(dep.key)}">перейти</a>`);
  }
  const index = parts.indexOf(part);
  if (index > 0 && item === part.steps[0]) {
    const before = parts[index - 1];
    const open = before.steps.find((s) => statusOf(s, before) !== "approved");
    if (!before.skipped && open) {
      out.push(`Часть «${esc(before.pkg.name)}» не завершена: предложения будут без опоры на её результат. `
        + `<a href="#" data-open="${esc(open.key)}">Вернуться</a> · <a href="#" data-skip="${before.pkg.id}">Пропустить</a>`);
    }
  }
  return out.map((w) => `<div class="ws-warn">${w}</div>`).join("");
}

// ---------------------------------------------------------------------- чек-лист

function autoBar(part) {
  const roots = cardsOf(part.pkg.auto.targets), busy = isBusy(part.pkg);
  return `<div class="auto-row"><b>${esc(part.pkg.name)}</b>
    <select data-auto-target="${part.pkg.id}" ${roots.length ? "" : "disabled"}><option value="">все (${roots.length})</option>${roots.map((c) => `<option value="${c.id}"${M["auto-" + part.pkg.id] === c.id ? " selected" : ""}>${esc(c.title.slice(0, 30))}</option>`).join("")}</select>
    <button data-auto="${part.pkg.id}" ${roots.length && !busy ? "" : "disabled"}>⚡ Авто</button></div>`;
}

function checklist(parts, selected) {
  const autos = parts.filter((p) => p.pkg.auto && !p.skipped);
  return `<nav class="checklist">${parts.map((part, pi) => {
    const done = part.steps.filter((s) => statusOf(s, part) === "approved").length;
    return `<div class="cl-part${part.skipped ? " skipped" : ""}">
      <div class="cl-head"><b>Часть ${pi + 1}. ${esc(part.pkg.name)}</b>
        <span class="hint">${part.skipped ? "пропущена" : `${done} из ${part.steps.length}`}</span>
        ${part.skipped ? `<button class="link" data-skip="${part.pkg.id}" data-skip-off>Вернуть</button>` : `<button class="link" data-skip="${part.pkg.id}" title="Часть можно пропустить: она не обязательна">Пропустить</button>`}</div>
      ${part.steps.map((item) => {
        const status = statusOf(item, part), [icon, label] = STATUS[status];
        const issues = issuesOf(item).length;
        return `<a href="#" class="cl-step s-${status}${selected && selected.key === item.key ? " sel" : ""}" data-open="${esc(item.key)}" title="${esc(label)}">
          <span class="cl-icon">${icon}</span><span class="cl-text"><b>${item.n}. ${esc(item.step.title)}</b>
          <span class="hint">${esc(label)}${item.st.runs ? ` · прогонов: ${item.st.runs}` : ""}</span></span>
          ${issues && !part.skipped && (hasResult(item) || item.st.stale) ? `<span class="cl-badge" title="Открытых вопросов: ${issues}">${issues}</span>` : ""}</a>`;
      }).join("")}</div>`;
  }).join("")}
    ${autos.length ? `<div class="cl-auto"><div class="hint">«Авто» проходит все шаги части без ваших вопросов; на развилках решает совет. Результат остаётся предложенным; повторный запуск улучшает имеющееся.</div>${autos.map(autoBar).join("")}</div>` : ""}</nav>`;
}

// ---------------------------------------------------------------------- рабочая область

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

function producedList(step) {
  const cards = step.produces.flatMap((k) => cardsOf(k)).slice(0, 60);
  if (!cards.length) return '<div class="hint">Карточек этого шага пока нет.</div>';
  return `<div class="produced">${cards.map((c) => `
    <div class="prow"><span class="chip">${esc(c.kind)}</span>
      <a href="#" data-show="${c.id}" title="Показать на графе и править">${esc(c.title)}</a>
      ${c.status === "proposed" ? '<span class="chip todo">предложена</span>' : ""}
      ${c.decision?.by === "council" ? `<span class="chip agent" title="${esc(c.decision.rationale || "")}">решил совет</span>` : ""}
      <span class="spacer"></span>
      ${c.status === "proposed" ? `<button data-accept-card="${c.id}" title="Принять">✓</button>` : ""}<button class="danger" data-del-card="${c.id}" title="Удалить">✕</button></div>`).join("")}</div>`;
}

function issueRow(issue, item) {
  const buttons = [];
  if (issue.type === "remark") buttons.push(`<button data-show-btn="${issue.card}">Показать</button><button class="danger" data-del-card="${issue.card}" title="Учтено / убрать">✕</button>`);
  if (issue.type === "proposal") buttons.push(`<button data-apply="${issue.card}">✓ Применить</button><button class="danger" data-del-card="${issue.card}" title="Отклонить">✕</button>`);
  if (issue.type === "stale") buttons.push(`<button data-stale="propose" data-open="${esc(item.key)}">Предложить правки</button><button data-stale="clear" data-open="${esc(item.key)}">Пересмотрено</button>`);
  if (issue.type === "pending") buttons.push(`<button data-accept-all="${esc(item.key)}">Принять всё</button>`);
  return `<li class="issue t-${issue.type}"><span class="i-icon">${ISSUE_ICON[issue.type] || "•"}</span><span class="i-text">${esc(issue.text)}</span><span class="i-act">${buttons.join("")}</span></li>`;
}

function primaryButtons(item, ctx) {
  const {busy, asking, results, pending, noTarget} = ctx;
  const suggest = (cls, label, hint) => `<button class="${cls}" data-act="suggest" data-key="${esc(item.key)}"${noTarget ? " disabled" : ""} title="${esc(hint)}">${label}</button>`;
  if (busy) return '<button class="primary big" disabled>Помощник работает…</button>';
  if (asking) return '<button class="primary big" disabled>Ответьте на вопрос ниже</button>';
  if (!results) return suggest("primary big", "Предложить", "Помощник предложит варианты и создаст предложенные карточки");
  const improve = suggest(pending ? "" : "primary big", "Улучшить", "Ещё один прогон: помощник дополнит и улучшит результат, ничего не дублируя");
  if (pending) return `<button class="primary big" data-accept-approve="${esc(item.key)}" title="Принять всё предложенное на шаге и утвердить его">Принять предложенное и утвердить</button>${improve}`;
  return improve;
}

function workspace(parts, part, item) {
  const {pkg, step} = item, st = item.st, status = statusOf(item, part);
  const run = runOf(pkg), busy = isBusy(pkg);
  const asking = !!(run && run.status === "asking" && run.question && run.step === step.id);
  const askingElsewhere = !!(run && run.status === "asking" && run.question && run.step !== step.id);
  const [, label] = STATUS[status];
  const noTarget = !cardsOf(targetKind(item)).length;
  const canSuggest = step.actions.includes("suggest");
  const primary = canSuggest ? primaryButtons(item, {busy, asking, results: hasResult(item), pending: pendingCount(item), noTarget}) : "";
  const more = step.actions.filter((a) => a !== "suggest").map((a) =>
    `<button data-act="${a}" data-key="${esc(item.key)}" title="${esc(ACTION_HINT[a])}"${busy || noTarget ? " disabled" : ""}>${ACTION_LABEL[a]}</button>`).join("");
  const issues = issuesOf(item);
  const visual = stepVisual(pkg.id, step.id);
  const questionBox = asking ? `<div class="ws-question">${questionHtml({...run.question, deferred: false})}</div>` : "";
  return `<section class="workspace" data-ws="${esc(item.key)}">
    <header class="ws-head"><span class="step-n">${item.n}</span><h2>${esc(step.title)}</h2>
      <span class="step-badge s-${status}">${esc(label)}</span><span class="spacer"></span>
      <span class="hint">прогонов: ${st.runs || 0}</span></header>
    <p class="ws-help">${esc(step.help || step.question)}</p>
    ${warnings(parts, part, item)}
    ${askingElsewhere ? `<div class="ws-warn">Агент ждёт ответа на другом шаге: <a href="#" data-open="${esc(pkg.id + ":" + run.step)}">открыть</a></div>` : ""}
    ${st.stale ? `<div class="ws-warn">⚠ ${esc(st.stale.reason)}</div>` : ""}
    ${!canSuggest && step.produces.includes(pkg.stage.roots) ? '<div class="ws-warn">Эту карточку пишете вы: кнопка «+ Сфера» вверху. Помощник может только проверить формулировку («Ещё»).</div>' : ""}
    ${step.actions.length ? `<div class="ws-act">
      ${targetSelect(item)}
      ${canSuggest ? `<label class="ws-goal">Что улучшить (необязательно)<textarea data-goal="${esc(item.key)}" rows="2" placeholder="Например: добавь роль врача; разбей шаг 3 на два; убери дубли">${esc(M.goal[item.key] || "")}</textarea></label>` : ""}
      <div class="ws-buttons">${primary}
        ${more ? `<details class="more"><summary>Ещё</summary><div class="more-menu">${more}</div></details>` : ""}
        ${busy ? '<button data-stop>■ Стоп</button>' : ""}</div></div>` : ""}
    ${questionBox}
    ${step.bank ? `<h3>${step.bank.type === "competitor" ? "Список конкурентов" : "Записи банка"}</h3>${bankTable(step)}` : ""}
    ${visual ? `<h3>${esc(visual.title || "Диаграмма")}</h3><div id="visualBox" class="visual-box"></div>` : ""}
    ${step.produces.length ? `<h3>Результат шага</h3>${producedList(step)}` : ""}
    <h3>Что ещё можно улучшить${issues.length ? ` · ${issues.length}` : ""}</h3>
    ${issues.length ? `<ul class="issues">${issues.map((i) => issueRow(i, item)).join("")}</ul>` : '<div class="hint">Открытых вопросов нет: шаг в порядке. Улучшать его можно в любой момент.</div>'}
    <footer class="ws-foot">${status === "approved"
      ? `<button data-gate="reopen" data-key="${esc(item.key)}" title="Снять отметку «устраивает», чтобы править шаг">Снять утверждение</button>`
      : `<button class="primary" data-gate="approve" data-key="${esc(item.key)}"${step.requires && st.required && !st.required.ok ? ' disabled title="Сначала отметьте нужное в карточках"' : ' title="Отметить, что шаг сейчас устраивает"'}>Утвердить шаг</button>`}
      <span class="hint">Утверждение не финал: его можно снять и улучшать шаг дальше.</span></footer>
  </section>`;
}

function runLine(parts, currentPkg) {
  return parts.map((part) => {
    const run = runOf(part.pkg);
    if (!run || run.status === "idle") return "";
    if (run.status === "finished" && part.pkg.id !== currentPkg) return "";       // итог прошлого прогона — только у открытой части
    const step = run.step ? part.pkg.stage.steps.find((s) => s.id === run.step) : null;
    const what = run.auto ? "автоматический режим" : run.role === "proposer" ? "предложение правок" : run.role === "reviewer" ? "ревью" : "помощник";
    return `<div class="runline s-${run.status}"><span class="status s-${run.status}">${esc(RUN_TEXT[run.status] || run.status)}</span>
      <span class="hint">${esc(part.pkg.name)} · ${esc(what)}${step ? ` · шаг «${esc(step.title)}»` : ""}${run.cost ? ` · $${run.cost.toFixed(3)}` : ""}</span>
      ${run.error ? `<span class="err-inline">${esc(run.error)}</span>` : ""}
      ${run.status === "finished" && run.summary ? `<span class="hint">— ${esc(run.summary.replace(/\s+/g, " ").slice(0, 160))}</span>` : ""}
      <span class="spacer"></span>${BUSY.includes(run.status) ? `<button data-stop="${part.pkg.id}">■ Стоп</button>` : ""}</div>`;
  }).join("");
}

export function selectStep(packageId, stepId) {
  M.sel = packageId + ":" + stepId;
  M.bank = null;
  renderMap(true);
}

let lastHtml = "";
export function renderMap(force = false) {
  const root = $("mapPage");
  if (!root || !S.project) return;
  const active = document.activeElement;
  if (!force && root.contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;   // не сбиваем ввод
  const parts = chain();
  if (!parts.length) { root.innerHTML = '<div class="empty">Пакеты-этапы не установлены.</div>'; return; }
  const all = parts.flatMap((p) => p.steps.map((s) => [p, s]));
  const next = nextStep(parts);
  if (!all.some(([, s]) => s.key === M.sel)) M.sel = (next ? next.item : all[0][1]).key;   // по умолчанию — «дальше» или первый шаг
  const [part, item] = all.find(([, s]) => s.key === M.sel);
  S.pkg = item.pkg.id;
  needBank(item.step);
  const html = `
    <div class="next-banner">${next ? `<span class="nb-icon">➜</span><span>${esc(next.text)}</span>${next.item.key !== item.key ? `<button data-open="${esc(next.item.key)}">Открыть</button>` : ""}`
      : '<span class="nb-icon">✓</span><span>Все шаги утверждены. Можно улучшать любой шаг: результат остаётся согласованным с соседними.</span>'}</div>
    ${runLine(parts, item.pkg.id)}
    <div class="flow-body">${checklist(parts, item)}${workspace(parts, part, item)}</div>`;
  if (html === lastHtml && !force) return;
  lastHtml = html;
  const scroll = root.querySelector(".workspace")?.scrollTop ?? 0, listScroll = root.scrollTop;
  root.innerHTML = html;
  root.scrollTop = listScroll;
  const ws = root.querySelector(".workspace");
  if (ws) ws.scrollTop = scroll;
  const visual = stepVisual(item.pkg.id, item.step.id);
  if (visual?.module?.visual && $("visualBox")) visual.module.visual($("visualBox"), {graph: S.graph, esc});
  const box = root.querySelector(".ws-question");
  if (box) bindQuestions(box);
}

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

// ---------------------------------------------------------------------- действия

function find(k) {
  const [id, stepId] = String(k).split(":");
  const part = chain().find((p) => p.pkg.id === id);
  return part && {part, item: part.steps.find((s) => s.step.id === stepId)};
}

async function approve(pkgId, stepId, acceptAllFlag) {
  try {
    await api("/api/stage/approve", {package: pkgId, step: stepId, accept_all: !!acceptAllFlag});
  } catch (error) {
    if (error.code === "pending" && !acceptAllFlag && confirm(error.message + "\n\nПринять всё предложенное и утвердить шаг?")) {
      await api("/api/stage/approve", {package: pkgId, step: stepId, accept_all: true});
    } else {
      throw error;
    }
  }
  await loadGraph();
  emit("poll");
}

async function acceptAll(item) {
  const ops = item.step.produces.flatMap((k) => cardsOf(k)).filter((c) => c.status === "proposed").map((c) => ({op: "update_card", id: c.id, status: "accepted"}));
  if (ops.length) await api("/api/ops", {ops, note: `Принято предложенное на шаге «${item.step.title}»`});
  if (item.step.bank && M.bank) {
    for (const record of M.bank.records.filter((r) => (r.data || {}).state === "proposed")) {
      await api("/api/bank/save", {name: item.step.bank.name, id: record.id, data: {...record.data, state: "accepted"}});
    }
  }
  await loadGraph();
  emit("poll");
}

function bind() {
  const root = $("mapPage");
  root.addEventListener("input", (e) => { if (e.target.dataset.goal !== undefined) M.goal[e.target.dataset.goal] = e.target.value; });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.target !== undefined) { M.target[t.dataset.target] = t.value; return; }
    if (t.dataset.autoTarget !== undefined) { M["auto-" + t.dataset.autoTarget] = t.value; return; }
    if (t.dataset.bankField) {
      const record = M.bank?.records.find((r) => r.id === t.dataset.id);
      if (!record) return;
      act(async () => { await api("/api/bank/save", {name: M.bank.name, id: record.id, data: {...record.data, [t.dataset.bankField]: t.value}}); emit("poll"); });
    }
  });
  root.addEventListener("submit", (e) => {
    if (!e.target.matches("[data-bank-form]")) return;
    e.preventDefault();
    const {item} = find(M.sel), data = {};
    e.target.querySelectorAll("[data-new]").forEach((el) => { data[el.dataset.new] = el.value.trim(); });
    if (!Object.values(data).some(Boolean)) return;
    const slug = String(data.url || data.name || "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    act(async () => { await api("/api/bank/save", {name: item.step.bank.name, type: item.step.bank.type, key: slug, data}); emit("poll"); });
  });
  root.addEventListener("click", (e) => {
    if (e.target.closest("select, input, textarea, option, summary")) return;
    if (e.target.closest(".question")) return;                                        // вопрос агента обрабатывает свой обработчик
    const el = e.target.closest("button, a");
    if (!el) return;
    const d = el.dataset;
    if (el.matches("a")) e.preventDefault();
    if (d.open && !d.stale) { if (find(d.open)) { M.sel = d.open; M.bank = null; renderMap(true); } return; }
    if (d.show) { emit("goto-graph", d.show); return; }
    if (d.showBtn) { emit("goto-graph", d.showBtn); return; }
    if (d.skip) { act(async () => { await api("/api/stage/skip", {package: d.skip, skipped: !("skipOff" in d)}); emit("poll"); }); return; }
    if (d.act) {
      const f = find(d.key || M.sel);
      const goal = (M.goal[f.item.key] || "").trim();
      M.sel = f.item.key;
      act(async () => {
        await api("/api/run/start", {package: f.item.pkg.id, step: f.item.step.id, action: d.act, target: targetValue(f.item), goal});
        if (d.act === "suggest") M.goal[f.item.key] = "";
        emit("poll");
      });
      return;
    }
    if (d.gate) {
      const f = find(d.key);
      act(async () => {
        if (d.gate === "approve") await approve(f.item.pkg.id, f.item.step.id, false);
        else { await api("/api/stage/reopen", {package: f.item.pkg.id, step: f.item.step.id}); emit("poll"); }
      });
      return;
    }
    if (d.acceptApprove) { const f = find(d.acceptApprove); act(() => approve(f.item.pkg.id, f.item.step.id, true)); return; }
    if (d.acceptAll) { const f = find(d.acceptAll); act(() => acceptAll(f.item)); return; }
    if (d.stale) {
      const f = find(d.open);
      act(async () => {
        if (d.stale === "propose") await api("/api/run/propose", {package: f.item.pkg.id});
        else await api("/api/stage/clear-stale", {package: f.item.pkg.id, step: f.item.step.id});
        emit("poll");
      });
      return;
    }
    if (d.auto) { act(() => api("/api/run/start", {package: d.auto, auto: {targets: M["auto-" + d.auto] ? [M["auto-" + d.auto]] : []}}).then(() => emit("poll"))); return; }
    if ("stop" in d) { const id = d.stop || find(M.sel).item.pkg.id; act(async () => { await api("/api/run/stop", {package: id}); emit("poll"); }); return; }
    if (d.apply) { act(async () => { await api("/api/proposals/apply", {id: d.apply}); await loadGraph(); toast("Правка применена"); emit("poll"); }); return; }
    if (d.acceptCard) { act(async () => { await api("/api/ops", {ops: [{op: "update_card", id: d.acceptCard, status: "accepted"}]}); await loadGraph(); emit("poll"); }); return; }
    if (d.delCard) { act(async () => { await api("/api/ops", {ops: [{op: "delete_card", id: d.delCard}]}); await loadGraph(); emit("poll"); }); return; }
    if (d.bankAccept) {
      const record = M.bank?.records.find((r) => r.id === d.bankAccept);
      if (record) act(async () => { await api("/api/bank/save", {name: M.bank.name, id: record.id, data: {...record.data, state: "accepted"}}); emit("poll"); });
      return;
    }
    if (d.bankDel) { act(async () => { await api("/api/bank/remove", {name: M.bank.name, id: d.bankDel}); emit("poll"); }); }
  });
  on("graph", () => renderMap());
}

let bound = false;
export function initMap() {
  if (bound) return;
  bound = true;
  bind();
}
