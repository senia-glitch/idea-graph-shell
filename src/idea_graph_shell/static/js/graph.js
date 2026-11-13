/* Экран «Граф»: карточки на холсте и панель свойств выбранной карточки или связи. */

import {createCanvas} from "./canvas.js";
import {$, DETAIL, ROOT, S, STATUS, act, api, authorName, emit, esc, on, promptText, toast, when} from "./core.js";

let canvas;
let layoutLoaded = false;
let saveTimer = 0;
const G = {cards: new Map(), edges: [], parents: new Map(), children: new Map()};

const KIND_COLORS = {
  "идея": "#e8833a", "ветка": "#5aa0ff", "решение": "#7fc97f", "граница": "#ff5d5d",
  "открытый вопрос": "#e8c33a", "замечание": "#ff8fa3", "требование": "#bb9af7", "факт": "#6fd3c7",
  "конкурент": "#c9a86a",
};
const PALETTE = ["#5aa0ff", "#7fc97f", "#bb9af7", "#c9a86a", "#6fd3c7", "#e79fd5", "#9fb4ff"];
function kindColor(kind) {
  if (KIND_COLORS[kind]) return KIND_COLORS[kind];
  let h = 0;
  for (const ch of kind) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const SERVICE_KINDS = ["открытый вопрос", "замечание"];   // их не «принимают»: на вопрос отвечают, замечание исправляют
const EDGE_COLORS = {"противоречит": "#ff5d5d", "о карточке": "#ff8fa3", "подтверждает": "#7fc97f", "опровергает": "#ff5d5d"};

export function graphIndex() { return G; }
export function kinds() { return [...new Set([...G.cards.values()].map((c) => c.kind).filter((k) => k !== ROOT))]; }
export function dependents(id) {
  const incoming = new Map();
  for (const e of G.edges) { if (!incoming.has(e.to)) incoming.set(e.to, []); incoming.get(e.to).push(e.from); }
  const seen = new Set(), todo = [id];
  while (todo.length) for (const other of incoming.get(todo.pop()) || []) if (!seen.has(other) && other !== id) { seen.add(other); todo.push(other); }
  return seen;
}

function decisionBadges(card) {
  const d = card.decision;
  if (!d || typeof d !== "object") return "";
  const bits = [];
  if (d.by && d.by !== "human") bits.push('<span class="chip agent" title="Решение принял решатель — его можно переопределить">решил агент</span>');
  if (d.by === "human") bits.push('<span class="chip">решили вы</span>');
  if (d.assumption) bits.push('<span class="chip warn" title="Для уверенного решения не хватило фактов">допущение</span>');
  if (d.disputed) bits.push('<span class="chip warn" title="Два решателя сначала разошлись">после спора</span>');
  return bits.length ? `<div class="badges">${bits.join("")}</div>` : "";
}

function renderNode(card) {
  const root = card.kind === ROOT;
  const agent = card.author !== "human";
  return `<div class="hd" style="--c:${kindColor(card.kind)}"><span class="grip" title="Перетащить карточку вместе с её веткой">⠿</span>` +
    `<span class="chip">${esc(card.kind)}</span>` +
    (agent ? `<span class="chip agent" title="Создал ${esc(authorName(card.author))}">агент</span>` : "") +
    (card.status === "proposed" ? '<span class="chip todo">предложена</span>' : "") +
    `<span class="t" title="${esc(card.title)}">${esc(card.title)}</span>` +
    '<span class="link-handle" title="Потяните к другой карточке, чтобы связать">○</span></div>' +
    (card.body ? `<div class="body">${esc(card.body)}</div>` : "") +
    decisionBadges(card) +
    (card.status === "proposed" && !root
      ? '<div class="row-actions">' + (SERVICE_KINDS.includes(card.kind) ? "" : '<button data-act="accept" title="Принять карточку">✓ Принять</button>') +
        '<button data-act="delete" class="danger" title="Удалить карточку">✕ Удалить</button></div>'
      : "") +
    '<button type="button" class="add-child" data-act="child" title="Добавить потомка">+</button>';
}

function renderPending() {
  return '<div class="hd"><span class="chip">новая карточка</span><span class="t"></span><button type="button" class="pending-close" data-close title="Отменить (Esc)">×</button></div>' +
    '<form class="pending-form"><label>Вид<input name="kind" list="kindList" value="решение" maxlength="60" required></label>' +
    `<datalist id="kindList">${["ветка", "решение", "граница", "открытый вопрос", ...kinds()].filter((v, i, a) => a.indexOf(v) === i).map((k) => `<option value="${esc(k)}">`).join("")}</datalist>` +
    '<label>Заголовок<input name="title" required maxlength="200" placeholder="Например: Оплата только по СБП"></label>' +
    '<label>Текст<textarea name="body" rows="3" placeholder="Подробности — по желанию"></textarea></label>' +
    '<div class="row-actions"><button type="button" data-close>Отмена</button><button class="primary">Добавить</button></div></form>';
}

export async function ops(list, note = "") {
  const result = await api("/api/ops", {ops: list, note});
  await loadGraph();
  return result;
}

async function onAction(action, id) {
  if (action === "child") return canvas.startPending(id);
  if (action === "accept") return act(() => ops([{op: "update_card", id, status: "accepted"}]));
  if (action === "delete") return removeCard(id);
}

async function removeCard(id) {
  const result = await act(() => ops([{op: "delete_card", id}]));
  if (result) toast("Карточка удалена — она осталась в «Истории»", {label: "Отменить", run: () => act(async () => { await api("/api/undo", {rev: result.revision}); await loadGraph(); })});
}

function scheduleLayoutSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => act(() => api("/api/layout", canvas.layout())), 400);
}

