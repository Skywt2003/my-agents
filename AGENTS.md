# MyAgents repository guidance

MyAgents is an Electron application built with electron-vite, Vite, and React.
It is not a Next.js application. Do not apply Next.js App Router, Route Handler,
or Turbopack conventions to the current codebase.

The Electron main process and preload bridge live under `src/main` and
`src/preload`. The React renderer lives under `src/renderer` and
`src/components`. Shared application behavior belongs in
`src/lib/myagents/desktop-service.ts`; Electron IPC and the development-only
Vite browser transport in `src/web/server.ts` should remain thin adapters around
that service.

Use the scripts in `package.json` for validation. In particular, treat
`npm run dev` and `npm run build` as electron-vite commands, while
`npm run dev:web` starts the browser debugging transport.
