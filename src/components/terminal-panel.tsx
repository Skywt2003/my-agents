"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, SquareTerminal, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/resize-handle";
import type { TerminalInfo, TerminalStreamEvent } from "@/lib/myagents/types";
import { cn } from "@/lib/utils";

type SessionTerminals = {
  tabs: TerminalInfo[];
  activeId: string | null;
};

type TerminalPanelProps = {
  sessionId: string;
  cwd: string;
  open: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
};

const emptySession = (): SessionTerminals => ({ tabs: [], activeId: null });
const TERMINAL_MIN_HEIGHT = 180;
const TERMINAL_MAX_HEIGHT = 720;

export function TerminalPanel({
  sessionId,
  cwd,
  open,
  height,
  onHeightChange,
  onClose,
}: TerminalPanelProps) {
  const [sessions, setSessions] = useState<Record<string, SessionTerminals>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoCreatedRef = useRef(new Set<string>());
  const terminalIdsRef = useRef<string[]>([]);
  const session = sessions[sessionId] ?? emptySession();

  useEffect(() => {
    terminalIdsRef.current = Object.values(sessions).flatMap(({ tabs }) =>
      tabs.map(({ id }) => id),
    );
  }, [sessions]);

  useEffect(() => {
    const closeTerminals = () => {
      for (const id of terminalIdsRef.current) {
        void fetch(`/api/terminals/${id}`, { method: "DELETE", keepalive: true });
      }
    };
    window.addEventListener("pagehide", closeTerminals);
    return () => window.removeEventListener("pagehide", closeTerminals);
  }, []);

  const createTab = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, cols: 80, rows: 24 }),
      });
      const data = (await response.json()) as {
        terminal?: TerminalInfo;
        error?: string;
      };
      if (!response.ok || !data.terminal) {
        throw new Error(data.error ?? "Could not create terminal.");
      }
      setSessions((current) => {
        const existing = current[sessionId] ?? emptySession();
        return {
          ...current,
          [sessionId]: {
            tabs: [...existing.tabs, data.terminal!],
            activeId: data.terminal!.id,
          },
        };
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create terminal.");
    } finally {
      setCreating(false);
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    if (!open || autoCreatedRef.current.has(sessionId)) return;
    autoCreatedRef.current.add(sessionId);
    void createTab();
  }, [createTab, open, sessionId]);

  const closeTab = useCallback(async (terminalId: string) => {
    setSessions((current) => {
      const existing = current[sessionId] ?? emptySession();
      const index = existing.tabs.findIndex(({ id }) => id === terminalId);
      const tabs = existing.tabs.filter(({ id }) => id !== terminalId);
      const activeId = existing.activeId === terminalId
        ? tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id ?? null
        : existing.activeId;
      return { ...current, [sessionId]: { tabs, activeId } };
    });
    const response = await fetch(`/api/terminals/${terminalId}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      setError("Could not close terminal.");
    }
  }, [sessionId]);

  const markExited = useCallback((terminalId: string, exitCode: number) => {
    setSessions((current) => {
      const existing = current[sessionId];
      if (!existing) return current;
      return {
        ...current,
        [sessionId]: {
          ...existing,
          tabs: existing.tabs.map((tab) =>
            tab.id === terminalId
              ? { ...tab, status: "exited", exitCode }
              : tab,
          ),
        },
      };
    });
  }, [sessionId]);

  return (
    <section
      className={cn(
        "relative shrink-0 flex-col border-t bg-background",
        open ? "flex" : "hidden",
      )}
      style={{ height }}
      aria-label="Terminal panel"
    >
      <ResizeHandle
        orientation="horizontal"
        value={height}
        min={TERMINAL_MIN_HEIGHT}
        max={TERMINAL_MAX_HEIGHT}
        label="Resize terminal panel"
        onChange={(value) =>
          onHeightChange(
            Math.min(
              Math.max(TERMINAL_MIN_HEIGHT, window.innerHeight - 180),
              value,
            ),
          )
        }
      />
      <div className="flex h-9 shrink-0 items-center border-b bg-muted/25 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {session.tabs.map((tab, index) => (
            <div
              key={tab.id}
              className={cn(
                "group flex h-7 shrink-0 items-center rounded-md",
                session.activeId === tab.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                className="flex h-full items-center gap-1.5 pl-2.5 pr-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setSessions((current) => ({
                  ...current,
                  [sessionId]: { ...(current[sessionId] ?? emptySession()), activeId: tab.id },
                }))}
                aria-selected={session.activeId === tab.id}
                role="tab"
              >
                <SquareTerminal className="size-3.5" />
                <span>{tab.title} {index + 1}</span>
                {tab.status === "exited" && (
                  <span className="size-1.5 rounded-full bg-muted-foreground" aria-label="Exited" />
                )}
              </button>
              <button
                type="button"
                className="mr-1 flex size-5 items-center justify-center rounded opacity-0 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={() => void closeTab(tab.id)}
                aria-label={`Close ${tab.title} ${index + 1}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void createTab()}
            disabled={creating}
            aria-label="New terminal"
          >
            <Plus />
          </Button>
          {session.activeId && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void closeTab(session.activeId!)}
              aria-label="Kill active terminal"
            >
              <Trash2 />
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close terminal panel">
            <X />
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-white dark:bg-[#111116]">
        {error && (
          <div className="absolute inset-x-3 top-2 z-10 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {open && session.activeId ? (
          <TerminalView
            key={session.activeId}
            terminalId={session.activeId}
            onExit={markExited}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Button variant="outline" size="sm" onClick={() => void createTab()} disabled={creating}>
              <Plus />New terminal
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function TerminalView({
  terminalId,
  onExit,
}: {
  terminalId: string;
  onExit: (terminalId: string, exitCode: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();
    let disposed = false;
    let disposeTerminal = () => {};

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      async ([{ Terminal }, { FitAddon }]) => {
        if (disposed) return;
        const dark = document.documentElement.classList.contains("dark");
        const terminal = new Terminal({
          cursorBlink: true,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.25,
          scrollback: 5_000,
          theme: dark
            ? { background: "#111116", foreground: "#f4f4f5", cursor: "#f4f4f5" }
            : { background: "#ffffff", foreground: "#18181b", cursor: "#18181b" },
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(container);
        fitAddon.fit();
        terminal.focus();

        let input = "";
        let inputTimer: ReturnType<typeof setTimeout> | null = null;
        let sendChain = Promise.resolve();
        const flushInput = () => {
          inputTimer = null;
          const data = input;
          input = "";
          if (!data) return;
          sendChain = sendChain.then(async () => {
            await fetch(`/api/terminals/${terminalId}/input`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ data }),
            });
          });
        };
        const inputDisposable = terminal.onData((data) => {
          input += data;
          if (!inputTimer) inputTimer = setTimeout(flushInput, 8);
        });

        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const resize = () => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return;
            fitAddon.fit();
            void fetch(`/api/terminals/${terminalId}/resize`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cols: terminal.cols, rows: terminal.rows }),
            });
          }, 40);
        };
        const observer = new ResizeObserver(resize);
        observer.observe(container);

        disposeTerminal = () => {
          if (inputTimer) clearTimeout(inputTimer);
          if (resizeTimer) clearTimeout(resizeTimer);
          inputDisposable.dispose();
          observer.disconnect();
          terminal.dispose();
        };

        try {
          const response = await fetch(`/api/terminals/${terminalId}/stream`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error("Terminal stream unavailable.");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const event = JSON.parse(line) as TerminalStreamEvent;
              if (event.type === "output") terminal.write(event.data);
              else {
                terminal.writeln(`\r\n[Process exited with code ${event.exitCode}]`);
                onExit(terminalId, event.exitCode);
              }
            }
            if (done) break;
          }
        } catch (cause) {
          if (!controller.signal.aborted) {
            terminal.writeln(`\r\n[${cause instanceof Error ? cause.message : "Terminal disconnected."}]`);
          }
        }
      },
    );

    return () => {
      disposed = true;
      controller.abort();
      disposeTerminal();
    };
  }, [onExit, terminalId]);

  return <div ref={containerRef} className="h-full w-full px-2 py-1.5" />;
}
