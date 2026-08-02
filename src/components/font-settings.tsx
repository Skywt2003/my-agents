"use client";

import { useSyncExternalStore } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

const FONT_STORAGE_KEY = "myagents-font";
const FONT_CHANGE_EVENT = "myagents-font-change";

type FontPreference = "sans" | "serif";

const fonts = [
  {
    value: "sans",
    label: "Sans",
    description: "Geist",
    sampleClassName: "font-sans-ui",
  },
  {
    value: "serif",
    label: "Serif",
    description: "Source Serif 4 + Source Han Serif",
    sampleClassName: "font-serif-ui",
  },
] as const satisfies ReadonlyArray<{
  value: FontPreference;
  label: string;
  description: string;
  sampleClassName: string;
}>;

function getFontPreference(): FontPreference {
  try {
    return window.localStorage.getItem(FONT_STORAGE_KEY) === "serif"
      ? "serif"
      : "sans";
  } catch {
    return document.documentElement.dataset.font === "serif" ? "serif" : "sans";
  }
}

function subscribeToFontPreference(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === FONT_STORAGE_KEY) onStoreChange();
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(FONT_CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(FONT_CHANGE_EVENT, onStoreChange);
  };
}

function setFontPreference(preference: FontPreference) {
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, preference);
  } catch {
    // The in-page preference still works when storage is unavailable.
  }
  document.documentElement.dataset.font = preference;
  window.dispatchEvent(new Event(FONT_CHANGE_EVENT));
}

export function FontSettings() {
  const font = useSyncExternalStore(
    subscribeToFontPreference,
    getFontPreference,
    () => "sans",
  );

  return (
    <div
      role="radiogroup"
      aria-label="Interface font"
      className="grid gap-3 sm:grid-cols-2"
    >
      {fonts.map(({ value, label, description, sampleClassName }) => {
        const selected = font === value;

        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setFontPreference(value)}
            className={cn(
              "relative flex min-h-28 flex-col items-start justify-between rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
              selected && "border-foreground/40 bg-muted/60",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("text-xl text-muted-foreground", sampleClassName)}
            >
              Aa 文
            </span>
            <span>
              <span className="block text-sm font-medium">{label}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {description}
              </span>
            </span>
            {selected && (
              <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-foreground text-background">
                <Check className="size-3" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
