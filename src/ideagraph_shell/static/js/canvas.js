/* Холст с карточками и связями. Общий для графа идеи и для карты пакетов.

   Поведение:
   - фон тянется мышью, колесо масштабирует к курсору, двойной щелчок по фону вписывает всё в окно;
   - карточка тянется вместе со своей веткой, не наезжает на чужие карточки, Esc отменяет перенос;
   - щелчок выбирает карточку, «+» создаёт потомка прямо на холсте, нижний край меняет высоту;
   - связь рисуется изогнутой стрелкой с подписью; новая связь тянется от кружка на карточке. */

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

const W = 280;
const GAP = 12;
const MIN_H = 54;
const MAX_H = 640;

function overlap(a, b, pad = 6) {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

/* Насколько можно сдвинуть группу карточек, чтобы она не наехала на остальные: сначала по X, потом по Y. */
function clampDelta(moving, still, current, target) {
  let dx = target.x - current.x;
  for (const r of moving) {
    const x = r.x + current.x, y = r.y + current.y;
    for (const o of still) {
      if (y >= o.y + o.h + GAP || y + r.h + GAP <= o.y) continue;
      if (dx > 0 && x + r.w + GAP <= o.x) dx = Math.min(dx, o.x - GAP - x - r.w);
      else if (dx < 0 && x >= o.x + o.w + GAP) dx = Math.max(dx, o.x + o.w + GAP - x);
    }
  }
  let dy = target.y - current.y;
  for (const r of moving) {
    const x = r.x + current.x + dx, y = r.y + current.y;
    for (const o of still) {
      if (x + r.w + GAP <= o.x || x >= o.x + o.w + GAP) continue;
      if (dy > 0 && y + r.h + GAP <= o.y) dy = Math.min(dy, o.y - GAP - y - r.h);
      else if (dy < 0 && y >= o.y + o.h + GAP) dy = Math.max(dy, o.y + o.h + GAP - y);
    }
  }
  return {x: current.x + dx, y: current.y + dy};
}

function borderPoint(rect, tx, ty) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return {x: cx, y: cy};
  const s = Math.min(rect.w / 2 / Math.abs(dx || 1e-9), rect.h / 2 / Math.abs(dy || 1e-9));
  return {x: cx + dx * s, y: cy + dy * s};
}

