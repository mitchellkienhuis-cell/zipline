"use strict";

// ---------------------------------------------------------------- backend
// Inside the app this talks to the Rust engine. On the web it runs the same
// engine compiled to WebAssembly (see the end of this file). Without either
// it falls back to a small simulation so the interface can be previewed.

const tauri = window.__TAURI__;

let backend = tauri ? {
  invoke: (cmd, args) => tauri.core.invoke(cmd, args),
  listen: (fn) => tauri.event.listen("zipline-event", (e) => fn(e.payload)),
  pickFiles: async () => toList(await tauri.dialog.open({ multiple: true, title: "Choose files to send" })),
  pickFolder: async () => toList(await tauri.dialog.open({ directory: true, multiple: true, title: "Choose folders to send" })),
  pickDir: () => tauri.dialog.open({ directory: true, title: "Save received files to" }),
  onDrop: (fn) => tauri.webview.getCurrentWebview().onDragDropEvent((e) => fn(e.payload)),
} : null;

async function chooseBackend() {
  if (backend) return backend;
  const params = new URLSearchParams(location.search);
  if (!params.has("demo") && !params.has("mock") && location.protocol.startsWith("http")) {
    let mod = null;
    try { mod = await import("./pkg/zipline_web.js"); } catch { /* plain preview: no engine bundled */ }
    if (mod) return webBackend(mod);
  }
  return mockBackend();
}

function toList(picked) {
  if (!picked) return [];
  return (Array.isArray(picked) ? picked : [picked]).map((p) => (typeof p === "string" ? p : p.path));
}

// ------------------------------------------------------------------ state

const state = { info: null, devices: [], transfers: new Map(), staged: [], mobile: false, platform: "", mode: "now", queue: { outgoing: [], incoming: [] } };
const $ = (id) => document.getElementById(id);
const rows = new Map(); // transfer id -> DOM row

// ---------------------------------------------------------------- helpers

function fmtBytes(n) {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1000; i++; } while (n >= 999.5 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function fmtTime(seconds) {
  if (!isFinite(seconds)) return "";
  if (seconds < 1.5) return "a moment";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}

const baseName = (path) => {
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
  // iOS hands out percent-encoded file:// URLs.
  try { return path.startsWith("file://") ? decodeURIComponent(name) : name; } catch { return name; }
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

const ICON = {
  laptop: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2.500"/><path d="M11 18h2"/></svg>',
  tablet: '<svg viewBox="0 0 24 24"><rect x="4.500" y="3" width="15" height="18" rx="2.500"/><path d="M11 18h2"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14m0 0-6-6m6 6 6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.500 4.500 4.500L19 7.500"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 8v5m0 3.500v.010"/><circle cx="12" cy="12" r="9"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

function deviceIcon(name) {
  const n = name.toLowerCase();
  if (/ipad|tablet|tab\b/.test(n)) return ICON.tablet;
  if (/iphone|phone|pixel|galaxy|android|oneplus|xiaomi/.test(n)) return ICON.phone;
  return ICON.laptop;
}

let toastTimer;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3800);
}

async function call(cmd, args) {
  try {
    return await backend.invoke(cmd, args);
  } catch (e) {
    toast(String(e));
    throw e;
  }
}

// ----------------------------------------------------------------- staging

function stage(paths) {
  for (const p of paths) if (!state.staged.includes(p)) state.staged.push(p);
  renderStaged();
}

function renderStaged() {
  const has = state.staged.length > 0;
  $("drop-empty").hidden = has;
  $("drop-staged").hidden = !has;
  document.body.classList.toggle("armed", has);
  if (!has) return;
  $("staged-count").textContent = `${plural(state.staged.length, "item")} ready`;
  $("chips").replaceChildren(...state.staged.map((path) =>
    el("span", { class: "chip", title: path },
      el("span", {}, baseName(path)),
      el("button", { "aria-label": "Remove", html: ICON.x, onclick: () => {
        state.staged = state.staged.filter((p) => p !== path);
        renderStaged();
      } }))));
}

const MODE_HINT = {
  now: "",
  ondemand: "Nothing moves yet. They get a note that it's ready and start it whenever they like (Zipline has to be open here at that moment).",
  web_ondemand: "Nothing moves yet. They get a note that it's ready and start it whenever they like, as long as this tab stays open.",
  web_later: "Starts by itself at the time you pick, if this tab is still open and Zipline is open on the other device.",
  later: "Starts by itself at the time you pick, if Zipline is open on both devices then.",
};

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll(".mode")) {
    b.classList.toggle("on", b.dataset.mode === mode);
    b.setAttribute("aria-checked", b.dataset.mode === mode);
  }
  const at = $("later-at");
  at.hidden = mode !== "later";
  if (mode === "later" && !at.value) {
    // Default: ten minutes from now, in the local-time format the input wants.
    const d = new Date(Date.now() + 10 * 60000 - new Date().getTimezoneOffset() * 60000);
    at.value = d.toISOString().slice(0, 16);
  }
  $("mode-hint").textContent = (state.platform === "web" && MODE_HINT[`web_${mode}`]) || MODE_HINT[mode];
}

