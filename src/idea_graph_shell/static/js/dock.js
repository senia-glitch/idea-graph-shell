/* Правая панель «Помощник»: что дальше, действия крупного этапа, вопросы агента, чат; вкладки «Банк», «Ресурсы», «История».
 *
 * Всё, что здесь показано, объявили пакеты-этапы (шаги, подписи кнопок, банки, проверки): про конкретные этапы тут ничего нет.
 */

import {$, S, act, allSteps, api, emit, esc, on, packageName, phases, toast, when} from "./core.js";
import {graphIndex, loadGraph, selectedCardId, setFocus} from "./graph.js";

const D = {resources: null, tab: "help", history: null, historyRev: -1, draft: "", custom: {}, picked: {}, banks: {}, bankSeq: -1};
const BUSY = ["running", "deciding", "researching"];
const RUN_TEXT = {running: "помощник работает…", deciding: "совет решает…", researching: "исследователи ищут…", asking: "ждёт вашего ответа",
  finished: "закончил", error: "ошибка", stopped: "остановлен", paused: "на паузе", idle: ""};
const ISSUE_ICON = {pending: "◔", check: "•", remark: "✎", proposal: "↻", stale: "⚠"};

/* Перерисовываем блок, только если он изменился: иначе кнопка может исчезнуть под курсором посреди щелчка. */
function setHtml(el, html) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

const cardsOf = (kind) => [...graphIndex().cards.values()].filter((c) => c.kind === kind).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
const runOf = (id) => S.project?.runs?.[id];
const isBusy = (id) => BUSY.includes(runOf(id)?.status);

// ---------------------------------------------------------------------- этап в фокусе

/* Первый крупный этап, где ещё ничего нет; если всё заполнено — первый. */
function defaultPhase(list) {
  return (list.find((p) => p.steps.every(({st}) => !(st.cards || st.records))) || list[0])?.name || "";
}

export function currentPhase() {
  const list = phases();
  if (!list.some((p) => p.name === S.phase)) S.phase = defaultPhase(list);
  return list.find((p) => p.name === S.phase) || null;
}

export function phaseKinds(phase) {
  const kinds = new Set();
  for (const {pkg, step} of phase?.steps || []) {
    step.produces.forEach((k) => kinds.add(k));
    if (step.produces.includes(pkg.stage.roots)) kinds.add(pkg.stage.roots);
  }
  return kinds;
}

/* Цель действия: выбранная на холсте карточка нужного вида, иначе первая карточка этого вида. */
function targetFor({pkg, step}) {
  const kind = step.target_kind || pkg.stage.roots, cards = cardsOf(kind), sel = selectedCardId();
  if (sel && cards.some((c) => c.id === sel)) return sel;
  return kind === pkg.stage.roots && cards.length ? cards[0].id : "";
}

// ---------------------------------------------------------------------- ширина панели

const DOCK_MIN = 320, DOCK_KEY = "ig-dock-width";
const dockMax = () => Math.max(DOCK_MIN + 40, Math.min(900, Math.floor(window.innerWidth * 0.7)));

function setDockWidth(width, save) {
  const value = Math.round(Math.min(dockMax(), Math.max(DOCK_MIN, width)));
  $("dock").style.width = value + "px";
  if (save) { try { localStorage.setItem(DOCK_KEY, String(value)); } catch (error) { /* без запоминания */ } }
  window.dispatchEvent(new Event("resize"));
}

function initDockResize() {
  const handle = document.createElement("div");
  handle.className = "dock-resize";
  handle.title = "Потяните, чтобы изменить ширину панели";
  $("dock").appendChild(handle);
  try {
    const saved = Number(localStorage.getItem(DOCK_KEY));
    if (saved) setDockWidth(saved, false);
  } catch (error) { /* без запоминания */ }
  handle.onpointerdown = (e) => {
    const startX = e.clientX, startWidth = $("dock").getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("drag");
    handle.onpointermove = (ev) => setDockWidth(startWidth + (startX - ev.clientX), false);
    handle.onpointerup = (ev) => {
      handle.onpointermove = handle.onpointerup = null;
      handle.classList.remove("drag");
      handle.releasePointerCapture(ev.pointerId);
      setDockWidth($("dock").getBoundingClientRect().width, true);
    };
  };
}

