/* Правая панель: пакеты и их запуск, вопрос с вариантами, чат, решения агента, история. */

import {$, S, act, api, authorName, emit, esc, on, packageName, toast, when} from "./core.js";
import {graphIndex, loadGraph} from "./graph.js";

const D = {autoOpen: false, resources: null, autoTarget: "", tab: "chat", filter: "all", history: null, historyRev: -1, draft: "", custom: {}, picked: {}};

const STATUS_TEXT = {
  idle: "ждёт", running: "думает…", asking: "ждёт вашего ответа", deciding: "решатель думает…",
  finished: "закончил", error: "ошибка", stopped: "остановлен", paused: "на паузе", researching: "исследуют область…",
};

/* Перерисовываем блок, только если он изменился: иначе кнопка может исчезнуть под курсором посреди щелчка. */
function setHtml(el, html) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

function runnable() {
  return (S.boot?.packages || []).filter((p) => p.kind === "agent" || p.kind === "code");
}
function runOf(id) { return S.project?.runs?.[id]; }

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
    <div class="pkg-bar" id="pkgBar"></div>
    <div class="pkg-ctl" id="pkgCtl"></div>
    <div class="dock-tabs" id="dockTabs"></div>
    <div class="dock-body" id="dockBody"></div>
    <form class="chat-form" id="chatForm">
      <textarea id="chatInput" rows="2" placeholder="Сообщение агенту… (Enter — отправить)"></textarea>
      <button class="primary" title="Отправить">➤</button>
    </form>`;
  initDockResize();
  $("pkgCtl").addEventListener("toggle", (e) => { if (e.target.matches("[data-auto-box]")) D.autoOpen = e.target.open; }, true);
  $("pkgBar").onclick = (e) => {
    const id = e.target.closest("[data-pkg]")?.dataset.pkg;
    if (id) { S.pkg = id; renderDock(); }
  };
  $("dockTabs").onclick = (e) => {
    const tab = e.target.dataset.tab;
    if (tab) { D.tab = tab; $("dockBody").dataset.fresh = ""; renderDock(); }
  };
  $("chatForm").onsubmit = (e) => { e.preventDefault(); sendMessage(); };
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  on("state", renderDock);
  on("graph", () => { if (D.tab !== "chat") renderBody(); });
}

function sendMessage() {
  const input = $("chatInput"), text = input.value.trim();
  if (!text) return;
  if (!S.pkg) return toast("Выберите пакет, которому адресовано сообщение");
  if (packageKind(S.pkg) !== "agent") return toast("Этот пакет работает без модели — писать ему незачем");
  input.value = "";
  act(async () => { await api("/api/run/message", {package: S.pkg, text}); emit("poll"); });
}
function packageKind(id) { return S.boot?.packages.find((p) => p.id === id)?.kind; }

export function renderDock() {
  if (!S.project) return;
  const list = runnable();
  if (!S.pkg || !list.some((p) => p.id === S.pkg)) S.pkg = list[0]?.id || "";
  setHtml($("pkgBar"), list.map((p) => {
    const run = runOf(p.id), status = run?.status || "idle";
    return `<button class="pkg${p.id === S.pkg ? " on" : ""}" data-pkg="${p.id}" title="${esc(p.description)}">
      <span class="dot s-${status}"></span>${esc(p.name)}</button>`;
  }).join("") || '<div class="hint">Пакеты не установлены. Поставьте idea-graph-problem и перезапустите оболочку.</div>');
  renderControls();
  const questions = openQuestions().length;
  const decided = decisionCards().filter((c) => c.decision.by !== "human").length;
  setHtml($("dockTabs"), [["chat", "Чат" + (questions ? ` · ${questions} ?` : "")], ["decisions", "Решения агента" + (decided ? ` · ${decided}` : "")], ...(S.boot.packages.some((p) => p.research) ? [["resources", "Ресурсы" + (D.resources ? ` · ${D.resources.length}` : "")]] : []), ["history", "История"]]
    .map(([id, name]) => `<button data-tab="${id}" class="${D.tab === id ? "on" : ""}">${name}</button>`).join(""));
  $("chatForm").hidden = D.tab !== "chat";
  renderBody();
}

function autoRow(pkg, busy) {
  const targets = [...graphIndex().cards.values()].filter((c) => c.kind === pkg.auto.targets);
  if (D.autoTarget && !targets.some((c) => c.id === D.autoTarget)) D.autoTarget = "";
  const options = [`<option value="">все (${targets.length})</option>`,
    ...targets.map((c) => `<option value="${c.id}"${D.autoTarget === c.id ? " selected" : ""}>${esc(c.title.slice(0, 60))}</option>`)].join("");
  return `<details class="auto-box" data-auto-box${D.autoOpen || !targets.length ? " open" : ""}>
    <summary title="Агент без вопросов достроит ветку до результата в пределах лимитов из настроек. Карточки останутся предложенными: примите и поправьте их на графе">Автоматический режим</summary>
    <select data-auto-target ${targets.length ? "" : "disabled"} title="Для какой карточки «${esc(pkg.auto.targets)}» запустить">${options}</select>
    <div class="auto-actions">
      <button data-do="auto" ${targets.length && !busy ? "" : "disabled"} title="Исследование области (если включено в настройках), затем ветка до результатов">⚡ Авто</button>
      ${pkg.research ? `<button data-do="research" ${targets.length && !busy ? "" : "disabled"} title="Три исследователя на разных моделях найдут реальные сценарии и проблемы области; агент создаст из них карточки со ссылками на источники">🔎 Исследовать</button>` : ""}</div>
    ${targets.length ? "" : `<div class="hint">Нужна хотя бы одна карточка «${esc(pkg.auto.targets)}»: нажмите «+ Домен» вверху.</div>`}
  </details>`;
}

function renderControls() {
  const box = $("pkgCtl"), pkg = S.boot.packages.find((p) => p.id === S.pkg);
  if (!pkg) { setHtml(box, ""); return; }
  const run = runOf(pkg.id), status = run?.status || "idle";
  const busy = status === "running" || status === "deciding" || status === "researching";
  const answerer = S.project.answerers[pkg.id] || "human";
  const started = run && run.turn > 0;
  setHtml(box, `
    <div class="ctl-row">
      <span class="status s-${status}">${STATUS_TEXT[status] || status}</span>
      ${run?.auto ? '<span class="chip" title="Работает автоматический режим: вопросов не будет">авто</span>' : ""}
      ${run?.turn ? `<span class="hint">ходов: ${run.turn}${run.cost ? ` · $${run.cost.toFixed(3)}` : ""}</span>` : ""}
      <span class="spacer"></span>
      ${busy ? '<button data-do="stop">■ Стоп</button>'
        : `<button class="primary" data-do="${status === "paused" ? "resume" : "start"}">${status === "paused" ? "Продолжить" : started && pkg.kind === "agent" && status !== "finished" ? "▶ Продолжить" : "▶ Запустить"}</button>`}
      ${started && !busy && pkg.kind === "agent" ? '<button data-do="fresh" title="Начать с новой сессией агента: он получит весь граф заново">Заново</button>' : ""}
    </div>
    ${pkg.auto ? autoRow(pkg, busy) : ""}
    ${pkg.asks && S.boot.packages.some((p) => p.kind === "decider") ? `<div class="ctl-row"><span class="hint">На вопросы отвечает:</span>
      <div class="seg"><button data-who="human" class="${answerer === "human" ? "on" : ""}">Я</button><button data-who="decider" class="${answerer === "decider" ? "on" : ""}" title="Пакет-решатель: его решения помечаются и их можно переопределить">Решатель</button></div></div>` : ""}
    ${run?.error ? `<div class="err">${esc(run.error)}</div>` : ""}
    ${status === "paused" && run.pause_reason ? `<div class="warn-box">${esc(run.pause_reason)}</div>` : ""}
    ${status === "finished" && run.outcome ? `<div class="hint">Итог: <b>${esc(run.outcome)}</b></div>` : ""}`);
  box.onchange = (e) => { if (e.target.dataset.autoTarget !== undefined) D.autoTarget = e.target.value; };
  box.onclick = (e) => {
    const todo = e.target.dataset.do, who = e.target.dataset.who;
    if (todo === "start") act(async () => { await api("/api/run/start", {package: pkg.id}); emit("poll"); });
    if (todo === "auto") act(async () => { await api("/api/run/start", {package: pkg.id, auto: {targets: D.autoTarget ? [D.autoTarget] : []}}); emit("poll"); });
    if (todo === "research") act(async () => { await api("/api/run/start", {package: pkg.id, auto: {targets: D.autoTarget ? [D.autoTarget] : [], only_research: true}}); emit("poll"); });
    if (todo === "fresh") act(async () => { await api("/api/run/start", {package: pkg.id, fresh: true}); emit("poll"); });
    if (todo === "stop") act(async () => { await api("/api/run/stop", {package: pkg.id}); emit("poll"); });
    if (todo === "resume") act(async () => { await api("/api/run/resume", {package: pkg.id}); emit("poll"); });
    if (who) act(async () => { await api("/api/run/answerer", {package: pkg.id, answerer: who}); emit("poll"); });
  };
}

// ---------------------------------------------------------------------- вопросы

function openQuestions() {
  const out = [];
  for (const run of Object.values(S.project?.runs || {})) {
    if (run.question && (run.status === "asking" || run.status === "paused")) out.push({...run.question, deferred: false});
    for (const q of run.deferred || []) out.push({...q, deferred: true});
  }
  return out.sort((a, b) => (a.package === S.pkg ? -1 : 0) - (b.package === S.pkg ? -1 : 0));
}

function questionHtml(q) {
  const picked = D.picked[q.id] || [];
  const options = q.options.map((o, i) => `
    <button class="option${(q.recommended || []).includes(i + 1) ? " rec" : ""}${picked.includes(i + 1) ? " picked" : ""}" data-q="${q.id}" data-pkg="${q.package}" data-toggle="${i + 1}">
      <span class="num">${picked.includes(i + 1) ? "✓" : ""}</span><span class="otext"><b>${esc(o.title)}</b>${o.consequence ? `<span class="cons">${esc(o.consequence)}</span>` : ""}
      ${(q.recommended || []).includes(i + 1) ? `<span class="recmark">рекомендация агента${q.reason ? ": " + esc(q.reason) : ""}</span>` : ""}</span>
    </button>`).join("");
  const cards = (q.cards || []).concat(q.revisits || []).filter((v, i, a) => a.indexOf(v) === i);
  const index = graphIndex();
  return `<div class="question" data-qbox="${q.id}">
    <div class="qhead"><span class="chip">${esc(packageName(q.package))}</span>
      ${q.deferred ? '<span class="chip warn" title="Вопрос затрагивает ваше решение, поэтому решатель его не трогает">ждёт вас</span>' : ""}
      ${q.important ? '<span class="chip" title="Затрагивает корень, несколько веток или карточку, от которой многое зависит">важный</span>' : ""}</div>
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