// A second click while the first is still being handed over must not send twice.
const handing = new Set();
async function sendTo(device, paths) {
  if (handing.has(device.id)) return;
  handing.add(device.id);
  try { await handOver(device, paths); } finally { handing.delete(device.id); }
}

async function handOver(device, paths) {
  const fromStage = !paths || paths.length === 0;
  if (fromStage) {
    paths = state.staged.length ? state.staged : await backend.pickFiles();
    if (paths.length === 0) return;
  }
  // The timing options only apply to what was staged; a drop on a device sends now.
  const mode = fromStage && state.staged.length ? state.mode : "now";
  if (mode === "ondemand") {
    await call("park", { deviceId: device.id, paths });
    toast(`Ready for ${device.name} whenever they want it`);
  } else if (mode === "later") {
    const at = new Date($("later-at").value).getTime();
    if (!at || at <= Date.now()) return toast("Pick a time in the future");
    await call("send_later", { deviceId: device.id, paths, atMs: at });
    toast(`Scheduled for ${fmtClock(at)}`);
  } else {
    await call("send", { deviceId: device.id, paths });
  }
  if (paths === state.staged) {
    state.staged = [];
    setMode("now");
    renderStaged();
  }
  $("activity").hidden = false;
}

function fmtClock(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

// ----------------------------------------------------------------- devices

function renderDevices() {
  $("devices-empty").hidden = state.devices.length > 0;
  $("devices").replaceChildren(...state.devices.map((d) => {
    const card = el("button", { class: `device${d.nearby ? " nearby" : ""}`, "data-device": d.id, onclick: () => sendTo(d) },
      el("span", { class: "avatar", html: deviceIcon(d.name) }),
      el("span", { class: "meta" },
        el("div", { class: "name" }, d.name),
        el("div", { class: "where" }, el("i"), d.nearby ? "Nearby" : "Paired")));
    if (handing.has(d.id)) card.disabled = true;
    if (d.saved) {
      card.append(el("span", { class: "forget", role: "button", tabindex: "0", title: "Forget this device", html: ICON.x,
        onclick: async (e) => {
          e.stopPropagation();
          await call("remove_device", { id: d.id });
        } }));
    }
    return card;
  }));
}

// --------------------------------------------------------------- transfers

function describe(t) {
  const what = t.names[0] || "Files";
  const more = t.names.length > 1 ? ` + ${t.names.length - 1} more` : "";
  const title = t.direction === "send" ? `${what}${more} → ${t.peer_name}` : `${what}${more} from ${t.peer_name}`;
  const size = `${plural(t.files_total, "file")} · ${fmtBytes(t.total_bytes)}`;
  let status;
  switch (t.state) {
    case "preparing": status = "Preparing…"; break;
    case "connecting": status = `Connecting to ${t.peer_name}…`; break;
    case "waiting":
      status = t.direction === "send" ? `Waiting for ${t.peer_name} to accept · ${size}` : `Wants to send you ${size}`;
      break;
    case "transferring": {
      const left = t.speed_bps > 0 ? (t.total_bytes - t.done_bytes) / t.speed_bps : Infinity;
      status = `${fmtBytes(t.done_bytes)} of ${fmtBytes(t.total_bytes)}`;
      if (t.speed_bps > 0) status += ` · ${fmtBytes(t.speed_bps)}/s · ${fmtTime(left)} left`;
      break;
    }
    case "done":
      status = `${t.direction === "send" ? "Sent" : "Received"} · ${size}`;
      if (t.direction === "receive" && state.platform === "web" && t.save_path) status += ` · saved to ${t.save_path}`;
      if (t.direction === "receive" && state.mobile) status += state.platform === "android" ? " · in Downloads › Zipline" : " · in the Files app under Zipline";
      break;
    case "declined": status = t.direction === "send" ? `${t.peer_name} declined` : "Declined"; break;
    case "cancelled": status = t.error || "Cancelled"; break;
    default: status = t.error || "Something went wrong";
  }
  return { title, status };
}

const ACTIVE = ["preparing", "connecting", "waiting", "transferring"];

function renderTransfer(t) {
  let row = rows.get(t.id);
  if (!row) {
    const sending = t.direction === "send";
    // Data always flows left to right on screen for a send, right to left for a receive.
    const me = el("span", { class: "node", html: state.mobile ? ICON.phone : ICON.laptop });
    const peer = el("span", { class: "node", html: deviceIcon(t.peer_name) });
    row = el("div", { class: "transfer" },
      el("div", { class: "badge" }),
      el("div", { class: "text" }, el("div", { class: "title" }), el("div", { class: "status" })),
      el("div", { class: "actions" }),
      el("div", { class: `wire ${sending ? "tx" : "rx"}` }, me,
        el("div", { class: "cable" }, el("i", { class: "fill" }), el("b"), el("b"), el("b")), peer));
    rows.set(t.id, row);
    $("transfers").prepend(row);
  }
  const { title, status } = describe(t);
  const asking = t.direction === "receive" && t.state === "waiting";
  const active = ACTIVE.includes(t.state);

  if (t.state === "done" && row.dataset.state && row.dataset.state !== "done") row.classList.add("landed");
  row.dataset.state = t.state;
  row.classList.toggle("ask", asking);
  row.querySelector(".title").textContent = title;
  const statusEl = row.querySelector(".status");
  statusEl.textContent = status;
  if (t.state === "transferring" && t.route) {
    statusEl.append(el("span", { class: `route ${t.route}`, title: t.route === "direct" ? "Device to device, no server in between" : "Going through an encrypted relay until a direct path is found" }, t.route === "direct" ? "Direct" : "Relay"));
  }

  const badge = t.state === "done" ? ICON.check : t.state === "failed" ? ICON.alert : t.direction === "send" ? ICON.up : ICON.down;
  if (row.dataset.badge !== badge) {
    row.dataset.badge = badge;
    row.querySelector(".badge").innerHTML = badge;
  }

  const wire = row.querySelector(".wire");
  wire.hidden = !active || asking;
  const moving = t.state === "transferring";
  wire.classList.toggle("live", moving);
  wire.classList.toggle("idle", !moving);
  wire.querySelector(".fill").style.width = t.total_bytes ? `${(100 * t.done_bytes / t.total_bytes).toFixed(1)}%` : "0%";
  // Faster link, faster packets: 2 MB/s crawls, 100 MB/s+ flies.
  const pace = Math.max(0.45, Math.min(2.2, 2.4 - Math.log10(Math.max(t.speed_bps, 1e6) / 1e6) * 0.9));
  wire.style.setProperty("--pace", `${pace.toFixed(2)}s`);

  // Buttons are rebuilt only when the set changes, so a click is never lost
  // to a progress update landing mid-press.
  const mode = asking ? "ask" : active ? "active" : t.state === "done" && t.save_path && !state.mobile && state.platform !== "web" ? "show" : "none";
  if (row.dataset.mode !== mode) {
    row.dataset.mode = mode;
    const actions = row.querySelector(".actions");
    actions.replaceChildren();
    if (mode === "ask") {
      actions.append(
        el("button", { class: "btn small", onclick: () => call("respond", { id: t.id, accept: false }) }, "Decline"),
        el("button", { class: "btn small primary", onclick: () => call("respond", { id: t.id, accept: true }) }, "Accept"));
    } else if (mode === "active") {
      actions.append(el("button", { class: "btn small", onclick: () => call("cancel", { id: t.id }) }, "Cancel"));
    } else if (mode === "show") {
      const path = t.save_path;
      actions.append(el("button", { class: "btn small", onclick: () => call("reveal", { path }) }, "Show file"));
    }
  }
  refreshWaitingRoom();
}

// "Play while you wait" is offered while something is in flight, and the
// game is told what the transfer is doing (tailwind, gold packets, finish arch).
let wasBusy = new Set();
function refreshWaitingRoom() {
  const busy = [...state.transfers.values()].filter((t) => ACTIVE.includes(t.state) && !(t.direction === "receive" && t.state === "waiting"));
  $("open-game").hidden = busy.length === 0;
  const line = $("game-transfer");
  const moving = busy.filter((t) => t.state === "transferring");
  const total = moving.reduce((n, t) => n + t.total_bytes, 0), done = moving.reduce((n, t) => n + t.done_bytes, 0);
  window.ZipDash?.setTransfer({
    active: moving.length > 0,
    progress: total ? done / total : 0,
    speed: moving.reduce((n, t) => n + t.speed_bps, 0),
    // The finish arch is for a delivery, not for a cancel or a failure.
    done: busy.length === 0 && [...wasBusy].some((id) => state.transfers.get(id)?.state === "done"),
  });
  wasBusy = new Set(busy.map((t) => t.id));
  if (busy.length === 0) line.textContent = state.transfers.size ? "Transfer finished" : "";
  else {
    const t = busy[0];
    line.textContent = t.state === "transferring" && t.total_bytes ? `${Math.floor(100 * t.done_bytes / t.total_bytes)}% · ${t.peer_name}` : `Waiting for ${t.peer_name}…`;
  }
}

// ------------------------------------------------------------------- queue

function shelfRow(icon, title, status, ...buttons) {
  return el("div", { class: "transfer shelf" },
    el("div", { class: "badge", html: icon }),
    el("div", { class: "text" }, el("div", { class: "title" }, title), el("div", { class: "status" }, status)),
    el("div", { class: "actions" }, ...buttons));
}

const itemsLabel = (q) => (q.names[0] || "Files") + (q.names.length > 1 ? ` + ${q.names.length - 1} more` : "");

function renderQueue() {
  const { outgoing, incoming } = state.queue;
  $("waiting-section").hidden = incoming.length === 0;
  $("waiting").replaceChildren(...incoming.map((w) => shelfRow(ICON.down,
    `${itemsLabel(w)} from ${w.from_name}`,
    `${plural(w.files, "file")} · ${fmtBytes(w.bytes)} · ready when you are`,
    el("button", { class: "btn small", onclick: () => call("dismiss_waiting", { id: w.id }) }, "Dismiss"),
    el("button", { class: "btn small primary", onclick: async (e) => {
      e.target.disabled = true;
      // Stays off for a moment after a yes: the transfer is on its way.
      try { await call("fetch", { id: w.id }); setTimeout(() => { e.target.disabled = false; }, 8000); }
      catch { e.target.disabled = false; }
    } }, "Get it now"))));
  $("queued").replaceChildren(...outgoing.map((o) => shelfRow(o.mode === "scheduled" ? ICON.clock : ICON.up,
    `${itemsLabel(o)} → ${o.peer_name}`,
    o.mode === "scheduled" ? `Scheduled for ${fmtClock(o.at_ms)} · ${fmtBytes(o.bytes)}`
      : o.announced ? `Ready whenever ${o.peer_name} wants it · ${fmtBytes(o.bytes)}`
      : `Will tell ${o.peer_name} as soon as it's online · ${fmtBytes(o.bytes)}`,
    el("button", { class: "btn small", onclick: () => call("cancel_queued", { id: o.id }) }, "Cancel"))));
  $("activity").hidden = state.transfers.size === 0 && outgoing.length === 0;
}

function setTransfers(list) {
  const ids = new Set(list.map((t) => t.id));
  for (const [id, row] of rows) {
    if (!ids.has(id)) { row.remove(); rows.delete(id); state.transfers.delete(id); }
  }
  // Oldest first so the newest ends up on top.
  for (const t of [...list].reverse()) { state.transfers.set(t.id, t); renderTransfer(t); }
  $("activity").hidden = state.transfers.size === 0 && state.queue.outgoing.length === 0;
  refreshWaitingRoom();
}

// ---------------------------------------------------------------- settings

function renderInfo() {
  $("me-name").textContent = state.info.name;
  $("my-code").textContent = state.info.id;
  $("name-input").value = state.info.name;
  $("download-dir").textContent = state.info.download_dir;
  $("download-dir").title = state.info.download_dir;
  $("auto-accept").checked = state.info.auto_accept;
}

// ------------------------------------------------------------------ wiring

function wire() {
  $("pick-files").onclick = async () => stage(await backend.pickFiles());
  $("add-more").onclick = async () => stage(await backend.pickFiles());
  $("pick-folder").onclick = async () => stage(await backend.pickFolder());
  $("clear-staged").onclick = () => { state.staged = []; setMode("now"); renderStaged(); };
  for (const b of document.querySelectorAll(".mode")) b.onclick = () => setMode(b.dataset.mode);
  $("open-game").onclick = () => { $("game").showModal(); window.ZipDash?.start(); };
  $("game").addEventListener("close", () => window.ZipDash?.stop());
  $("clear-finished").onclick = async () => setTransfers(await call("clear_finished"));

  const openSettings = () => { renderInfo(); $("settings").showModal(); };
  $("open-settings").onclick = openSettings;
  $("me").onclick = openSettings;
  $("name-input").onchange = async (e) => {
    const name = e.target.value.trim();
    if (name) { state.info = await call("set_name", { name }); renderInfo(); }
  };
  $("auto-accept").onchange = async (e) => { state.info = await call("set_auto_accept", { on: e.target.checked }); };
  $("change-dir").onclick = async () => {
    const dir = await backend.pickDir();
    if (dir) { state.info = await call("set_download_dir", { dir }); renderInfo(); }
  };

  $("open-pair").onclick = async () => {
    $("pair-error").textContent = "";
    $("their-code").value = "";
    $("pair").showModal();
    if (!$("qr").firstChild) $("qr").innerHTML = await call("qr_svg");
  };
  $("copy-code").onclick = async () => {
    try { await navigator.clipboard.writeText(state.info.id); toast("Code copied"); }
    catch { toast("Select the code and copy it manually"); }
  };
  const connect = async () => {
    const code = $("their-code").value.trim();
    if (!code) return;
    const button = $("connect");
    button.disabled = true;
    button.textContent = "Connecting…";
    $("pair-error").textContent = "";
    try {
      const device = await backend.invoke("add_device", { code });
      $("pair").close();
      toast(`Connected to ${device.name}`);
    } catch (e) {
      $("pair-error").textContent = String(e);
    } finally {
      button.disabled = false;
      button.textContent = "Connect";
    }
  };
  $("connect").onclick = (e) => { e.preventDefault(); connect(); };
  // Phones can read the other device's QR code with the camera.
  const scanner = tauri?.barcodeScanner;
  $("scan-code").onclick = async (e) => {
    e.preventDefault();
    try {
      const permission = await scanner.requestPermissions();
      if (permission !== "granted") return void ($("pair-error").textContent = "Allow camera access in Settings to scan a code.");
      // The camera view covers the app while scanning.
      $("pair").close();
      const result = await scanner.scan({ windowed: false, formats: ["QR_CODE"] });
      $("pair").showModal();
      const code = (result?.content || "").trim();
      if (!code) return;
      $("their-code").value = code;
      connect();
    } catch (err) {
      if (!$("pair").open) $("pair").showModal();
      $("pair-error").textContent = /cancel/i.test(String(err)) ? "" : `Couldn't scan: ${err}`;
    }
  };
  $("their-code").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); connect(); } };

  // Click on the dimmed area closes a dialog.
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  }

  // Drag & drop from the desktop: onto a device sends straight away,
  // anywhere else stages the files.
  let hot = null;
  const mark = (target) => {
    if (hot === target) return;
    hot?.classList.remove("over");
    hot = target;
    hot?.classList.add("over");
  };
  backend.onDrop((e) => {
    if (e.type === "leave") return mark(null);
    const scale = window.devicePixelRatio || 1;
    const under = e.position ? document.elementFromPoint(e.position.x / scale, e.position.y / scale) : null;
    const card = under?.closest?.("[data-device]");
    if (e.type === "enter" || e.type === "over") return mark(card || $("drop"));
    if (e.type === "drop") {
      mark(null);
      const paths = e.paths || [];
      if (paths.length === 0) return;
      const device = card && state.devices.find((d) => d.id === card.dataset.device);
      if (device) sendTo(device, paths);
      else stage(paths);
    }
  });
}