export function initDock() {
  $("dock").innerHTML = `
    <div class="dock-tabs" id="dockTabs"></div>
    <div class="dock-body" id="dockBody"></div>
    <form class="chat-form" id="chatForm">
      <textarea id="chatInput" rows="2" placeholder="Что нужно (необязательно)… Enter — написать помощнику"></textarea>
      <button class="primary" title="Отправить сообщение помощнику">➤</button>
    </form>`;
  initDockResize();
  $("dockTabs").onclick = (e) => {
    const tab = e.target.dataset.tab;
    if (tab) { D.tab = tab; $("dockBody").dataset.fresh = ""; renderDock(); }
  };
  $("chatForm").onsubmit = (e) => { e.preventDefault(); sendMessage(); };
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  on("state", renderDock);
  on("select", () => { if (D.tab === "help") renderDock(); });
  on("graph", () => { if (D.tab !== "help") renderBody(); else renderDock(); });
}

/* Сообщение уходит пакету текущего этапа; если помощник сейчас не запущен, он продолжит с этим сообщением. */
function sendMessage() {
  const input = $("chatInput"), text = input.value.trim();
  if (!text) return;
  const first = currentPhase()?.steps[0];
  if (!first) return toast("Нет установленного этапа, которому адресовано сообщение");
  input.value = "";
  act(async () => { await api("/api/run/message", {package: first.pkg.id, text}); emit("poll"); });
}

export function renderDock() {
  if (!S.project) return;
  const phase = currentPhase();
  setFocus(phaseKinds(phase));
  const questions = openQuestions().length;
  const hasBank = allSteps().some(({step}) => step.bank);
  const hasResearch = S.boot.packages.some((p) => p.research);
  setHtml($("dockTabs"), [["help", "Помощник" + (questions ? ` · ${questions} ?` : "")], ...(hasBank ? [["bank", "Банк"]] : []),
    ...(hasResearch ? [["resources", "Ресурсы" + (D.resources ? ` · ${D.resources.length}` : "")]] : []), ["history", "История"]]
    .map(([id, name]) => `<button data-tab="${id}" class="${D.tab === id ? "on" : ""}">${name}</button>`).join(""));
  $("chatForm").hidden = D.tab !== "help";
  renderBody();
}

// ---------------------------------------------------------------------- вопросы

function openQuestions() {
  const out = [];
  for (const run of Object.values(S.project?.runs || {})) {
    if (run.question && run.status === "asking") out.push({...run.question, deferred: false});
  }
  return out;
}

export function questionHtml(q) {
  const picked = D.picked[q.id] || [];
  const options = q.options.map((o, i) => `
    <button class="option${(q.recommended || []).includes(i + 1) ? " rec" : ""}${picked.includes(i + 1) ? " picked" : ""}" data-q="${q.id}" data-pkg="${q.package}" data-toggle="${i + 1}">
      <span class="num">${picked.includes(i + 1) ? "✓" : ""}</span><span class="otext"><b>${esc(o.title)}</b>${o.consequence ? `<span class="cons">${esc(o.consequence)}</span>` : ""}
      ${(q.recommended || []).includes(i + 1) ? `<span class="recmark">рекомендация агента${q.reason ? ": " + esc(q.reason) : ""}</span>` : ""}</span>
    </button>`).join("");
  const cards = (q.cards || []).concat(q.revisits || []).filter((v, i, a) => a.indexOf(v) === i);
  const index = graphIndex();
  return `<div class="question" data-qbox="${q.id}">
    <div class="qhead"><span class="chip">${esc(packageName(q.package))}</span></div>
    ${q.comment ? `<div class="qcomment">${esc(q.comment)}</div>` : ""}
    <div class="qtext">${esc(q.question)}</div>
    ${cards.length ? `<div class="qcards">${cards.filter((id) => index.cards.has(id)).map((id) => `<a href="#" data-card="${id}">${esc(index.cards.get(id).title)}</a>`).join("")}</div>` : ""}
    <div class="hint">Можно отметить несколько вариантов, не отмечать ни одного и дописать своё.</div>
    <div class="options">${options}</div>
    <div class="qcustom"><textarea rows="2" data-custom="${q.id}" placeholder="Своё дополнение или своё решение…">${esc(D.custom[q.id] || "")}</textarea>
      <div class="row-actions"><button data-q="${q.id}" data-pkg="${q.package}" data-reject title="Ни один вариант не нужен: ничего не добавлять">Отклонить всё</button>
      <button class="primary" data-q="${q.id}" data-pkg="${q.package}" data-send>Ответить${picked.length ? " (выбрано: " + picked.length + ")" : ""}</button></div></div>
  </div>`;
}

