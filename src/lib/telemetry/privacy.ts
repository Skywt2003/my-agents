type TelemetryBreadcrumb = {
  category?: string;
  data?: Record<string, unknown>;
  level?: string;
  message?: string;
};

type TelemetryEvent = {
  breadcrumbs?: TelemetryBreadcrumb[];
  contexts?: Record<string, unknown>;
  exception?: {
    values?: Array<{
      stacktrace?: { frames?: Array<Record<string, unknown>> };
      value?: string;
    }>;
  };
  logentry?: Record<string, unknown>;
  message?: string;
  extra?: Record<string, unknown>;
  request?: Record<string, unknown>;
  server_name?: string;
  spans?: Array<Record<string, unknown>>;
  tags?: Record<string, unknown>;
  transaction?: string;
  user?: Record<string, unknown>;
};

const SAFE_CONTEXTS = new Set([
  "app",
  "electron",
  "os",
  "react",
  "runtime",
  "trace",
]);

const SAFE_TAGS = new Set([
  "app_version",
  "ipc.channel",
  "process",
  "telemetry_mode",
]);

const SAFE_BREADCRUMB_CATEGORIES = [
  "electron",
  "navigation",
  "sentry",
  "ui.",
];

const SENSITIVE_KEY = /(?:auth|cookie|credential|description|email|input|message|password|path|prompt|secret|session|terminal|title|token|url|user)/i;

export function redactAnonymousText(value: string): string {
  return value
    .replace(/\b[A-Z]:\\Users\\[^\\\s]+/gi, "<user-home>")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "/<user-home>")
    .replace(/\b[A-Z]:\\(?:[^\\\s]+\\){2,}[^\s,;)]*/gi, "<path>")
    .replace(/(?:\/[A-Za-z0-9._-]+){3,}/g, "<path>")
    .replace(/([?&](?:access_token|api_key|auth|key|password|secret|token)=)[^&#\s]*/gi, "$1<redacted>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, "<secret>")
    .slice(0, 500);
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 4) return "<truncated>";
  if (typeof value === "string") {
    return SENSITIVE_KEY.test(key) ? "<redacted>" : redactAnonymousText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([childKey, childValue]) => [
          childKey,
          sanitizeValue(childValue, childKey, depth + 1),
        ]),
    );
  }
  return String(value);
}

function sanitizeFrame(frame: Record<string, unknown>) {
  const next = { ...frame };
  delete next.vars;
  delete next.abs_path;
  delete next.context_line;
  delete next.pre_context;
  delete next.post_context;
  if (typeof next.filename === "string") {
    const normalized = next.filename.replaceAll("\\", "/");
    next.filename = normalized.startsWith("app:///")
      ? normalized
      : normalized.split("/").at(-1);
  }
  return next;
}

export function sanitizeAnonymousBreadcrumb<T>(
  breadcrumb: T,
): T | null {
  const current = breadcrumb as TelemetryBreadcrumb;
  const category = current.category ?? "";
  const safeCategory = SAFE_BREADCRUMB_CATEGORIES.some((prefix) =>
    category.startsWith(prefix),
  );
  if (!safeCategory) return null;

  return {
    ...current,
    ...(current.message ? { message: category || "activity" } : {}),
    ...(current.data
      ? { data: sanitizeValue(current.data, "breadcrumb") as Record<string, unknown> }
      : {}),
  } as T;
}

export function sanitizeAnonymousEvent<T>(event: T): T {
  const next = { ...(event as TelemetryEvent) };
  delete next.user;
  delete next.request;
  delete next.extra;
  delete next.server_name;
  delete next.logentry;
  if (next.message) next.message = "<redacted>";

  if (next.tags) {
    next.tags = Object.fromEntries(
      Object.entries(next.tags).filter(([key]) => SAFE_TAGS.has(key)),
    );
  }
  if (next.contexts) {
    next.contexts = Object.fromEntries(
      Object.entries(next.contexts)
        .filter(([key]) => SAFE_CONTEXTS.has(key))
        .map(([key, value]) => [key, sanitizeValue(value, key)]),
    );
  }
  if (next.breadcrumbs) {
    next.breadcrumbs = next.breadcrumbs
      .map((breadcrumb) => sanitizeAnonymousBreadcrumb(breadcrumb))
      .filter((breadcrumb): breadcrumb is TelemetryBreadcrumb => breadcrumb !== null);
  }
  if (next.transaction) next.transaction = redactAnonymousText(next.transaction);
  if (next.spans) {
    next.spans = next.spans.map((span) =>
      sanitizeValue(span, "span") as Record<string, unknown>,
    );
  }
  if (next.exception?.values) {
    next.exception = {
      ...next.exception,
      values: next.exception.values.map((exception) => ({
        ...exception,
        ...(exception.value ? { value: "<redacted>" } : {}),
        ...(exception.stacktrace?.frames
          ? {
              stacktrace: {
                ...exception.stacktrace,
                frames: exception.stacktrace.frames.map(sanitizeFrame),
              },
            }
          : {}),
      })),
    };
  }

  return next as T;
}
