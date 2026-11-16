/* UML-диаграммы в SVG: последовательности («как есть», «решение») и вариантов использования (сценарий). */

import {esc} from "./canvas.js";

const wrap = (text, width, maxLines = 3) => {
  const lines = [];
  let line = "";
  for (const word of String(text ?? "").split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > width) { lines.push(line); line = word; }
    else line = line ? line + " " + word : word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, "…"); }
  return lines.length ? lines : [""];
};

const MARKS = {new: ["#4caf50", "новый шаг"], changed: ["#e8a33a", "изменён"], auto: ["#4f9bff", "автоматизирован"], removed: ["#8d8e97", "убран"]};
const SIGNS = {new: "+", changed: "~", auto: "*", removed: "-"};

/* Шаги диаграммы текстом: «1. Кто → Кому: что [боль: …]» — так их пишет человек, так их разбирает движок. */
export function stepsText(diagram) {
  return (diagram?.steps || []).map((s, i) => {
    const sign = SIGNS[s.mark] ? SIGNS[s.mark] + " " : "";
    const pain = s.pain && (s.pain.what || s.pain.often) ? ` [боль: ${[s.pain.what, s.pain.often, s.pain.cost, s.pain.importance].map((x) => x || "").join(" | ")}]` : "";
    const by = s.by ? ` [решение: ${s.by}]` : "";
    return `${i + 1}. ${sign}${s.from} → ${s.to}: ${s.text}${pain}${by}`;
  }).join("\n");
}

/* Диаграмма последовательности UML: участники сверху, линии жизни, блоки активности, горизонтальные пронумерованные стрелки сверху вниз. */
export function sequenceSvg(diagram) {
  const people = diagram?.participants || [];
  const steps = diagram?.steps || [];
  if (people.length < 2 || !steps.length) return '<div class="hint">Диаграмма пока пустая.</div>';
  const colW = 160, left = 14, boxW = 132, topY = 8, boxH = 42, startY = 78;
  const width = left * 2 + colW * people.length;
  const x = (name) => left + colW * people.indexOf(name) + colW / 2;
  // высота строки зависит от числа строк подписи
  const rows = [];
  let y = startY;
  for (const [i, step] of steps.entries()) {
    const span = Math.abs(x(step.from) - x(step.to));
    const chars = step.from === step.to ? 22 : Math.max(14, Math.floor((span - 24) / 6.4));
    const lines = wrap(`${i + 1}. ${step.text}`, chars);
    y += 12 + 14 * lines.length;
    rows.push({y, lines});
    y += 22;
  }
  const height = y + 14;
  const out = [`<svg class="seq" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img">`,
    '<defs><marker id="sq-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>'];
  for (const name of people) {
    const cx = x(name), lines = wrap(name, 16, 2);
    out.push(`<rect x="${cx - boxW / 2}" y="${topY}" width="${boxW}" height="${boxH}" rx="3" class="seq-actor"/>`);
    lines.forEach((l, k) => out.push(`<text x="${cx}" y="${topY + boxH / 2 + 4 + (k - (lines.length - 1) / 2) * 14}" text-anchor="middle" class="seq-name">${esc(l)}</text>`));
    out.push(`<line x1="${cx}" y1="${topY + boxH}" x2="${cx}" y2="${height - 6}" class="seq-life"/>`);
  }
  // блоки активности: участник «работает» вокруг каждого своего шага
  for (const name of people) {
    const spans = [];
    steps.forEach((s, i) => { if (s.from === name || s.to === name) spans.push([rows[i].y - 12, rows[i].y + 12]); });
    const merged = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1] + 14) last[1] = Math.max(last[1], span[1]); else merged.push([...span]);
    }
    for (const [a, b] of merged) out.push(`<rect x="${x(name) - 5}" y="${a}" width="10" height="${b - a}" class="seq-act"/>`);
  }
  steps.forEach((s, i) => {
    const {y: ay, lines} = rows[i];
    const mark = MARKS[s.mark], color = s.pain ? "#e5534b" : (mark ? mark[0] : "currentColor");
    const dash = s.mark === "removed" ? ' stroke-dasharray="6 4"' : "";
    const a = x(s.from), b = x(s.to);
    if (a === b) {
      out.push(`<path d="M${a + 5} ${ay - 8} h38 v16 h-38" fill="none" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#sq-arr)"/>`);
      lines.forEach((l, k) => out.push(`<text x="${a + 50}" y="${ay - 4 + k * 14}" class="seq-text" fill="${color}">${esc(l)}</text>`));
    } else {
      const dir = b > a ? 1 : -1;
      out.push(`<line x1="${a + 5 * dir}" y1="${ay}" x2="${b - 5 * dir}" y2="${ay}" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#sq-arr)"/>`);
      const mid = (a + b) / 2;
      lines.forEach((l, k) => out.push(`<text x="${mid}" y="${ay - 7 - (lines.length - 1 - k) * 14}" text-anchor="middle" class="seq-text" fill="${color}"${s.mark === "removed" ? ' text-decoration="line-through"' : ""}>${esc(l)}</text>`));
    }
    if (s.pain) {
      const tip = [s.pain.what, s.pain.often, s.pain.cost, s.pain.importance && "важность: " + s.pain.importance].filter(Boolean).join(" · ");
      const px = a === b ? a + 60 : a + (b > a ? 22 : -22);
      out.push(`<g class="seq-pain"><title>${esc(tip)}</title><circle cx="${px}" cy="${ay + 14}" r="8" fill="#e5534b"/><text x="${px}" y="${ay + 18}" text-anchor="middle" class="seq-pain-mark">!</text></g>`);
    }
  });
  const used = [...new Set(steps.map((s) => s.mark).filter((m) => MARKS[m]))];
  out.push("</svg>");
  const legend = (used.length || steps.some((s) => s.pain))
    ? '<div class="legend">' + (steps.some((s) => s.pain) ? '<span><i style="background:#e5534b"></i>проблема</span>' : "")
      + used.map((m) => `<span><i style="background:${MARKS[m][0]}"></i>${MARKS[m][1]}</span>`).join("") + "</div>" : "";
  return `<div class="diagram">${out.join("")}</div>${legend}`;
}