function bindQuestions(body) {
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

function chatLine(m) {
  const who = m.who === "human" ? "Вы" : m.who === "agent" ? packageName(m.package) : m.who === "decider" ? "Решатель" : "Оболочка";
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

function decisionCards() {
  return [...graphIndex().cards.values()].filter((c) => c.decision && typeof c.decision === "object" && c.decision.chosen);
}

function renderBody() {
  const body = $("dockBody");
  if (D.tab === "chat") return renderChat(body);
  if (D.tab === "decisions") return renderDecisions(body);
  if (D.tab === "resources") return renderResources(body);
  return renderHistory(body);
}

function renderChat(body) {
  const typing = body.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
  const questions = openQuestions();
  const signature = JSON.stringify([S.chat.length, S.chat.at(-1)?.seq, questions.map((q) => q.id + q.deferred), JSON.stringify(D.picked), S.pkg, graphIndex().cards.size, Object.values(S.project.runs).map((r) => r.status)]);
  if (body.dataset.sig === signature && body.dataset.tab === "chat") return;
  if (typing && body.dataset.tab === "chat" && JSON.stringify(questions.map((q) => q.id)) === body.dataset.qs) return;   // не сбиваем ввод своего ответа
  const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60 || body.dataset.tab !== "chat";
  const busy = Object.values(S.project.runs).filter((r) => r.status === "running" || r.status === "deciding" || r.status === "researching");
  body.onclick = null;
  body.dataset.sig = signature;
  body.dataset.tab = "chat";
  body.dataset.qs = JSON.stringify(questions.map((q) => q.id));
  body.innerHTML =
    (S.chat.length ? S.chat.filter((m) => !(m.kind === "question" && questions.some((q) => q.id === m.qid))).map(chatLine).join("") : '<div class="empty">Нажмите «+ Домен» вверху и напишите, кто испытывает проблему. Затем «▶ Запустить»: агент будет задавать вопросы с готовыми вариантами ответа, а ваши ответы превращать в карточки: домен → сценарий → проблема → результат.</div>') +
    busy.map((r) => `<div class="thinking">${esc(packageName(r.package))}: ${r.status === "deciding" ? "решатель думает" : r.status === "researching" ? "исследователи ищут информацию" : "агент думает"}<span class="dots"></span></div>`).join("") +
    questions.map(questionHtml).join("");
  bindQuestions(body);
  if (stick) body.scrollTop = body.scrollHeight;
  const current = questions.find((q) => !q.deferred) || questions[0];
  emit("highlight", current ? (current.cards || []).concat(current.revisits || []) : []);
}

async function renderResources(body) {
  if (body.dataset.tab === "resources" && D.resources && body.dataset.fresh === "1") return;   // не стираем ввод ссылки
  body.dataset.tab = "resources";
  body.dataset.sig = "";
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

function renderDecisions(body) {
  body.dataset.tab = "decisions";
  body.dataset.sig = "";
  const all = decisionCards();
  const filters = {all: () => true, agent: (c) => c.decision.by !== "human", assumption: (c) => c.decision.assumption, disputed: (c) => c.decision.disputed};
  const names = {all: "Все", agent: "Решил агент", assumption: "Допущения", disputed: "После спора"};
  const list = all.filter(filters[D.filter]).sort((a, b) => b.updated_rev - a.updated_rev);
  body.innerHTML = `<div class="filters">${Object.keys(filters).map((key) =>
    `<button data-filter="${key}" class="${D.filter === key ? "on" : ""}">${names[key]} · ${all.filter(filters[key]).length}</button>`).join("")}</div>` +
    (list.map((c) => {
      const d = c.decision, chosen = d.chosen;
      const what = chosen.type === "rejected" ? "отклонено" : chosen.value;
      return `<a href="#" class="decision-row" data-card="${c.id}"><b>${esc(c.title)}</b>
        <span>${esc(d.question || "")} → <b>${esc(what)}</b></span>
        <span class="hint">${esc(authorName(d.by))}${d.assumption ? " · допущение" : ""}${d.disputed ? " · после спора" : ""}${d.overridden ? " · переопределено вами" : ""}</span>
        ${d.rationale ? `<span class="rationale">${esc(d.rationale)}</span>` : ""}</a>`;
    }).join("") || '<div class="empty">Здесь появятся решения, записанные на карточках. Решение агента можно открыть и переопределить.</div>');
  body.onclick = (e) => {
    const filter = e.target.dataset.filter, row = e.target.closest("[data-card]");
    if (filter) { D.filter = filter; renderDecisions(body); }
    if (row) { e.preventDefault(); emit("reveal", row.dataset.card); }
  };
}

async function renderHistory(body) {
  body.dataset.tab = "history";
  body.dataset.sig = "";
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