export function createCanvas(host, opts) {
  host.classList.add("canvas");
  host.innerHTML = '<div class="view"><div class="stage"><svg class="edges"></svg></div></div>';
  const viewEl = host.querySelector(".view");
  const stage = host.querySelector(".stage");
  const svg = host.querySelector("svg");
  const S = {
    view: {x: 40, y: 40, k: 1}, pos: new Map(), heights: new Map(), nodes: [], edges: [],
    selected: null, selectedEdge: null, highlight: new Set(), pending: null, draggedAt: 0, boxes: {},
    fresh: new Set(), viewTouched: false,
  };

  // ------------------------------------------------------------------ окно просмотра
  function applyView() {
    viewEl.style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.k})`;
    opts.onZoom?.(Math.round(S.view.k * 100));
  }
  function fit() {
    const cw = host.clientWidth, ch = host.clientHeight;
    const boxes = Object.values(S.boxes);
    if (!boxes.length || !cw) return;
    const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const k = Math.min(1, Math.max(0.2, Math.min((cw - 80) / (x1 - x0 || 1), (ch - 80) / (y1 - y0 || 1))));
    S.view.k = k;
    S.view.x = (cw - (x1 - x0) * k) / 2 - x0 * k;
    S.view.y = (ch - (y1 - y0) * k) / 2 - y0 * k;
    applyView();
    opts.onView?.();
  }
  host.addEventListener("wheel", (event) => {
    if (event.target.closest(".card textarea, .card .body")) return;
    event.preventDefault();
    const rect = host.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    const next = Math.min(2.5, Math.max(0.2, S.view.k * (event.deltaY < 0 ? 1.12 : 0.89)));
    const scale = next / S.view.k;
    S.view.x = px - (px - S.view.x) * scale;
    S.view.y = py - (py - S.view.y) * scale;
    S.view.k = next;
    S.viewTouched = true;
    applyView();
    opts.onView?.();
  }, {passive: false});
  let pan = null;
  host.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target.closest(".card") || event.target.closest("[data-edge]")) return;
    pan = {x: event.clientX, y: event.clientY, vx: S.view.x, vy: S.view.y, moved: false};
    host.classList.add("grabbing");
  });
  window.addEventListener("mousemove", (event) => {
    if (!pan) return;
    if (Math.hypot(event.clientX - pan.x, event.clientY - pan.y) > 2) pan.moved = true;
    S.view.x = pan.vx + event.clientX - pan.x;
    S.view.y = pan.vy + event.clientY - pan.y;
    applyView();
  });
  window.addEventListener("mouseup", () => {
    if (!pan) return;
    const moved = pan.moved;
    pan = null;
    host.classList.remove("grabbing");
    if (moved) { S.viewTouched = true; opts.onView?.(); }
    else if (S.selected || S.selectedEdge) { S.selected = null; S.selectedEdge = null; opts.onSelect?.(null); draw(); }
  });
  host.addEventListener("dblclick", (event) => {
    if (event.target.closest(".card")) return;
    S.viewTouched = false;
    fit();
  });

  // ------------------------------------------------------------------ измерения и связи
  function measure() {
    const out = {};
    stage.querySelectorAll(".card[data-id]").forEach((el) => {
      out[el.dataset.id] = {x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight};
    });
    S.boxes = out;
    return out;
  }
  function sizeStage() {
    let w = 900, h = 600;
    for (const b of Object.values(S.boxes)) { w = Math.max(w, b.x + b.w + 80); h = Math.max(h, b.y + b.h + 80); }
    stage.style.width = w + "px";
    stage.style.height = h + "px";
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
  }
  function edgePath(a, b) {
    const fcx = a.x + a.w / 2, fcy = a.y + a.h / 2, tcx = b.x + b.w / 2, tcy = b.y + b.h / 2;
    const dx = tcx - fcx, dy = tcy - fcy, dist = Math.hypot(dx, dy);
    if (!dist) return null;
    const p1 = borderPoint(a, tcx, tcy), p2 = borderPoint(b, fcx, fcy);
    const ux = dx / dist, uy = dy / dist, nx = -uy, ny = ux;
    const k = Math.min(dist * 0.35, 70), bow = Math.min(dist * 0.09, 14);
    const d = `M${p1.x},${p1.y} C${p1.x + ux * k + nx * bow},${p1.y + uy * k + ny * bow} ` +
      `${p2.x - ux * k + nx * bow},${p2.y - uy * k + ny * bow} ${p2.x},${p2.y}`;
    return {d, mx: (p1.x + p2.x) / 2 + nx * bow * 0.75, my: (p1.y + p2.y) / 2 + ny * bow * 0.75 - 5};
  }
  function drawEdges(extra = "") {
    const colors = new Map();
    const parts = [];
    for (const edge of S.edges) {
      const a = S.boxes[edge.from], b = S.boxes[edge.to];
      if (!a || !b) continue;
      const path = edgePath(a, b);
      if (!path) continue;
      const color = opts.edgeColor?.(edge) || "#9a9aa2";
      const key = color.replace(/[^a-z0-9]/gi, "");
      colors.set(key, color);
      const on = S.selectedEdge === edge.id;
      const dash = opts.edgeDashed?.(edge) ? ' stroke-dasharray="6,4"' : "";
      parts.push(
        `<path d="${path.d}" fill="none" stroke="${on ? "#e8833a" : color}" stroke-width="${on ? 2.6 : 1.7}"${dash} marker-end="url(#ar-${on ? "sel" : key})"/>` +
        `<path d="${path.d}" class="edge-hit" data-edge="${esc(edge.id)}" fill="none" stroke="transparent" stroke-width="14"/>` +
        `<text class="elab${on ? " on" : ""}" data-edge="${esc(edge.id)}" x="${path.mx}" y="${path.my}" text-anchor="middle">${esc(opts.edgeLabel?.(edge) ?? edge.kind ?? "")}</text>`,
      );
    }
    colors.set("sel", "#e8833a");
    let defs = "<defs>";
    for (const [key, color] of colors) {
      defs += `<marker id="ar-${key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;
    }
    svg.innerHTML = defs + "</defs>" + parts.join("") + extra;
  }
  svg.addEventListener("click", (event) => {
    const id = event.target.dataset?.edge;
    if (!id) return;
    event.stopPropagation();
    S.selectedEdge = id;
    S.selected = null;
    opts.onEdgeSelect?.(id);
    draw();
  });

  // ------------------------------------------------------------------ расстановка новых карточек
  function rectOf(id) {
    const p = S.pos.get(id);
    return {x: p.x, y: p.y, w: W, h: S.boxes[id]?.h || S.heights.get(id) || 110};
  }
  function placeMissing() {
    const fresh = [];
    for (const node of S.nodes) {
      if (S.pos.has(node.id)) continue;
      const parent = (opts.parentsOf?.(node.id) || []).find((p) => S.pos.has(p));
      let x = 44, y = 42;
      if (parent) {
        const pp = S.pos.get(parent);
        x = pp.x + W + 80;
        y = pp.y;
      } else if (S.pos.size) {
        y = Math.max(...[...S.pos.keys()].map((id) => rectOf(id).y + rectOf(id).h)) + 30;
      }
      const mine = {x, y, w: W, h: 110};
      const others = [...S.pos.keys()].map(rectOf);
      let guard = 0;
      while (others.some((o) => overlap(mine, o, GAP)) && guard++ < 400) mine.y += 22;
      S.pos.set(node.id, {x: mine.x, y: mine.y});
      fresh.push(node.id);
    }
    return fresh;
  }
  /* После отрисовки высоты известны точно: раздвигаем только что поставленные карточки. */
  function settle(fresh) {
    let moved = false;
    for (const id of fresh) {
      const box = S.boxes[id];
      if (!box) continue;
      let guard = 0;
      const others = Object.entries(S.boxes).filter(([other]) => other !== id).map(([, b]) => b);
      while (others.some((o) => overlap(box, o, GAP)) && guard++ < 400) { box.y += 22; moved = true; }
      S.pos.set(id, {x: box.x, y: box.y});
      const el = stage.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (el) el.style.top = box.y + "px";
    }
    return moved;
  }

  // ------------------------------------------------------------------ перетаскивание
  function bindDrag(el, onMove, onEnd) {
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button,input,select,textarea,.no-drag,.link-handle,.vresize")) return;
      event.stopPropagation();
      const sx = event.clientX, sy = event.clientY, id = event.pointerId, scale = S.view.k || 1;
      const startX = parseFloat(el.style.left) || 0, startY = parseFloat(el.style.top) || 0;
      let moved = false, cancelled = false, frame = 0, latest = null;
      const apply = () => { frame = 0; if (latest && moved) onMove(startX + (latest.x - sx) / scale, startY + (latest.y - sy) / scale); };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        window.removeEventListener("keydown", key);
        el.classList.remove("dragging");
      };
      const move = (e) => {
        if (e.pointerId !== id) return;
        latest = {x: e.clientX, y: e.clientY};
        if (!moved && Math.hypot(latest.x - sx, latest.y - sy) < 3) return;
        if (!moved) { moved = true; el.classList.add("dragging"); }
        if (!frame) frame = requestAnimationFrame(apply);
      };
      const up = (e) => {
        if (cancelled || e.pointerId !== id) return;
        if (frame) cancelAnimationFrame(frame);
        if (moved) apply();
        stop();
        if (moved) onEnd(false);
      };
      const key = (e) => {
        if (e.key !== "Escape" || !moved || cancelled) return;
        cancelled = true;
        if (frame) cancelAnimationFrame(frame);
        stop();
        onEnd(true);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      window.addEventListener("keydown", key);
    });
  }
  function subtree(id) {
    const moving = new Set([id]), todo = [id];
    while (todo.length) for (const c of opts.childrenOf?.(todo.pop()) || []) if (!moving.has(c) && S.pos.has(c)) { moving.add(c); todo.push(c); }
    return moving;
  }
  function enableNodeDrag(card, node) {
    let moving = null, originals = null, current = {x: 0, y: 0};
    bindDrag(card, (nx, ny) => {
      if (!moving) {
        moving = subtree(node.id);
        originals = new Map([...moving].map((id) => [id, {...S.pos.get(id)}]));
        current = {x: 0, y: 0};
      }
      const origin = originals.get(node.id);
      const movingRects = [...moving].map((id) => ({...originals.get(id), w: W, h: S.boxes[id]?.h || 110}));
      const still = S.nodes.filter((n) => !moving.has(n.id) && S.boxes[n.id]).map((n) => S.boxes[n.id]);
      current = clampDelta(movingRects, still, current, {x: nx - origin.x, y: ny - origin.y});
      for (const id of moving) {
        const o = originals.get(id), p = {x: o.x + current.x, y: o.y + current.y};
        S.pos.set(id, p);
        const el = stage.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (el) { el.style.left = p.x + "px"; el.style.top = p.y + "px"; }
      }
      S.draggedAt = Date.now();
      measure(); drawEdges(); sizeStage();
    }, (cancelled) => {
      if (cancelled && originals) for (const [id, p] of originals) S.pos.set(id, p);
      moving = null; originals = null;
      draw();
      if (!cancelled) opts.onMoved?.();
    });
  }
  function enableLink(handle, node) {
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation(); event.preventDefault();
      const rect = () => host.getBoundingClientRect();
      const toStage = (e) => ({x: (e.clientX - rect().left - S.view.x) / S.view.k, y: (e.clientY - rect().top - S.view.y) / S.view.k});
      const from = S.boxes[node.id];
      let target = null;
      const move = (e) => {
        const p = toStage(e);
        const start = borderPoint(from, p.x, p.y);
        drawEdges(`<path d="M${start.x},${start.y} L${p.x},${p.y}" stroke="#e8833a" stroke-width="2" stroke-dasharray="5,4" fill="none"/>`);
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".card[data-id]");
        const id = el && el.dataset.id !== node.id && !el.classList.contains("pending-node") ? el.dataset.id : null;
        if (id !== target) {
          stage.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
          target = id;
          if (el && id) el.classList.add("drop-target");
        }
      };
      const up = (e) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        stage.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
        drawEdges();
        if (target) opts.onLink?.(node.id, target, {x: e.clientX, y: e.clientY});
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }
  function enableResize(grip, card, node) {
    grip.addEventListener("pointerdown", (event) => {
      event.stopPropagation(); event.preventDefault();
      const startY = event.clientY, startH = card.offsetHeight, scale = S.view.k || 1;
      card.classList.add("vresizing");
      const move = (e) => {
        const h = Math.max(MIN_H, Math.min(MAX_H, Math.round(startH + (e.clientY - startY) / scale)));
        card.style.height = h + "px";
        S.heights.set(node.id, h);
        S.draggedAt = Date.now();
        measure(); drawEdges(); sizeStage();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        card.classList.remove("vresizing");
        draw(); opts.onMoved?.();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    grip.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (S.heights.delete(node.id)) { draw(); opts.onMoved?.(); }
    });
  }

  // ------------------------------------------------------------------ отрисовка
  function closePending() { S.pending = null; }
  function draw() {
    for (const child of [...stage.children]) if (child !== svg) child.remove();
    const fresh = placeMissing();
    for (const node of S.nodes) {
      const p = S.pos.get(node.id);
      const card = document.createElement("article");
      card.className = "card " + (opts.nodeClass?.(node) || "") + (S.selected === node.id ? " sel" : "") +
        (S.highlight.has(node.id) ? " kin" : "") + (S.fresh.has(node.id) ? " fresh" : "");
      card.dataset.id = node.id;
      card.style.left = p.x + "px";
      card.style.top = p.y + "px";
      if (S.heights.has(node.id)) { card.style.height = S.heights.get(node.id) + "px"; card.classList.add("fixed-h"); }
      card.innerHTML = opts.renderNode(node) + '<div class="vresize" title="Потяните, чтобы изменить высоту. Двойной щелчок — высота по содержимому"></div>';
      card.tabIndex = 0;
      const select = () => { S.selected = node.id; S.selectedEdge = null; opts.onSelect?.(node.id); draw(); };
      card.addEventListener("click", (event) => {
        const action = event.target.closest("[data-act]");
        if (action) { event.stopPropagation(); opts.onAction?.(action.dataset.act, node.id, event); return; }
        if (event.target.closest("button,.link-handle,.vresize")) return;
        event.stopPropagation();
        if (Date.now() - S.draggedAt < 250) return;
        select();
      });
      card.addEventListener("keydown", (event) => {
        if (event.target !== card) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
      });
      stage.appendChild(card);
      enableNodeDrag(card, node);
      const handle = card.querySelector(".link-handle");
      if (handle) enableLink(handle, node);
      enableResize(card.querySelector(".vresize"), card, node);
    }
    if (S.pending) drawPending();
    measure();
    if (fresh.length && settle(fresh)) measure();
    drawEdges(); sizeStage(); applyView();
    if (fresh.length) {
      opts.onMoved?.();
      if (!S.viewTouched) fit();          // пока человек сам не двигал холст, новые карточки остаются на виду
    }
  }
  function drawPending() {
    const parent = S.pos.get(S.pending.parentId);
    if (!parent) { S.pending = null; return; }
    const card = document.createElement("article");
    card.className = "card pending-node";
    card.dataset.id = "__pending__";
    const mine = {x: parent.x + W + 80, y: parent.y, w: W, h: 230};
    const others = [...S.pos.keys()].map(rectOf);
    let guard = 0;
    while (others.some((o) => overlap(mine, o, GAP)) && guard++ < 400) mine.y += 22;
    card.style.left = mine.x + "px";
    card.style.top = mine.y + "px";
    card.innerHTML = opts.renderPending(S.pending.parentId);
    card.querySelector("[data-close]")?.addEventListener("click", (e) => { e.stopPropagation(); closePending(); draw(); });
    card.querySelector("form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.currentTarget));
      const parentId = S.pending.parentId;
      closePending();
      opts.onCreate?.(parentId, data, {x: mine.x, y: mine.y});
    });
    stage.appendChild(card);
    setTimeout(() => card.querySelector("input,textarea")?.focus({preventScroll: true}), 0);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && S.pending && host.offsetParent) { closePending(); draw(); }
  });

  applyView();
  return {
    state: S,
    draw,
    fit() { S.viewTouched = false; fit(); },   // «Вписать»: вид снова следует за графом
    setData(nodes, edges) {
      const known = new Set(nodes.map((n) => n.id));
      for (const id of [...S.pos.keys()]) if (!known.has(id)) { S.pos.delete(id); S.heights.delete(id); }
      if (S.selected && !known.has(S.selected)) S.selected = null;
      if (S.selectedEdge && !edges.some((e) => e.id === S.selectedEdge)) S.selectedEdge = null;
      S.nodes = nodes;
      S.edges = edges;
      draw();
    },
    setLayout(layout) {
      S.pos = new Map(Object.entries(layout?.positions || {}).map(([id, p]) => [id, {x: +p.x || 0, y: +p.y || 0}]));
      S.heights = new Map(Object.entries(layout?.positions || {}).filter(([, p]) => p.h).map(([id, p]) => [id, +p.h]));
      if (layout?.view && Number.isFinite(layout.view.k)) {
        S.view = {x: +layout.view.x || 0, y: +layout.view.y || 0, k: layout.view.k};
        S.viewTouched = !!layout.view.touched;       // человек сам двигал холст — не подстраиваем вид под новые карточки
      }
    },
    layout() {
      const positions = {};
      for (const [id, p] of S.pos) {
        if (id.startsWith("__")) continue;
        positions[id] = {x: Math.round(p.x), y: Math.round(p.y)};
        if (S.heights.has(id)) positions[id].h = S.heights.get(id);
      }
      return {positions, view: {...S.view, touched: S.viewTouched}};
    },
    placeAt(id, point) { if (!S.pos.has(id)) S.pos.set(id, point); },
    select(id) { S.selected = id; S.selectedEdge = null; draw(); },
    highlight(ids) { S.highlight = new Set(ids || []); draw(); },
    markFresh(ids) { S.fresh = new Set(ids || []); },
    startPending(parentId) { S.pending = {parentId}; draw(); },
    reveal(id) {
      const box = S.boxes[id];
      if (!box) return;
      const k = S.view.k, cw = host.clientWidth, ch = host.clientHeight;
      const left = -S.view.x / k, top = -S.view.y / k;
      if (box.x >= left + 40 && box.y >= top + 40 && box.x + box.w <= left + cw / k - 40 && box.y + box.h <= top + ch / k - 40) return;
      S.view.x = cw / 2 - (box.x + box.w / 2) * k;
      S.view.y = ch / 2 - (box.y + box.h / 2) * k;
      applyView();
    },
  };
}
