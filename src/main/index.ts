import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, shell } from "electron";

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let cleanup = () => {};

process.env.MYAGENTS_DATA_DIR ??= app.getPath("userData");
process.env.MYAGENTS_APP_ROOT ??= app.getAppPath();
const telemetryReady = import("./telemetry")
  .then(({ initializeMainTelemetry }) => initializeMainTelemetry())
  .catch((error) => {
    console.error("Failed to initialize telemetry.", error);
  });

function performCleanup() {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
  settingsWindow = null;
  cleanup();
  cleanup = () => {};
}

function configureNavigation(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
}

async function loadRenderer(window: BrowserWindow, view?: "settings") {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (view) url.searchParams.set("view", view);
    await window.loadURL(url.toString());
    return;
  }
  await window.loadFile(join(__dirname, "../renderer/index.html"), {
    ...(view ? { query: { view } } : {}),
  });
}

async function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    title: "Settings",
    width: 760,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090b" : "#ffffff",
    ...(mainWindow ? { parent: mainWindow } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const window = settingsWindow;
  configureNavigation(window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  await loadRenderer(window, "settings");
}

async function createWindow() {
  const isMac = process.platform === "darwin";

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 540,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#ffffff",
    ...(isMac ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 16 },
      vibrancy: "sidebar" as const,
      visualEffectState: "followWindow" as const,
    } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  configureNavigation(mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    performCleanup();
    mainWindow = null;
  });

  const { registerIpc } = await import("./ipc");
  cleanup = registerIpc(mainWindow, {
    isTrustedSender: (event) =>
      event.sender === mainWindow?.webContents ||
      event.sender === settingsWindow?.webContents,
    openSettingsWindow: createSettingsWindow,
    broadcastAgentsChanged: (agents) => {
      for (const window of [mainWindow, settingsWindow]) {
        if (window && !window.isDestroyed()) {
          window.webContents.send("settings:agents-changed", agents);
        }
      }
    },
  });

  await loadRenderer(mainWindow);
}

app.whenReady().then(async () => {
  await telemetryReady;
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", performCleanup);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