export function initGraph() {
  canvas = createCanvas($("canvas"), {
    renderNode,
    renderPending,
    nodeClass: (card) => (card.kind === ROOT ? "k-root " : "") + (card.status === "proposed" ? "planned " : ""),
    // новая карточка встаёт рядом с родителем, а если родителя нет — рядом с тем, на что она ссылается
    parentsOf: (id) => G.parents.get(id) || G.edges.filter((e) => e.from === id).map((e) => e.to),
    childrenOf: (id) => G.children.get(id) || [],
    edgeColor: (edge) => EDGE_COLORS[edge.kind] || (edge.kind === DETAIL ? "#9a9aa2" : "#5aa0ff"),
    edgeDashed: (edge) => edge.kind !== DETAIL,
    edgeLabel: (edge) => edge.kind,
    onZoom: (percent) => { $("zoomLabel").textContent = percent + "%"; },
    onView: scheduleLayoutSave,
    onMoved: scheduleLayoutSave,
    onSelect: () => renderInspector(),
    onEdgeSelect: () => renderInspector(),
    onAction,
    onCreate: (parentId, data, point) => act(async () => {
      const result = await api("/api/ops", {ops: [{op: "add_card", kind: data.kind, title: data.title, body: data.body || "", parent: parentId}]});
      canvas.placeAt(result.ids[0], point);
      await loadGraph();
      canvas.select(result.ids[0]);
      renderInspector();
    }),
    onLink: (from, to) => act(async () => {
      const used = [...new Set(G.edges.map((e) => e.kind))];
      const kind = await promptText(`Связь: «${G.cards.get(from).title}» → «${G.cards.get(to).title}»`, DETAIL, [DETAIL, "зависит от", "противоречит", "уточняет", ...used]);
      if (kind) await ops([{op: "add_edge", from, to, kind}]);
    }),
  });
  $("fitBtn").onclick = () => canvas.fit();
  $("undoBtn").onclick = () => act(async () => {
    const history = await api("/api/history");
    const last = history.entries.find((e) => !e.undone && !e.undo_of && e.rev > 1);
    if (!last) return toast("Отменять нечего");
    await api("/api/undo", {rev: last.rev});
    await loadGraph();
    toast(`Отменено: ${last.lines[0] || "ревизия " + last.rev}`);
  });
  on("highlight", (ids) => canvas.highlight(ids));
  on("reveal", (id) => { if (G.cards.has(id)) { canvas.select(id); canvas.reveal(id); renderInspector(); } });
}

export async function loadGraph() {
  const data = await api("/api/graph");
  const before = new Set(G.cards.keys());
  G.cards = new Map(data.cards.map((c) => [c.id, c]));
  G.edges = data.edges;
  G.parents = new Map();
  G.children = new Map();
  for (const e of data.edges) {
    if (e.kind !== DETAIL) continue;
    if (!G.parents.has(e.from)) G.parents.set(e.from, []);
    G.parents.get(e.from).push(e.to);
    if (!G.children.has(e.to)) G.children.set(e.to, []);
    G.children.get(e.to).push(e.from);
  }
  S.graph = data;
  if (!layoutLoaded) { canvas.setLayout(data.layout); layoutLoaded = true; }
  const fresh = before.size ? data.cards.filter((c) => !before.has(c.id) && c.author !== "human").map((c) => c.id) : [];
  canvas.markFresh(fresh);
  if (fresh.length) setTimeout(() => { canvas.markFresh([]); canvas.draw(); }, 4000);
  // корень первым, дальше по порядку появления: так новые карточки встают рядом с родителем
  const order = [...data.cards].sort((a, b) => (a.kind === ROOT ? -1 : b.kind === ROOT ? 1 : Number(a.id.slice(1)) - Number(b.id.slice(1))));
  canvas.setData(order, data.edges);
  renderInspector();
  emit("graph");
}

