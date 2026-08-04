import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

import {
  isTelemetryMode,
  type TelemetryMode,
  type TelemetrySettingsSnapshot,
} from "@/lib/telemetry/types";
import {
  sanitizeAnonymousBreadcrumb,
  sanitizeAnonymousEvent,
} from "@/lib/telemetry/privacy";

declare const __MYAGENTS_SENTRY_DSN__: string;
declare const __MYAGENTS_SENTRY_ENVIRONMENT__: string;
declare const __MYAGENTS_SENTRY_RELEASE__: string;

type MainSentry = typeof import("@sentry/electron/main");

const SETTINGS_FILE = "privacy-settings.json";
const HIGH_FREQUENCY_CHANNELS = new Set([
  "terminals:resize",
  "terminals:subscribe",
  "terminals:unsubscribe",
  "terminals:write",
]);

let mainSentry: MainSentry | null = null;
let startupMode: TelemetryMode = "off";
let initialized = false;

function getDataDirectory() {
  return process.env.MYAGENTS_DATA_DIR ?? app.getPath("userData");
}

function getSettingsPath() {
  return join(getDataDirectory(), SETTINGS_FILE);
}

function getDsn() {
  return process.env.MYAGENTS_SENTRY_DSN ??
    process.env.SENTRY_DSN ??
    __MYAGENTS_SENTRY_DSN__;
}

export function readTelemetryMode(): TelemetryMode {
  try {
    const parsed = JSON.parse(readFileSync(getSettingsPath(), "utf8")) as {
      telemetryMode?: unknown;
    };
    return isTelemetryMode(parsed.telemetryMode) ? parsed.telemetryMode : "off";
  } catch {
    return "off";
  }
}

function writeTelemetryMode(mode: TelemetryMode) {
  const settingsPath = getSettingsPath();
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ version: 1, telemetryMode: mode }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporaryPath, settingsPath);
}

function snapshot(mode = readTelemetryMode()): TelemetrySettingsSnapshot {
  const configured = Boolean(getDsn());
  return {
    mode,
    activeMode: configured ? startupMode : "off",
    configured,
    restartRequired: configured && initialized && mode !== startupMode,
  };
}

export function getTelemetrySettings() {
  return snapshot();
}

export function setTelemetryMode(mode: TelemetryMode) {
  if (!isTelemetryMode(mode)) throw new Error("Invalid telemetry mode.");
  writeTelemetryMode(mode);
  return snapshot(mode);
}

export async function initializeMainTelemetry() {
  startupMode = readTelemetryMode();
  initialized = true;
  const dsn = getDsn();
  if (!dsn || startupMode === "off") return snapshot(startupMode);

  const Sentry = await import("@sentry/electron/main");
  const developer = startupMode === "developer";
  Sentry.init({
    dsn,
    release: __MYAGENTS_SENTRY_RELEASE__,
    environment: __MYAGENTS_SENTRY_ENVIRONMENT__,
    attachScreenshot: developer,
    attachStacktrace: true,
    enableLogs: developer,
    includeLocalVariables: developer,
    maxBreadcrumbs: developer ? 200 : 50,
    normalizeDepth: developer ? 10 : 4,
    sampleRate: 1,
    sendDefaultPii: developer,
    tracesSampleRate: developer ? 1 : 0.1,
    integrations: (defaults) => developer
      ? [...defaults, Sentry.consoleLoggingIntegration()]
      : defaults,
    beforeBreadcrumb: developer
      ? undefined
      : (breadcrumb) => sanitizeAnonymousBreadcrumb(breadcrumb),
    beforeSend: developer
      ? undefined
      : (event) => sanitizeAnonymousEvent(event),
    beforeSendTransaction: developer
      ? undefined
      : (event) => sanitizeAnonymousEvent(event),
  });
  mainSentry = Sentry;

  Sentry.setTags({
    app_version: app.getVersion(),
    process: "main",
    telemetry_mode: startupMode,
  });
  Sentry.setContext("runtime", {
    appPath: developer ? app.getAppPath() : undefined,
    arch: process.arch,
    chrome: process.versions.chrome,
    dataDirectory: developer ? getDataDirectory() : undefined,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    platform: process.platform,
  });
  Sentry.addBreadcrumb({
    category: "electron.lifecycle",
    level: "info",
    message: "Main telemetry initialized",
  });
  return snapshot(startupMode);
}

function developerArguments(channel: string, args: unknown[]) {
  if (channel !== "terminals:write") return args;
  const input = args[0] as { data?: unknown; id?: unknown } | undefined;
  return [{ id: input?.id, dataLength: String(input?.data ?? "").length }];
}

export async function instrumentIpc<T>(
  channel: string,
  args: unknown[],
  operation: () => T | Promise<T>,
): Promise<T> {
  const Sentry = mainSentry;
  if (!Sentry) return operation();

  const run = async () => {
    try {
      const result = await operation();
      if (!HIGH_FREQUENCY_CHANNELS.has(channel)) {
        Sentry.addBreadcrumb({
          category: "electron.ipc",
          level: "info",
          message: channel,
          ...(startupMode === "developer"
            ? { data: { arguments: developerArguments(channel, args) } }
            : {}),
        });
      }
      return result;
    } catch (error) {
      Sentry.withScope((scope) => {
        scope.setTag("ipc.channel", channel);
        if (startupMode === "developer") {
          scope.setContext("ipc", {
            arguments: developerArguments(channel, args),
            channel,
          });
        }
        Sentry.captureException(error);
      });
      throw error;
    }
  };

  if (HIGH_FREQUENCY_CHANNELS.has(channel)) return run();
  return Sentry.startSpan(
    { name: channel, op: "ipc.invoke", attributes: { "ipc.channel": channel } },
    run,
  );
}
