/* Запуск интерфейса: вкладки, выбор проекта, опрос состояния. */

import {$, S, act, api, emit, esc, on} from "./core.js";
import {initBank, renderBank} from "./bank.js";
import {fitGraph, initGraph, loadGraph, resetGraphView} from "./graph.js";
import {renderSettings} from "./settings.js";
import {initSteps, renderSteps} from "./steps.js";

let tab = "welcome";
let seen = -1;

function tabs() {
  const items = S.project ? [["work", "Работа"], ["bank", "Банк"], ["settings", "Настройки"]] : [["welcome", "Проекты"], ["settings", "Настройки"]];
  $("tabs").innerHTML = items.map(([id, name]) => `<button class="tabbtn${tab === id ? " on" : ""}" data-tab="${id}">${esc(name)}</button>`).join("");
}

async function show(next) {
  tab = next;
  document.querySelectorAll("main > .tab").forEach((el) => el.classList.toggle("on", el.id === "tab-" + next));
  for (const id of ["zoomLabel", "fitBtn"]) $(id).style.display = next === "work" ? "" : "none";
  tabs();
  if (next === "settings") renderSettings();
  if (next === "welcome") renderWelcome();
  if (next === "bank") renderBank(true);
  if (next === "work") { renderSteps(true); setTimeout(fitGraph, 80); }
}

function renderWelcome() {
  const root = S.boot.projects_root || "";
  const projects = S.boot.projects || [];
  const inRoot = new Set(projects.map((p) => p.folder));
  const elsewhere = (S.boot.settings.recent || []).filter((f) => !inRoot.has(f) && !f.startsWith(root));
  $("welcomePage").innerHTML = `
    <h2>Проекты</h2>
    <p class="hint">Корневая папка проектов: <b>${esc(root)}</b>. <a href="#" id="toSettings">Изменить в настройках</a></p>
    ${projects.length
      ? `<div class="recent">${projects.map((p) => `<a href="#" data-folder="${esc(p.folder)}"><b>${esc(p.title)}</b><span class="hint">${esc(p.folder)}</span></a>`).join("")}</div>`
      : '<div class="hint">В корневой папке пока нет проектов. Создайте первый ниже.</div>'}
    <h2>Новый проект</h2>
    <form id="createForm" class="form-grid one">
      <label>Название проекта<input name="title" required maxlength="120" placeholder="Например: автоматизация парикмахерской"></label>
      <div class="row-actions"><button class="primary">Создать</button></div>
    </form>
    <h2>Открыть папку проекта</h2>
    <form id="openForm" class="form-grid one"><label>Папка, где уже есть проект<input name="folder" placeholder="путь к папке проекта"></label>
      <div class="row-actions"><button>Открыть</button></div></form>
    ${elsewhere.length ? `<div class="lbl">Недавние из других папок</div><div class="recent">${elsewhere.map((f) => `<a href="#" data-folder="${esc(f)}">${esc(f)}</a>`).join("")}</div>` : ""}`;
  $("toSettings").onclick = (e) => { e.preventDefault(); show("settings"); };
  $("createForm").onsubmit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    act(async () => { await api("/api/project/create", data); await openProject(); });
  };
  const open = (folder) => act(async () => { await api("/api/project/open", {folder}); await openProject(); });
  $("openForm").onsubmit = (e) => {
    e.preventDefault();
    const folder = new FormData(e.currentTarget).get("folder");
    if (folder) open(folder);
  };
  $("welcomePage").querySelectorAll("[data-folder]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); open(a.dataset.folder); };
  });
}

async function loadAll() {
  const [, bank] = await Promise.all([loadGraph(), api("/api/bank")]);
  S.bank = bank.records;
}

async function openProject() {
  S.boot = await api("/api/boot");
  S.project = S.boot.project;
  seen = -1;
  resetGraphView();
  S.step = 0;
  if (!S.project) { tabs(); return show("welcome"); }
  $("projectTitle").textContent = S.project.title;
  document.title = S.project.title + " — Граф идеи";
  await loadAll();
  seen = S.project.version;
  S.step = firstOpenStep();
  await show("work");
}

/* При открытии проекта показываем первый шаг, где ещё нет результата. */
function firstOpenStep() {
  const has = [S.graph.cards.some((c) => c.kind === "сфера"), S.bank.some((r) => r.type === "competitor"), S.bank.some((r) => r.type === "fact"),
    S.graph.cards.some((c) => c.kind === "роль"), S.graph.cards.some((c) => c.kind === "сценарий"), S.graph.cards.some((c) => c.kind === "как есть"),
    S.graph.cards.some((c) => c.kind === "решение")];
  const i = has.findIndex((x) => !x);
  return i < 0 ? has.length - 1 : i;
}

let polling = false;
async function poll() {
  if (polling || !S.project) return;
  polling = true;
  try {
    const state = await api("/api/state");
    const changed = state.version !== seen || state.revision !== S.project.revision;
    S.project = state;
    if (changed) { seen = state.version; await loadAll(); }
    $("projectTitle").textContent = state.title;
    $("saveState").textContent = "";
    if (tab === "work") renderSteps(changed);
    if (tab === "bank") renderBank(changed);
  } catch (error) {
    $("saveState").textContent = "нет связи с оболочкой";
  } finally {
    polling = false;
  }
}

async function main() {
  $("tabs").onclick = (e) => { const id = e.target.dataset.tab; if (id) show(id); };
  $("openBtn").onclick = () => { S.project && tab !== "welcome" ? show("welcome") : show(S.project ? "work" : "welcome"); };
  initGraph();
  initSteps();
  initBank();
  on("poll", poll);
  try {
    await openProject();
  } catch (error) {
    $("welcomePage").innerHTML = `<div class="err">${esc(error.message)}</div>`;
  }
  setInterval(poll, 1000);
}

main();
