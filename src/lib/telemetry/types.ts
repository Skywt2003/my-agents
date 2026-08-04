export const TELEMETRY_MODES = ["developer", "anonymous", "off"] as const;

export type TelemetryMode = (typeof TELEMETRY_MODES)[number];

export type TelemetrySettingsSnapshot = {
  mode: TelemetryMode;
  activeMode: TelemetryMode;
  configured: boolean;
  restartRequired: boolean;
};

export type TelemetryApi = {
  getSettings(): Promise<TelemetrySettingsSnapshot>;
  setMode(mode: TelemetryMode): Promise<TelemetrySettingsSnapshot>;
};

export function isTelemetryMode(value: unknown): value is TelemetryMode {
  return typeof value === "string" && TELEMETRY_MODES.includes(value as TelemetryMode);
}