export function bindQuestions(body) {
  body.querySelectorAll("[data-custom]").forEach((area) => {
    area.addEventListener("input", () => { D.custom[area.dataset.custom] = area.value; });
  });
  body.querySelectorAll(".question").forEach((box) => {
    box.addEventListener("click", (e) => {
      const link = e.target.closest("[data-card]");
      if (link) { e.preventDefault(); emit("reveal", link.dataset.card); return; }
      const button = e.target.closest("button[data-q]");
      if (!button) return;
      const id = button.dataset.q;
      let choice;
      if (button.dataset.toggle) {
        const n = Number(button.dataset.toggle), list = D.picked[id] || (D.picked[id] = []);
        const at = list.indexOf(n);
        if (at >= 0) list.splice(at, 1); else list.push(n);
        emit("poll");
        return;
      }
      if ("reject" in button.dataset) choice = {type: "rejected", value: (D.custom[id] || "").trim()};
      else {
        const text = (D.custom[id] || "").trim(), indexes = [...(D.picked[id] || [])].sort((a, b) => a - b);
        if (!indexes.length && !text) return toast("Отметьте вариант или напишите своё");
        choice = {type: "choice", indexes, text};
      }
      box.classList.add("sent");
      act(async () => {
        await api("/api/run/answer", {package: button.dataset.pkg, question: id, choice});
        delete D.custom[id];
        delete D.picked[id];
        emit("poll");
      }).then(() => box.classList.remove("sent"));
    });
  });
}

// ---------------------------------------------------------------------- тело панели

function renderBody() {
  const body = $("dockBody");
  if (D.tab === "help") return renderHelp(body);
  if (D.tab === "bank") return renderBank(body);
  if (D.tab === "resources") return renderResources(body);
  return renderHistory(body);
}

function chatLine(m) {
  const who = m.who === "human" ? "Вы" : m.who === "agent" ? packageName(m.package) : m.who === "council" ? "Совет" : "Система";
  let text = esc(m.text);
  if (m.kind === "answer") {
    text = `<span class="hint">на вопрос «${esc(m.question)}»</span><br>${text}` +
      (m.rationale ? `<div class="rationale">${esc(m.rationale)}</div>` : "") +
      (m.assumption ? ' <span class="chip warn">допущение</span>' : "") + (m.disputed ? ' <span class="chip warn">после спора</span>' : "");
  }
  if (m.kind === "question" && m.comment) text = `<div class="qcomment">${esc(m.comment)}</div>` + text;
  if (m.kind === "finish") {
    text = `<b>Работа закончена${m.outcome ? ` · итог: ${esc(m.outcome)}` : ""}.</b> ${text}` +
      ((m.files || []).length ? `<div class="hint">Файлы: ${m.files.map(esc).join(", ")}</div>` : "");
  }
  return `<div class="msg w-${m.who} k-${m.kind}"><div class="mhead"><b>${esc(who)}</b><span class="hint">${when(m.ts)}</span></div><div class="mtext">${text}</div></div>`;
}