export function resetGraphView() {
  layoutLoaded = false;
  G.cards = new Map();
  canvas.state.pos = new Map();
  canvas.state.heights = new Map();
  canvas.state.viewTouched = false;
  canvas.state.selected = null;
}

// ---------------------------------------------------------------------- панель свойств

function decisionBlock(card) {
  const d = card.decision;
  if (!d || typeof d !== "object") return "";
  const chosen = d.chosen || {};
  const options = (d.options || []).map((o, i) =>
    `<li class="${(chosen.indexes || []).includes(i + 1) ? "chosen" : ""}">${esc(o)}</li>`).join("");
  const what = chosen.type === "rejected" ? "все варианты отклонены" : esc(chosen.value || "");
  const positions = (d.positions || []).map((p) =>
    `<div class="position"><b>Решатель ${esc(p.slot)}</b>: ${esc(p.value || "")}<br><span class="hint">${esc(p.rationale || "")}</span></div>`).join("");
  return `<div class="decision"><div class="lbl">Решение</div>
    ${d.question ? `<div class="q">${esc(d.question)}</div>` : ""}
    ${options ? `<ol>${options}</ol>` : ""}
    <div><b>Выбрано:</b> ${what}</div>
    <div class="hint">Решил: ${esc(authorName(d.by) || "—")}${d.assumption ? " · допущение" : ""}${d.disputed ? " · после спора" : ""}${d.overridden ? " · переопределено вами" : ""}</div>
    ${d.rationale ? `<div class="rationale">${esc(d.rationale)}</div>` : ""}
    ${positions ? `<details><summary>Позиции в споре</summary>${positions}</details>` : ""}
    ${d.by && d.by !== "human" ? '<button id="overrideBtn">Переопределить решение</button>' : ""}
    <div id="overrideBox"></div></div>`;
}

function renderInspector() {
  const box = $("inspector");
  const state = canvas.state;
  if (state.selectedEdge) return renderEdgeInspector(box, G.edges.find((e) => e.id === state.selectedEdge));
  const card = state.selected && G.cards.get(state.selected);
  if (!card) { box.hidden = true; box.innerHTML = ""; box.dataset.card = ""; return; }
  const active = document.activeElement;
  if (box.dataset.card === card.id && box.contains(active) && ["INPUT", "TEXTAREA"].includes(active.tagName)) return;  // не сбиваем ввод
  box.dataset.card = card.id;
  const root = card.kind === ROOT;
  const links = G.edges.filter((e) => e.from === card.id || e.to === card.id).map((e) => {
    const out = e.from === card.id, other = G.cards.get(out ? e.to : e.from);
    return `<div class="link-row" data-edge="${e.id}"><span class="dir">${out ? "→" : "←"}</span>
      <input class="edge-kind" value="${esc(e.kind)}" list="edgeKinds" title="Вид связи">
      <a href="#" class="goto" data-card="${other.id}" title="Перейти к карточке">${esc(other.title)}</a>
      <button class="icon danger" data-del title="Удалить связь">✕</button></div>`;
  }).join("");
  box.hidden = false;
  box.innerHTML = `<div class="insp-head"><b>Карточка ${card.id}</b><span class="spacer"></span><button class="icon" id="inspClose" title="Закрыть">×</button></div>
    <label>Вид<input id="fKind" value="${esc(card.kind)}" list="kindList2" ${root ? "disabled" : ""}></label>
    <datalist id="kindList2">${kinds().map((k) => `<option value="${esc(k)}">`).join("")}</datalist>
    <label>Заголовок<input id="fTitle" value="${esc(card.title)}" maxlength="200"></label>
    <label>Текст<textarea id="fBody" rows="7">${esc(card.body || "")}</textarea></label>
    <div class="seg" id="fStatus">${Object.entries(STATUS).map(([key, name]) =>
      `<button class="${card.status === key ? "on" : ""}" data-status="${key}" ${root ? "disabled" : ""}>${name}</button>`).join("")}</div>
    <div class="hint">Автор: ${esc(authorName(card.author))} · зависит карточек: ${dependents(card.id).size}</div>
    ${decisionBlock(card)}
    <div class="lbl">Связи</div>
    <datalist id="edgeKinds">${[...new Set([DETAIL, ...G.edges.map((e) => e.kind)])].map((k) => `<option value="${esc(k)}">`).join("")}</datalist>
    ${links || '<div class="hint">Связей нет. Потяните кружок ○ на карточке к другой карточке.</div>'}
    <div class="row-actions"><button id="inspChild">+ Потомок</button>${root ? "" : '<button id="inspDelete" class="danger">Удалить карточку</button>'}</div>
    <details id="cardHistory"><summary>История карточки</summary><div class="hint">…</div></details>`;
  const save = (field, id) => $(id).addEventListener("change", () => {
    const value = $(id).value;
    if (value !== (card[field] || "")) act(() => ops([{op: "update_card", id: card.id, [field]: value}]));
  });
  save("kind", "fKind"); save("title", "fTitle"); save("body", "fBody");
  $("inspClose").onclick = () => { canvas.select(null); renderInspector(); };
  $("fStatus").onclick = (e) => {
    const status = e.target.dataset.status;
    if (status && status !== card.status) act(() => ops([{op: "update_card", id: card.id, status}]));
  };
  $("inspChild").onclick = () => canvas.startPending(card.id);
  if (!root) $("inspDelete").onclick = () => removeCard(card.id);
  box.querySelectorAll(".link-row").forEach((row) => {
    const id = row.dataset.edge;
    row.querySelector(".edge-kind").addEventListener("change", (e) => act(() => ops([{op: "update_edge", id, kind: e.target.value}])));
    row.querySelector("[data-del]").onclick = () => act(() => ops([{op: "delete_edge", id}]));
    row.querySelector(".goto").onclick = (e) => { e.preventDefault(); emit("reveal", e.target.dataset.card); };
  });
  $("overrideBtn")?.addEventListener("click", () => renderOverride(card));
  $("cardHistory").addEventListener("toggle", async (e) => {
    if (!e.target.open) return;
    const data = await act(() => api("/api/card-history?id=" + card.id));
    if (!data) return;
    e.target.querySelector("div").innerHTML = data.items.map((item) =>
      `<div>${when(item.ts)} · ${esc(authorName(item.author))} · ${item.before ? (item.after ? "изменена" : "удалена") : "создана"}${item.note ? " — " + esc(item.note) : ""}</div>`).join("") || "Изменений нет";
  });
}