// Files handed over by "Share to Zipline" get staged as soon as the app is in front.
async function collectShared() {
  try {
    const shared = await backend.invoke("take_shared");
    if (shared && shared.length) stage(shared);
  } catch { /* not available on this platform */ }
}

async function main() {
  try {
    backend = await chooseBackend();
  } catch (e) {
    $("drop-title").textContent = "Zipline couldn't start";
    $("drop-hint").textContent = String(e);
    return;
  }
  wire();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) collectShared(); });
  window.addEventListener("focus", collectShared);
  await backend.listen((event) => {
    if (event.type === "devices") { state.devices = event.devices; renderDevices(); }
    if (event.type === "queue") { state.queue = event.queue; renderQueue(); }
    if (event.type === "transfer") {
      state.transfers.set(event.transfer.id, event.transfer);
      renderTransfer(event.transfer);
      $("activity").hidden = false;
    }
  });
  const snap = await call("snapshot");
  state.info = snap.info;
  state.devices = snap.devices;
  state.mobile = snap.mobile;
  state.platform = snap.platform || "";
  state.queue = snap.queue || state.queue;
  if (state.mobile) {
    $("drop-title").textContent = "Send files";
    $("drop-hint").textContent = "pick them, then choose where they go";
    $("pick-folder").hidden = true;
    $("folder-field").hidden = true;
    $("scan-code").hidden = !tauri?.barcodeScanner;
  }
  if (state.platform === "web") {
    document.body.classList.add("web");
    $("drop-hint").textContent = "or pick them, then choose where they go";
    $("change-dir").hidden = !window.showDirectoryPicker;
    $("devices-empty").replaceChildren(
      el("p", {}, el("strong", {}, "No devices yet")),
      el("p", { class: "muted" }, "Open Zipline on your phone or computer, choose Add device there, and enter this browser's code. Or press Add device here and paste theirs."),
      el("p", { class: "muted" }, "Keep this tab open while files are moving."));
    $("mode-hint").dataset.web = "1";
  }
  renderInfo();
  renderDevices();
  renderStaged();
  setMode("now");
  setTransfers(snap.transfers);
  renderQueue();
  collectShared();
}

