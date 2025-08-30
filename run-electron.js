// run-electron.js — overlay widget w/ pad controls + width clamp + real-browser opens
"use strict";

const path = require("path");
const fs = require("fs");
const {
  app, BrowserWindow, Tray, Menu, nativeImage, screen, globalShortcut, shell
} = require("electron");

/* ===================== SET THESE ===================== */
const WIDGET_URL   = "https://classroom-challenge-lundquistjoshua.replit.app/?mode=compact"; // your stable URL
const SAFE_MODE    = false;   // true = framed/opaque for debugging; false = overlay
const OPEN_IN_CHROME = true;  // try Chrome first for external links, else default browser

// Clamp the window width so it isn't too wide
const MAX_W = 220;            // 👈 adjust this to cap width (e.g., 200/220/240)

// Drag bar geometry
const DRAG_BAR_Y = 153;       // vertical offset (moves the bar/× together)
const DRAG_BAR_HEIGHT = 80;   // visual height (grows downward)

/* === Padding Tweaks (Bumps) — for drag bar & shape math === */
const PAD_LEFT   = 79;        // move bar right (increase) / left (decrease)
const PAD_RIGHT  = 17;        // shorten bar on right (increase)
const PAD_TOP    = 15;        // vertical padding used by (optional) shape math
const PAD_BOTTOM = 29;
/* ===================================================== */

const RIGHT_MARGIN = 20;
const TOP_MARGIN   = 20;

let tray = null;
let win = null;
let isQuitting = false;
let loadedOnce = false;

/* --- hard-exit helper: unregister, destroy tray, exit process --- */
function forceQuit(code = 0) {
  if (isQuitting) return;
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch {}
  try { tray?.destroy(); } catch {}
  try { win?.removeAllListeners(); } catch {}
  try { app.removeAllListeners("window-all-closed"); } catch {}
  try { app.removeAllListeners("before-quit"); } catch {}

  // Ask Electron to quit, then hard-exit as a failsafe.
  try { app.quit(); } catch {}
  setTimeout(() => {
    try { app.exit(code); } catch {}
    try { process.exit(code); } catch {}
  }, 50);
}

function resolveTrayIcon() {
  const candidates = [
    path.join(__dirname, "assets", "tray.png"),
    path.join(__dirname, "Assets", "tray.png"),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return nativeImage.createFromPath(p); } catch {}
  }
  return null;
}

function openInChromeOrDefault(url) {
  if (!OPEN_IN_CHROME) { shell.openExternal(url); return; }

  const trySpawn = (exePath, args = []) => {
    try {
      if (!exePath || !fs.existsSync(exePath)) return false;
      const { spawn } = require("child_process");
      const child = spawn(exePath, args, { detached: true, stdio: "ignore" });
      child.unref();
      return true;
    } catch { return false; }
  };

  let launched = false;
  if (process.platform === "win32") {
    const guesses = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES"] && path.join(process.env["PROGRAMFILES"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
    for (const exe of guesses) { if (trySpawn(exe, [url])) { launched = true; break; } }
  } else if (process.platform === "darwin") {
    try {
      const { spawn } = require("child_process");
      const child = spawn("open", ["-a", "Google Chrome", url], { detached: true, stdio: "ignore" });
      child.unref();
      launched = true;
    } catch {}
  } else {
    const guesses = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/snap/bin/chromium",
      "/usr/bin/chromium-browser",
    ];
    for (const exe of guesses) { if (trySpawn(exe, [url])) { launched = true; break; } }
  }
  if (!launched) shell.openExternal(url);
}