function runLine(phase) {
  const ids = [...new Set((phase?.steps || []).map(({pkg}) => pkg.id))];
  return ids.map((id) => {
    const run = runOf(id);
    if (!run || run.status === "idle") return "";
    const step = run.step && phase.steps.find(({step: s}) => s.id === run.step)?.step;
    const what = run.auto ? "автоматический режим" : run.role === "proposer" ? "предложение правок" : run.role === "reviewer" ? "ревью" : "помощник";
    return `<div class="runline s-${run.status}"><span class="status s-${run.status}">${esc(RUN_TEXT[run.status] || run.status)}</span>
      <span class="hint">${esc(what)}${step ? ` · «${esc(step.title)}»` : ""}${run.cost ? ` · $${run.cost.toFixed(3)}` : ""}</span>
      ${run.error ? `<div class="err">${esc(run.error)}</div>` : ""}
      ${run.status === "finished" && run.summary ? `<div class="hint">${esc(run.summary.replace(/\s+/g, " ").slice(0, 200))}</div>` : ""}
      <span class="spacer"></span>${BUSY.includes(run.status) || run.status === "asking" ? `<button data-do="stop" data-pkg="${id}">■ Стоп</button>` : ""}</div>`;
  }).join("");
}

/* «Что дальше»: всё, что ждёт решения человека на этом этапе, и подсказка следующего действия. */
function nextBlock(phase, questions) {
  const rows = [];
  let pending = 0, decide = 0;
  for (const {pkg, step, st} of phase?.steps || []) {
    pending += (st.proposed || 0) + (st.records_proposed || 0);
    for (const issue of st.issues || []) {
      if (issue.type === "pending") continue;
      if (issue.type !== "check") decide++;
      const buttons = [];
      if (issue.type === "remark") buttons.push(`<button data-show="${issue.card}">Показать</button><button class="danger" data-del="${issue.card}" title="Учтено: убрать замечание">✕</button>`);
      if (issue.type === "proposal") buttons.push(`<button data-apply="${issue.card}">✓ Применить</button><button class="danger" data-del="${issue.card}" title="Отклонить правку">✕</button>`);
      if (issue.type === "stale") buttons.push(`<button data-stale="propose" data-pkg="${pkg.id}" data-step="${step.id}">Предложить правки</button><button data-stale="clear" data-pkg="${pkg.id}" data-step="${step.id}">Игнорировать</button>`);
      rows.push(`<li class="issue t-${issue.type}"><span class="i-icon">${ISSUE_ICON[issue.type] || "•"}</span>
        <span class="i-text">${esc(issue.text)}${issue.type === "stale" || issue.type === "check" ? ` <span class="hint">· ${esc(step.title)}</span>` : ""}</span><span class="i-act">${buttons.join("")}</span></li>`);
    }
  }
  const stepsWithLabel = (phase?.steps || []).filter(({step}) => step.actions.includes("suggest"));
  const empty = stepsWithLabel.find(({st}) => !(st.cards || st.records));
  const busy = (phase?.steps || []).some(({pkg}) => isBusy(pkg.id));
  let hint = "";
  if (questions) hint = "Агент ждёт вашего ответа — вопрос выше.";
  else if (busy) hint = "Помощник работает: результат появится на холсте.";
  else if (decide || pending) hint = "Разберите предложенное: примите, поправьте на холсте или уберите лишнее.";
  else if (empty) hint = `Дальше: «${empty.step.label || empty.step.title}».`;
  else hint = phase ? "Этап выглядит заполненным. Можно проверить его или перейти к следующему." : "";
  return `<div class="next-box"><div class="lbl">Что дальше</div>
    ${hint ? `<div class="next-hint">${esc(hint)}</div>` : ""}
    ${pending ? `<div class="row-actions" style="justify-content:flex-start"><button data-accept-all>Принять все непринятое · ${pending}</button></div>` : ""}
    ${rows.length ? `<ul class="issues">${rows.join("")}</ul>` : ""}</div>`;
}