// ------------------------------------------------------------ browser mock

function mockBackend() {
  let emit = () => {};
  // ?demo=<scene>&mobile=1 freezes the UI in a chosen state (used for store screenshots).
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo");
  const mobileDemo = params.has("mobile");
  const info = { id: "9f3c1e7a52b84d06a1c7e5f2b8d4039c6e1a7f52b3c8d9e0f1a2b3c4d5e6f708", name: demo ? (mobileDemo ? "Anna's iPhone" : "Studio Mac") : "Preview Mac", download_dir: "/Users/you/Downloads", auto_accept: false };
  let devices = demo ? [
    { id: "a1", name: mobileDemo ? "Studio Mac" : "Anna's iPhone", nearby: true, saved: true },
    { id: "b2", name: "Pixel 9", nearby: true, saved: false },
    { id: "c3", name: "Office PC", nearby: true, saved: false },
    { id: "d4", name: "Ben's iPad", nearby: false, saved: true },
  ] : [
    { id: "a1", name: "Mitchell's iPhone", nearby: true, saved: false },
    { id: "b2", name: "Studio PC", nearby: true, saved: true },
    { id: "c3", name: "Galaxy Tab", nearby: false, saved: true },
  ];
  const transfers = new Map();
  const queue = { outgoing: [], incoming: [{ id: "w1", from_id: "b2", from_name: "Studio PC", names: ["Final cut.mp4"], files: 1, bytes: 3.1e9, received_ms: Date.now() }] };
  const emitQueue = () => emit({ type: "queue", queue: JSON.parse(JSON.stringify(queue)) });
  const peer = () => devices[0];
  function scene(name) {
    const sending = { ...base, id: "d1", direction: "send", peer_id: peer().id, peer_name: peer().name, state: "transferring", names: ["Holiday 2026"], files_total: 148, files_done: 91, total_bytes: 2.4e9, done_bytes: 1.49e9, speed_bps: 112e6, route: "direct" };
    const done = { ...base, id: "d0", direction: "receive", peer_id: "b2", peer_name: "Pixel 9", state: "done", names: ["Trip video.mp4"], files_total: 1, total_bytes: 8.6e8, done_bytes: 8.6e8, save_path: "/x", started_ms: 1 };
    if (name === "send") {
      push(done); push(sending);
      // On a phone the action is below the fold: bring devices + activity into view.
      if (mobileDemo) window.scrollTo(0, $("devices").closest("section").offsetTop - 76);
    }
    if (name === "ready") {
      queue.incoming = [
        { id: "w1", from_id: peer().id, from_name: peer().name, names: ["Final cut.mp4"], files: 1, bytes: 3.1e9, received_ms: 1 },
        { id: "w2", from_id: "c3", from_name: "Office PC", names: ["Q4 report.pdf", "Budget.xlsx"], files: 2, bytes: 4.2e6, received_ms: 2 },
      ];
      queue.outgoing = [];
      emitQueue();
    }
    if (name === "modes") {
      stage(["/x/Wedding photos", "/x/Speech.mov", "/x/Guest list.pdf"]);
      setMode("ondemand");
    }
    if (name === "game") {
      push(sending);
      $("game").showModal();
      window.ZipDash?.demo();
    }
  }
  const base = { files_done: 0, done_bytes: 0, speed_bps: 0, route: null, error: null, save_path: null, started_ms: Date.now() };
  const push = (t) => { transfers.set(t.id, t); emit({ type: "transfer", transfer: { ...t } }); };
  const run = (t) => {
    t.state = "transferring"; t.route = "direct";
    const timer = setInterval(() => {
      if (t.state !== "transferring") return clearInterval(timer);
      t.speed_bps = 96e6 + Math.random() * 30e6;
      t.done_bytes = Math.min(t.total_bytes, t.done_bytes + t.speed_bps / 5);
      if (t.done_bytes >= t.total_bytes) { t.state = "done"; t.save_path = "/Users/you/Downloads/" + t.names[0]; clearInterval(timer); }
      push(t);
    }, 200);
  };
  if (!demo) setTimeout(() => push({ ...base, id: "in1", direction: "receive", peer_id: "a1", peer_name: "Mitchell's iPhone", state: "waiting", names: ["Holiday 2026"], files_total: 148, total_bytes: 2.4e9 }), 900);
  return {
    listen: async (fn) => { emit = fn; if (demo) setTimeout(() => scene(demo), 60); },
    pickFiles: async () => ["/Users/you/Movies/Keynote final.mov", "/Users/you/Documents/Budget.xlsx"],
    pickFolder: async () => ["/Users/you/Pictures/Holiday 2026"],
    pickDir: async () => "/Users/you/Desktop/Received",
    onDrop: () => {},
    invoke: async (cmd, a = {}) => {
      switch (cmd) {
        case "snapshot": return { info, devices, transfers: [], queue: demo ? { outgoing: [], incoming: [] } : queue, mobile: mobileDemo };
        case "take_shared": return [];
        case "park": case "send_later": {
          const d = devices.find((x) => x.id === a.deviceId);
          queue.outgoing.push({ id: "q" + Date.now(), peer_id: d.id, peer_name: d.name, paths: a.paths, names: a.paths.map(baseName).slice(0, 4), files: a.paths.length, bytes: 1.8e9, mode: cmd === "park" ? "on_demand" : "scheduled", at_ms: a.atMs || null, announced: true, created_ms: Date.now() });
          emitQueue(); return;
        }
        case "cancel_queued": queue.outgoing = queue.outgoing.filter((o) => o.id !== a.id); emitQueue(); return;
        case "dismiss_waiting": queue.incoming = queue.incoming.filter((w) => w.id !== a.id); emitQueue(); return;
        case "fetch": {
          const w = queue.incoming.find((x) => x.id === a.id);
          queue.incoming = queue.incoming.filter((x) => x.id !== a.id); emitQueue();
          const t = { ...base, id: "f" + Date.now(), direction: "receive", peer_id: w.from_id, peer_name: w.from_name, state: "connecting", names: w.names, files_total: w.files, total_bytes: w.bytes, started_ms: Date.now() };
          push(t); setTimeout(() => run(t), 800); return;
        }
        case "set_name": info.name = a.name; return info;
        case "set_auto_accept": info.auto_accept = a.on; return info;
        case "set_download_dir": info.download_dir = a.dir; return info;
        case "qr_svg": return '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><path d="M1 1h3v3H1zM6 1h3v3H6zM1 6h3v3H1zM6 6h1v1H6zM8 8h1v1H8z" fill="#000"/></svg>';
        case "add_device": {
          await new Promise((r) => setTimeout(r, 700));
          if (a.code.length < 8) throw "that doesn't look like a device code";
          const d = { id: a.code, name: "Office laptop", nearby: false, saved: true };
          devices = [...devices, d]; emit({ type: "devices", devices }); return d;
        }
        case "remove_device": devices = devices.filter((d) => d.id !== a.id); emit({ type: "devices", devices }); return;
        case "send": {
          const d = devices.find((x) => x.id === a.deviceId);
          const t = { ...base, id: "s" + Date.now(), direction: "send", peer_id: d.id, peer_name: d.name, state: "connecting", names: a.paths.map(baseName).slice(0, 4), files_total: a.paths.length, total_bytes: 1.8e9, started_ms: Date.now() };
          push(t);
          setTimeout(() => { t.state = "waiting"; push(t); }, 500);
          setTimeout(() => run(t), 1500);
          return t.id;
        }
        case "respond": { const t = transfers.get(a.id); if (a.accept) run(t); else { t.state = "declined"; push(t); } return; }
        case "cancel": { const t = transfers.get(a.id); t.state = "cancelled"; push(t); return; }
        case "clear_finished": {
          for (const [id, t] of transfers) if (!["preparing", "connecting", "waiting", "transferring"].includes(t.state)) transfers.delete(id);
          return [...transfers.values()];
        }
        default: return;
      }
    },
  };
}

