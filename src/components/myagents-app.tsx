"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cjk } from "@streamdown/cjk";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Code2,
  Download,
  FolderGit2,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { Streamdown } from "streamdown";

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
  RegistryAgent,
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

type RegistryAgentView = RegistryAgent & { installed: boolean };

type ProjectGroup = {
  id: string;
  name: string;
  path: string;
  sessions: SessionSummary[];
};

const streamdownPlugins = { cjk };

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
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<
    Partial<Record<AgentId, string>>
  >({});
  const conversationRef = useRef<HTMLDivElement>(null);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId) ?? null,
    [agentId, agents],
  );

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
        setAgentId(
          data.agents.find(({ id }) => id === "codex")?.id ??
            data.agents.find(({ available, enabled }) => available && enabled)?.id ??
            data.agents[0]?.id ??
            "codex",
        );
        void fetch("/api/sessions?sync=1", { cache: "no-store" })
          .then(async (response) => {
            if (!response.ok) throw new Error("Could not sync agent history.");
            return (await response.json()) as SessionsResponse;
          })
          .then((synced) => {
            setSessions(synced.sessions);
            setAgents(synced.agents);
            setSyncErrors(synced.syncErrors);
          })
          .catch((error) => setPageError(getError(error)));
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

  function toggleProject(projectId: string) {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function openProjectSessionDialog(project: ProjectGroup) {
    setCwd(project.path);
    setDialogOpen(true);
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
    if (!selectedAgent?.available) {
      setPageError("The selected ACP agent executable is not available.");
      return;
    }
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

  function replaceAgents(nextAgents: AgentDescriptor[]) {
    setAgents(nextAgents);
    if (!nextAgents.some(({ id }) => id === agentId)) {
      setAgentId(
        nextAgents.find(({ available, enabled }) => available && enabled)?.id ??
          nextAgents[0]?.id ??
          "codex",
      );
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
              <Button className="w-full justify-start gap-2 shadow-none" size="sm" variant="secondary"><Plus />New session</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader><DialogTitle>Start a new session</DialogTitle><DialogDescription>Choose a local ACP agent and its workspace.</DialogDescription></DialogHeader>
              <div className="grid gap-4 py-2"><div className="grid gap-2"><Label>Agent</Label><div className="flex flex-wrap gap-2">{agents.filter(({ enabled }) => enabled).map((agent) => <Button key={agent.id} type="button" size="sm" variant={agentId === agent.id ? "default" : "outline"} onClick={() => setAgentId(agent.id)} disabled={!agent.available} title={!agent.available ? `Executable not found: ${agent.command}` : syncErrors[agent.id] ?? agent.error}>{agent.name}</Button>)}</div>{selectedAgent && <p className="text-xs leading-5 text-muted-foreground">{selectedAgent.available ? `${selectedAgent.source} · ${selectedAgent.command} ${selectedAgent.args.join(" ")}` : `Executable not found: ${selectedAgent.command}`}</p>}{Object.keys(syncErrors).length > 0 && <p className="text-xs leading-5 text-muted-foreground">Some agents could not sync history. This does not disable session creation when their ACP server remains available.</p>}</div><div className="grid gap-2"><Label htmlFor="cwd">Working directory</Label><Input id="cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} className="font-mono text-xs" /></div></div>
              <DialogFooter><Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button><Button onClick={createSession} disabled={creating || !cwd.trim() || !selectedAgent?.available}>{creating && <LoaderCircle className="animate-spin" />}Start session</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <Separator />
        <ScrollArea className="min-h-0 flex-1">
          <div className="overflow-x-hidden px-3 py-3">
            <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Sessions</p>
            {loading ? <SidebarStatus icon={<LoaderCircle className="animate-spin" />} label="Loading" /> : sessions.length === 0 ? (
              <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">No sessions yet. Start one with any installed ACP agent.</p>
            ) : <div className="w-[248px] max-w-full space-y-1">{projectGroups.map((project) => { const collapsed = collapsedProjectIds.has(project.id); return <section key={project.id}><div className="flex h-8 items-center gap-1" onMouseEnter={() => setHoveredProjectId(project.id)} onMouseLeave={() => setHoveredProjectId((current) => current === project.id ? null : current)}><button type="button" aria-expanded={!collapsed} onClick={() => toggleProject(project.id)} className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-left text-[11px] font-medium text-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring"><ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} /><FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{project.name}</span></button><Button type="button" variant="ghost" size="xs" className={cn("mr-1 opacity-0 transition-opacity focus-visible:opacity-100", hoveredProjectId === project.id && "opacity-100")} aria-label={`New session in ${project.name}`} onClick={() => openProjectSessionDialog(project)}><Plus />New</Button></div>{!collapsed && <div className="ml-5 space-y-0.5 border-l pl-1">{project.sessions.map((session) => (
              <button key={session.id} onClick={() => setSelectedId(session.id)} className={cn("flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors", selectedId === session.id ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
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
            ))}</div>}</section>; })}</div>}
          </div>
        </ScrollArea>
        <div className="border-t p-3"><div className="flex items-center gap-2 rounded-lg px-2 py-2"><Avatar className="size-7 rounded-md"><AvatarFallback className="rounded-md bg-muted"><Code2 /></AvatarFallback></Avatar><div className="min-w-0 flex-1"><p className="text-xs font-medium">Local agents</p><p className="truncate text-[10px] text-muted-foreground">{agents.filter(({ enabled }) => enabled).length} ACP agents</p></div><ThemeToggle /><AgentSettingsDialog agents={agents} onAgentsChanged={replaceAgents} /></div></div>
      </aside>

      <section className="flex min-h-0 min-w-0 select-text flex-col">
        {selected ? <>
          <header className="flex h-16 shrink-0 items-center justify-between border-b px-6"><div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">{selected.title}</h1><AgentBadge session={selected} /><Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] font-normal"><span className={cn("size-1.5 rounded-full", selected.status === "error" ? "bg-destructive" : "bg-emerald-500")} />{selected.status === "running" ? "Working" : selected.status === "error" ? "Offline" : "Ready"}</Badge></div><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{selected.cwd}</p></div><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Session options"><MoreHorizontal /></Button></TooltipTrigger><TooltipContent>Session options are coming next</TooltipContent></Tooltip></header>
          <ScrollArea ref={conversationRef} className="min-h-0 flex-1"><div className="mx-auto w-full max-w-3xl px-6 py-8">{selected.messages.length === 0 && selected.activities.length === 0 ? <EmptyConversation /> : <div className="space-y-7">{selected.messages.map((message, index) => <Message key={message.id} message={message} isStreaming={selected.status === "running" && message.role === "assistant" && index === selected.messages.length - 1} />)}{selected.activities.length > 0 && <ActivityGroup activities={selected.activities} />}{selected.pendingPermissions.map((permission) => <Permission key={permission.id} permission={permission} onResolve={resolvePermission} />)}{selected.status === "running" && selected.pendingPermissions.length === 0 && <SidebarStatus icon={<LoaderCircle className="animate-spin" />} label="Agent is working" />}{selected.error && <SessionError message={selected.error} />}</div>}</div></ScrollArea>
          <div className="shrink-0 px-6 pb-6 pt-2"><div className="mx-auto max-w-3xl">{pageError && <p className="mb-2 text-xs text-destructive">{pageError}</p>}{syncErrors[selected.agentId] && <p className="mb-2 text-xs text-muted-foreground">History sync: {syncErrors[selected.agentId]}</p>}<div className="rounded-xl border bg-card p-2 focus-within:ring-1"><Textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={`Message ${selected.agentName}…`} className="min-h-20 resize-none border-0 bg-transparent px-2 py-2 text-sm shadow-none focus-visible:ring-0" disabled={selected.status === "error"} /><div className="flex items-center justify-end px-1 pb-1">{selected.status === "running" ? <Button size="icon-sm" variant="secondary" onClick={stopSession} aria-label={`Stop ${selected.agentName}`}><CircleStop /></Button> : <Button size="icon-sm" onClick={sendMessage} disabled={!draft.trim() || selected.status === "error"} aria-label="Send message"><ArrowUp /></Button>}</div></div></div></div>
        </> : <NoSession loading={loading} error={pageError} onCreate={() => setDialogOpen(true)} />}
      </section>
    </main>
  );
}

