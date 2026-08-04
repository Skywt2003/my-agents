import { useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";

import type {
  TelemetryApi,
  TelemetryMode,
  TelemetrySettingsSnapshot,
} from "@/lib/telemetry/types";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{
  description: string;
  details: string;
  mode: TelemetryMode;
  title: string;
}> = [
  {
    mode: "developer",
    title: "Developer",
    description: "Maximum diagnostic detail for local development and dogfooding.",
    details: "Includes errors, native crashes, full performance traces, logs, screenshots, session replay, local variables, paths, commands, and IPC inputs. Prompts or terminal-related data may appear in diagnostics.",
  },
  {
    mode: "anonymous",
    title: "Anonymous",
    description: "Privacy-preserving diagnostics suitable for regular users.",
    details: "Includes errors, native crashes, and sampled performance data. User identity, request data, prompts, terminal input, local paths, screenshots, session replay, and diagnostic logs are removed or disabled.",
  },
  {
    mode: "off",
    title: "Off",
    description: "Do not initialize Sentry or send telemetry.",
    details: "No crash reports, errors, performance traces, logs, screenshots, or replays are sent.",
  },
];

export function TelemetrySettings({ api }: { api: TelemetryApi }) {
  const [settings, setSettings] = useState<TelemetrySettingsSnapshot | null>(null);
  const [saving, setSaving] = useState<TelemetryMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function selectMode(mode: TelemetryMode) {
    if (mode === settings?.mode || saving) return;
    setSaving(mode);
    setError(null);
    try {
      setSettings(await api.setMode(mode));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(null);
    }
  }

  if (!settings && !error) {
    return (
      <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        Loading telemetry settings
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-medium">Telemetry level</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Choose what MyAgents may send to the configured Sentry project. Off is the default.
        </p>
      </div>

      <fieldset className="space-y-2" disabled={!settings || saving !== null}>
        <legend className="sr-only">Telemetry level</legend>
        {OPTIONS.map((option) => {
          const selected = settings?.mode === option.mode;
          return (
            <label
              key={option.mode}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors",
                "hover:bg-muted/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                selected && "border-foreground/30 bg-muted/40",
                saving && "cursor-wait opacity-70",
              )}
            >
              <input
                type="radio"
                name="telemetry-mode"
                value={option.mode}
                checked={selected}
                onChange={() => void selectMode(option.mode)}
                className="mt-0.5 size-4 accent-foreground"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {option.title}
                  {saving === option.mode && (
                    <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
                  )}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {option.description}
                </span>
                <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground/90">
                  {option.details}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {settings && !settings.configured && (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p>
            This build has no Sentry DSN. Your preference is saved, but no telemetry can be sent until the app is rebuilt with <code className="font-mono">SENTRY_DSN</code>.
          </p>
        </div>
      )}

      {settings?.restartRequired && (
        <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-5" role="status">
          Restart MyAgents to apply this change to JavaScript and native crash reporting. This process is still using <span className="font-medium">{settings.activeMode}</span> mode.
        </div>
      )}

      {settings?.configured && !settings.restartRequired && (
        <p className="text-[11px] text-muted-foreground" role="status">
          Active for this process: <span className="font-medium text-foreground">{settings.activeMode}</span>
        </p>
      )}

      {error && (
        <p className="text-xs leading-5 text-destructive" role="alert">
          Could not update telemetry settings: {error}
        </p>
      )}
    </div>
  );
}
