// Tree desktop client (Windows) — Electron wrapper around the Tree web UI.
//
// The Tree server runs 24/7 on the user's cloud server; this app is only a
// client. It never stores credentials: the user logs in through the web UI
// exactly as in a browser (admin user `tree`).
//
// Features: system tray (minimize-to-tray, double-click to show), global
// hotkey (default Ctrl+Alt+T) to show/hide, desktop notifications for new
// bot replies while the window is hidden (via the server's /api/events SSE
// stream, read-only, no server changes), server URL + hotkey settings.

const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, dialog, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SseParser, createNotifier } = require('./notifier');

const log = (...args) => console.log('[tree-desktop]', ...args);

const DEFAULT_SERVER_URL = 'http://59.110.24.80:8787';
const DEFAULT_HOTKEY = 'CommandOrControl+Alt+T';
const APP_NAME = 'Tree';

// Set the app name before anything reads userData paths, so the per-user
// config folder is the same on every launch.
app.setName(APP_NAME);

// ---------------------------------------------------------------- config ---
// User-editable config lives next to the exe (portable folder) so the user
// can change the server URL without rebuilding. Falls back to the bundled
// config.json (same folder as main.js) and then to defaults.

function configCandidates() {
  // Read order: config.json next to the exe (unzipped-folder install,
  // user-editable), then the per-user copy (the portable exe runs from a
  // temp folder, so settings saved there live here and survive restarts),
  // then the bundled default.
  const list = [];
  try { list.push(path.join(path.dirname(process.execPath), 'config.json')); } catch (_) { /* ignore */ }
  try { list.push(path.join(app.getPath('userData'), 'config.json')); } catch (_) { /* ignore */ }
  list.push(path.join(__dirname, 'config.json'));
  return list;
}

function configWriteTarget() {
  // The NSIS portable exe extracts to a temp folder on every launch, so a
  // config written there would be lost. Write next to the exe for a normal
  // (unzipped folder) install, otherwise to the per-user app data folder.
  try {
    const exeDir = path.dirname(process.execPath);
    const tmp = os.tmpdir();
    if (exeDir !== tmp && !exeDir.startsWith(tmp + path.sep)) return path.join(exeDir, 'config.json');
  } catch (_) { /* fall through */ }
  return path.join(app.getPath('userData'), 'config.json');
}

function writeConfig(cfg) {
  const target = configWriteTarget();
  const data = { serverUrl: cfg.serverUrl, hotkey: cfg.hotkey };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return target;
}
function readConfig() {
  const cfg = { serverUrl: DEFAULT_SERVER_URL, hotkey: DEFAULT_HOTKEY };
  for (const p of configCandidates()) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof raw.serverUrl === 'string' && raw.serverUrl.trim()) cfg.serverUrl = raw.serverUrl.trim().replace(/\/+$/, '');
      if (typeof raw.hotkey === 'string' && raw.hotkey.trim()) cfg.hotkey = raw.hotkey.trim();
      cfg._source = p;
      break;
    } catch (_) { /* try next candidate */ }
  }
  return cfg;
}

// ------------------------------------------------------------ window state ---
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (_) { return {}; }
}

function saveWindowState(win) {
  try {
    const b = win.getBounds();
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ bounds: b }), 'utf8');
  } catch (_) { /* non-fatal */ }
}

// ------------------------------------------------------------------- app ---
let config = readConfig();
let win = null;
let tray = null;
let settingsWin = null;
let quitting = false;
let hotkeyRegistered = false;
let hotkeyWarningShown = false;

const iconPng = path.join(__dirname, 'assets', 'icon.png');

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideWindow() {
  if (!win) return;
  saveWindowState(win);
  win.hide();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) hideWindow();
  else showWindow();
}

function createWindow() {
  const saved = loadWindowState().bounds || {};
  win = new BrowserWindow({
    title: APP_NAME,
    width: saved.width || 1200,
    height: saved.height || 800,
    x: saved.x,
    y: saved.y,
    icon: fs.existsSync(iconPng) ? iconPng : undefined,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Voice (push-to-talk) needs the microphone; the web UI also uses desktop
  // notifications. Allow both, but only for the configured Tree server.
  const allowForTree = (origin) => {
    try { return new URL(origin).origin === new URL(config.serverUrl).origin; } catch (_) { return false; }
  };
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    callback((permission === 'media' || permission === 'notifications') && allowForTree(url));
  });
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission === 'media' || permission === 'notifications') return allowForTree(requestingOrigin);
    return false;
  });

  win.loadURL(config.serverUrl);
  win.once('ready-to-show', () => showWindow());
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow(); // closing the window hides to tray; the app keeps running
    } else {
      saveWindowState(win);
    }
  });
  win.on('closed', () => { win = null; });
  return win;
}

// ------------------------------------------------------------------ tray ---
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示 Tree', click: () => showWindow() },
    { label: '隐藏', click: () => hideWindow() },
    { type: 'separator' },
    { label: '重新连接', click: () => { if (win) win.reload(); } },
    { label: '设置服务器地址…', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(fs.existsSync(iconPng) ? iconPng : path.join(__dirname, 'assets', 'icon.ico'));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => toggleWindow());
}

