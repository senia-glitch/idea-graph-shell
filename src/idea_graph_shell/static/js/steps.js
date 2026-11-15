/* Левая панель: линейная цепочка шагов. На экране один шаг; каждое предложение агента человек принимает, отклоняет или заменяет своим. */

import {$, S, act, api, cards, childrenOf, emit, esc, records, rolesOf, toast} from "./core.js";
import {sequenceSvg, stepsText, usecaseSvg} from "./diagrams.js";

const U = {picked: {}, text: {}};           // что человек ввёл, но ещё не отправил: переживает перерисовку
const BUSY = ["running", "asking"];
const run = () => S.project?.run;
const busy = () => BUSY.includes(run()?.status);
const dis = () => (busy() ? " disabled" : "");
const accepted = (list) => list.filter((c) => c.status === "accepted");
/* Непринятые сверху, принятые уходят вниз: следующая карточка для решения всегда на виду. Порядок внутри групп сохраняется. */
const pendingFirst = (list) => [...list].sort((a, b) => (a.status === "accepted") - (b.status === "accepted"));

// ---------------------------------------------------------------------- готовность шагов

function done(i) {
  const scenarios = accepted(cards("сценарий"));
  switch (i) {
    case 0: return cards("сфера").length > 0;
    case 1: return records("competitor").some((r) => r.data.state === "accepted");
    case 2: { const a = records("competitor").filter((r) => r.data.state === "accepted"); return a.length > 0 && a.every((r) => r.data.analyzed); }
    case 3: return accepted(cards("роль")).length > 0;
    case 4: return scenarios.length > 0;
    case 5: return scenarios.length > 0 && scenarios.every((s) => childrenOf(s.id, "как есть").length);
    default: return scenarios.length > 0 && scenarios.every((s) => childrenOf(s.id, "решение").length);
  }
}

// ---------------------------------------------------------------------- общие куски

const tag = (text, cls = "") => `<span class="tag ${cls}">${esc(text)}</span>`;
const btn = (label, attrs, cls = "") => `<button class="${cls}" ${attrs}${dis()}>${label}</button>`;
const start = (kind, label, extra = "", cls = "") => btn(label, `data-start="${kind}" ${extra}`, cls);

function row(title, sub, actions, chips = "") {
  return `<div class="row"><div class="t"><b>${title}</b>${chips}${sub ? `<span>${sub}</span>` : ""}</div><div class="acts">${actions}</div></div>`;
}

/* Принять / отклонить для предложенного агентом; удалить для принятого. */
function cardActions(card) {
  return card.status === "proposed"
    ? btn("Принять", `data-act="accept" data-id="${card.id}"`) + btn("Отклонить", `data-act="remove" data-id="${card.id}"`)
    : btn("Удалить", `data-act="remove" data-id="${card.id}"`, "ghost");
}

function addForm(action, placeholder, extra = "", hidden = "") {
  return `<form class="add" data-form="${action}" ${hidden}><input name="title" placeholder="${esc(placeholder)}" autocomplete="off"${dis()}>${extra}<button${dis()}>Добавить</button></form>`;
}

const RUN_STEP = {autopilot: 0, competitors: 1, analysis: 2, roles: 3, scenarios: 4, problems: 5, asis: 5, variants: 6, solution: 6};

function runBlock() {
  const r = run();
  if (!r) return "";
  if (!BUSY.includes(r.status) && RUN_STEP[r.kind] !== S.step) return "";       // итог прошлой работы виден только на своём шаге
  const notes = (r.notes || []).map((n) => `<div class="hint">${esc(n)}</div>`).join("");
  if (r.status === "running") {
    const progress = r.total > 1 ? ` · ${r.done} из ${r.total}` : "";
    return `<div class="runbox"><span class="spin"></span><span>${esc(r.title)}${progress}</span><span class="spacer"></span><button data-stop>Стоп</button></div>${notes}`;
  }
  if (r.status === "asking" && r.question) return questionBlock(r.question) + notes;
  if (r.status === "error") return `<div class="err">${esc(r.error)}</div>${notes}`;
  if (r.status === "done" && (r.summary || notes)) return `<div class="runbox ok"><span>${esc(r.summary || "Готово")}</span></div>${notes}`;
  if (r.status === "stopped") return '<div class="runbox"><span>Остановлено</span></div>';
  return notes;
}

