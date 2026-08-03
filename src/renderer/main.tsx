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

import "./globals.css";

document.documentElement.dataset.platform = window.myagents.platform;
initializeAppearance();

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element is missing.");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider defaultTheme="light">
      <RemoveButtonTooltips />
      <MyAgentsApp />
    </ThemeProvider>
  </StrictMode>,
);
