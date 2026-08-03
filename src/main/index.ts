import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";

let mainWindow: BrowserWindow | null = null;
let cleanup = () => {};

function performCleanup() {
  cleanup();
  cleanup = () => {};
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 540,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    performCleanup();
    mainWindow = null;
  });

  const { registerIpc } = await import("./ipc");
  cleanup = registerIpc(mainWindow);

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  process.env.MYAGENTS_DATA_DIR ??= app.getPath("userData");
  process.env.MYAGENTS_APP_ROOT ??= app.getAppPath();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", performCleanup);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