function questionBlock(q) {
  const picked = U.picked[q.id] || [];
  const options = q.options.map((o, i) => `<button class="option${q.recommended.includes(i + 1) ? " rec" : ""}${picked.includes(i + 1) ? " picked" : ""}" data-pick="${i + 1}" data-q="${q.id}">
    <span class="num">${picked.includes(i + 1) ? "✓" : ""}</span><span class="otext"><b>${esc(o.title)}</b>${o.consequence ? `<span class="cons">${esc(o.consequence)}</span>` : ""}
    ${q.recommended.includes(i + 1) ? `<span class="recmark">рекомендует помощник${q.reason ? ": " + esc(q.reason) : ""}</span>` : ""}</span></button>`).join("");
  return `<div class="question"><div class="qtext">${esc(q.question)}</div>
    <div class="hint">Отметьте один или несколько вариантов, можно дописать своё.</div>
    <div class="options">${options}</div>
    <textarea rows="2" data-text="q${q.id}" placeholder="Своё решение или дополнение…">${esc(U.text["q" + q.id] || "")}</textarea>
    <div class="row-actions"><button data-answer="reject" data-q="${q.id}">Ни один не подходит</button><button class="primary" data-answer="send" data-q="${q.id}">Ответить</button></div></div>`;
}

function nav(i) {
  const last = i === S.boot.steps.length - 1;
  return `<div class="bar">${i > 0 ? `<button data-step="${i - 1}">Назад</button>` : ""}<span class="spacer"></span>
    ${last ? "" : `<button class="${done(i) ? "primary" : ""}" data-step="${i + 1}">${done(i) ? "Дальше" : "Пропустить"}</button>`}</div>`;
}

// ---------------------------------------------------------------------- шаги

function stepSphere() {
  const sphere = cards("сфера")[0];
  return `<p class="sub">Какой бизнес вы хотите автоматизировать? Одна короткая фраза, например «парикмахерская».</p>
    <form class="add" data-form="set_sphere"><input name="title" value="${esc(U.text.sphere ?? sphere?.title ?? "")}" data-text="sphere" placeholder="Сфера бизнеса" autocomplete="off"${dis()}><button class="primary"${dis()}>Сохранить</button></form>
    ${sphere ? pilotBlock() : ""}`;
}

function pilotBlock() {
  const has = cards("роль").length || cards("сценарий").length || records("competitor").length;
  const how = has
    ? `<div class="hint">В проекте уже что-то есть. «Довести до согласования»: автопилот принимает и отклоняет то, что ждёт решения, и достраивает недостающее, готовое не трогает.
        «Улучшить уже есть»: сверх этого оценивает сделанное, убирает слабое (в том числе принятое вами), дополняет недостающим и перестраивает диаграммы.</div>
      <div class="top">${start("autopilot", "Довести до согласования", "", "primary")}${start("autopilot", "Улучшить уже есть", 'data-redo="1"')}</div>`
    : `<div class="hint">Проект пуст: автопилот построит всё с нуля.</div><div class="top">${start("autopilot", "Построить автоматически", "", "primary")}</div>`;
  return `<div class="block"><div class="lbl">Автопилот</div>
    <div class="hint">Сначала сильная модель анализирует, что уже есть, и (если границ ещё нет) задаёт до 15 вопросов о границах системы. Затем сама проходит цепочку. Всё можно поправить вручную, «Стоп» останавливает.</div>${how}</div>`;
}

function stepCompetitors() {
  const list = records("competitor").sort((a, b) => (a.data.state === "proposed" ? 0 : 1) - (b.data.state === "proposed" ? 0 : 1));
  const rows = list.map((r) => row(
    r.data.url ? `<a href="${esc(r.data.url)}" target="_blank" rel="noopener">${esc(r.data.name || r.key)}</a>` : esc(r.data.name || r.key), esc(r.data.why || ""),
    r.data.state === "proposed" ? btn("Принять", `data-act="bank_update" data-id="${r.id}" data-state="accepted"`) + btn("Отклонить", `data-act="bank_remove" data-id="${r.id}"`)
      : btn("Удалить", `data-act="bank_remove" data-id="${r.id}"`, "ghost"),
    r.data.state === "proposed" ? tag("предложен", "warn") : tag("принят", "ok")));
  return `<p class="sub">Сайты реальных бизнесов этой сферы — не конструкторы сайтов и не гиганты. Ищут три исследователя.</p>
    <div class="top">${start("competitors", list.length ? "Найти ещё" : "Найти конкурентов", "", list.length ? "" : "primary")}</div>
    ${rows.join("") || '<div class="empty">Пока никого. Нажмите «Найти конкурентов» или добавьте своих; шаг можно пропустить, если конкуренты уже найдены.</div>'}
    <form class="add" data-form="bank_add"><input type="hidden" name="type" value="competitor"><input name="name" placeholder="Название" autocomplete="off"${dis()}><input name="url" placeholder="Сайт" autocomplete="off"${dis()}><button${dis()}>Добавить своего</button></form>`;
}

