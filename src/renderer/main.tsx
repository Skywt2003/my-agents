import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/noto-serif-sc";

import { MyAgentsApp } from "@/components/myagents-app";
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

document.documentElement.dataset.platform = window.myagents.platform;
initializeAppearance();

async function bootstrap() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Renderer root element is missing.");

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
        <MyAgentsApp />
      </ThemeProvider>
    </StrictMode>,
  );
}

void bootstrap();