function AgentSettingsDialog({
  agents,
  onAgentsChanged,
}: {
  agents: AgentDescriptor[];
  onAgentsChanged: (agents: AgentDescriptor[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [registry, setRegistry] = useState<RegistryAgentView[]>([]);
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [authenticatingId, setAuthenticatingId] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [savingCustom, setSavingCustom] = useState(false);

  function loadRegistry() {
    if (registry.length > 0 || registryLoading) return;
    setRegistryLoading(true);
    setRegistryError(null);
    void fetch("/api/agents/registry", { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as {
          agents?: RegistryAgentView[];
          error?: string;
        };
        if (!response.ok || !data.agents) {
          throw new Error(data.error ?? "Could not load ACP Registry.");
        }
        setRegistry(data.agents);
      })
      .catch((error) => setRegistryError(getError(error)))
      .finally(() => setRegistryLoading(false));
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) loadRegistry();
  }

  const visibleRegistry = useMemo(() => {
    const query = registryQuery.trim().toLowerCase();
    return registry
      .filter(
        (agent) =>
          !query ||
          agent.name.toLowerCase().includes(query) ||
          agent.id.toLowerCase().includes(query) ||
          agent.description.toLowerCase().includes(query),
      )
      .slice(0, 12);
  }, [registry, registryQuery]);

  async function installAgent(registryId: string) {
    setInstallingId(registryId);
    setRegistryError(null);
    try {
      const response = await fetch("/api/agents/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registryId }),
      });
      const data = (await response.json()) as {
        agents?: AgentDescriptor[];
        error?: string;
      };
      if (!response.ok || !data.agents) {
        throw new Error(data.error ?? "Could not install ACP agent.");
      }
      onAgentsChanged(data.agents);
      setRegistry((current) =>
        current.map((agent) =>
          agent.id === registryId ? { ...agent, installed: true } : agent,
        ),
      );
    } catch (error) {
      setRegistryError(getError(error));
    } finally {
      setInstallingId(null);
    }
  }

  async function addCustom() {
    setSavingCustom(true);
    setRegistryError(null);
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: customName,
          command: customCommand,
          args: customArgs
            .split("\n")
            .map((argument) => argument.trim())
            .filter(Boolean),
        }),
      });
      const data = (await response.json()) as {
        agents?: AgentDescriptor[];
        error?: string;
      };
      if (!response.ok || !data.agents) {
        throw new Error(data.error ?? "Could not add custom ACP agent.");
      }
      onAgentsChanged(data.agents);
      setCustomName("");
      setCustomCommand("");
      setCustomArgs("");
    } catch (error) {
      setRegistryError(getError(error));
    } finally {
      setSavingCustom(false);
    }
  }

  async function deleteAgent(id: string) {
    setRegistryError(null);
    try {
      const response = await fetch(`/api/agents?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as {
        agents?: AgentDescriptor[];
        error?: string;
      };
      if (!response.ok || !data.agents) {
        throw new Error(data.error ?? "Could not remove ACP agent.");
      }
      onAgentsChanged(data.agents);
      setRegistry((current) =>
        current.map((agent) =>
          agent.id === id ? { ...agent, installed: false } : agent,
        ),
      );
    } catch (error) {
      setRegistryError(getError(error));
    }
  }

  async function authenticate(agent: AgentDescriptor, methodId: string) {
    setAuthenticatingId(agent.id);
    setRegistryError(null);
    try {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(agent.id)}/authenticate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ methodId }),
        },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? `Could not authenticate ${agent.name}.`);
      }
    } catch (error) {
      setRegistryError(getError(error));
    } finally {
      setAuthenticatingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Manage ACP agents">
          <Settings2 />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] overflow-hidden sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>ACP agents</DialogTitle>
          <DialogDescription>
            Manage local ACP commands or install an agent from the official registry.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[68vh] pr-4">
          <div className="space-y-6 py-1">
            <section>
              <Label>Installed</Label>
              <div className="mt-2 space-y-2">
                {agents.map((agent) => (
                  <div key={agent.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                    <span className={cn("size-2 shrink-0 rounded-full", agent.available ? "bg-emerald-500" : "bg-destructive")} aria-label={agent.available ? "Available" : "Unavailable"} role="img" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><p className="truncate text-xs font-semibold">{agent.name}</p><Badge variant="outline" className="h-4 px-1 text-[9px]">{agent.source}</Badge></div>
                      <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{agent.command} {agent.args.join(" ")}</p>
                    </div>
                    {agent.capabilities && <span className="text-[10px] text-muted-foreground">{agent.capabilities.loadSession ? "load" : agent.capabilities.resumeSession ? "resume" : "new only"}{agent.capabilities.listSessions ? " · list" : ""}</span>}
                    {agent.authMethods[0] && <Button variant="outline" size="sm" disabled={authenticatingId !== null} onClick={() => void authenticate(agent, agent.authMethods[0].id)}>{authenticatingId === agent.id && <LoaderCircle className="animate-spin" />}{agent.authMethods[0].name}</Button>}
                    {(agent.source === "custom" || agent.source === "registry") && <Button variant="ghost" size="icon-sm" onClick={() => void deleteAgent(agent.id)} aria-label={`Remove ${agent.name}`}><Trash2 /></Button>}
                  </div>
                ))}
              </div>
            </section>

            <section>
              <Label>Add a local command</Label>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="Agent name" />
                <Input value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} placeholder="/absolute/path/to/agent" className="font-mono text-xs" />
                <Textarea value={customArgs} onChange={(event) => setCustomArgs(event.target.value)} placeholder={"One argument per line\n--acp"} className="min-h-16 font-mono text-xs sm:col-span-2" />
              </div>
              <Button className="mt-2" size="sm" variant="outline" onClick={() => void addCustom()} disabled={savingCustom || !customName.trim() || !customCommand.trim()}>{savingCustom && <LoaderCircle className="animate-spin" />}Add agent</Button>
            </section>

            <section>
              <Label>Official ACP Registry</Label>
              <div className="relative mt-2"><Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input value={registryQuery} onChange={(event) => setRegistryQuery(event.target.value)} placeholder="Search agents" className="pl-8" /></div>
              {registryLoading ? <SidebarStatus icon={<LoaderCircle className="animate-spin" />} label="Loading registry" /> : <div className="mt-2 space-y-1.5">{visibleRegistry.map((agent) => <div key={agent.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{agent.name} <span className="font-normal text-muted-foreground">{agent.version}</span></p><p className="truncate text-[10px] text-muted-foreground">{agent.description}</p></div><Button size="sm" variant="outline" disabled={agent.installed || installingId !== null} onClick={() => void installAgent(agent.id)}>{installingId === agent.id ? <LoaderCircle className="animate-spin" /> : <Download />}{agent.installed ? "Added" : "Install"}</Button></div>)}</div>}
            </section>
            {registryError && <p className="text-xs leading-5 text-destructive">{registryError}</p>}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function SidebarStatus({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">{icon}{label}</div>;
}

function NoSession({ loading, error, onCreate }: { loading: boolean; error: string | null; onCreate: () => void }) {
  return <div className="flex h-full flex-col items-center justify-center px-6 text-center"><div className="mb-5 flex size-12 items-center justify-center rounded-xl border bg-card">{loading ? <LoaderCircle className="animate-spin text-muted-foreground" /> : <Bot className="text-muted-foreground" />}</div><h1 className="text-lg font-semibold">{loading ? "Loading MyAgents" : "Start with a fresh session"}</h1><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{error ?? "Connect to a local ACP agent and work inside any folder on this machine."}</p>{!loading && <Button className="mt-5" size="sm" onClick={onCreate}><Plus />New session</Button>}</div>;
}

function EmptyConversation() {
  return <div className="flex min-h-[44vh] flex-col items-center justify-center text-center"><div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-muted"><Sparkles className="size-4 text-muted-foreground" /></div><h2 className="text-base font-semibold">What would you like to build?</h2><p className="mt-1.5 max-w-sm text-xs leading-5 text-muted-foreground">Ask the agent to inspect code, explain a problem, or make a change in this workspace.</p></div>;
}

function Message({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  const user = message.role === "user";
  if (user) {
    return <article className="ml-auto max-w-[85%] rounded-xl bg-muted px-4 py-2.5"><p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/90">{message.content}</p></article>;
  }

  return (
    <article>
      <Streamdown
        className="break-words text-[13px] leading-6 text-foreground/90"
        isAnimating={isStreaming}
        mode={isStreaming ? "streaming" : "static"}
        plugins={streamdownPlugins}
      >
        {message.content}
      </Streamdown>
    </article>
  );
}

function AgentBadge({ session }: { session: SessionSummary }) {
  return <Badge variant="outline" className="h-4 shrink-0 rounded px-1 text-[9px] font-medium leading-none">{session.agentName}</Badge>;
}

function ActivityGroup({ activities }: { activities: ToolActivity[] }) {
  const active = activities.some(({ status }) => status === "pending" || status === "in_progress");
  const failed = activities.some(({ status }) => status === "failed");
  return <details className="group rounded-lg border border-transparent open:border-border open:bg-muted/30"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-2 text-[11px] text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />{active ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : failed ? <CircleStop className="size-3.5 shrink-0 text-destructive" /> : <Check className="size-3.5 shrink-0 text-emerald-500" />}<Wrench className="size-3 shrink-0" /><span>{activities.length} tool {activities.length === 1 ? "call" : "calls"}</span></summary><div className="divide-y border-t">{activities.map((activity) => <div key={activity.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-4 py-2.5 text-[11px]">{activity.status === "completed" ? <Check className="size-3.5 text-emerald-500" /> : <LoaderCircle className={cn("size-3.5", activity.status === "in_progress" && "animate-spin")} />}<span className="min-w-0 truncate">{activity.title}</span><span className="text-muted-foreground"><code>{activity.kind}</code> · <span className="capitalize">{activity.status.replace("_", " ")}</span></span></div>)}</div></details>;
}

function SessionError({ message }: { message: string }) {
  return <details className="group rounded-lg border border-destructive/30 bg-destructive/5 text-xs text-destructive"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" /><span className="font-medium">Session error</span></summary><p className="border-t border-destructive/20 px-3 py-2 leading-5">{message}</p></details>;
}

function Permission({ permission, onResolve }: { permission: PermissionRequest; onResolve: (permission: PermissionRequest, optionId?: string) => Promise<void> }) {
  return <details className="group rounded-xl border bg-card"><summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" /><ShieldCheck className="size-4 shrink-0 text-muted-foreground" /><span className="shrink-0 font-semibold">Permission required</span><span className="truncate text-muted-foreground">{permission.title}</span></summary><div className="border-t px-4 py-3"><p className="text-xs leading-5 text-muted-foreground">{permission.title}</p><div className="mt-3 flex flex-wrap gap-2">{permission.options.map((option) => <Button key={option.optionId} size="sm" variant={option.kind.startsWith("allow") ? "default" : "outline"} onClick={() => void onResolve(permission, option.optionId)}>{option.name}</Button>)}<Button size="sm" variant="ghost" onClick={() => void onResolve(permission)}>Cancel</Button></div></div></details>;
}