function stepAnalysis() {
  const list = records("competitor").filter((r) => r.data.state === "accepted");
  const fresh = list.filter((r) => !r.data.analyzed).length;
  const rows = list.map((r) => {
    const n = records("fact").filter((f) => f.data.competitor === r.key).length;
    return row(esc(r.data.name || r.key), esc(r.data.url || ""), "", r.data.analyzed ? tag(`фактов: ${n}`, "ok") : tag("новый", "warn"));
  });
  return `<p class="sub">Исследователи изучают сайты принятых конкурентов; роли, процессы и возможности попадают в банк знаний.
    Если анализ уже проведён, шаг можно пропустить.</p>
    ${list.length ? `<div class="top">${fresh ? start("analysis", `Проанализировать${fresh < list.length ? " новых" : ""} (${fresh})`, "", "primary") : ""}
      ${list.length > fresh ? start("analysis", "Повторить анализ всех", 'data-redo="1"') : ""}</div>` : ""}
    ${rows.join("") || '<div class="empty">Нет принятых конкурентов. Вернитесь на шаг «Конкуренты».</div>'}`;
}

function stepRoles() {
  const list = pendingFirst(cards("роль"));
  const rows = list.map((c) => row(esc(c.title), esc(c.body || ""), cardActions(c), c.status === "proposed" ? tag("предложена", "warn") : ""));
  return `<p class="sub">Кто участвует в бизнес-процессах. Помощник предлагает по банку знаний и сфере; вы принимаете, отклоняете или пишете свои.</p>
    <div class="top">${start("roles", list.length ? "Предложить ещё" : "Предложить роли", "", list.length ? "" : "primary")}</div>
    ${rows.join("") || '<div class="empty">Ролей пока нет.</div>'}${addForm("add_role", "Своя роль")}`;
}

function stepScenarios() {
  const roles = accepted(cards("роль"));
  const list = pendingFirst(cards("сценарий"));
  const blocks = list.map((c) => `<div class="block">${row(esc(c.title), esc(c.body || ""), cardActions(c), c.status === "proposed" ? tag("предложен", "warn") : "")}
    ${usecaseSvg(c.attrs?.usecase)}</div>`);
  const checks = roles.map((r) => `<label class="check"><input type="checkbox" name="roles" value="${esc(r.title)}"${dis()}> ${esc(r.title)}</label>`).join("");
  return `<p class="sub">Ключевые ситуации, в которых роли взаимодействуют. Для каждого сценария строится UML-диаграмма вариантов использования.</p>
    <div class="top">${start("scenarios", list.length ? "Предложить ещё" : "Предложить сценарии", "", list.length ? "" : "primary")}</div>
    ${blocks.join("") || '<div class="empty">Сценариев пока нет.</div>'}
    <form class="add col" data-form="add_scenario"><input name="title" placeholder="Свой сценарий" autocomplete="off"${dis()}>
      ${roles.length ? `<div class="checks">${checks}</div>` : '<span class="hint">Сначала примите роли.</span>'}<button${dis()}>Добавить сценарий</button></form>`;
}

function diagramEditor(scenario, kind, cardKind) {
  const card = childrenOf(scenario.id, cardKind)[0];
  const key = `${kind}:${scenario.id}`;
  const text = U.text[key] ?? stepsText(card?.attrs?.diagram);
  return `${card ? sequenceSvg(card.attrs.diagram) : ""}
    <details class="steps-box"${card ? "" : " open"}><summary>Шаги диаграммы${card ? "" : " (пока нет — напишите свои или сгенерируйте)"}</summary>
      <textarea rows="${Math.max(4, text.split("\n").length + 1)}" data-text="${key}" placeholder="1. Клиент → Администратор: Звонит и просит запись [боль: не дозвониться]&#10;2. Администратор → Клиент: Называет время"${dis()}>${esc(text)}</textarea>
      <div class="hint">Строка: «Кто → Кому: что происходит». После текста можно добавить [боль: что не так]${kind === "solution" ? "; знак в начале строки: + новый, ~ изменён, * автоматизирован, − убран" : ""}.</div>
      <div class="row-actions"><button data-save-steps="${kind}" data-scenario="${scenario.id}"${dis()}>Построить диаграмму по шагам</button></div></details>`;
}

