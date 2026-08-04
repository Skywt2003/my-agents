import type { ErrorInfo } from "react";

import {
  sanitizeAnonymousBreadcrumb,
  sanitizeAnonymousEvent,
} from "@/lib/telemetry/privacy";

type ReactErrorHandler = (error: unknown, errorInfo: ErrorInfo) => void;

export type RendererTelemetry = {
  onRecoverableError?: ReactErrorHandler;
  onUncaughtError?: ReactErrorHandler;
};

export async function initializeRendererTelemetry(): Promise<RendererTelemetry> {
  const api = window.myagents.telemetry;
  if (!api) return {};

  const settings = await api.getSettings();
  if (!settings.configured || settings.activeMode === "off") return {};

  const [ElectronSentry, ReactSentry] = await Promise.all([
    import("@sentry/electron/renderer"),
    import("@sentry/react"),
  ]);
  const developer = settings.activeMode === "developer";
  ElectronSentry.init(
    {
      attachStacktrace: true,
      enableLogs: developer,
      maxBreadcrumbs: developer ? 200 : 50,
      normalizeDepth: developer ? 10 : 4,
      sampleRate: 1,
      sendDefaultPii: developer,
      tracePropagationTargets: [],
      tracesSampleRate: developer ? 1 : 0.1,
      replaysOnErrorSampleRate: developer ? 1 : 0,
      replaysSessionSampleRate: developer ? 1 : 0,
      integrations: (defaults) => [
        ...defaults,
        ReactSentry.browserTracingIntegration(),
        ...(developer
          ? [
              ReactSentry.consoleLoggingIntegration(),
              ReactSentry.replayIntegration({
                blockAllMedia: false,
                maskAllInputs: false,
                maskAllText: false,
              }),
            ]
          : []),
      ],
      beforeBreadcrumb: developer
        ? undefined
        : (breadcrumb) => sanitizeAnonymousBreadcrumb(breadcrumb),
      beforeSend: developer
        ? undefined
        : (event) => sanitizeAnonymousEvent(event),
      beforeSendTransaction: developer
        ? undefined
        : (event) => sanitizeAnonymousEvent(event),
    },
    ReactSentry.init,
  );

  ElectronSentry.setTags({
    process: "renderer",
    telemetry_mode: settings.activeMode,
  });
  ElectronSentry.setContext("react", { rootApi: "createRoot" });
  ElectronSentry.addBreadcrumb({
    category: "electron.lifecycle",
    level: "info",
    message: "Renderer telemetry initialized",
  });

  return {
    onRecoverableError: ReactSentry.reactErrorHandler(),
    onUncaughtError: ReactSentry.reactErrorHandler(),
  };
}
