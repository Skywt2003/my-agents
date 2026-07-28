"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  CircleStop,
  Code2,
  FolderGit2,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import type {
  AgentDescriptor,
  AgentId,
  ChatMessage,
  PermissionRequest,
  SessionStreamEvent,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import { cn } from "@/lib/utils";

type SessionsResponse = {
  sessions: SessionSummary[];
  agents: AgentDescriptor[];
  defaultCwd: string;
  syncErrors: Partial<Record<AgentId, string>>;
};

type ProjectGroup = {
  id: string;
  name: string;
  path: string;
  sessions: SessionSummary[];
};

const getError = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

function appendAssistant(messages: ChatMessage[], id: string, text: string) {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === id);
  if (index < 0) {
    next.push({ id, role: "assistant", content: text, createdAt: new Date().toISOString() });
  } else {
    next[index] = { ...next[index], content: next[index].content + text };
  }
  return next;
}

function upsertActivity(items: ToolActivity[], activity: ToolActivity) {
  const next = [...items];
  const index = next.findIndex((item) => item.id === activity.id);
  if (index < 0) next.push(activity);
  else next[index] = activity;
  return next;
}

export function MyAgentsApp() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [agentId, setAgentId] = useState<AgentId>("codex");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [draft, setDraft] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<
    Partial<Record<AgentId, string>>
  >({});
  const conversationRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId],
  );
  const projectGroups = useMemo(
    () =>
      sessions.reduce<ProjectGroup[]>((groups, session) => {
        const existing = groups.find(({ id }) => id === session.project.id);
        if (existing) existing.sessions.push(session);
        else groups.push({ ...session.project, sessions: [session] });
        return groups;
      }, []),
    [sessions],
  );

  useEffect(() => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load local sessions.");
        return (await response.json()) as SessionsResponse;
      })
      .then((data) => {
        setSessions(data.sessions);
        setAgents(data.agents);
        setSyncErrors(data.syncErrors);
        setCwd(data.defaultCwd);
        setSelectedId(data.sessions[0]?.id ?? null);
      })
      .catch((error) => setPageError(getError(error)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void refreshSession(selectedId, true);
    // The selected session is the only trigger; refreshSession is intentionally stable by ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    const viewport = conversationRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [selected?.messages, selected?.activities, selected?.pendingPermissions]);

  function patchSession(id: string, update: (session: SessionSummary) => SessionSummary) {
    setSessions((current) =>
      current.map((session) => (session.id === id ? update(session) : session)),
    );
  }

  async function refreshSession(id: string, showLoading = false) {
    if (showLoading) setLoadingSessionId(id);
    try {
      const response = await fetch(`/api/sessions/${id}`, { cache: "no-store" });
      const data = (await response.json()) as {
        session?: SessionSummary;
        error?: string;
      };
      if (!response.ok || !data.session) {
        throw new Error(data.error ?? "Could not load session.");
      }
      patchSession(id, () => data.session!);
    } catch (error) {
      setPageError(getError(error));
    } finally {
      if (showLoading) setLoadingSessionId(null);
    }
  }

  async function createSession() {
    setCreating(true);
    setPageError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, agentId }),
      });
      const data = (await response.json()) as { session?: SessionSummary; error?: string };
      if (!response.ok || !data.session) throw new Error(data.error ?? "Could not create session.");
      setSessions((current) => [data.session!, ...current]);
      setSelectedId(data.session.id);
      setDialogOpen(false);
    } catch (error) {
      setPageError(getError(error));
    } finally {
      setCreating(false);
    }
  }

  function applyEvent(id: string, event: SessionStreamEvent) {
    patchSession(id, (session) => {
      if (event.type === "assistant_delta") {
        return { ...session, messages: appendAssistant(session.messages, event.messageId, event.text) };
      }
      if (event.type === "tool") {
        return { ...session, activities: upsertActivity(session.activities, event.activity) };
      }
      if (event.type === "permission") {
        return {
          ...session,
          pendingPermissions: [
            ...session.pendingPermissions.filter((item) => item.id !== event.permission.id),
            event.permission,
          ],
        };
      }
      if (event.type === "permission_resolved") {
        return {
          ...session,
          pendingPermissions: session.pendingPermissions.filter(
            (item) => item.id !== event.permissionId,
          ),
        };
      }
      if (event.type === "status") return { ...session, status: event.status };
      if (event.type === "error") return { ...session, status: "error", error: event.message };
      return session;
    });
  }

  async function sendMessage() {
    const message = draft.trim();
    if (!selected || !message || selected.status === "running") return;
    const id = selected.id;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(), role: "user", content: message, createdAt: new Date().toISOString(),
    };
    setDraft("");
    patchSession(id, (session) => ({
      ...session,
      title: session.title === "New session"
        ? message.length > 38 ? `${message.slice(0, 38).trim()}…` : message
        : session.title,
      status: "running",
      error: undefined,
      messages: [...session.messages, userMessage],
    }));

    try {
      const response = await fetch(`/api/sessions/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!response.ok || !response.body) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? `${selected.agentName} did not accept the message.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) applyEvent(id, JSON.parse(line));
        if (done) break;
      }
      if (buffer.trim()) applyEvent(id, JSON.parse(buffer));
      await refreshSession(id);
    } catch (error) {
      patchSession(id, (session) => ({ ...session, status: "error", error: getError(error) }));
    }
  }

  async function stopSession() {
    if (selected) await fetch(`/api/sessions/${selected.id}/cancel`, { method: "POST" });
  }

  async function resolvePermission(permission: PermissionRequest, optionId?: string) {
    if (!selected) return;
    const response = await fetch(`/api/sessions/${selected.id}/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionId: permission.id, optionId }),
    });
    if (response.ok) {
      patchSession(selected.id, (session) => ({
        ...session,
        pendingPermissions: session.pendingPermissions.filter((item) => item.id !== permission.id),
      }));
    }
  }

  return (
    <main className="grid h-dvh min-h-[540px] grid-cols-[272px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background">
      <aside className="flex min-h-0 flex-col border-r bg-sidebar">
        <div className="flex h-16 shrink-0 items-center gap-3 px-5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background">
            <Sparkles className="size-4" />
          </div>
          <div><p className="text-sm font-semibold">MyAgents</p><p className="text-[11px] text-muted-foreground">ACP client</p></div>
        </div>
        <div className="px-3 pb-4">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="w-full justify-start gap-2 shadow-none" size="sm"><Plus />New session</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader><DialogTitle>Start a new session</DialogTitle><DialogDescription>Choose a local ACP agent and its workspace.</DialogDescription></DialogHeader>
              <div className="grid gap-4 py-2"><div className="grid gap-2"><Label>Agent</Label><div className="grid grid-cols-2 gap-2">{agents.map((agent) => <Button key={agent.id} type="button" variant={agentId === agent.id ? "default" : "outline"} onClick={() => setAgentId(agent.id)} disabled={Boolean(syncErrors[agent.id])} title={syncErrors[agent.id]}>{agent.name}</Button>)}</div>{syncErrors.opencode && <p className="text-xs leading-5 text-muted-foreground">OpenCode ACP is unavailable in the installed version. Existing sessions remain visible through a read-only CLI fallback.</p>}</div><div className="grid gap-2"><Label htmlFor="cwd">Working directory</Label><Input id="cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} className="font-mono text-xs" /></div></div>
              <DialogFooter><Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button><Button onClick={createSession} disabled={creating || !cwd.trim()}>{creating && <LoaderCircle className="animate-spin" />}Start session</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <Separator />
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-3 py-4">
            <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Sessions</p>
            {loading ? <SidebarStatus icon={<LoaderCircle className="animate-spin" />} label="Loading" /> : sessions.length === 0 ? (
              <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">No sessions yet. Start one to connect with Codex.</p>
            ) : <div className="space-y-5">{projectGroups.map((project) => <section key={project.id}><div className="mb-1.5 flex items-center gap-1.5 px-2 text-[11px] font-medium text-foreground"><FolderGit2 className="size-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{project.name}</span><span className="text-[10px] font-normal text-muted-foreground">{project.sessions.length}</span></div><div className="space-y-1">{project.sessions.map((session) => (
              <button key={session.id} onClick={() => setSelectedId(session.id)} className={cn("flex w-[248px] max-w-full items-center gap-2 rounded-lg px-2.5 py-2.5 text-left transition-colors", selectedId === session.id ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{session.title}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <AgentBadge session={session} />
                  {session.status === "running" || loadingSessionId === session.id ? (
                    <LoaderCircle className="size-3 animate-spin" aria-label="Working" />
                  ) : (
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        session.status === "error" ? "bg-destructive" : "bg-emerald-500",
                      )}
                      aria-label={session.status === "error" ? "Offline" : "Ready"}
                      role="img"
                    />
                  )}
                </span>
              </button>
            ))}</div></section>)}</div>}
          </div>
        </ScrollArea>
        <div className="border-t p-3"><div className="flex items-center gap-2 rounded-lg px-2 py-2"><Avatar className="size-7 rounded-md"><AvatarFallback className="rounded-md bg-muted"><Code2 /></AvatarFallback></Avatar><div className="min-w-0 flex-1"><p className="text-xs font-medium">Local agents</p><p className="truncate text-[10px] text-muted-foreground">Codex + OpenCode</p></div><ThemeToggle /><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Settings"><Settings2 /></Button></TooltipTrigger><TooltipContent>Settings are coming next</TooltipContent></Tooltip></div></div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col">
        {selected ? <>
          <header className="flex h-16 shrink-0 items-center justify-between border-b px-6"><div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">{selected.title}</h1><AgentBadge session={selected} /><Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] font-normal"><span className={cn("size-1.5 rounded-full", selected.status === "error" ? "bg-destructive" : "bg-emerald-500")} />{selected.status === "running" ? "Working" : selected.status === "error" ? "Offline" : "Ready"}</Badge></div><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{selected.cwd}</p></div><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Session options"><MoreHorizontal /></Button></TooltipTrigger><TooltipContent>Session options are coming next</TooltipContent></Tooltip></header>
          <ScrollArea ref={conversationRef} className="min-h-0 flex-1"><div className="mx-auto w-full max-w-3xl px-6 py-8">{selected.messages.length === 0 && selected.activities.length === 0 ? <EmptyConversation agentName={selected.agentName} /> : <div className="space-y-7">{selected.messages.map((message) => <Message key={message.id} message={message} agentName={selected.agentName} />)}{selected.activities.length > 0 && <div className="ml-10 space-y-1.5">{selected.activities.map((activity) => <Activity key={activity.id} activity={activity} />)}</div>}{selected.pendingPermissions.map((permission) => <Permission key={permission.id} permission={permission} onResolve={resolvePermission} />)}{selected.status === "running" && selected.pendingPermissions.length === 0 && <SidebarStatus icon={<LoaderCircle className="animate-spin" />} label={`${selected.agentName} is working`} />}{selected.error && <div className="ml-10 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{selected.error}</div>}</div>}</div></ScrollArea>
          <div className="shrink-0 px-6 pb-6 pt-2"><div className="mx-auto max-w-3xl">{pageError && <p className="mb-2 text-xs text-destructive">{pageError}</p>}{syncErrors.opencode && selected.agentId !== "opencode" && <p className="mb-2 text-xs text-muted-foreground">OpenCode session sync is using a read-only compatibility fallback.</p>}<div className="rounded-xl border bg-card p-2 shadow-[0_12px_40px_-24px_rgba(0,0,0,0.55)] focus-within:ring-1"><Textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={`Message ${selected.agentName}…`} className="min-h-20 resize-none border-0 bg-transparent px-2 py-2 text-sm shadow-none focus-visible:ring-0" disabled={selected.status === "error"} /><div className="flex items-center justify-between px-1 pb-1"><p className="text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>{selected.status === "running" ? <Button size="icon-sm" variant="secondary" onClick={stopSession} aria-label={`Stop ${selected.agentName}`}><CircleStop /></Button> : <Button size="icon-sm" onClick={sendMessage} disabled={!draft.trim() || selected.status === "error"} aria-label="Send message"><ArrowUp /></Button>}</div></div><p className="mt-2 text-center text-[10px] text-muted-foreground/70">MyAgents uses ACP. Review commands and file changes before approval.</p></div></div>
        </> : <NoSession loading={loading} error={pageError} onCreate={() => setDialogOpen(true)} />}
      </section>
    </main>
  );
}

function SidebarStatus({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">{icon}{label}</div>;
}

function NoSession({ loading, error, onCreate }: { loading: boolean; error: string | null; onCreate: () => void }) {
  return <div className="flex h-full flex-col items-center justify-center px-6 text-center"><div className="mb-5 flex size-12 items-center justify-center rounded-xl border bg-card">{loading ? <LoaderCircle className="animate-spin text-muted-foreground" /> : <Bot className="text-muted-foreground" />}</div><h1 className="text-lg font-semibold">{loading ? "Loading MyAgents" : "Start with a fresh session"}</h1><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{error ?? "Connect to a local ACP agent and work inside any folder on this machine."}</p>{!loading && <Button className="mt-5" size="sm" onClick={onCreate}><Plus />New session</Button>}</div>;
}

function EmptyConversation({ agentName }: { agentName: string }) {
  return <div className="flex min-h-[44vh] flex-col items-center justify-center text-center"><div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-muted"><Sparkles className="size-4 text-muted-foreground" /></div><h2 className="text-base font-semibold">What would you like to build?</h2><p className="mt-1.5 max-w-sm text-xs leading-5 text-muted-foreground">Ask {agentName} to inspect code, explain a problem, or make a change in this workspace.</p></div>;
}

function Message({ message, agentName }: { message: ChatMessage; agentName: string }) {
  const user = message.role === "user";
  return <article className="grid grid-cols-[28px_minmax(0,1fr)] gap-3"><Avatar className="size-7 rounded-md"><AvatarFallback className={cn("rounded-md text-[9px] font-semibold", user ? "bg-foreground text-background" : "bg-muted")}>{user ? "YOU" : <Sparkles />}</AvatarFallback></Avatar><div className="min-w-0 pt-0.5"><p className="mb-1.5 text-xs font-semibold">{user ? "You" : agentName}</p><p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/90">{message.content}</p></div></article>;
}

function AgentBadge({ session }: { session: SessionSummary }) {
  return <Badge variant="outline" className="h-4 shrink-0 rounded px-1 text-[9px] font-medium leading-none">{session.agentName}</Badge>;
}

function Activity({ activity }: { activity: ToolActivity }) {
  return <div className="flex items-center gap-2 text-[11px] text-muted-foreground">{activity.status === "completed" ? <Check className="size-3.5 text-emerald-500" /> : <LoaderCircle className="size-3.5 animate-spin" />}<Wrench className="size-3" /><span className="truncate">{activity.title}</span></div>;
}

function Permission({ permission, onResolve }: { permission: PermissionRequest; onResolve: (permission: PermissionRequest, optionId?: string) => Promise<void> }) {
  return <div className="ml-10 rounded-xl border bg-card p-4"><div className="flex items-start gap-3"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"><ShieldCheck /></div><div className="min-w-0 flex-1"><p className="text-xs font-semibold">Permission required</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{permission.title}</p><div className="mt-3 flex flex-wrap gap-2">{permission.options.map((option) => <Button key={option.optionId} size="sm" variant={option.kind.startsWith("allow") ? "default" : "outline"} onClick={() => void onResolve(permission, option.optionId)}>{option.name}</Button>)}<Button size="sm" variant="ghost" onClick={() => void onResolve(permission)}>Cancel</Button></div></div></div></div>;
}