function stepAsis() {
  const scenarios = accepted(cards("сценарий"));
  if (!scenarios.length) return '<div class="empty">Нет принятых сценариев. Вернитесь на шаг «Сценарии».</div>';
  const blocks = scenarios.map((s) => {
    const problems = pendingFirst(childrenOf(s.id, "проблема"));
    const okProblems = accepted(problems).length;
    return `<div class="block"><div class="bhead"><b>${esc(s.title)}</b></div>
      <div class="lbl">Проблемы сценария</div>
      ${problems.map((p) => row(esc(p.title), esc(p.body || ""), cardActions(p), (p.attrs?.importance ? tag(p.attrs.importance, "warn") : "") + (p.status === "proposed" ? tag("предложена", "warn") : ""))).join("")
        || '<div class="hint">Проблем пока нет.</div>'}
      <form class="add" data-form="add_problem" data-scenario="${s.id}"><input name="title" placeholder="Своя проблема" autocomplete="off"${dis()}><button${dis()}>Добавить</button></form>
      <div class="top">${start("problems", "Предложить проблемы", `data-ids="${s.id}"`)}</div>
      <div class="lbl">Диаграмма «как есть»</div>
      ${okProblems ? `<div class="top">${start("asis", childrenOf(s.id, "как есть").length ? "Построить заново" : "Построить диаграмму", `data-ids="${s.id}"`, "primary")}</div>`
        : '<div class="hint">Примите проблемы — по ним помощник построит диаграмму. Или напишите шаги сами.</div>'}
      ${diagramEditor(s, "asis", "как есть")}</div>`;
  });
  return `<p class="sub">Сначала проблемы сценария, затем UML-диаграмма последовательности: как процесс проходит сейчас, с отмеченными проблемами.</p>
    <div class="top">${start("problems", "Предложить проблемы для всех", "", "primary")}</div>${blocks.join("")}`;
}

function stepSolution() {
  const scenarios = accepted(cards("сценарий"));
  if (!scenarios.length) return '<div class="empty">Нет принятых сценариев. Вернитесь на шаг «Сценарии».</div>';
  const blocks = scenarios.map((s) => {
    const problems = accepted(childrenOf(s.id, "проблема")).sort((a, b) => (accepted(childrenOf(a.id, "вариант")).length > 0) - (accepted(childrenOf(b.id, "вариант")).length > 0));
    const solvedCount = problems.filter((p) => accepted(childrenOf(p.id, "вариант")).length).length;
    const items = problems.map((p) => {
      const variants = pendingFirst(childrenOf(p.id, "вариант"));
      return `<div class="sub-block"><div class="lbl">Проблема: ${esc(p.title)}${p.attrs?.importance ? ` ${tag(p.attrs.importance, "warn")}` : ""}</div>
        ${variants.map((v) => row(esc(v.title), esc(v.body || ""),
          v.status === "accepted" ? btn("Удалить", `data-act="remove" data-id="${v.id}"`, "ghost") : btn("Выбрать", `data-act="choose_variant" data-id="${v.id}"`) + btn("Отклонить", `data-act="remove" data-id="${v.id}"`),
          v.status === "accepted" ? tag("выбран", "ok") : "")).join("") || '<div class="hint">Вариантов пока нет.</div>'}
        <form class="add" data-form="add_variant" data-problem="${p.id}"><input name="title" placeholder="Свой вариант решения" autocomplete="off"${dis()}><button${dis()}>Добавить</button></form>
        <div class="top">${start("variants", "Предложить варианты", `data-ids="${p.id}"`)}</div></div>`;
    }).join("");
    return `<div class="block"><div class="bhead"><b>${esc(s.title)}</b></div>
      ${items || '<div class="hint">Нет принятых проблем. Вернитесь на шаг «Как есть».</div>'}
      <div class="lbl">Диаграмма «решение» (как будет)</div>
      ${solvedCount ? `<div class="top">${start("solution", childrenOf(s.id, "решение").length ? "Построить заново" : "Построить диаграмму", `data-ids="${s.id}"`, "primary")}</div>`
        : '<div class="hint">Выберите вариант решения хотя бы для одной проблемы — по выбранным решениям помощник построит диаграмму. Проблемы без решения остаются в ней как есть. Или напишите шаги сами.</div>'}
      ${diagramEditor(s, "solution", "решение")}</div>`;
  });
  const summary = scenarios.map((s) => {
    const problems = accepted(childrenOf(s.id, "проблема"));
    if (!problems.length) return "";
    return `<div class="block sum"><b>${esc(s.title)}</b>${problems.map((p) => {
      const v = accepted(childrenOf(p.id, "вариант"))[0];
      return `<div>• ${esc(p.title)}${p.attrs?.importance ? ` <span class="hint">(${esc(p.attrs.importance)})</span>` : ""}${v ? ` → <b>${esc(v.title)}</b>` : ' <span class="hint">— решения нет</span>'}</div>`;
    }).join("")}</div>`;
  }).join("");
  return `<p class="sub">Для каждой принятой проблемы выберите вариант её решения. По выбранным решениям строится UML-диаграмма последовательности «как будет».</p>
    <div class="top">${start("variants", "Предложить варианты для всех проблем", "", "primary")}</div>${blocks.join("")}
    ${summary ? `<div class="lbl">Итог: что стоит автоматизировать</div>${summary}` : ""}`;
}