/* Диаграмма вариантов использования UML: актёры слева, граница системы с вариантами (эллипсами), линии актёр — вариант.
 * Актёры расставлены по среднему положению своих вариантов, чтобы линии пересекались как можно реже. */
export function usecaseSvg(usecase) {
  const cases = usecase?.cases || [];
  if (!cases.length) return '<div class="hint">Диаграмма появится, когда у сценария будут роли.</div>';
  const actors = [];
  cases.forEach((c, i) => c.actors.forEach((name) => {
    let item = actors.find((a) => a.name === name);
    if (!item) { item = {name, at: []}; actors.push(item); }
    item.at.push(i);
  }));
  const pitch = 78, boxX = 190, boxW = 300, caseX = boxX + boxW / 2, rx = 118, ry = 28, boxTop = 14, titleH = 34;
  const caseY = (i) => boxTop + titleH + 40 + i * pitch;
  const boxH = titleH + 40 + (cases.length - 1) * pitch + 52;
  for (const a of actors) a.y = a.at.reduce((s, i) => s + caseY(i), 0) / a.at.length;
  actors.sort((p, q) => p.y - q.y);
  for (let i = 1; i < actors.length; i++) if (actors[i].y - actors[i - 1].y < 84) actors[i].y = actors[i - 1].y + 84;
  const height = Math.max(boxTop + boxH, ...actors.map((a) => a.y + 52)) + 14;
  const out = [`<svg class="uc" viewBox="0 0 ${boxX + boxW + 14} ${height}" width="${boxX + boxW + 14}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img">`];
  out.push(`<rect x="${boxX}" y="${boxTop}" width="${boxW}" height="${boxH}" class="uc-box"/>`);
  wrap(usecase.system || "Система", 38, 2).forEach((l, k) => out.push(`<text x="${caseX}" y="${boxTop + 20 + k * 14}" text-anchor="middle" class="uc-sys">${esc(l)}</text>`));
  const ax = 62;
  cases.forEach((c, i) => c.actors.forEach((name) => {
    const a = actors.find((q) => q.name === name);
    out.push(`<line x1="${ax + 16}" y1="${a.y}" x2="${caseX - rx}" y2="${caseY(i)}" class="uc-link"/>`);
  }));
  cases.forEach((c, i) => {
    const lines = wrap(c.name, 24, 2);
    out.push(`<ellipse cx="${caseX}" cy="${caseY(i)}" rx="${rx}" ry="${ry}" class="uc-case"/>`);
    lines.forEach((l, k) => out.push(`<text x="${caseX}" y="${caseY(i) + 4 + (k - (lines.length - 1) / 2) * 14}" text-anchor="middle" class="uc-text">${esc(l)}</text>`));
  });
  for (const a of actors) {
    const y = a.y;
    out.push(`<g class="uc-actor"><circle cx="${ax}" cy="${y - 20}" r="8"/><path d="M${ax} ${y - 12} v18 M${ax - 13} ${y - 4} h26 M${ax} ${y + 6} l-11 15 M${ax} ${y + 6} l11 15"/>`);
    wrap(a.name, 14, 2).forEach((l, k) => out.push(`<text x="${ax}" y="${y + 36 + k * 13}" text-anchor="middle" class="uc-text">${esc(l)}</text>`));
    out.push("</g>");
  }
  out.push("</svg>");
  return `<div class="diagram">${out.join("")}</div>`;
}