function actionsBlock(phase) {
  if (!phase) return "";
  const steps = phase.steps;
  const buttons = steps.filter(({step}) => step.actions.includes("suggest")).map((item) => {
    const busy = isBusy(item.pkg.id), noTarget = !targetFor(item) && (item.step.target_kind || item.pkg.stage.roots) === item.pkg.stage.roots;
    return `<button class="${item.st.cards || item.st.records ? "" : "primary"}" data-go="suggest" data-pkg="${item.pkg.id}" data-step="${item.step.id}"${busy || noTarget ? " disabled" : ""}
      title="${esc(item.step.help || item.step.question)}">${esc(item.step.label || "Предложить: " + item.step.title)}</button>`;
  });
  const owner = steps[0].pkg.id, busy = isBusy(owner);
  const can = (action) => steps.some(({step}) => step.actions.includes(action));
  const auto = steps.map(({pkg}) => pkg).find((p) => p.auto);
  const missingRoot = steps.some(({pkg, step}) => step.produces.includes(pkg.stage.roots) && !step.actions.includes("suggest")) && !cardsOf(steps[0].pkg.stage.roots).length;
  return `<div class="act-box"><div class="lbl">Этап «${esc(phase.name)}»</div>
    ${missingRoot ? '<div class="ws-warn">Первую карточку пишете вы: кнопка «+ Сфера» вверху.</div>' : ""}
    <div class="act-buttons">${buttons.join("")}</div>
    <div class="act-buttons">
      ${can("review") ? `<button data-go="review" data-pkg="${owner}" data-phase="1"${busy ? " disabled" : ""} title="Независимый ревьюер оставит замечания карточками; ничего не правит">Проверить этап</button>` : ""}
      ${can("clarify") ? `<button data-go="clarify" data-pkg="${owner}" data-phase="1"${busy ? " disabled" : ""} title="Помощник найдёт неточности и задаст вопросы с вариантами">Уточнить</button>` : ""}
      ${auto ? `<button data-auto="${auto.id}"${isBusy(auto.id) ? " disabled" : ""} title="Помощник проходит все шаги сам, на развилках решает совет. Результат остаётся предложенным">⚡ Авто</button>` : ""}
      ${steps.some(({pkg}) => isBusy(pkg.id)) ? `<button data-do="stop" data-pkg="${owner}">■ Стоп</button>` : ""}</div>
    <div class="hint">Текст в поле внизу — уточнение к действию («добавь роль врача»). Цель — выбранная на холсте карточка.</div></div>`;
}

function renderHelp(body) {
  const typing = body.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
  const phase = currentPhase(), questions = openQuestions();
  const signature = JSON.stringify([S.chat.length, S.chat.at(-1)?.seq, questions.map((q) => q.id), D.picked, S.phase, selectedCardId(),
    JSON.stringify(S.project.runs), JSON.stringify(S.project.stages), graphIndex().cards.size]);
  if (body.dataset.sig === signature && body.dataset.tab === "help") return;
  if (typing && body.dataset.tab === "help" && JSON.stringify(questions.map((q) => q.id)) === body.dataset.qs) return;   // не сбиваем ввод своего ответа
  const sameTab = body.dataset.tab === "help", newQuestion = sameTab && JSON.stringify(questions.map((q) => q.id)) !== body.dataset.qs;
  const keep = sameTab ? body.scrollTop : 0;
  body.dataset.sig = signature;
  body.dataset.tab = "help";
  body.dataset.qs = JSON.stringify(questions.map((q) => q.id));
  body.innerHTML = runLine(phase) +
    questions.map(questionHtml).join("") + nextBlock(phase, questions.length) + actionsBlock(phase) +
    '<div class="lbl chat-lbl">Разговор (новое сверху)</div>' +
    (S.chat.length ? S.chat.filter((m) => !(m.kind === "question" && questions.some((q) => q.id === m.qid))).slice(-12).reverse().map(chatLine).join("")
      : '<div class="empty">Напишите сферу («+ Сфера» вверху), затем нажимайте кнопки этапа: помощник предлагает, вы принимаете и правите. Вопросы агента появятся здесь с готовыми вариантами.</div>');
  bindQuestions(body);
  body.onclick = helpClick;
  body.onchange = body.onsubmit = null;
  body.scrollTop = newQuestion || !sameTab ? 0 : keep;
  const current = questions[0];
  emit("highlight", current ? (current.cards || []).concat(current.revisits || []) : []);
}