const STEP_VIEWS = [stepSphere, stepCompetitors, stepAnalysis, stepRoles, stepScenarios, stepAsis, stepSolution];

// ---------------------------------------------------------------------- отрисовка и действия

let last = "";
export function renderSteps(force = false) {
  const root = $("steps");
  if (!root || !S.boot || !S.project) return;
  const names = S.boot.steps;
  const active = document.activeElement;
  if (!force && root.contains(active) && ["INPUT", "TEXTAREA"].includes(active.tagName)) return;   // не сбиваем ввод
  if (S.step >= names.length) S.step = 0;
  const stepper = names.map(([, name], i) => `<button class="st${S.step === i ? " on" : ""}${done(i) ? " done" : ""}" data-step="${i}"><b>${done(i) ? "✓" : i + 1}</b>${esc(name)}</button>`).join("");
  const html = `<div class="stepper">${stepper}</div><div class="step-body"><h3>${S.step + 1}. ${esc(names[S.step][1])}</h3>${runBlock()}${STEP_VIEWS[S.step]()}${nav(S.step)}</div>`;
  if (html === last) return;
  last = html;
  const scroll = root.querySelector(".step-body")?.scrollTop ?? 0;
  root.innerHTML = html;
  const body = root.querySelector(".step-body");
  if (body) body.scrollTop = scroll;
}

const refresh = () => emit("poll");

function formData(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") { if (el.checked) (data[el.name] = data[el.name] || []).push(el.value); }
    else data[el.name] = el.value;
  }
  return data;
}

export function initSteps() {
  const root = $("steps");
  root.addEventListener("input", (e) => { const k = e.target.dataset.text; if (k) U.text[k] = e.target.value; });
  root.addEventListener("focusout", () => setTimeout(() => { if (!root.contains(document.activeElement)) renderSteps(); }, 150));
  root.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-form]");
    if (!form) return;
    e.preventDefault();
    const d = formData(form), action = form.dataset.form;
    if (form.dataset.scenario) d.scenario = form.dataset.scenario;
    if (form.dataset.problem) d.problem = form.dataset.problem;
    act(async () => {
      await api("/api/act", {action, ...d});
      delete U.text.sphere;
      form.reset();
      refresh();
    });
  });
  root.addEventListener("click", (e) => {
    const el = e.target.closest("button");
    if (!el) return;
    const d = el.dataset;
    if (d.step !== undefined) { S.step = Number(d.step); renderSteps(true); return; }
    if (d.stop !== undefined) return void act(async () => { await api("/api/stop", {}); refresh(); });
    if (d.start) {
      const ids = d.ids ? d.ids.split(",") : undefined;
      return void act(async () => { await api("/api/start", {kind: d.start, ids, redo: "redo" in d}); refresh(); });
    }
    if (d.act) {
      const {act: action, ...rest} = d;
      return void act(async () => { await api("/api/act", {action, ...rest}); refresh(); });
    }
    if (d.saveSteps) {
      const key = `${d.saveSteps}:${d.scenario}`, area = root.querySelector(`[data-text="${key}"]`);
      const kind = d.saveSteps === "asis" ? "как есть" : "решение";
      return void act(async () => { await api("/api/act", {action: "save_steps", scenario: d.scenario, kind, text: area ? area.value : ""}); delete U.text[key]; refresh(); });
    }
    if (d.pick) {
      const list = U.picked[d.q] || (U.picked[d.q] = []), n = Number(d.pick), at = list.indexOf(n);
      if (at >= 0) list.splice(at, 1); else list.push(n);
      return renderSteps(true);
    }
    if (d.answer) {
      const text = (U.text["q" + d.q] || "").trim(), indexes = [...(U.picked[d.q] || [])].sort((a, b) => a - b);
      let choice;
      if (d.answer === "reject") choice = {type: "rejected", value: text};
      else {
        if (!indexes.length && !text) return toast("Отметьте вариант или напишите своё");
        choice = {type: "choice", indexes, text};
      }
      act(async () => { await api("/api/answer", {question: d.q, choice}); delete U.picked[d.q]; delete U.text["q" + d.q]; refresh(); });
    }
  });
}
