/* Экран «Настройки»: какой агент и какая модель у каждого пакета, два решателя, автоматика. */

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
  const efforts = agent?.efforts?.length ? agent.efforts : [""];
  return `<tr data-slot="${esc(key)}"><td><b>${esc(label)}</b><div class="hint">${esc(hint)}</div></td>
    <td><select data-f="agent">${agents.map((a) => `<option value="${a.id}" ${a.id === slot.agent ? "selected" : ""}>${esc(a.name)}${a.found ? "" : " — не найден"}</option>`).join("")}</select></td>
    <td>${modelField}</td>
    <td><select data-f="effort">${efforts.map((e) => `<option value="${e}" ${e === (slot.effort || "") ? "selected" : ""}>${e || "по умолчанию"}</option>`).join("")}</select></td></tr>`;
}

const KIND_NAMES = {agent: "скилл для агента", code: "без модели", decider: "решатель", view: "экран"};

export async function renderSettings() {
  const page = $("settingsPage");
  if (!agents) {
    page.innerHTML = '<div class="hint">Проверяю, какие агенты установлены…</div>';
    const data = await act(() => api("/api/agents"));
    if (!data) return;
    agents = data.agents;
  }
  const st = S.boot.settings, auto = st.automation;
  const packages = S.boot.packages.filter((p) => p.kind === "agent");
  const hasDecider = S.boot.packages.some((p) => p.kind === "decider");
  const slot = (id) => ({...st.default_slot, ...(st.slots[id] || {})});
  page.innerHTML = `
    <h2>Корневая папка проектов</h2>
    <div class="form-grid one"><label>Здесь создаются новые проекты и ищутся существующие (пусто — «Документы\\Граф идеи»)
      <input id="projectsRoot" value="${esc(st.projects_root || "")}" placeholder="${esc(S.boot.projects_root || "")}"></label></div>
    <h2>Агенты</h2>
    <p class="hint">Оболочка сама запускает выбранного агента и даёт ему только свои инструменты: читать граф, менять граф, задать вопрос, завершить работу. Файлы и терминал агенту закрыты.</p>
    <div class="agents">${agents.map((a) => `<div class="agent-card ${a.found ? "ok" : "bad"}"><b>${esc(a.name)}</b>
      <div class="hint">${a.found ? esc(a.path) : "команда не найдена — установите агента и войдите в него"}</div>
      <button data-check="${a.id}">Подключить</button> <span class="hint" id="check-${a.id}"></span></div>`).join("")}</div>
    <h2>Кто работает в каждом пакете</h2>
    <table class="slots"><thead><tr><th>Пакет</th><th>Агент</th><th>Модель</th><th>Усилие</th></tr></thead><tbody>
      ${slotRow("default", "По умолчанию", "для пакетов без своей настройки", st.default_slot)}
      ${packages.map((p) => slotRow("pkg:" + p.id, p.name, `рекомендуемая модель: ${p.model_level}${p.web_search ? " · нужен веб-поиск" : ""}`, slot(p.id))).join("")}
      ${hasDecider ? slotRow("decider:0", "Решатель 1", "отвечает на вопросы вместо вас", st.deciders[0]) : ""}
      ${hasDecider ? slotRow("decider:1", "Решатель 2", "подключается к важным вопросам; дайте ему другую модель", st.deciders[1]) : ""}
    </tbody></table>
    ${hasDecider ? `<h2>Автоматика</h2>
    <div class="form-grid">
      <label>Кругов спора у пары решателей<input type="number" min="0" max="6" id="aRounds" value="${auto.rounds}"></label>
      <label>Пауза после стольких решений подряд без вас (0 — без паузы)<input type="number" min="0" max="500" id="aFuse" value="${auto.fuse_decisions}"></label>
      <label>Пауза после такой суммы расходов без вас, $ (0 — без паузы)<input type="number" min="0" step="0.5" id="aCost" value="${auto.fuse_cost}"></label>
      <label>Вопрос важный, если от его карточки зависит столько карточек<input type="number" min="1" max="50" id="aImportant" value="${auto.important_dependents}"></label>
    </div>` : ""}
    <div class="row-actions"><button class="primary" id="saveSettings">Сохранить настройки</button></div>
    <h2>Установленные пакеты</h2>
    <table class="slots"><tbody>${S.boot.packages.map((p) => `<tr><td><b>${esc(p.name)}</b> <span class="hint">${esc(p.id)} ${esc(p.version || "")}</span><div class="hint">${esc(p.description)}</div></td>
      <td class="hint">${KIND_NAMES[p.kind] || p.kind}</td>
      <td class="hint">читает: ${esc((p.reads || []).join(", ") || "—")}<br>создаёт: ${esc((p.writes || []).join(", ") || "—")}</td></tr>`).join("")}</tbody></table>
    ${(S.boot.package_errors || []).map((e) => `<div class="err">${esc(e)}</div>`).join("")}`;
  page.querySelectorAll("[data-check]").forEach((button) => {
    button.onclick = () => act(async () => {
      const out = $("check-" + button.dataset.check);
      out.textContent = "проверяю…";
      const result = await api("/api/agents/check", {agent: button.dataset.check});
      out.textContent = result.found ? "подключён: " + (result.version || "версия неизвестна") : "не найден";
    });
  });
  page.querySelectorAll('select[data-f="agent"]').forEach((select) => {
    select.onchange = () => { collect(); renderSettings(); };
  });
  $("saveSettings").onclick = () => act(async () => {
    const data = await api("/api/settings", collect());
    S.boot.settings = data.settings;
    S.boot = await api("/api/boot");
    toast("Настройки сохранены");
  });
}

function collect() {
  const st = S.boot.settings;
  const patch = {
    projects_root: $("projectsRoot") ? $("projectsRoot").value.trim() : (st.projects_root || ""),
    slots: {}, deciders: [{...st.deciders[0]}, {...st.deciders[1]}], default_slot: {...st.default_slot},
    automation: $("aRounds") ? {rounds: +$("aRounds").value, fuse_decisions: +$("aFuse").value, fuse_cost: +$("aCost").value, important_dependents: +$("aImportant").value} : {...st.automation},
  };
  document.querySelectorAll("tr[data-slot]").forEach((row) => {
    const slot = {};
    row.querySelectorAll("[data-f]").forEach((el) => { slot[el.dataset.f] = el.value; });
    const key = row.dataset.slot;
    if (key === "default") patch.default_slot = slot;
    else if (key.startsWith("pkg:")) patch.slots[key.slice(4)] = slot;
    else patch.deciders[Number(key.slice(8))] = slot;
  });
  // чтобы перерисовка после смены агента показала новый выбор
  st.slots = {...st.slots, ...patch.slots};
  st.deciders = patch.deciders;
  st.default_slot = patch.default_slot;
  st.automation = patch.automation;
  return patch;
}
