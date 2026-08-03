import { Check, Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const themes = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Follow system", icon: Monitor },
] as const;

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="grid gap-3 sm:grid-cols-3"
    >
      {themes.map(({ value, label, icon: Icon }) => {
        const selected = theme === value;

        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(value)}
            className={cn(
              "relative flex min-h-28 flex-col items-start justify-between rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
              selected && "border-foreground/40 bg-muted/60",
            )}
          >
            <Icon className="size-5 text-muted-foreground" />
            <span className="text-sm font-medium">{label}</span>
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
