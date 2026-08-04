# MyAgents

MyAgents is a minimal, local-first Agent Client Protocol (ACP) client. It can
launch any local stdio ACP agent described by a command and arguments, rather
than maintaining a fixed list of supported products. Electron is the primary
runtime; a development-only browser transport exposes the same local service
for remote debugging.

## Features

- Add an agent from the official ACP Registry
- Create independent sessions for any enabled ACP agent
- Discover existing sessions when an agent advertises `session/list`
- Group sessions by Git project, including sessions created from linked worktrees
- Persist session metadata, messages, and tool activity in local SQLite
- Restore sessions through `session/load` or `session/resume` when advertised
- Stream plain-text agent responses (Markdown rendering is intentionally deferred)
- Show tool activity and agent state
- Review ACP permission requests before a command or file operation continues
- Cancel a running turn
- Store each agent's reported capabilities
- Keep discovered and MyAgents-created sessions across application restarts

## Run locally

Requirements: Node.js 20.9 or newer, pnpm 10.34.4, and at least one local ACP
agent.

Install dependencies and launch the Electron application:

```bash
pnpm install
pnpm dev
```

For remote browser debugging, run `pnpm dev:web` (the legacy
`pnpm dev:remote` alias is also supported). The server listens only on
`127.0.0.1:3200` by default. Its startup output contains the complete URL with
a `#token=...` fragment. The fragment is removed from the address bar as soon
as the browser stores it for the current tab.

Unless `MYAGENTS_WEB_TOKEN` is set, the server creates a stable token at
`.myagents/browser-debug-token` with mode `0600`. Set `MYAGENTS_WEB_HOST`,
`MYAGENTS_WEB_PORT`, `MYAGENTS_WEB_ORIGIN`, or
`MYAGENTS_WEB_ALLOWED_ORIGINS` to override the browser server defaults. This
transport is intended for trusted development access and is not included in
the packaged Electron application.

The initial installation detects these local commands when available:

- Codex through the system `codex` command, translated to ACP by the internal adapter
- OpenCode through `opencode acp`
- Grok Build through `grok agent stdio`

These are seed configurations, not special runtime integrations. All three use
the same ACP client path. The Codex adapter always delegates to the system
`codex` command. To select a different local Codex installation:

```bash
MYAGENTS_CODEX_PATH=/absolute/path/to/codex pnpm dev
```

OpenCode and Grok Build are resolved from `PATH`. Override them with
`MYAGENTS_OPENCODE_PATH` and `MYAGENTS_GROK_PATH` when needed.

Authentication must be completed with each agent's own command-line tools
before MyAgents launches it. MyAgents does not expose ACP authentication methods
or store API keys.

Session and agent data is stored at `.myagents/myagents.db` by default. Set
`MYAGENTS_DATA_DIR` to move it; an Electron wrapper should point this variable
at `app.getPath("userData")`. Registry-installed packages and binaries are
stored below the same data directory.

## Architecture

```text
React renderer
  -> Electron IPC (desktop) or authenticated WebSocket RPC (browser debug)
    -> Shared desktop service
      -> SQLite persistence + active session/terminal runtimes
        -> ACP TypeScript SDK -> configured ACP subprocess (stdio)
```

`src/lib/acp/agents.ts` owns Registry agent configuration and installation.
`src/lib/acp/runtime.ts` owns the generic ACP lifecycle and makes
decisions from capabilities returned by `initialize`; it does not branch on an
agent's product name. `src/lib/myagents/desktop-service.ts` owns the shared
application operations. Electron IPC and the browser WebSocket server are thin
transport adapters around that service.

## Adding agents

The official Registry entries currently use npm, `uvx`, or downloadable binary
distributions. MyAgents installs the selected distribution into its managed
data directory and records the resulting command, arguments, and environment.

An agent is usable if it implements ACP initialization and session creation.
History sync and restoration remain capability-dependent: MyAgents will not
shell out to product-specific history/export commands when an ACP method is
missing or broken.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm test:e2e:web
pnpm build
```

## Continuous desktop builds

Every push to `main` runs the verification suite and packages unsigned desktop
builds for Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel. Once
all four packages succeed, the workflow replaces the rolling
[`continuous` pre-release](https://github.com/Skywt2003/my-agents/releases/tag/continuous)
and publishes a SHA-256 checksum file alongside the installers.

These builds are intended for testing. macOS Gatekeeper and Windows SmartScreen
may warn until code-signing and notarization credentials are configured.

The Vitest suite uses isolated temporary SQLite databases and a deterministic
stdio ACP fixture. The Playwright migration guards run the same core workflow
through Electron IPC and the browser WebSocket transport: session creation,
streaming, model configuration, permissions, terminal I/O, and reload
restoration, all without contacting a real Agent.

## Limitations

- The UI displays plain text only.
- Session rename, deletion, search, attachments, and Markdown are not included yet.
- ACP does not guarantee that every agent implements session listing, loading,
  resuming, closing, or the same content types. The UI follows the capabilities
  reported by each process and preserves locally recorded history where
  possible.
- On the most recently tested local installations, Codex ACP supports new,
  prompt, cancel, close, list, and load. OpenCode 1.18.7 advertises these
  capabilities but returns `Internal error: OpenCode service failure` for
  session operations. Grok Build 0.2.112 completes the ACP handshake but
  requires Grok authentication before `session/new`. These are agent-side
  states; MyAgents deliberately has no product-specific compatibility fallback.
- The current runtime targets a trusted local desktop environment, not a multi-user deployment.
