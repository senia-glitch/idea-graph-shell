/* Экран «Настройки»: корневая папка проектов, агенты и модели в каждой роли, автоматический режим. */

import {$, S, act, api, esc, toast} from "./core.js";

let agents = null;

function slotRow(key, label, hint, slot) {
  const agent = agents.find((a) => a.id === slot.agent) || agents[0];
  const models = agent?.models || [];
  const known = models.some((m) => m.id === slot.model);
  const modelField = models.length
    ? `<select data-f="model">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === slot.model ? "selected" : ""}>${esc(m.name)}</option>`).join("")}` +
      (known || !slot.model ? "" : `<option selected value="${esc(slot.model)}">${esc(slot.model)}</option>`) + "</select>"
    : `<input data-f="model" value="${esc(slot.model || "")}" placeholder="провайдер/модель">`;
  const model = models.find((m) => m.id === slot.model);
  // у OpenCode усилие — вариант конкретной модели: у каждой свой набор (а у части его нет)
  const own = model?.efforts ? ["", ...model.efforts] : null;
  const efforts = own || (agent?.efforts?.length ? agent.efforts : [""]);
  return `<tr data-slot="${esc(key)}"><td><b>${esc(label)}</b><div class="hint">${esc(hint)}</div></td>
    <td><select data-f="agent">${agents.map((a) => `<option value="${a.id}" ${a.id === slot.agent ? "selected" : ""}>${esc(a.name)}${a.found ? "" : " — не найден"}</option>`).join("")}</select></td>
    <td>${modelField}</td>
    <td><select data-f="effort">${efforts.map((e) => `<option value="${e}" ${e === (efforts.includes(slot.effort || "") ? (slot.effort || "") : "") ? "selected" : ""}>${e || "по умолчанию"}</option>`).join("")}</select></td></tr>`;
}

const slotTable = (rows, first = "Роль") =>
  `<table class="slots"><thead><tr><th>${first}</th><th>Агент</th><th>Модель</th><th>Усилие</th></tr></thead><tbody>${rows}</tbody></table>`;

export async function renderSettings() {
  const page = $("settingsPage");
  if (!agents) {
    page.innerHTML = '<div class="hint">Проверяю, какие агенты установлены…</div>';
    const data = await act(() => api("/api/agents"));
    if (!data) return;
    agents = data.agents;
  }
  const st = S.boot.settings;
  const packages = S.boot.packages.filter((p) => p.kind === "agent");
  const withAuto = S.boot.packages.filter((p) => p.auto);
  const slot = (id) => ({...st.default_slot, ...(st.slots[id] || {})});
  page.innerHTML = `
    <h2>Корневая папка проектов</h2>
    <div class="form-grid one"><label>Здесь создаются новые проекты и ищутся существующие (пусто — «Документы\\Граф идеи»)
      <input id="projectsRoot" value="${esc(st.projects_root || "")}" placeholder="${esc(S.boot.projects_root || "")}"></label></div>

    <h2>Агенты</h2>
    <p class="hint">Движок сам запускает выбранного агента и даёт ему только свои инструменты: читать и менять граф, читать и писать банки, задать вопрос, завершить работу. Файлы и терминал агенту закрыты.</p>
    <div class="agents">${agents.map((a) => `<div class="agent-card ${a.found ? "ok" : "bad"}"><b>${esc(a.name)}</b>
      <div class="hint">${a.found ? esc(a.path) : "команда не найдена — установите агента и войдите в него"}</div>
      <button data-check="${a.id}">Подключить</button> <span class="hint" id="check-${a.id}"></span></div>`).join("")}</div>

    <h2>Помощник этапа</h2>
    <p class="hint">Основной агент каждого этапа: ведёт диалог, предлагает, проверяет, строит диаграммы.</p>
    ${slotTable(slotRow("default", "По умолчанию", "для этапов без своей настройки", st.default_slot)
      + packages.map((p) => slotRow("pkg:" + p.id, p.name, `рекомендуемая модель: ${p.model_level}`, slot(p.id))).join(""), "Этап")}

    <h2>Исследователи</h2>
    <p class="hint">Три агента независимо ищут в сети и в ваших ресурсах (вкладка «Ресурсы»). Им нужен агент с веб-поиском (например, Claude Code); дайте им разные модели.</p>
    ${slotTable([0, 1, 2].map((i) => slotRow("researcher:" + i, "Исследователь " + (i + 1), "веб-поиск и ваши ресурсы", st.researchers[i])).join(""))}

    <h2>Совет и ревью</h2>
    <p class="hint">Совет из трёх советников принимает решения в автоматическом режиме: каждый предлагает решение с кратким обоснованием, при расхождении один круг обсуждения. Ревьюер — независимая проверка результата шага: оставляет только замечания.</p>
    ${slotTable([0, 1, 2].map((i) => slotRow("adviser:" + i, "Советник " + (i + 1), "решает на развилках", st.advisers[i])).join("")
      + slotRow("reviewer", "Ревьюер", "независимое ревью шага", st.reviewer))}

    <h2>Автоматический режим и правки</h2>
    <label class="check"><input type="checkbox" id="autoResearch" ${st.auto_research ? "checked" : ""}> В автоматическом режиме сначала исследовать область (исследователи → основной агент)</label>
    <label class="check" title="Агент не будет упираться в число карточек, но создаёт только то, что подтверждено фактами и нужно по критериям этапа"><input type="checkbox" id="autoUnlimited" ${st.auto_unlimited ? "checked" : ""}> Не ограничивать автоматический режим по количеству карточек (агент делает только то, что подтверждено фактами, без работы ради работы)</label>
    <label class="check"><input type="checkbox" id="autoPropagate" ${st.auto_propagate ? "checked" : ""}> После правки утверждённого шага автоматически предлагать правки зависимых карточек (вы их принимаете или отклоняете)</label>
    ${withAuto.length ? `<p class="hint">Лимиты автоматического режима (не действуют при включённом «Не ограничивать»):</p>
    <div class="form-grid">${withAuto.map((p) => p.auto.limits.map((l) =>
      `<label>${esc(p.name)}: ${esc(l.name)}<input type="number" min="1" max="20" data-auto="${p.id}.${l.key}" value="${(st.auto_limits?.[p.id]?.[l.key]) ?? l.default}"></label>`).join("")).join("")}</div>` : ""}

    <div class="row-actions"><button class="primary" id="saveSettings">Сохранить настройки</button></div>

    <h2>Установленные пакеты</h2>
    <table class="slots"><tbody>${S.boot.packages.map((p) => `<tr><td><b>${esc(p.name)}</b> <span class="hint">${esc(p.id)} ${esc(p.version || "")}</span><div class="hint">${esc(p.description)}</div></td>
      <td class="hint">${p.stage ? `шагов: ${p.stage.steps.length}` : "экран"}<br>банки: ${esc([...new Set([...(p.banks?.reads || []), ...(p.banks?.writes || [])])].join(", ") || "—")}</td></tr>`).join("")}</tbody></table>
    ${(S.boot.package_errors || []).map((e) => `<div class="err">${esc(e)}</div>`).join("")}`;
  page.querySelectorAll("[data-check]").forEach((button) => {
    button.onclick = () => act(async () => {
      const out = $("check-" + button.dataset.check);
      out.textContent = "проверяю…";
      const result = await api("/api/agents/check", {agent: button.dataset.check});
      out.textContent = result.found ? "подключён: " + (result.version || "версия неизвестна") : "не найден";
    });
  });
  page.querySelectorAll('select[data-f="agent"], select[data-f="model"]').forEach((select) => {
    select.onchange = () => { collect(); renderSettings(); };
  });
  $("saveSettings").onclick = () => act(async () => {
    const data = await api("/api/settings", collect());
    S.boot.settings = data.settings;
    S.boot = await api("/api/boot");
    toast("Настройки сохранены");
  });
}

function autoLimits() {
  const out = {};
  document.querySelectorAll("[data-auto]").forEach((input) => {
    const [pkg, key] = input.dataset.auto.split(".");
    (out[pkg] = out[pkg] || {})[key] = Math.max(1, Math.min(20, Number(input.value) || 1));
  });
  return out;
}

function collect() {
  const st = S.boot.settings;
  const patch = {
    auto_limits: autoLimits(),
    projects_root: $("projectsRoot") ? $("projectsRoot").value.trim() : (st.projects_root || ""),
    slots: {}, default_slot: {...st.default_slot},
    researchers: st.researchers.map((r) => ({...r})),
    advisers: st.advisers.map((r) => ({...r})),
    reviewer: {...st.reviewer},
    auto_research: $("autoResearch") ? $("autoResearch").checked : st.auto_research,
    auto_unlimited: $("autoUnlimited") ? $("autoUnlimited").checked : st.auto_unlimited,
    auto_propagate: $("autoPropagate") ? $("autoPropagate").checked : st.auto_propagate,
  };
  document.querySelectorAll("tr[data-slot]").forEach((row) => {
    const slot = {};
    row.querySelectorAll("[data-f]").forEach((el) => { slot[el.dataset.f] = el.value; });
    const key = row.dataset.slot;
    if (key === "default") patch.default_slot = slot;
    else if (key === "reviewer") patch.reviewer = slot;
    else if (key.startsWith("pkg:")) patch.slots[key.slice(4)] = slot;
    else if (key.startsWith("researcher:")) patch.researchers[Number(key.slice(11))] = slot;
    else if (key.startsWith("adviser:")) patch.advisers[Number(key.slice(8))] = slot;
  });
  // чтобы перерисовка после смены агента показала новый выбор
  Object.assign(st, {slots: {...st.slots, ...patch.slots}, default_slot: patch.default_slot, researchers: patch.researchers,
    advisers: patch.advisers, reviewer: patch.reviewer, auto_limits: patch.auto_limits, auto_research: patch.auto_research,
    auto_unlimited: patch.auto_unlimited, auto_propagate: patch.auto_propagate});
  return patch;
}
