/* Граф справа: только наглядное отображение того, что сделано по шагам. Логикой не управляет, карточки создаются слева. */

import {createCanvas} from "./canvas.js";
import {$, S, act, api, esc} from "./core.js";
import {sequenceSvg, usecaseSvg} from "./diagrams.js";

const COLORS = {"сфера": "#e8833a", "роль": "#5aa0ff", "сценарий": "#bb9af7", "проблема": "#ff6b6b", "вариант": "#e8c33a",
  "как есть": "#e0785a", "решение": "#7fc97f"};
const DETAIL = "детализирует";
let canvas = null, layoutLoaded = false, saveTimer = 0;

const clip = (text, n) => { const t = String(text ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function renderNode(card) {
  const color = COLORS[card.kind] || "#888";
  const diagram = card.attrs?.diagram, usecase = card.attrs?.usecase;
  const thumb = diagram ? `<div class="thumb" title="Нажмите, чтобы открыть крупно">${sequenceSvg(diagram)}</div>`
    : usecase?.cases?.length ? `<div class="thumb" title="Нажмите, чтобы открыть крупно">${usecaseSvg(usecase)}</div>` : "";
  const importance = card.attrs?.importance ? `<span class="chip warn">${esc(card.attrs.importance)}</span>` : "";
  return `<div class="hd" style="--c:${color}"><span class="grip" title="Перетащить">⠿</span><span class="chip kind">${esc(card.kind)}</span>${importance}
      ${card.status === "proposed" ? '<span class="chip todo">предложено</span>' : ""}<span class="t">${esc(card.title)}</span></div>
    ${thumb || (card.body ? `<div class="body">${esc(clip(card.body, 160))}</div>` : "")}`;
}

function openBig(card) {
  const diagram = card.attrs?.diagram, usecase = card.attrs?.usecase;
  if (!diagram && !usecase?.cases?.length) return;
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal big"><div class="modal-title">${esc(card.title)}</div>
    <div class="big-body">${diagram ? sequenceSvg(diagram) : usecaseSvg(usecase)}</div>
    <div class="modal-actions"><button class="primary" data-close>Закрыть</button></div></div>`;
  const close = () => back.remove();
  back.querySelector("[data-close]").onclick = close;
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", function onKey(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } });
  document.body.appendChild(back);
}

export function initGraph() {
  canvas = createCanvas($("canvas"), {
    renderNode,
    renderPending: () => "",
    nodeClass: (card) => (card.status === "proposed" ? "planned " : ""),
    parentsOf: (id) => (S.graph?.edges || []).filter((e) => e.from === id && e.kind === DETAIL).map((e) => e.to),
    childrenOf: (id) => (S.graph?.edges || []).filter((e) => e.to === id && e.kind === DETAIL).map((e) => e.from),
    edgeColor: (edge) => (edge.kind === DETAIL ? "#9a9aa2" : "#5aa0ff"),
    edgeDashed: (edge) => edge.kind !== DETAIL,
    edgeLabel: (edge) => (edge.kind === DETAIL ? "" : edge.kind),
    onZoom: (percent) => { $("zoomLabel").textContent = percent + "%"; },
    onView: () => scheduleSave(),
    onMoved: () => scheduleSave(),
    onSelect: (id) => { const card = S.graph?.cards.find((c) => c.id === id); if (card) openBig(card); },
    onEdgeSelect: () => {},
  });
  $("fitBtn").onclick = () => canvas.fit();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => act(() => api("/api/layout", canvas.layout())), 400);
}

export async function loadGraph() {
  const data = await api("/api/graph");
  const before = new Set((S.graph?.cards || []).map((c) => c.id));
  S.graph = data;
  if (!layoutLoaded) { canvas.setLayout(data.layout); layoutLoaded = true; }
  const fresh = before.size ? data.cards.filter((c) => !before.has(c.id)).map((c) => c.id) : [];
  canvas.markFresh(fresh);
  if (fresh.length) setTimeout(() => { canvas.markFresh([]); canvas.draw(); }, 4000);
  const order = [...data.cards].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  canvas.setData(order, data.edges.filter((e) => e.kind === DETAIL));       // связи «участвует» видны на диаграммах, на графе только иерархия
}

export function resetGraphView() {
  layoutLoaded = false;
  S.graph = null;
  canvas.state.pos = new Map();
  canvas.state.heights = new Map();
  canvas.state.viewTouched = false;
  canvas.state.selected = null;
}

/* Вкладка была скрыта и карточки не измерялись: перерисовать и вписать. */
export const fitGraph = () => { canvas?.draw(); canvas?.fit(); };