async function acceptAll(phase) {
  const ops = [];
  for (const {step} of phase.steps) {
    for (const kind of step.produces) cardsOf(kind).filter((c) => c.status === "proposed").forEach((c) => ops.push({op: "update_card", id: c.id, status: "accepted"}));
  }
  if (ops.length) await api("/api/ops", {ops, note: `Принято предложенное на этапе «${phase.name}»`});
  for (const {step} of phase.steps) {
    const name = step.produces_bank || step.bank?.name;
    if (!name) continue;
    const data = await api("/api/bank?name=" + encodeURIComponent(name));
    for (const record of data.records.filter((r) => (r.data || {}).state === "proposed")) {
      await api("/api/bank/save", {name, id: record.id, data: {...record.data, state: "accepted"}});
    }
  }
  await loadGraph();
  emit("poll");
}

function helpClick(e) {
  if (e.target.closest(".question")) return;                                    // вопрос агента обрабатывает свой обработчик
  const el = e.target.closest("button, a");
  if (!el) return;
  const d = el.dataset, phase = currentPhase();
  if (el.matches("a")) e.preventDefault();
  if (d.go) {
    const goal = $("chatInput").value.trim();
    const item = phase.steps.find(({pkg, step}) => pkg.id === d.pkg && (d.step ? step.id === d.step : true));
    const payload = d.phase ? {package: d.pkg, action: d.go, phase: phase.name, goal}
      : {package: d.pkg, step: d.step, action: d.go, target: targetFor(item), goal};
    act(async () => { await api("/api/run/start", payload); $("chatInput").value = ""; emit("poll"); });
  } else if (d.auto) {
    const pkg = S.boot.packages.find((p) => p.id === d.auto), sel = selectedCardId();
    const targets = sel && graphIndex().cards.get(sel)?.kind === pkg.auto.targets ? [sel] : [];
    act(async () => { await api("/api/run/start", {package: d.auto, auto: {targets}}); emit("poll"); });
  } else if (d.do === "stop") {
    act(async () => { await api("/api/run/stop", {package: d.pkg}); emit("poll"); });
  } else if (d.show) {
    emit("reveal", d.show);
  } else if (d.apply) {
    act(async () => { await api("/api/proposals/apply", {id: d.apply}); await loadGraph(); toast("Правка применена"); emit("poll"); });
  } else if (d.del) {
    act(async () => { await api("/api/ops", {ops: [{op: "delete_card", id: d.del}]}); await loadGraph(); emit("poll"); });
  } else if (d.stale) {
    act(async () => {
      if (d.stale === "propose") await api("/api/run/propose", {package: d.pkg});
      else await api("/api/stage/clear-stale", {package: d.pkg, step: d.step});
      emit("poll");
    });
  } else if ("acceptAll" in d) {
    act(() => acceptAll(phase));
  }
}

// ---------------------------------------------------------------------- банк

function needBanks(names) {
  const stamp = S.project.seq;
  if (D.bankSeq === stamp && names.every((n) => D.banks[n])) return true;
  D.bankSeq = stamp;
  Promise.all(names.map((n) => api("/api/bank?name=" + encodeURIComponent(n)).then((r) => { D.banks[n] = r.records; }))).then(() => {
    if (D.tab === "bank") { $("dockBody").dataset.sig = ""; renderBody(); }
  }).catch(() => {});
  return names.every((n) => D.banks[n]);
}