function renderOverride(card) {
  const d = card.decision;
  const options = (d.options || []).map((o, i) => `<label class="radio"><input type="checkbox" name="ov" value="${i + 1}">${esc(o)}</label>`).join("");
  $("overrideBox").innerHTML = `<form id="ovForm">${options}
    <textarea name="text" rows="2" placeholder="Своё решение или дополнение"></textarea>
    <div class="row-actions"><button class="primary">Сохранить моё решение</button></div></form>`;
  $("ovForm").onsubmit = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget), text = String(form.get("text") || "").trim();
    const indexes = form.getAll("ov").map(Number).sort((a, b) => a - b);
    if (!indexes.length && !text) return toast("Выберите вариант или напишите своё");
    const values = indexes.map((i) => d.options[i - 1]);
    const chosen = {type: "choice", indexes, values, text, value: [...values, ...(text ? [text] : [])].join("; ")};
    const decision = {...d, chosen, by: "human", assumption: false, disputed: false, overridden: d.by, rationale: ""};
    act(async () => {
      await ops([{op: "update_card", id: card.id, decision, status: "accepted"}], "решение агента переопределено человеком");
      toast("Решение переопределено. Зависимые карточки проверит пакет проверки.");
    });
  };
}

function renderEdgeInspector(box, edge) {
  if (!edge) { box.hidden = true; return; }
  box.dataset.card = "";
  const from = G.cards.get(edge.from), to = G.cards.get(edge.to);
  box.hidden = false;
  box.innerHTML = `<div class="insp-head"><b>Связь ${edge.id}</b><span class="spacer"></span><button class="icon" id="inspClose">×</button></div>
    <div class="edge-ends"><a href="#" data-card="${from.id}">${esc(from.title)}</a><div class="hint">↓ ${esc(edge.kind)}</div><a href="#" data-card="${to.id}">${esc(to.title)}</a></div>
    <label>Вид связи<input id="eKind" value="${esc(edge.kind)}" list="edgeKinds2"></label>
    <datalist id="edgeKinds2">${[...new Set([DETAIL, ...G.edges.map((e) => e.kind)])].map((k) => `<option value="${esc(k)}">`).join("")}</datalist>
    <div class="hint">Автор: ${esc(authorName(edge.author))}</div>
    <div class="row-actions"><button id="eFlip">⇄ Развернуть</button><button id="eDelete" class="danger">Удалить связь</button></div>`;
  $("inspClose").onclick = () => { canvas.state.selectedEdge = null; canvas.draw(); renderInspector(); };
  $("eKind").addEventListener("change", (e) => act(() => ops([{op: "update_edge", id: edge.id, kind: e.target.value}])));
  $("eFlip").onclick = () => act(() => ops([{op: "update_edge", id: edge.id, from: edge.to, to: edge.from}]));
  $("eDelete").onclick = () => act(() => ops([{op: "delete_edge", id: edge.id}]));
  box.querySelectorAll("[data-card]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); emit("reveal", a.dataset.card); }; });
}
