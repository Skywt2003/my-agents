# Telemetry

MyAgents initializes Sentry only in the Electron application. The `dev:web`
browser-debug entry does not expose the telemetry API and does not import or
initialize either Sentry SDK.

Telemetry defaults to `off`. The persisted setting lives in
`privacy-settings.json` under the Electron user-data directory. Changing modes
requires an application restart so the JavaScript SDKs and Electron native crash
reporter start with one consistent policy.

## Modes

- `developer`: full error and native crash capture, 100% tracing, console logs,
  screenshots, unmasked session replay, local variables, and detailed IPC error
  context. This can include prompts, paths, commands, and other sensitive data.
- `anonymous`: errors and native crashes plus 10% tracing. Default PII, stable
  user identity, request data, extras, prompts, terminal input, paths, session
  replay, screenshots, and diagnostic logs are removed or disabled. Stack-frame
  paths and retained breadcrumbs are sanitized before sending.
- `off`: neither the main-process nor renderer SDK is initialized.

## Sentry configuration

Set `SENTRY_DSN` while building the distributed app. The DSN is a public
ingestion identifier and is embedded only in the Electron main bundle. A local
launch can instead use `MYAGENTS_SENTRY_DSN` or `SENTRY_DSN` as a runtime
environment variable.

For readable production stack traces, also provide `SENTRY_AUTH_TOKEN`,
`SENTRY_ORG`, and `SENTRY_PROJECT` during `pnpm build` or `pnpm dist`. The Vite
plugin then creates hidden source maps, uploads them under the same release as
the SDK, and deletes the local map files. The auth token is build-only and is
not embedded in the application. `SENTRY_URL` can point uploads at a self-hosted
instance.

For the anonymous policy, enable Sentry's project-level **Prevent Storing of IP
Addresses** option as defense in depth. Configure event, transaction, replay,
and attachment retention to match the application's published privacy policy.
