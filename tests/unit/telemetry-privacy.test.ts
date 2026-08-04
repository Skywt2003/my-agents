import { describe, expect, it } from "vitest";

import {
  redactAnonymousText,
  sanitizeAnonymousBreadcrumb,
  sanitizeAnonymousEvent,
} from "@/lib/telemetry/privacy";

describe("anonymous telemetry privacy", () => {
  it("redacts common local identity, path, credential, and email values", () => {
    const value = redactAnonymousText(
      "open /home/alice/Codes/private/project/file.ts for alice@example.com " +
      "with https://example.test/api?token=super-secret-value-123456789012345678901234",
    );

    expect(value).not.toContain("alice");
    expect(value).not.toContain("private/project");
    expect(value).not.toContain("super-secret");
    expect(value).toContain("<user-home>");
    expect(value).toContain("token=<redacted>");
    expect(value).toContain("<email>");
  });

  it("drops unsafe breadcrumbs and removes sensitive event sections", () => {
    const event = sanitizeAnonymousEvent({
      user: { id: "stable-user" },
      request: { url: "https://example.test/private" },
      extra: { prompt: "private prompt" },
      server_name: "alice-laptop",
      tags: {
        telemetry_mode: "anonymous",
        project_path: "/home/alice/project",
      },
      contexts: {
        os: { name: "Linux" },
        custom: { prompt: "private prompt" },
      },
      breadcrumbs: [
        { category: "console", level: "info", message: "private prompt" },
        { category: "ui.click", message: "button at /home/alice/project" },
      ],
      exception: {
        values: [{
          value: "failed at /home/alice/project/file.ts",
          stacktrace: {
            frames: [{
              abs_path: "/home/alice/project/file.ts",
              filename: "/home/alice/project/file.ts",
              vars: { token: "secret" },
            }],
          },
        }],
      },
    });

    expect(event.user).toBeUndefined();
    expect(event.request).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    expect(event.tags).toEqual({ telemetry_mode: "anonymous" });
    expect(event.contexts).toEqual({ os: { name: "Linux" } });
    expect(event.breadcrumbs).toHaveLength(1);
    expect(event.exception?.values?.[0]?.value).toBe("<redacted>");
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: "file.ts",
    });
  });

  it("drops console breadcrumbs and removes UI interaction text", () => {
    expect(sanitizeAnonymousBreadcrumb({
      category: "console",
      level: "info",
      message: "hello",
    })).toBeNull();
    expect(sanitizeAnonymousBreadcrumb({
      category: "console",
      level: "error",
      message: "failed at /Users/alice/private/file.ts",
    })).toBeNull();
    expect(sanitizeAnonymousBreadcrumb({
      category: "ui.click",
      message: "Private project name",
    })).toMatchObject({
      category: "ui.click",
      message: "ui.click",
    });
  });
});