// ------------------------------------------------------------- web backend
// The engine compiled to WebAssembly. Files to send are File objects the
// browser hands over (the interface refers to them by a token); received
// files go into a folder the user picked (Chrome, Edge) or the downloads.

async function webBackend(mod) {
  await mod.default();
  const STORE = "zipline-web";
  const MEMORY_LIMIT = 2e9;
  let emit = () => {};
  let seq = 0;
  const picked = new Map(); // token -> [{ file, rel }]
  let folder = null;        // FileSystemDirectoryHandle, for this visit
  const sinks = new Map();  // transfer id -> where its files are going

  const register = (name, entries) => {
    const token = `web:${++seq}/${name}`;
    picked.set(token, entries);
    return token;
  };
  const resolve = (paths) => {
    const files = [], rels = [];
    for (const p of paths) for (const e of picked.get(p) || []) { files.push(e.file); rels.push(e.rel); }
    if (files.length === 0) throw "Those files are no longer available. Pick them again.";
    return [files, rels];
  };
  const fromList = (list) => {
    const tokens = [], folders = new Map();
    for (const file of list) {
      const rel = file.webkitRelativePath;
      if (rel && rel.includes("/")) {
        const top = rel.split("/")[0];
        if (!folders.has(top)) folders.set(top, []);
        folders.get(top).push({ file, rel });
      } else tokens.push(register(file.name, [{ file, rel: file.name }]));
    }
    for (const [top, entries] of folders) tokens.push(register(top, entries));
    return tokens;
  };
  const pick = (directory) => new Promise((done) => {
    const input = el("input", { type: "file" });
    if (directory) input.webkitdirectory = true; else input.multiple = true;
    input.onchange = () => done(fromList(input.files));
    input.oncancel = () => done([]);
    input.click();
  });

  // A dropped folder is walked so it arrives as a folder on the other side.
  const walk = async (entry, prefix, out) => {
    if (entry.isFile) {
      const file = await new Promise((ok, no) => entry.file(ok, no));
      out.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((ok, no) => reader.readEntries(ok, no));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
      }
    }
  };
  const fromDrop = async (data) => {
    const entries = [...data.items].filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry?.());
    if (entries.length === 0 || entries.some((e) => !e)) return fromList(data.files);
    const tokens = [];
    for (const entry of entries) {
      const out = [];
      try { await walk(entry, "", out); } catch { continue; }
      if (out.length) tokens.push(register(entry.name, out));
    }
    return tokens;
  };

  const placeLabel = () => (folder ? folder.name : "your browser's downloads");
  const withPlace = (info) => ({ ...info, download_dir: folder ? folder.name : "Your browser's downloads folder" });
  const exists = async (dir, name) => {
    try { await dir.getFileHandle(name); return true; } catch (e) { if (e.name === "TypeMismatchError") return true; }
    try { await dir.getDirectoryHandle(name); return true; } catch (e) { return e.name === "TypeMismatchError"; }
  };
  // Never overwrite: "Trip.mov" becomes "Trip (2).mov".
  const freeName = async (dir, name) => {
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
      if (!(await exists(dir, candidate))) return candidate;
    }
  };
  const cleanPart = (part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "_") || "_";

  const hooks = {
    event: (json) => emit(JSON.parse(json)),
    persist: (json) => { try { localStorage.setItem(STORE, json); } catch { /* private window */ } },
    async open(id, listing) {
      const files = JSON.parse(listing);
      const total = files.reduce((n, f) => n + f.size, 0);
      let dir = folder;
      if (dir && (await dir.queryPermission({ mode: "readwrite" })) !== "granted") dir = null;
      if (!dir && total > MEMORY_LIMIT) {
        throw new Error(window.showDirectoryPicker
          ? "Too large for the browser's memory. Choose a folder in Settings first, then send again."
          : "Too large for this browser (2 GB at most). Use the Zipline app, or Chrome or Edge.");
      }
      sinks.set(id, { files, dir, tops: new Map(), writers: new Map(), written: new Map(), parts: new Map() });
    },
    async write(id, index, offset, data) {
      const sink = sinks.get(id);
      const meta = sink.files[index];
      if (!sink.dir) {
        if (!sink.parts.has(index)) sink.parts.set(index, []);
        sink.parts.get(index).push({ offset, blob: new Blob([data]) });
        return;
      }
      if (!sink.writers.has(index)) {
        sink.writers.set(index, (async () => {
          const parts = meta.path.split("/").map(cleanPart);
          if (!sink.tops.has(parts[0])) sink.tops.set(parts[0], freeName(sink.dir, parts[0]));
          parts[0] = await sink.tops.get(parts[0]);
          let dir = sink.dir;
          for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
          const handle = await dir.getFileHandle(parts.at(-1), { create: true });
          return handle.createWritable();
        })());
      }
      const writer = await sink.writers.get(index);
      await writer.write({ type: "write", position: offset, data });
      const written = (sink.written.get(index) || 0) + data.length;
      sink.written.set(index, written);
      if (written >= meta.size) { await writer.close(); sink.writers.set(index, null); }
    },
    async close(id, ok) {
      const sink = sinks.get(id);
      sinks.delete(id);
      if (!sink) return null;
      if (sink.dir) {
        for (const pending of sink.writers.values()) {
          const writer = await Promise.resolve(pending).catch(() => null);
          if (writer) await (ok ? writer.close() : writer.abort()).catch(() => {});
        }
        const tops = await Promise.all(sink.tops.values());
        if (!ok) for (const top of tops) await sink.dir.removeEntry(top, { recursive: true }).catch(() => {});
        return ok ? `${sink.dir.name} › ${tops[0] || ""}` : null;
      }
      if (!ok) return null;
      // No folder: hand each file to the browser's downloads.
      for (const [index, meta] of sink.files.entries()) {
        const parts = (sink.parts.get(index) || []).sort((a, b) => a.offset - b.offset).map((p) => p.blob);
        const url = URL.createObjectURL(new Blob(parts));
        const link = el("a", { href: url, download: meta.path.split("/").map(cleanPart).join(" - ") });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (sink.files.length > 1) await new Promise((r) => setTimeout(r, 250));
      }
      return placeLabel();
    },
  };

  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const system = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  let saved = "";
  try { saved = localStorage.getItem(STORE) || ""; } catch { /* private window */ }
  const engine = await mod.start(saved, system ? `${browser} on ${system}` : browser, hooks);

  // Leaving the page stops everything that is in flight or parked.
  window.addEventListener("beforeunload", (e) => {
    const busy = [...state.transfers.values()].some((t) => ACTIVE.includes(t.state)) || state.queue.outgoing.length > 0;
    if (busy) { e.preventDefault(); e.returnValue = ""; }
  });

  return {
    listen: async (fn) => { emit = fn; },
    pickFiles: () => pick(false),
    pickFolder: () => pick(true),
    pickDir: async () => {
      try { folder = await window.showDirectoryPicker({ mode: "readwrite" }); } catch { return null; }
      return folder.name;
    },
    onDrop: (fn) => {
      const at = (e) => ({ x: e.clientX * (window.devicePixelRatio || 1), y: e.clientY * (window.devicePixelRatio || 1) });
      const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
      window.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); fn({ type: "over", position: at(e) }); } });
      window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) fn({ type: "leave" }); });
      window.addEventListener("drop", async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        const position = at(e);
        fn({ type: "drop", position, paths: await fromDrop(e.dataTransfer) });
      });
    },
    invoke: async (cmd, a = {}) => {
      switch (cmd) {
        case "snapshot": { const snap = JSON.parse(engine.snapshot()); snap.info = withPlace(snap.info); return snap; }
        case "set_name": return withPlace(JSON.parse(engine.set_name(a.name)));
        case "set_auto_accept": return withPlace(JSON.parse(engine.set_auto_accept(a.on)));
        case "set_download_dir": return withPlace(JSON.parse(engine.snapshot()).info);
        case "add_device": return JSON.parse(await engine.add_device(a.code));
        case "remove_device": return engine.remove_device(a.id);
        case "send": return engine.send(a.deviceId, ...resolve(a.paths));
        case "park": return engine.park(a.deviceId, ...resolve(a.paths));
        case "send_later": return engine.send_later(a.deviceId, ...resolve(a.paths), a.atMs);
        case "cancel_queued": return engine.cancel_queued(a.id);
        case "fetch": return engine.fetch(a.id);
        case "dismiss_waiting": return engine.dismiss_waiting(a.id);
        case "respond": return engine.respond(a.id, a.accept);
        case "cancel": return engine.cancel(a.id);
        case "clear_finished": return JSON.parse(engine.clear_finished());
        case "qr_svg": return engine.qr_svg();
        case "take_shared": return [];
        default: return undefined;
      }
    },
  };
}

main();