// --------------------------------------------------------------- hotkey -----
function registerHotkey() {
  if (hotkeyRegistered) globalShortcut.unregister(config.hotkey);
  hotkeyRegistered = false;
  try {
    hotkeyRegistered = globalShortcut.register(config.hotkey, () => toggleWindow());
  } catch (_) {
    hotkeyRegistered = false;
  }
  if (!hotkeyRegistered && !hotkeyWarningShown) {
    hotkeyWarningShown = true;
    dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: `全局快捷键 ${config.hotkey} 注册失败`,
      detail: '这个快捷键可能已经被别的程序占用了。Tree 仍可正常使用（托盘图标双击可显示窗口），如需换一个快捷键，请在托盘菜单里打开“设置服务器地址…”修改。',
      buttons: ['知道了'],
    });
  }
  return hotkeyRegistered;
}

// -------------------------------------------------------------- settings ----
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    title: 'Tree 设置',
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    icon: fs.existsSync(iconPng) ? iconPng : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('settings:get', () => ({ serverUrl: config.serverUrl, hotkey: config.hotkey }));
ipcMain.handle('settings:save', (_e, next) => {
  if (typeof next.serverUrl === 'string' && next.serverUrl.trim()) {
    config.serverUrl = next.serverUrl.trim().replace(/\/+$/, '');
  }
  if (typeof next.hotkey === 'string' && next.hotkey.trim()) {
    config.hotkey = next.hotkey.trim();
  }
  const target = writeConfig(config);
  hotkeyWarningShown = false;
  registerHotkey();
  if (win) win.loadURL(config.serverUrl);
  restartNotifier();
  return { ok: true, savedTo: target, needsRelogin: true };
});
ipcMain.handle('settings:open-config-file', () => {
  const { shell } = require('electron');
  return shell.openPath(config._source || configCandidates()[0]);
});

// ----------------------------------------------------------- notifications --
// Read-only SSE client on the server's /api/events stream. The session cookie
// (tree_session) is read from this app's own cookie jar after the user logs
// in through the window, so no credentials are ever stored in the app.
// A new bot reply = an assistant message row whose streaming has finished.
// Notify only while the window is hidden or minimized.

const botNames = new Map(); // botId -> display name (loaded from /api/bots)
const notifier = { running: false, stopFlag: false, cookie: null };
const notifierApi = createNotifier({
  onNotify: ({ title, body }) => {
    const n = new Notification({ title, body });
    n.on('click', () => showWindow());
    n.show();
  },
  windowNeedsNotify: () => !win || !win.isVisible() || win.isMinimized(),
  getBotName: (botId) => botNames.get(botId) || 'Tree',
});
notifier.handleEvent = notifierApi.handleEvent;

async function getSessionCookie() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: config.serverUrl });
    const c = cookies.find((x) => x.name === 'tree_session');
    return c ? c.value : null;
  } catch (_) {
    return null;
  }
}

async function loadBotNames(cookie) {
  try {
    const res = await fetch(`${config.serverUrl}/api/bots`, { headers: { Cookie: `tree_session=${cookie}` } });
    if (!res.ok) return;
    const data = await res.json();
    for (const b of data.bots || []) botNames.set(b.id, b.name || b.id);
  } catch (_) { /* names are optional */ }
}

async function sseLoop() {
  let delay = 2000;
  while (!notifier.stopFlag) {
    const cookie = await getSessionCookie();
    if (!cookie) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    notifier.cookie = cookie;
    await loadBotNames(cookie);
    try {
      const res = await fetch(`${config.serverUrl}/api/events`, {
        headers: { Cookie: `tree_session=${cookie}`, Accept: 'text/event-stream' },
      });
      if (!res.ok || !res.body) {
        if (res.status === 401) { await new Promise((r) => setTimeout(r, 5000)); continue; }
        throw new Error(`SSE HTTP ${res.status}`);
      }
      delay = 2000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || notifier.stopFlag) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          notifier.handleEvent(ev);
        }
      }
      try { reader.cancel(); } catch (_) { /* ignore */ }
    } catch (_) {
      // network down / server restarting: back off and retry; never crash
    }
    if (notifier.stopFlag) break;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30000);
  }
}

function startNotifier() {
  if (notifier.running) return;
  notifier.running = true;
  notifier.stopFlag = false;
  sseLoop().finally(() => { notifier.running = false; });
}

function restartNotifier() {
  notifier.stopFlag = true;
  notifierApi.notified.clear();
  notifierApi.streaming.clear();
  setTimeout(() => { notifier.running = false; startNotifier(); }, 500);
}

// ------------------------------------------------------------------ boot ---
app.whenReady().then(() => {
  app.setName(APP_NAME);
  log('ready, server:', config.serverUrl, '| hotkey:', config.hotkey);
  createWindow();
  log('window created');
  createTray();
  log('tray created');
  const ok = registerHotkey();
  log('hotkey registered:', ok, config.hotkey);
  startNotifier();
  log('notifier started');
  app.on('activate', () => showWindow());
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // keep running in the tray on Windows
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  notifier.stopFlag = true;
});
