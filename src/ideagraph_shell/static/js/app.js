/* Запуск интерфейса: вкладки, выбор идеи, опрос состояния оболочки. */

import {createCanvas} from "./canvas.js";
import {$, S, act, api, emit, esc, on, toast} from "./core.js";
import {initDock, renderDock} from "./dock.js";
import {initGraph, loadGraph, resetGraphView} from "./graph.js";
import {renderSettings} from "./settings.js";

let tab = "welcome";
let graphRevision = -1;
const mounted = new Map();

function tabs() {
  const items = S.project
    ? [["graph", "Граф"], ...S.boot.views.map((v) => ["view-" + v.id, v.tab]), ["settings", "Настройки"]]
    : [["welcome", "Идеи"], ["settings", "Настройки"]];
  $("tabs").innerHTML = items.map(([id, name]) => `<button class="tabbtn${tab === id ? " on" : ""}" data-tab="${id}">${esc(name)}</button>`).join("");
}

async function show(next) {
  tab = next;
  document.querySelectorAll("main > .tab").forEach((el) => el.classList.toggle("on", el.id === "tab-" + next));
  for (const id of ["zoomLabel", "fitBtn", "undoBtn"]) $(id).style.display = next === "graph" ? "" : "none";
  tabs();
  if (next === "settings") renderSettings();
  if (next === "welcome") renderWelcome();
  if (next === "graph") emit("state");
  if (next.startsWith("view-")) await mountView(next.slice(5));
}

async function mountView(id) {
  let section = $("tab-view-" + id);
  if (!section) {
    section = document.createElement("section");
    section.className = "tab on";
    section.id = "tab-view-" + id;
    document.querySelector("main").appendChild(section);
  }
  section.classList.add("on");
  if (!mounted.has(id)) {
    try {
      const module = await import(`/pkg/${id}/static/view.js`);
      const call = (path, data) => api(`/pkg/${id}/api/${path}`, data);
      mounted.set(id, module.mount(section, {S, api, call, act, toast, esc, on, emit, createCanvas}));
    } catch (error) {
      section.innerHTML = `<div class="page"><div class="err">Экран пакета не загрузился: ${esc(error.message)}</div></div>`;
      return;
    }
  }
  mounted.get(id)?.show?.();
}

function renderWelcome() {
  const recent = S.boot.settings.recent || [];
  $("welcomePage").innerHTML = `
    <h2>Новая идея</h2>
    <p class="hint">Одна идея — одна папка. Граф хранится в ней (подпапка .ideagraph), поэтому его можно вести в git вместе с остальным.</p>
    <form id="createForm" class="form-grid one">
      <label>Идея одной строкой<input name="title" required maxlength="200" placeholder="Например: сервис записи к врачу без звонков"></label>
      <label>Подробнее, если есть что добавить<textarea name="body" rows="4" placeholder="Сырой текст идеи как есть"></textarea></label>
      <label>Папка идеи (будет создана)<input name="folder" required value="${esc(S.boot.default_root || "")}"></label>
      <div class="row-actions"><button class="primary">Создать идею</button></div>
    </form>
    <h2>Открыть идею</h2>
    <form id="openForm" class="form-grid one"><label>Папка, где уже есть граф<input name="folder" placeholder="путь к папке"></label>
      <div class="row-actions"><button>Открыть</button></div></form>
    ${recent.length ? `<div class="lbl">Недавние</div><div class="recent">${recent.map((f) => `<a href="#" data-folder="${esc(f)}">${esc(f)}</a>`).join("")}</div>` : ""}`;
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

async function openProject() {
  S.boot = await api("/api/boot");
  S.project = S.boot.project;
  S.chat = S.project?.chat || [];
  S.chatSeq = S.chat.at(-1)?.seq || 0;
  graphRevision = -1;
  resetGraphView();
  if (!S.project) return show("welcome");
  $("projectTitle").textContent = S.project.title;
  document.title = S.project.title + " — граф идеи";
  await show("graph");
  await loadGraph();
  graphRevision = S.project.revision;
  renderDock();
}

let polling = false;
async function poll() {
  if (polling || !S.project) return;
  polling = true;
  try {
    const state = await api("/api/state?chat=" + S.chatSeq);
    const fresh = state.chat || [];
    if (fresh.length) { S.chat.push(...fresh); S.chatSeq = fresh.at(-1).seq; }
    S.project = {...state, chat: undefined};
    $("projectTitle").textContent = state.title;
    $("saveState").textContent = "";
    if (state.revision !== graphRevision) { graphRevision = state.revision; await loadGraph(); }
    emit("state");
  } catch (error) {
    $("saveState").textContent = "нет связи с оболочкой";
  } finally {
    polling = false;
  }
}

async function main() {
  $("tabs").onclick = (e) => { const id = e.target.dataset.tab; if (id) show(id); };
  $("openBtn").onclick = () => show(tab === "welcome" && S.project ? "graph" : "welcome");
  initGraph();
  initDock();
  on("poll", poll);
  try {
    await openProject();
  } catch (error) {
    $("welcomePage").innerHTML = `<div class="err">${esc(error.message)}</div>`;
  }
  setInterval(poll, 1000);
}

main();
