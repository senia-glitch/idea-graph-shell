/* Полоса крупных этапов над холстом: где мы, сколько сделано, что ждёт вас. Нажатие ставит этап в фокус. */

import {$, S, phases} from "./core.js";
import {currentPhase, selectPhase} from "./dock.js";

let last = "";

export function renderPhases() {
  const bar = $("phaseBar");
  if (!bar) return;
  const list = phases();
  if (!S.project || list.length < 1) { bar.hidden = true; return; }
  bar.hidden = false;
  const active = currentPhase()?.name;
  const html = list.map((phase, i) => {
    const cards = phase.steps.reduce((n, {st}) => n + (st.cards || 0) + (st.records || 0), 0);
    const proposed = phase.steps.reduce((n, {st}) => n + (st.proposed || 0) + (st.records_proposed || 0), 0);
    const open = phase.steps.reduce((n, {st}) => n + (st.issues || []).filter((x) => x.type !== "pending").length, 0);
    const busy = phase.steps.some(({pkg}) => ["running", "deciding", "researching", "asking"].includes(S.project.runs?.[pkg.id]?.status));
    return `<button class="phase${phase.name === active ? " on" : ""}${cards ? " has" : ""}" data-phase="${phase.name}" title="Показать этот этап и его кнопки в панели помощника">
      <span class="phase-n">${i + 1}</span><span class="phase-text"><b>${phase.name}</b>
      <span class="hint">${cards ? `${cards} шт.` : "пусто"}${proposed ? ` · ${proposed} предложено` : ""}${open ? ` · ${open} вопр.` : ""}${busy ? " · работает…" : ""}</span></span></button>`;
  }).join('<span class="phase-arrow">›</span>');
  if (html === last) return;
  last = html;
  bar.innerHTML = html;
  bar.onclick = (e) => {
    const name = e.target.closest("[data-phase]")?.dataset.phase;
    if (name) selectPhase(name);
  };
}
