# MyAgents

MyAgents is a minimal, local-first Agent Client Protocol (ACP) client. It can
launch any local stdio ACP agent described by a command and arguments, rather
than maintaining a fixed list of supported products. The runtime is structured
so it can later move into an Electron main process.

## Features

- Add an agent from the official ACP Registry or configure a custom local agent
- Create independent sessions for any enabled ACP agent
- Discover existing sessions when an agent advertises `session/list`
- Group sessions by Git project, including sessions created from linked worktrees
- Persist session metadata, messages, and tool activity in local SQLite
- Restore sessions through `session/load` or `session/resume` when advertised
- Stream plain-text agent responses (Markdown rendering is intentionally deferred)
- Show tool activity and agent state
- Review ACP permission requests before a command or file operation continues
- Cancel a running turn
- Store each agent's reported capabilities and authentication methods
- Keep discovered and MyAgents-created sessions across application restarts

## Run locally

Requirements: Node.js 20.9 or newer and at least one local ACP agent.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), choose **New session**,
select an agent, and enter an absolute workspace path. Use **Manage ACP
agents** to browse the Registry or add a command manually.

For development-only access through the local Caddy and Tailscale setup, run:

```bash
npm run dev:remote
```

This listens only on `127.0.0.1:3200`; Caddy exposes it at
`https://my-agents.dev.skywt`. The production and future Electron runtimes do
not use this port or remote entry point.

The initial installation detects these local commands when available:

- Codex through the bundled `@agentclientprotocol/codex-acp` adapter
- OpenCode through `opencode acp`
- Grok Build through `grok agent stdio`

These are seed configurations, not special runtime integrations. All three use
the same ACP client path. To force the Codex adapter to use another local Codex
installation:

```bash
MYAGENTS_CODEX_PATH=/absolute/path/to/codex npm run dev
```

OpenCode and Grok Build are resolved from `PATH`. Override them with
`MYAGENTS_OPENCODE_PATH` and `MYAGENTS_GROK_PATH` when needed.

Authentication normally comes from the agent's existing local configuration.
When an agent advertises an ACP agent-managed authentication method, the
settings dialog can start it through the standard `authenticate` request.
Environment-variable and terminal-based methods must be configured in the
agent's environment or terminal before it is launched.

Session and agent data is stored at `.myagents/myagents.db` by default. Set
`MYAGENTS_DATA_DIR` to move it; an Electron wrapper should point this variable
at `app.getPath("userData")`. Registry-installed packages and binaries are
stored below the same data directory.

## Architecture

```text
Browser UI
  -> Next.js route handlers (NDJSON streaming)
    -> SQLite agent/session persistence + active session runtime
      -> ACP TypeScript SDK (initialize, authenticate, list/load/resume, prompt)
        -> Configured ACP subprocess (stdio)
          -> Agent sessions
```

`src/lib/acp/agents.ts` owns Registry/custom agent configuration and
installation. `src/lib/acp/runtime.ts` owns the generic ACP lifecycle and makes
decisions from capabilities returned by `initialize`; it does not branch on an
agent's product name. The React UI only consumes the local HTTP contract. For
Electron, this boundary can move to the main process while preserving the
session and event types in `src/lib/myagents`.

## Adding agents

The official Registry entries currently use npm, `uvx`, or downloadable binary
distributions. MyAgents installs the selected distribution into its managed
data directory and records the resulting command, arguments, and environment.

For an agent that is not in the Registry, add a custom agent with:

- a stable local ID and display name
- an executable or absolute executable path
- its stdio ACP arguments

An agent is usable if it implements ACP initialization and session creation.
History sync and restoration remain capability-dependent: MyAgents will not
shell out to product-specific history/export commands when an ACP method is
missing or broken.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
```

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
