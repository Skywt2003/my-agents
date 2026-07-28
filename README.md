# MyAgents

MyAgents is a minimal, local-first Agent Client Protocol (ACP) client. The MVP connects a Next.js interface to local Codex and OpenCode sessions and is intentionally structured so the local runtime can later move into an Electron main process.

## MVP features

- Create independent Codex sessions for an absolute working directory
- Discover existing Codex and OpenCode sessions and show their source agent
- Group sessions by Git project, including sessions created from linked worktrees
- Persist session metadata, messages, and tool activity in local SQLite
- Restore an existing session and its history through ACP when it is selected
- Stream plain-text agent responses (Markdown rendering is intentionally deferred)
- Show tool activity and agent state
- Review ACP permission requests before a command or file operation continues
- Cancel a running turn
- Keep all discovered and MyAgents-created sessions across application restarts

## Run locally

Requirements: Node.js 20.9 or newer and a working Codex login or API key.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), choose **New session**, and enter an absolute workspace path.

For development-only access through the local Caddy and Tailscale setup, run:

```bash
npm run dev:remote
```

This listens only on `127.0.0.1:3200`; Caddy exposes it at
`https://my-agents.dev.skywt`. The production and future Electron runtimes do
not use this port or remote entry point.

The adapter ships with a compatible Codex binary. To force MyAgents to use another local Codex installation:

```bash
MYAGENTS_CODEX_PATH=/absolute/path/to/codex npm run dev
```

OpenCode is resolved from `PATH`. Override it with `MYAGENTS_OPENCODE_PATH` when needed.

Authentication is inherited from the local Codex configuration. `CODEX_API_KEY` and `OPENAI_API_KEY` are also supported by the adapter.

Session data is stored at `.myagents/myagents.db` by default. Set `MYAGENTS_DATA_DIR` to move it; an Electron wrapper should point this variable at `app.getPath("userData")`.

## Architecture

```text
Browser UI
  -> Next.js route handlers (NDJSON streaming)
    -> SQLite persistence + active session runtime
      -> ACP TypeScript SDK (list, load, prompt)
        -> Codex or OpenCode ACP subprocess (stdio)
          -> Agent sessions
```

ACP and process management live under `src/lib/acp`; the React UI only consumes the local HTTP contract. For Electron, this boundary can move to the main process while preserving the session and event types in `src/lib/myagents`.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
```

## MVP limitations

- The UI displays plain text only.
- Session rename, deletion, search, attachments, settings, and Markdown are not included yet.
- OpenCode 1.18.7 advertises ACP session capabilities but returns service errors for `session/list`, `session/load`, and `session/new` on the tested host. MyAgents therefore imports its existing sessions and text history through a read-only CLI compatibility path and disables new OpenCode sessions until its ACP adapter is usable.
- The current runtime targets a trusted local desktop environment, not a multi-user deployment.
