/* Экран «Настройки»: корневая папка проектов, агент-помощник и три исследователя. */

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

const table = (rows, first) => `<table class="slots"><thead><tr><th>${first}</th><th>Агент</th><th>Модель</th><th>Усилие</th></tr></thead><tbody>${rows}</tbody></table>`;

export async function renderSettings() {
  const page = $("settingsPage");
  if (!agents) {
    page.innerHTML = '<div class="hint">Проверяю, какие агенты установлены…</div>';
    const data = await act(() => api("/api/agents"));
    if (!data) return;
    agents = data.agents;
  }
  const st = S.boot.settings;
  page.innerHTML = `
    <h2>Корневая папка проектов</h2>
    <div class="form-grid one"><label>Здесь создаются новые проекты (пусто — «Документы\\Граф идеи»)
      <input id="projectsRoot" value="${esc(st.projects_root || "")}" placeholder="${esc(S.boot.projects_root || "")}"></label></div>

    <h2>Агенты</h2>
    <p class="hint">Программа сама запускает выбранного агента. Файлов и терминала у него нет: он ищет в сети, предлагает и задаёт вопросы.</p>
    <div class="agents">${agents.map((a) => `<div class="agent-card ${a.found ? "ok" : "bad"}"><b>${esc(a.name)}</b>
      <div class="hint">${a.found ? esc(a.path) : "команда не найдена — установите агента и войдите в него"}</div>
      <button data-check="${a.id}">Проверить</button> <span class="hint" id="check-${a.id}"></span></div>`).join("")}</div>

    <h2>Помощник</h2>
    <p class="hint">Предлагает роли, сценарии, проблемы и варианты автоматизации, строит диаграммы.</p>
    ${table(slotRow("helper", "Помощник", "предлагает и строит диаграммы", st.helper), "Роль")}

    <h2>Автопилот</h2>
    <p class="hint">Сильная модель: сначала задаёт вопросы о границах системы (до 15), затем сама проходит всю цепочку — принимает и отклоняет предложения. Выберите самую сильную модель.</p>
    ${table(slotRow("autopilot", "Автопилот", "вопросы о границах и решения", st.autopilot), "Роль")}

    <h2>Проверяющий</h2>
    <p class="hint">Независимая модель: перед выгрузкой один раз читает граф и ищет разногласия. Выберите НЕ ту модель, что у помощника и автопилота: иначе проверка не независима.</p>
    ${table(slotRow("checker", "Проверяющий", "проверка графа перед выгрузкой", st.checker || {agent: "claude", model: "sonnet", effort: ""}), "Роль")}

    <h2>Исследователи</h2>
    <p class="hint">Три агента независимо ищут конкурентов и анализируют их сайты. Нужен веб-поиск; дайте им разные модели.</p>
    ${table([0, 1, 2].map((i) => slotRow("researcher:" + i, "Исследователь " + (i + 1), "поиск и анализ в сети", st.researchers[i])).join(""), "Роль")}

    <div class="row-actions"><button class="primary" id="saveSettings">Сохранить</button></div>`;
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
    toast("Настройки сохранены");
  });
}

function collect() {
  const st = S.boot.settings;
  const patch = {projects_root: $("projectsRoot") ? $("projectsRoot").value.trim() : (st.projects_root || ""), helper: {...st.helper}, autopilot: {...st.autopilot},
    checker: {...(st.checker || {agent: "claude", model: "sonnet", effort: ""})},
    researchers: st.researchers.map((r) => ({...r}))};
  document.querySelectorAll("tr[data-slot]").forEach((row) => {
    const slot = {};
    row.querySelectorAll("[data-f]").forEach((el) => { slot[el.dataset.f] = el.value; });
    const key = row.dataset.slot;
    if (key === "helper") patch.helper = slot;
    else if (key === "autopilot") patch.autopilot = slot;
    else if (key === "checker") patch.checker = slot;
    else patch.researchers[Number(key.slice(11))] = slot;
  });
  Object.assign(st, {helper: patch.helper, autopilot: patch.autopilot, checker: patch.checker, researchers: patch.researchers});     // чтобы перерисовка показала новый выбор
  return patch;
}
