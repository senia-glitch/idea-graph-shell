/* Общее состояние интерфейса, запросы к оболочке и мелкие помощники. */

export {esc} from "./canvas.js";
import {esc} from "./canvas.js";

export const S = {
  boot: null,          // пакеты, настройки, экраны пакетов
  project: null,       // состояние открытой идеи: ревизия, работа пакетов
  graph: null,         // карточки и связи
  chat: [],
  chatSeq: 0,
  pkg: "",             // пакет, выбранный в панели справа
};

export const $ = (id) => document.getElementById(id);
export const DETAIL = "детализирует";
export const ROOT = "идея";
export const STATUS = {proposed: "предложена", accepted: "принята"};

const bus = new EventTarget();
export const on = (name, fn) => bus.addEventListener(name, (event) => fn(event.detail));
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, {detail}));

export async function api(path, data) {
  const init = data === undefined
    ? {}
    : {method: "POST", headers: {"Content-Type": "application/json", "X-Idea-Graph": "1"}, body: JSON.stringify(data)};
  let response, body;
  try {
    response = await fetch(path, init);
    body = await response.json();
  } catch (error) {
    throw new Error("Оболочка не отвечает. Проверьте, что команда idea-graph ещё запущена.");
  }
  if (!response.ok) {
    const failure = new Error(body.message || "Ошибка запроса");
    failure.code = body.error;
    throw failure;
  }
  return body;
}

let toastTimer = 0;
export function toast(text, action) {
  const el = $("toast");
  el.innerHTML = esc(text) + (action ? ` <button id="toastAct">${esc(action.label)}</button>` : "");
  el.hidden = false;
  if (action) $("toastAct").onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 3500);
}

/* Действие с показом ошибки: всё, что нажимает человек, идёт через эту обёртку. */
export async function act(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(error.message || String(error));
    return undefined;
  }
}

/* Маленькое окно ввода одной строки (вид связи и т. п.). */
export function promptText(title, value, suggestions = []) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<form class="modal"><div class="modal-title">${esc(title)}</div>
      <input name="v" value="${esc(value)}" list="promptList" autocomplete="off">
      <datalist id="promptList">${suggestions.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>
      <div class="modal-actions"><button type="button" data-no>Отмена</button><button class="primary">Готово</button></div></form>`;
    const done = (result) => { back.remove(); resolve(result); };
    back.querySelector("form").onsubmit = (e) => { e.preventDefault(); done(back.querySelector("input").value.trim() || null); };
    back.querySelector("[data-no]").onclick = () => done(null);
    back.addEventListener("mousedown", (e) => { if (e.target === back) done(null); });
    back.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
    document.body.appendChild(back);
    const input = back.querySelector("input");
    input.focus(); input.select();
  });
}

export function when(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const today = new Date().toDateString() === d.toDateString();
  return (today ? "" : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} `) + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function authorName(author) {
  if (author === "human") return "человек";
  if (author?.startsWith("package:")) return "пакет " + packageName(author.slice(8));
  if (author?.startsWith("decider")) return "решатель";
  return author || "";
}

export function packageName(id) {
  return S.boot?.packages.find((p) => p.id === id)?.name || id;
}
