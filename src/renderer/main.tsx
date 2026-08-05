import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/noto-serif-sc";

import { MyAgentsApp, SettingsApp } from "@/components/myagents-app";
import { RemoveButtonTooltips } from "@/components/remove-button-tooltips";
import {
  initializeAppearance,
  ThemeProvider,
} from "@/components/theme-provider";
import {
  initializeRendererTelemetry,
  type RendererTelemetry,
} from "@/renderer/telemetry";

import "./globals.css";

async function bootstrap() {
  if (__MYAGENTS_BROWSER_DEBUG__) {
    const { installBrowserApi } = await import("@/renderer/browser-api");
    installBrowserApi();
  }
  document.documentElement.dataset.platform = window.myagents.platform;
  initializeAppearance();

  const root = document.getElementById("root");
  if (!root) throw new Error("Renderer root element is missing.");
  const settingsView = new URLSearchParams(window.location.search).get("view") ===
    "settings";
  if (settingsView) document.title = "Settings";

  let telemetry: RendererTelemetry = {};
  try {
    telemetry = await initializeRendererTelemetry();
  } catch (error) {
    console.error("Failed to initialize renderer telemetry.", error);
  }

  createRoot(root, telemetry).render(
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <RemoveButtonTooltips />
        {settingsView ? <SettingsApp /> : <MyAgentsApp />}
      </ThemeProvider>
    </StrictMode>,
  );
}

void bootstrap();