function bankTable(spec) {
  const data = D.banks[spec.name], fields = spec.fields || [];
  const cell = (record, f) => {
    const value = (record.data || {})[f.key];
    if (f.list) return `<span class="hint">${esc((Array.isArray(value) ? value : []).map((x) => (typeof x === "object" ? x.name : x)).join(", ").slice(0, 160) || "—")}</span>`;
    if (f.values) return `<select data-bank-field="${f.key}" data-bank="${spec.name}" data-id="${record.id}">${["", ...f.values].map((v) => `<option${(value || "") === v ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
    return `<input data-bank-field="${f.key}" data-bank="${spec.name}" data-id="${record.id}" value="${esc(value ?? "")}">`;
  };
  const rows = data.map((r) => `<tr class="${(r.data || {}).state === "proposed" ? "proposed" : ""}">
    ${fields.map((f) => `<td>${cell(r, f)}</td>`).join("")}
    <td class="bank-src">${(r.sources || []).slice(0, 3).map((s) => (/^https?:/i.test(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener">источник</a>` : esc(s))).join(" ") || '<span class="hint">без источника</span>'}</td>
    <td class="bank-act">${(r.data || {}).state === "proposed" ? `<button data-bank-accept="${r.id}" data-bank="${spec.name}" title="Принять запись">✓</button>` : '<span class="hint">принято</span>'}<button class="danger" data-bank-del="${r.id}" data-bank="${spec.name}" title="Удалить запись">✕</button></td></tr>`).join("");
  const add = fields.filter((f) => !f.list).map((f) => f.values
    ? `<select data-new="${f.key}">${f.values.map((v) => `<option>${esc(v)}</option>`).join("")}</select>`
    : `<input data-new="${f.key}" placeholder="${esc(f.title)}">`).join("");
  return `<table class="bank"><thead><tr>${fields.map((f) => `<th>${esc(f.title)}</th>`).join("")}<th>Источники</th><th></th></tr></thead><tbody>${rows
    || `<tr><td colspan="${fields.length + 2}" class="hint">Записей пока нет. Нажмите кнопку этапа или добавьте вручную.</td></tr>`}</tbody></table>
    ${fields.some((f) => !f.list) ? `<form class="bank-add" data-bank-form="${spec.name}" data-type="${esc(spec.type || "")}">${add}<button class="primary">Добавить</button></form>` : ""}`;
}

function renderBank(body) {
  const typing = body.contains(document.activeElement) && ["INPUT", "SELECT"].includes(document.activeElement.tagName);
  if (typing && body.dataset.tab === "bank") return;
  const specs = [], seen = new Set();
  for (const {step} of allSteps()) if (step.bank && !seen.has(step.bank.name)) { seen.add(step.bank.name); specs.push({...step.bank, title: step.title}); }
  body.dataset.tab = "bank";
  body.dataset.sig = "";
  if (!needBanks(specs.map((s) => s.name))) { body.innerHTML = '<div class="hint">Загружаю банк…</div>'; return; }
  body.innerHTML = '<div class="hint">Здесь лежат найденные факты с источниками. Предложенное агентами нужно принять (✓) — только принятое попадает в документ без пометки.</div>' +
    specs.map((s) => `<h3 class="bank-title">${esc(s.title)}</h3>${bankTable(s)}`).join("");
  body.onclick = (e) => {
    const el = e.target.closest("button");
    if (!el || e.target.closest("select, input")) return;
    const d = el.dataset, name = d.bank;
    const record = (D.banks[name] || []).find((r) => r.id === (d.bankAccept || d.bankDel));
    if (d.bankAccept && record) act(async () => { await api("/api/bank/save", {name, id: record.id, data: {...record.data, state: "accepted"}}); D.bankSeq = -1; emit("poll"); });
    if (d.bankDel) act(async () => { await api("/api/bank/remove", {name, id: d.bankDel}); D.bankSeq = -1; emit("poll"); });
  };
  body.onchange = (e) => {
    const t = e.target;
    if (!t.dataset.bankField) return;
    const record = (D.banks[t.dataset.bank] || []).find((r) => r.id === t.dataset.id);
    if (record) act(async () => { await api("/api/bank/save", {name: t.dataset.bank, id: record.id, data: {...record.data, [t.dataset.bankField]: t.value}}); D.bankSeq = -1; emit("poll"); });
  };
  body.onsubmit = (e) => {
    const form = e.target.closest("[data-bank-form]");
    if (!form) return;
    e.preventDefault();
    const data = {};
    form.querySelectorAll("[data-new]").forEach((el) => { data[el.dataset.new] = el.value.trim(); });
    if (!Object.values(data).some(Boolean)) return;
    const slug = String(data.url || data.name || "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    act(async () => { await api("/api/bank/save", {name: form.dataset.bankForm, type: form.dataset.type, key: slug, data}); D.bankSeq = -1; emit("poll"); });
  };
}

// ---------------------------------------------------------------------- ресурсы и история

async function renderResources(body) {
  if (body.dataset.tab === "resources" && D.resources && body.dataset.fresh === "1") return;   // не стираем ввод ссылки
  body.dataset.tab = "resources";
  body.dataset.sig = "";
  body.onclick = body.onchange = body.onsubmit = null;
  if (!D.resources) {
    const data = await act(() => api("/api/resources"));
    if (!data) return;
    D.resources = data.items;
    if (D.tab !== "resources") return;
  }
  body.dataset.fresh = "1";
  body.innerHTML = `<div class="hint">Ссылки и текстовые файлы, из которых исследователи берут материал вместе со своим веб-поиском (форумы, отчёты, статьи, ваши заметки). Страница или файл читаются сразу при добавлении.</div>
    <form id="resForm" class="chat-form" style="margin:8px 0"><input name="value" placeholder="https://… или путь к файлу (.txt, .md, .html, .csv)" autocomplete="off" style="flex:1;min-width:0">
      <button class="primary">Добавить</button></form>` +
    (D.resources.map((r) => `<div class="hist"><div><span class="chip">${r.kind === "url" ? "ссылка" : "файл"}</span> <b style="word-break:break-all">${esc(r.value)}</b></div>
      <div class="hint">прочитано символов: ${r.chars} <button data-rm="${r.id}">Убрать</button></div></div>`).join("")
      || '<div class="empty">Ресурсов пока нет: исследователи будут искать только в сети.</div>');
  const refresh = () => { D.resources = null; body.dataset.fresh = ""; renderBody(); };
  $("resForm").onsubmit = (e) => {
    e.preventDefault();
    const value = new FormData(e.currentTarget).get("value").trim();
    if (value) act(async () => { await api("/api/resources/add", {value}); toast("Ресурс прочитан и добавлен"); refresh(); });
  };
  body.onclick = (e) => {
    const id = e.target.dataset.rm;
    if (id) act(async () => { await api("/api/resources/remove", {id}); refresh(); });
  };
}

async function renderHistory(body) {
  body.dataset.tab = "history";
  body.dataset.sig = "";
  body.onchange = body.onsubmit = null;
  if (D.historyRev !== S.project.revision || !D.history) {
    const data = await act(() => api("/api/history"));
    if (!data) return;
    D.history = data;
    D.historyRev = S.project.revision;
    if (D.tab !== "history") return;
  }
  const h = D.history;
  body.innerHTML =
    `<details class="deleted" ${h.deleted.length ? "open" : ""}><summary>Удалённые карточки · ${h.deleted.length}</summary>${h.deleted.map((d) =>
      `<div class="hist"><div><span class="chip">${esc(d.kind)}</span> <b>${esc(d.title)}</b></div>${d.body ? `<div class="hint">${esc(d.body.slice(0, 200))}</div>` : ""}
        <div class="hint">удалил ${esc(d.author_name)} · ${when(d.ts)} <button data-undo="${d.rev}" title="Вернуть карточку: отменить ревизию ${d.rev}">Вернуть</button></div></div>`).join("") || '<div class="hint">Пока ничего не удаляли.</div>'}</details>` +
    '<div class="lbl">Все изменения</div>' +
    h.entries.map((e) => `<div class="hist${e.undone ? " undone" : ""}">
      <div class="mhead"><b>#${e.rev} · ${esc(e.author_name)}</b><span class="hint">${when(e.ts)}</span></div>
      ${e.note ? `<div class="hint">${esc(e.note)}</div>` : ""}
      ${e.lines.slice(0, 6).map((l) => `<div>${esc(l)}</div>`).join("")}${e.lines.length > 6 ? `<div class="hint">…и ещё ${e.lines.length - 6}</div>` : ""}
      ${e.undone ? '<div class="hint">отменено</div>' : !e.undo_of ? `<button data-undo="${e.rev}">Отменить</button>` : ""}</div>`).join("");
  body.onclick = (e) => {
    const rev = e.target.dataset.undo;
    if (rev) act(async () => { await api("/api/undo", {rev: Number(rev)}); await loadGraph(); D.historyRev = -1; emit("poll"); toast("Готово"); });
  };
}

export function selectPhase(name) {
  S.phase = name;
  D.tab = "help";
  $("dockBody").dataset.sig = "";
  renderDock();
}