/* ---------- window ---------- */
function createWindow() {
  if (win) { win.show(); win.focus(); return; }

  const baseOpts = SAFE_MODE ? {
    width: 420, height: 700, frame: true, transparent: false, alwaysOnTop: true, backgroundColor: "#ffffff",
  } : {
    width: 160, height: 600, frame: false, transparent: true, alwaysOnTop: true, backgroundColor: "#00000000",
  };

  win = new BrowserWindow({
    ...baseOpts,
    resizable: false,
    minimizable: false,
    maximizable: false,
    useContentSize: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  // place top-right
  try {
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(
      workArea.x + workArea.width - baseOpts.width - RIGHT_MARGIN,
      workArea.y + TOP_MARGIN
    );
  } catch {}

  const wc = win.webContents;

  // Any window.open → real browser
  wc.setWindowOpenHandler(({ url }) => {
    openInChromeOrDefault(url);
    return { action: "deny" };
  });

  // Special in-page navigation (hash) to trigger a hard quit
  wc.on("did-navigate-in-page", (_e, url) => {
    if (/#__quit_now__\b/i.test(url)) forceQuit(0);
  });

  win.loadURL(WIDGET_URL);

  if (SAFE_MODE) {
    wc.once("did-finish-load", () => {
      // wc.openDevTools({ mode: "detach" });
    });
  }

  if (!SAFE_MODE) {
    // Overlay: transparent host & pads + width clamp
    wc.on("did-finish-load", async () => {
      // Transparent host; inputs not draggable
      await wc.insertCSS(`
        html, body { background: transparent !important; margin: 0 !important; overflow: hidden !important; }
        button, a, input, select, textarea, [role="button"], .no-drag { -webkit-app-region: no-drag; }
      `).catch(() => {});

      // Measure content and clamp width
      const dims = await wc.executeJavaScript(`(function () {
        const body = document.body, html = document.documentElement;
        const maxW = Math.max(body.scrollWidth, body.offsetWidth, html.clientWidth, html.scrollWidth, html.offsetWidth);
        const maxH = Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight);
        return { w: maxW || 320, h: maxH || 500 };
      })();`).catch(() => ({ w: 320, h: 500 }));

      const W = Math.max(40, Math.min(dims.w, MAX_W));          // 👈 width clamp via MAX_W
      const padTopForBar = DRAG_BAR_Y + DRAG_BAR_HEIGHT;        // bar occupies this much vertical space
      const H = Math.max(40, Math.min(dims.h + padTopForBar, 1200));
      win.setContentSize(W, H);

      // Trim the window shape so only the bar + content are clickable.
      try {
        if (typeof win.setShape === 'function') {
          const barY      = DRAG_BAR_Y + PAD_TOP;                 // where the drag bar starts
          const contentY  = barY + DRAG_BAR_HEIGHT;               // content starts below the bar
          const innerW    = W - PAD_LEFT - PAD_RIGHT;
          const contentH  = Math.max(0, H - contentY - PAD_BOTTOM);

          const shapeRects = [
            { x: PAD_LEFT, y: barY,     width: innerW, height: DRAG_BAR_HEIGHT }, // drag bar
            { x: PAD_LEFT, y: contentY, width: innerW, height: contentH },        // content
          ];
          win.setShape(shapeRects);
        } else {
          console.warn('BrowserWindow.setShape not supported on this Electron/platform.');
        }
      } catch (e) {
        console.warn('setShape failed:', e);
      }

      // Re-snap to right edge after sizing
      try {
        const { workArea } = screen.getPrimaryDisplay();
        win.setPosition(
          workArea.x + workArea.width - W - RIGHT_MARGIN,
          workArea.y + TOP_MARGIN
        );
      } catch {}

      // Pad/bump-driven drag bar + close dot
      await wc.insertCSS(`
        #__qw_wrap__ { position: relative !important; }

        #__dragbar__ {
          position: fixed;
          top: ${DRAG_BAR_Y + PAD_TOP}px;
          left: ${PAD_LEFT}px;
          width: ${W - PAD_LEFT - PAD_RIGHT}px;
          height: ${DRAG_BAR_HEIGHT}px;
          -webkit-app-region: drag;
          cursor: move;
          z-index: 2147483647;
          background: rgba(120,120,120,0.05);
          border-radius: 8px;
        }
        #__dragbar__:hover { background: rgba(120,120,120,0.05); }

        #__close__ {
          position: fixed;
          top: ${DRAG_BAR_Y + PAD_TOP + 3}px;
          right: ${PAD_RIGHT + 3}px;
          width: 12px; height: 12px;
          background: #f33; border-radius: 6px;
          z-index: 2147483647; cursor: pointer; -webkit-app-region: no-drag;
        }
        #__close__:hover { background: #e22; }
        #__close__::before {
          content: '×'; position: absolute; left: 50%; top: 50%;
          transform: translate(-50%, -52%); font-size: 10px; color: #fff; font-weight: 700;
          user-select: none; pointer-events: none;
        }
      `).catch(() => {});

      // Inject elements
      await wc.executeJavaScript(`(function () {
        const wrap = document.getElementById('__qw_wrap__') || document.body;

        if (!document.getElementById('__dragbar__')) {
          const bar = document.createElement('div');
          bar.id = '__dragbar__';
          wrap.prepend(bar);
        }

        if (!document.getElementById('__close__')) {
          const b = document.createElement('div');
          b.id = '__close__';
          b.title = 'Close';
          b.setAttribute('role','button');
          // Dual path: set special hash (main catches) + fallback window.close()
          b.onclick = () => {
            try { location.hash = '__quit_now__'; } catch {}
            try { window.close(); } catch {}
          };
          wrap.appendChild(b);
        }
        true;
      })();`).catch(() => {});
    });
  }

  // After first successful load (if you use nav intercepts elsewhere)
  wc.once("did-finish-load", () => { loadedOnce = true; });

  // Close = hard quit (destroy tray + exit, no ghost tray)
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      forceQuit(0);
    }
  });
  win.on("closed", () => { win = null; });
}

/* ---------- tray ---------- */
function createTray() {
  const icon = resolveTrayIcon();
  tray = new Tray(icon || nativeImage.createEmpty());
  tray.setToolTip("Quiet Widget");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show/Hide Widget",
      click: () => {
        if (!win) return createWindow();
        win.isVisible() ? win.hide() : win.show();
      }},
    { label: "Reload Widget", click: () => win?.webContents.reloadIgnoringCache() },
    { type: "separator" },
    { label: "Quit", click: () => forceQuit(0) }, // ← hard-exit via helper
  ]));
}

/* ---------- hotkeys ---------- */
function registerHotkeys() {
  try {
    globalShortcut.register("Control+Shift+W", () => {
      if (!win) return createWindow();
      win.isVisible() ? win.hide() : win.show();
    });
  } catch {}
}

/* ---------- lifecycle ---------- */
app.whenReady().then(() => {
  createWindow();
  createTray();
  registerHotkeys();
  app.on("activate", () => { if (!win) createWindow(); });
  app.on("window-all-closed", (e) => { if (!isQuitting) e.preventDefault(); });
});

// Ensure tray cleaned up for any quit path
app.on("before-quit", () => { try { tray?.destroy(); } catch {} try { globalShortcut.unregisterAll(); } catch {} });
app.on("quit",       () => { try { tray?.destroy(); } catch {} });

// Optional: handle process signals (just in case)
process.on("SIGINT",  () => forceQuit(0));
process.on("SIGTERM", () => forceQuit(0));
