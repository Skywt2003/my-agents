import { resolve } from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
import {
  defineConfig,
  externalizeDepsPlugin,
  loadEnv,
} from "electron-vite";

import packageJson from "./package.json";

const sourceRoot = resolve("src");

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const dsn = env.SENTRY_DSN ?? "";
  const release = env.SENTRY_RELEASE ?? `my-agents@${packageJson.version}`;
  const environment = env.SENTRY_ENVIRONMENT ??
    (mode === "production" ? "production" : "development");
  const uploadSourceMaps = command === "build" && Boolean(
    env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT,
  );

  function sourceMapPlugins() {
    return uploadSourceMaps
      ? [sentryVitePlugin({
          authToken: env.SENTRY_AUTH_TOKEN,
          org: env.SENTRY_ORG,
          project: env.SENTRY_PROJECT,
          url: env.SENTRY_URL,
          telemetry: false,
          release: { name: release },
          sourcemaps: {
            filesToDeleteAfterUpload: ["./out/**/*.map"],
          },
        })]
      : [];
  }

  const build = { sourcemap: uploadSourceMaps ? "hidden" as const : false };

  return {
    main: {
      build,
      plugins: [externalizeDepsPlugin(), ...sourceMapPlugins()],
      resolve: { alias: { "@": sourceRoot } },
      define: {
        __MYAGENTS_SENTRY_DSN__: JSON.stringify(dsn),
        __MYAGENTS_SENTRY_ENVIRONMENT__: JSON.stringify(environment),
        __MYAGENTS_SENTRY_RELEASE__: JSON.stringify(release),
      },
    },
    preload: {
      build,
      plugins: [externalizeDepsPlugin(), ...sourceMapPlugins()],
      resolve: { alias: { "@": sourceRoot } },
    },
    renderer: {
      build,
      plugins: [react(), ...sourceMapPlugins()],
      resolve: { alias: { "@": sourceRoot } },
      define: { __MYAGENTS_BROWSER_DEBUG__: "false" },
    },
  };
});
