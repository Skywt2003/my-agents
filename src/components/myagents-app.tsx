import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { cjk } from "@streamdown/cjk";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  FolderOpen,
  FolderGit2,
  Info,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  Streamdown,
  type Components,
  type LinkSafetyConfig,
  type LinkSafetyModalProps,
} from "streamdown";

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
import { ResizeHandle } from "@/components/resize-handle";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { FontSettings } from "@/components/font-settings";
import { ThemeSettings } from "@/components/theme-toggle";
import { TerminalPanel } from "@/components/terminal-panel";
import { TelemetrySettings } from "@/components/telemetry-settings";
import type {
  RegistryAgentView,
  SelectSessionConfigOption,
  SessionsSnapshot,
} from "@/lib/myagents/desktop-api";
import type {
  AgentDescriptor,
  AgentId,
  ChatMessage,
  ConversationItem,
  PermissionRequest,
  SessionStreamEvent,
  SessionConfigOption,
  SessionProject,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import { applySessionEvent } from "@/lib/myagents/session-reducer";
import { cn } from "@/lib/utils";

type UiPreferences = {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  terminalHeight: number;
  collapsedProjectIds: string[];
};

const streamdownPlugins = { cjk };
const streamdownComponents = {
  p: ({ children, node, ...props }) => {
    const containsBlockImage = node?.children.some(
      (child) => child.type === "element" && child.tagName === "img",
    );
    const Paragraph = containsBlockImage ? "div" : "p";

    return <Paragraph {...props}>{children}</Paragraph>;
  },
} satisfies Components;
const streamdownLinkSafety = {
  enabled: true,
  renderModal: ExternalLinkSafetyModal,
} satisfies LinkSafetyConfig;
const UI_PREFERENCES_STORAGE_KEY = "myagents:ui-preferences:v1";
const MODEL_OPTIONS_CACHE_STORAGE_KEY = "myagents:model-options-cache:v1";
const MODEL_OPTIONS_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1_000;
const MODEL_OPTIONS_CACHE_MAX_ENTRIES = 50;
const REGISTRY_PAGE_SIZE = 10;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_COLLAPSED_WIDTH = 48;
const MACOS_SIDEBAR_COLLAPSED_WIDTH = 80;
const SIDEBAR_HORIZONTAL_PADDING = 24;
const TERMINAL_MIN_HEIGHT = 180;
const TERMINAL_MAX_HEIGHT = 720;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const getError = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

function isModelConfigOption(
  option: SessionConfigOption,
): option is SelectSessionConfigOption {
  return option.category === "model" && option.type === "select";
}

type ModelOptionsCacheEntry = {
  agentFingerprint: string;
  fetchedAt: number;
  option: SelectSessionConfigOption;
};

function modelCacheKey(projectId: string, agentId: AgentId) {
  return JSON.stringify([projectId, agentId]);
}

function agentCacheFingerprint(agent: AgentDescriptor) {
  return JSON.stringify([agent.version ?? null, agent.command, agent.args]);
}

function isModelOptionValue(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.value === "string" && typeof item.name === "string";
}

function isCachedModelOption(value: unknown): value is SelectSessionConfigOption {
  if (!value || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  if (
    option.type !== "select" ||
    option.category !== "model" ||
    typeof option.id !== "string" ||
    typeof option.name !== "string" ||
    typeof option.currentValue !== "string" ||
    !Array.isArray(option.options)
  ) return false;
  return option.options.every((item) => {
    if (!item || typeof item !== "object") return false;
    if (!("group" in item)) return isModelOptionValue(item);
    const group = item as Record<string, unknown>;
    return typeof group.group === "string" &&
      typeof group.name === "string" &&
      Array.isArray(group.options) &&
      group.options.every(isModelOptionValue);
  });
}

function readCachedModelOption(projectId: string, agent: AgentDescriptor | null) {
  if (!projectId || !agent) return null;
  try {
    const cache = JSON.parse(
      window.localStorage.getItem(MODEL_OPTIONS_CACHE_STORAGE_KEY) ?? "{}",
    ) as Record<string, Partial<ModelOptionsCacheEntry>>;
    const entry = cache[modelCacheKey(projectId, agent.id)];
    if (
      !entry ||
      entry.agentFingerprint !== agentCacheFingerprint(agent) ||
      typeof entry.fetchedAt !== "number" ||
      Date.now() - entry.fetchedAt > MODEL_OPTIONS_CACHE_MAX_AGE ||
      !isCachedModelOption(entry.option)
    ) return null;
    return entry.option;
  } catch {
    return null;
  }
}

function writeCachedModelOption(
  projectId: string,
  agent: AgentDescriptor,
  option: SelectSessionConfigOption,
) {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(MODEL_OPTIONS_CACHE_STORAGE_KEY) ?? "{}",
    ) as Record<string, ModelOptionsCacheEntry>;
    const entries = Object.entries(stored)
      .filter(([, entry]) =>
        typeof entry?.fetchedAt === "number" &&
        Date.now() - entry.fetchedAt <= MODEL_OPTIONS_CACHE_MAX_AGE,
      )
      .sort(([, left], [, right]) => right.fetchedAt - left.fetchedAt)
      .slice(0, MODEL_OPTIONS_CACHE_MAX_ENTRIES - 1);
    const cache = Object.fromEntries(entries);
    cache[modelCacheKey(projectId, agent.id)] = {
      agentFingerprint: agentCacheFingerprint(agent),
      fetchedAt: Date.now(),
      option,
    };
    window.localStorage.setItem(MODEL_OPTIONS_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Model loading still works when local storage is unavailable or full.
  }
}

function deleteCachedModelOption(projectId: string, agentId: AgentId) {
  try {
    const cache = JSON.parse(
      window.localStorage.getItem(MODEL_OPTIONS_CACHE_STORAGE_KEY) ?? "{}",
    ) as Record<string, ModelOptionsCacheEntry>;
    delete cache[modelCacheKey(projectId, agentId)];
    window.localStorage.setItem(MODEL_OPTIONS_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore unavailable or malformed local storage.
  }
}

function modelOptionHasValue(option: SelectSessionConfigOption, value: string) {
  return option.options.some((item) =>
    "group" in item
      ? item.options.some((nested) => nested.value === value)
      : item.value === value,
  );
}

function ModelSelect({
  id,
  session,
  previewModel = null,
  previewValue = null,
  loading = false,
  disabled = false,
  onPrepare,
  onChange,
}: {
  id: string;
  session: SessionSummary | null;
  previewModel?: SelectSessionConfigOption | null;
  previewValue?: string | null;
  loading?: boolean;
  disabled?: boolean;
  onPrepare?: () => void;
  onChange: (
    session: SessionSummary | null,
    option: SessionConfigOption,
    value: string,
  ) => void;
}) {
  const liveModel = session?.configOptions.find(isModelConfigOption);
  const model = liveModel ?? previewModel ?? undefined;
  const unavailable = Boolean(session && !liveModel);
  const items = model?.options.flatMap((option) =>
    "group" in option
      ? option.options.map((item) => ({ label: item.name, value: item.value }))
      : [{ label: option.name, value: option.value }],
  ) ?? [];
  const placeholder = loading && !model
    ? "Loading models…"
    : unavailable
      ? "Agent default"
      : "Choose model…";

  return (
    <Select
      items={items}
      value={liveModel?.currentValue ?? previewValue}
      disabled={disabled || (loading && !model) || unavailable}
      onOpenChange={(open) => {
        if (open) onPrepare?.();
      }}
      onValueChange={(value) => {
        if (model && value) onChange(session, model, value);
      }}
    >
      <SelectTrigger
        id={id}
        size="sm"
        className="max-w-56 text-[10px]"
        aria-label="Model"
        title={unavailable ? "This agent does not expose model selection through ACP." : undefined}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {model?.options.map((option) =>
          "group" in option ? (
            <SelectGroup key={option.group}>
              <SelectLabel>{option.name}</SelectLabel>
              {option.options.map((item) => (
                <SelectItem key={item.value} value={item.value}>{item.name}</SelectItem>
              ))}
            </SelectGroup>
          ) : (
            <SelectItem key={option.value} value={option.value}>{option.name}</SelectItem>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

export function MyAgentsApp() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<SessionProject[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [agentId, setAgentId] = useState<AgentId>("codex");
  const [projectId, setProjectId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftSession, setDraftSession] = useState<SessionSummary | null>(null);
  const [cachedModel, setCachedModel] = useState<SelectSessionConfigOption | null>(null);
  const [pendingModelValue, setPendingModelValue] = useState<string | null>(null);
  const [creatingSessionView, setCreatingSessionView] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [selectingProjectDirectory, setSelectingProjectDirectory] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [updatingModelSessionId, setUpdatingModelSessionId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(280);
  const [sidebarWidth, setSidebarWidth] = useState(272);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [syncErrors, setSyncErrors] = useState<
    Partial<Record<AgentId, string>>
  >({});
  const conversationRef = useRef<HTMLDivElement>(null);
  const draftGenerationRef = useRef(0);
  const draftPreparationRef = useRef<Promise<SessionSummary | null> | null>(null);
  const pendingModelValueRef = useRef<string | null>(null);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId) ?? null,
    [agentId, agents],
  );

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId],
  );
  const projectGroups = useMemo(
    () => {
      const sessionsByProject = new Map<string, SessionSummary[]>();
      for (const session of sessions) {
        const projectSessions = sessionsByProject.get(session.project.id) ?? [];
        projectSessions.push(session);
        sessionsByProject.set(session.project.id, projectSessions);
      }
      return projects.map((project) => ({
        ...project,
        sessions: sessionsByProject.get(project.id) ?? [],
      }));
    },
    [projects, sessions],
  );

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
      if (stored) {
        const preferences = JSON.parse(stored) as Partial<UiPreferences>;
        const sidebarMaximum = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - 360),
        );
        const terminalMaximum = Math.max(
          TERMINAL_MIN_HEIGHT,
          Math.min(TERMINAL_MAX_HEIGHT, window.innerHeight - 180),
        );
        if (
          typeof preferences.sidebarWidth === "number" &&
          Number.isFinite(preferences.sidebarWidth)
        ) {
          setSidebarWidth(
            clamp(
              preferences.sidebarWidth,
              SIDEBAR_MIN_WIDTH,
              sidebarMaximum,
            ),
          );
        }
        if (typeof preferences.sidebarCollapsed === "boolean") {
          setSidebarCollapsed(preferences.sidebarCollapsed);
        }
        if (
          typeof preferences.terminalHeight === "number" &&
          Number.isFinite(preferences.terminalHeight)
        ) {
          setTerminalHeight(
            clamp(
              preferences.terminalHeight,
              TERMINAL_MIN_HEIGHT,
              terminalMaximum,
            ),
          );
        }
        if (Array.isArray(preferences.collapsedProjectIds)) {
          setCollapsedProjectIds(
            new Set(
              preferences.collapsedProjectIds.filter(
                (projectId): projectId is string => typeof projectId === "string",
              ),
            ),
          );
        }
      }
    } catch {
      // Ignore malformed or unavailable local storage and keep safe defaults.
    } finally {
      setPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!preferencesLoaded) return;
    const preferences: UiPreferences = {
      sidebarWidth,
      sidebarCollapsed,
      terminalHeight,
      collapsedProjectIds: Array.from(collapsedProjectIds),
    };
    try {
      window.localStorage.setItem(
        UI_PREFERENCES_STORAGE_KEY,
        JSON.stringify(preferences),
      );
    } catch {
      // The UI remains usable when storage is disabled or full.
    }
  }, [
    collapsedProjectIds,
    preferencesLoaded,
    sidebarCollapsed,
    sidebarWidth,
    terminalHeight,
  ]);

  useEffect(() => {
    void window.myagents.sessions.list()
      .then((data) => {
        const initialProjectId = data.projects[0]?.id ?? "";
        const initialAgent = data.agents.find(({ id }) => id === "codex") ??
          data.agents.find(({ available, enabled }) => available && enabled) ??
          data.agents[0] ??
          null;
        const initialAgentId = initialAgent?.id ?? "codex";
        setSessions(data.sessions);
        setProjects(data.projects);
        setAgents(data.agents);
        setSyncErrors(data.syncErrors);
        setSelectedId(data.sessions[0]?.id ?? null);
        setCreatingSessionView(data.sessions.length === 0);
        setProjectId(initialProjectId);
        setAgentId(initialAgentId);
        setCachedModel(readCachedModelOption(initialProjectId, initialAgent));
        void window.myagents.sessions.list(true)
          .then((synced) => {
            setSessions(synced.sessions);
            setProjects(synced.projects);
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
    void refreshSession(selectedId, true, true);
    // The selected session is the only trigger; refreshSession is intentionally stable by ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useLayoutEffect(() => {
    const viewport = conversationRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [selectedId, selected?.conversation]);

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

  function discardDraftSession() {
    draftGenerationRef.current += 1;
    draftPreparationRef.current = null;
    setCreating(false);
    pendingModelValueRef.current = null;
    setPendingModelValue(null);
    const session = draftSession;
    setDraftSession(null);
    if (session) {
      void window.myagents.sessions.discard(session.id).catch((error) =>
        setPageError(getError(error)),
      );
    }
  }

  function openNewSession(nextProjectId?: string, preserveDraft = false) {
    if (nextProjectId) {
      setProjectId(nextProjectId);
      setCachedModel(readCachedModelOption(nextProjectId, selectedAgent));
    } else {
      setCachedModel(readCachedModelOption(projectId, selectedAgent));
    }
    if (!preserveDraft) setDraft("");
    discardDraftSession();
    setSelectedId(null);
    setCreatingSessionView(true);
    setPageError(null);
  }

  async function syncSessions() {
    setSyncing(true);
    setPageError(null);
    try {
      const data: SessionsSnapshot = await window.myagents.sessions.list(true);
      const refreshed = selectedId
        ? await window.myagents.sessions.reload(selectedId)
        : null;
      setSessions(data.sessions.map((session) =>
        session.id === refreshed?.id ? refreshed : session
      ));
      setProjects(data.projects);
      setAgents(data.agents);
      setSyncErrors(data.syncErrors);
    } catch (error) {
      setPageError(getError(error));
    } finally {
      setSyncing(false);
    }
  }

  async function refreshSession(
    id: string,
    showLoading = false,
    reload = false,
  ) {
    if (showLoading) setLoadingSessionId(id);
    try {
      const session = reload
        ? await window.myagents.sessions.reload(id)
        : await window.myagents.sessions.get(id);
      const sessionAgent = agents.find(({ id: agent }) => agent === session.agentId);
      const model = session.configOptions.find(isModelConfigOption);
      if (sessionAgent && model) {
        writeCachedModelOption(session.project.id, sessionAgent, model);
      } else if (!model) {
        deleteCachedModelOption(session.project.id, session.agentId);
      }
      patchSession(id, () => session);
    } catch (error) {
      setPageError(getError(error));
    } finally {
      if (showLoading) {
        setLoadingSessionId((current) => current === id ? null : current);
      }
    }
  }

  async function prepareSessionDraft() {
    if (draftSession) return draftSession;
    if (draftPreparationRef.current) return draftPreparationRef.current;
    if (!selectedAgent?.available) {
      setPageError("The selected ACP agent executable is not available.");
      return null;
    }
    if (!projectId) {
      setPageError("Choose a project before starting a session.");
      return null;
    }
    const generation = draftGenerationRef.current;
    const nextProjectId = projectId;
    const nextAgentId = agentId;
    const nextAgent = selectedAgent;
    const preparation = (async () => {
      const session = await window.myagents.sessions.create(nextProjectId, nextAgentId);
      if (generation !== draftGenerationRef.current) {
        await window.myagents.sessions.discard(session.id);
        return null;
      }

      const model = session.configOptions.find(isModelConfigOption) ?? null;
      if (model) {
        writeCachedModelOption(nextProjectId, nextAgent, model);
        setCachedModel(model);
      } else {
        deleteCachedModelOption(nextProjectId, nextAgentId);
        setCachedModel(null);
      }
      setDraftSession(session);

      const pendingValue = pendingModelValueRef.current;
      if (pendingValue) {
        pendingModelValueRef.current = null;
        setPendingModelValue(null);
        if (model && modelOptionHasValue(model, pendingValue)) {
          await changeModel(session, model, pendingValue);
        } else {
          setPageError("The cached model is no longer available. Using the agent default.");
        }
      }
      return session;
    })();
    draftPreparationRef.current = preparation;
    setCreating(true);
    setPageError(null);
    try {
      return await preparation;
    } catch (error) {
      setPageError(getError(error));
      return null;
    } finally {
      if (draftPreparationRef.current === preparation) {
        draftPreparationRef.current = null;
        setCreating(false);
      }
    }
  }

  async function addProject() {
    const preserveDraft = creatingSessionView;
    setAddingProject(true);
    setProjectError(null);
    try {
      const project = await window.myagents.projects.create(projectName, projectPath);
      setProjects((current) => [...current, project].sort((a, b) =>
        a.name.localeCompare(b.name),
      ));
      setProjectId(project.id);
      setProjectName("");
      setProjectPath("");
      setProjectDialogOpen(false);
      openNewSession(project.id, preserveDraft);
    } catch (error) {
      setProjectError(getError(error));
    } finally {
      setAddingProject(false);
    }
  }

  async function selectProjectDirectory() {
    setSelectingProjectDirectory(true);
    setProjectError(null);
    try {
      const path = await window.myagents.projects.selectDirectory();
      if (path) setProjectPath(path);
    } catch (error) {
      setProjectError(getError(error));
    } finally {
      setSelectingProjectDirectory(false);
    }
  }

  function replaceAgents(nextAgents: AgentDescriptor[]) {
    setAgents(nextAgents);
    if (!nextAgents.some(({ id }) => id === agentId)) {
      discardDraftSession();
      const nextAgent = nextAgents.find(
        ({ available, enabled }) => available && enabled,
      ) ?? nextAgents[0] ?? null;
      const nextAgentId = nextAgent?.id ?? "codex";
      setAgentId(nextAgentId);
      setCachedModel(readCachedModelOption(projectId, nextAgent));
    }
  }

  function applyEvent(id: string, event: SessionStreamEvent) {
    patchSession(id, (session) => applySessionEvent(session, event));
  }

  async function sendMessage(
    target: SessionSummary | null = selected,
    messageInput = draft,
  ) {
    const message = messageInput.trim();
    if (
      !target ||
      !message ||
      target.status === "running" ||
      loadingSessionId === target.id
    ) return;
    const id = target.id;
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
      conversation: [
        ...session.conversation,
        { type: "message", message: userMessage },
      ],
    }));

    try {
      await window.myagents.sessions.prompt(id, message, (event) =>
        applyEvent(id, event),
      );
      await refreshSession(id, true, true);
    } catch (error) {
      patchSession(id, (session) => ({ ...session, status: "error", error: getError(error) }));
    }
  }

  async function startNewSession() {
    const message = draft.trim();
    if (!message) return;
    const preparedSession = draftSession?.project.id === projectId &&
      draftSession.agentId === agentId
      ? draftSession
      : null;
    const session = preparedSession ?? await prepareSessionDraft();
    if (session) {
      setSessions((current) => current.some(({ id }) => id === session.id)
        ? current.map((item) => item.id === session.id ? session : item)
        : [session, ...current]);
      setSelectedId(session.id);
      setCreatingSessionView(false);
      setDraftSession(null);
      await sendMessage(session, message);
    }
  }

  async function prepareNewSessionModels() {
    if (creating || draftSession || !projectId || !selectedAgent?.available) return;
    await prepareSessionDraft();
  }

  async function changeModel(
    session: SessionSummary,
    option: SessionConfigOption,
    value: string,
  ) {
    setUpdatingModelSessionId(session.id);
    setPageError(null);
    try {
      const updated = await window.myagents.sessions.setConfigOption(
        session.id,
        option.id,
        value,
      );
      const updatedModel = updated.configOptions.find(isModelConfigOption);
      if (updatedModel) {
        const updatedAgent = agents.find(({ id }) => id === updated.agentId);
        if (updatedAgent) {
          writeCachedModelOption(updated.project.id, updatedAgent, updatedModel);
        }
        if (updated.project.id === projectId && updated.agentId === agentId) {
          setCachedModel(updatedModel);
        }
      }
      patchSession(session.id, () => updated);
      setDraftSession((current) => current?.id === session.id ? updated : current);
    } catch (error) {
      setPageError(getError(error));
    } finally {
      setUpdatingModelSessionId(null);
    }
  }

  async function stopSession() {
    if (selected) await window.myagents.sessions.cancel(selected.id);
  }

  async function resolvePermission(permission: PermissionRequest, optionId?: string) {
    if (!selected) return;
    try {
      await window.myagents.sessions.resolvePermission(
        selected.id,
        permission.id,
        optionId,
      );
      patchSession(selected.id, (session) => ({
        ...session,
        pendingPermissions: session.pendingPermissions.filter((item) => item.id !== permission.id),
      }));
    } catch (error) {
      setPageError(getError(error));
    }
  }

  return (
    <main
      className="macos-window-surface grid h-dvh min-h-[540px] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background transition-[grid-template-columns] duration-200"
      style={{
        gridTemplateColumns: `${sidebarCollapsed ? window.myagents.platform === "darwin" ? MACOS_SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_COLLAPSED_WIDTH : sidebarWidth}px minmax(0, 1fr)`,
      }}
    >
      <aside
        aria-label="Session sidebar"
        className="macos-sidebar-surface relative flex min-h-0 min-w-0 flex-col overflow-hidden border-r bg-sidebar"
      >
        <div className={cn(
          "macos-titlebar-drag-region macos-window-drag-region flex h-10 shrink-0 items-center gap-2",
          sidebarCollapsed && "macos-titlebar-drag-region-collapsed",
          sidebarCollapsed ? "justify-center px-2" : "px-3",
        )}>
          {!sidebarCollapsed ? (
            <>
              <p className="min-w-0 flex-1 truncate text-xs font-semibold">MyAgents</p>
              {__MYAGENTS_BROWSER_DEBUG__ ? (
                <Badge variant="outline" className="shrink-0 text-[9px] uppercase tracking-wide">
                  Browser debug
                </Badge>
              ) : null}
            </>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </div>
        <Dialog open={projectDialogOpen} onOpenChange={(open) => {
          setProjectDialogOpen(open);
          if (!open) setProjectError(null);
        }}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader><DialogTitle>Add project</DialogTitle><DialogDescription>Give the project a name and bind it to one local directory.</DialogDescription></DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-2"><Label htmlFor="project-name">Project name</Label><Input id="project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="My project" autoFocus /></div>
              <div className="grid gap-2">
                <Label htmlFor="project-path">Directory</Label>
                <div className="flex gap-2">
                  <Input id="project-path" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} placeholder="/absolute/path/to/project" className="min-w-0 font-mono text-xs" />
                  {window.myagents.transport === "electron" && (
                    <Button type="button" variant="outline" onClick={() => void selectProjectDirectory()} disabled={selectingProjectDirectory}>
                      {selectingProjectDirectory ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
                      Choose…
                    </Button>
                  )}
                </div>
              </div>
              {projectError && <p className="text-xs text-destructive">{projectError}</p>}
            </div>
            <DialogFooter><Button variant="ghost" onClick={() => setProjectDialogOpen(false)}>Cancel</Button><Button onClick={() => void addProject()} disabled={addingProject || !projectName.trim() || !projectPath.trim()}>{addingProject && <LoaderCircle className="animate-spin" />}Add project</Button></DialogFooter>
          </DialogContent>
        </Dialog>
        {!sidebarCollapsed ? (
          <>
            <Separator />
            <ScrollArea className="min-h-0 flex-1">
          <div className="overflow-x-hidden px-3 py-3">
            <div className="mb-1 flex h-6 items-center justify-between pl-1 pr-0.5"><p className="text-[10px] font-semibold uppercase tracking-[0.035em] text-muted-foreground">Projects</p><div className="flex items-center gap-0.5"><Button type="button" variant="ghost" size="icon-xs" onClick={() => setProjectDialogOpen(true)} aria-label="Add project"><Plus /></Button><Button type="button" variant="ghost" size="icon-xs" disabled={loading || syncing} onClick={() => void syncSessions()} aria-label={syncing ? "Syncing agent sessions" : "Sync agent sessions"}><RefreshCw className={cn(syncing && "animate-spin")} /></Button></div></div>
            {loading ? <SidebarStatus icon={<LoaderCircle className="animate-spin" />} label="Loading" /> : projects.length === 0 ? (
              <button type="button" onClick={() => setProjectDialogOpen(true)} className="w-full rounded-lg px-2 py-3 text-left text-[11px] leading-[17px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground">No projects yet. Add one to start a session.</button>
            ) : <div data-slot="session-directory" className="max-w-full space-y-1" style={{ width: sidebarWidth - SIDEBAR_HORIZONTAL_PADDING }}>{projectGroups.map((project) => { const collapsed = collapsedProjectIds.has(project.id); return <section key={project.id}><div className="flex h-8 items-center gap-1" onMouseEnter={() => setHoveredProjectId(project.id)} onMouseLeave={() => setHoveredProjectId((current) => current === project.id ? null : current)}><button type="button" aria-expanded={!collapsed} onClick={() => toggleProject(project.id)} className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[11px] font-medium text-foreground outline-none hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring"><ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} /><FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{project.name}</span></button><Button type="button" variant="ghost" size="icon-xs" className={cn("mr-1 opacity-0 transition-opacity focus-visible:opacity-100", hoveredProjectId === project.id && "opacity-100")} aria-label={`New session in ${project.name}`} onClick={() => openNewSession(project.id)}><Plus /></Button></div>{!collapsed && <div className="ml-5 space-y-0.5 border-l pl-1">{project.sessions.map((session) => (
              <button key={session.id} onClick={() => { discardDraftSession(); setSelectedId(session.id); setCreatingSessionView(false); }} className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors", selectedId === session.id && !creatingSessionView ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{session.title}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <AgentIcon session={session} />
                  <span className="flex size-3 shrink-0 items-center justify-center">
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
                </span>
              </button>
            ))}</div>}</section>; })}</div>}
          </div>
            </ScrollArea>
            <div className="h-10 border-t px-3"><div className="flex h-full items-center gap-2 rounded-md px-1"><Avatar size="sm" className="rounded-md"><AvatarFallback className="rounded-md bg-muted"><Bot className="size-3.5" /></AvatarFallback></Avatar><p className="min-w-0 flex-1 truncate text-[11px] font-medium">{agents.filter(({ enabled }) => enabled).length} Agents</p><AgentSettingsDialog agents={agents} onAgentsChanged={replaceAgents} /></div></div>
            <ResizeHandle
          orientation="vertical"
          value={sidebarWidth}
          min={SIDEBAR_MIN_WIDTH}
          max={SIDEBAR_MAX_WIDTH}
          label="Resize sidebar"
          onChange={(value) => {
            const maximum = Math.max(
              SIDEBAR_MIN_WIDTH,
              Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - 360),
            );
            setSidebarWidth(Math.min(maximum, value));
          }}
            />
          </>
        ) : null}
      </aside>

      <section className="macos-content-surface flex min-h-0 min-w-0 flex-col">
        {loading && !selected ? (
          <NoSession loading error={pageError} onCreate={() => openNewSession()} />
        ) : creatingSessionView || !selected ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-8">
            <div className="w-full max-w-2xl -translate-y-[5vh]">
              <div className="mb-5 text-center"><div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-muted"><Sparkles className="size-4 text-muted-foreground" /></div><h1 className="text-[15px] font-semibold">Start a new session</h1><p className="mt-1 text-xs text-muted-foreground">Choose a project and an agent, then describe what you want to do.</p></div>
              {pageError && <p className="mb-2 text-xs text-destructive">{pageError}</p>}
              <div className="rounded-[9px] border bg-card p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring">
                <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void startNewSession(); } }} placeholder="What would you like to work on?" autoFocus className="min-h-16 resize-none border-0 bg-transparent px-2 py-2 text-xs shadow-none focus-visible:ring-0" />
                <div className="flex flex-wrap items-center justify-between gap-2 border-t px-1 pt-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Select
                      items={projects.map((project) => ({ label: project.name, value: project.id }))}
                      value={projectId || null}
                      disabled={projects.length === 0 || creating}
                      onValueChange={(value) => {
                        if (!value) return;
                        discardDraftSession();
                        setProjectId(value);
                        setCachedModel(readCachedModelOption(value, selectedAgent));
                      }}
                    >
                      <SelectTrigger id="new-session-project" size="sm" className="max-w-56 text-xs" aria-label="Project">
                        <SelectValue placeholder={projects.length === 0 ? "No projects" : "Choose project…"} />
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectGroup>
                          {projects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Select
                      items={agents.filter(({ enabled }) => enabled).map((agent) => ({
                        label: `${agent.name}${agent.available ? "" : " (unavailable)"}`,
                        value: agent.id,
                      }))}
                      value={agentId}
                      disabled={creating}
                      onValueChange={(value) => {
                        if (!value) return;
                        discardDraftSession();
                        setAgentId(value);
                        setCachedModel(readCachedModelOption(
                          projectId,
                          agents.find(({ id }) => id === value) ?? null,
                        ));
                      }}
                    >
                      <SelectTrigger id="new-session-agent" size="sm" className="max-w-56 text-xs" aria-label="Agent">
                        <SelectValue placeholder="Choose agent…" />
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectGroup>
                          {agents.filter(({ enabled }) => enabled).map((agent) => (
                            <SelectItem key={agent.id} value={agent.id} disabled={!agent.available}>
                              {agent.name}{agent.available ? "" : " (unavailable)"}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <ModelSelect
                      id="new-session-model"
                      session={draftSession}
                      previewModel={cachedModel}
                      previewValue={pendingModelValue}
                      loading={creating && !draftSession}
                      disabled={!projectId || !selectedAgent?.available || updatingModelSessionId === draftSession?.id}
                      onPrepare={() => void prepareNewSessionModels()}
                      onChange={(session, option, value) => {
                        if (session) {
                          void changeModel(session, option, value);
                          return;
                        }
                        pendingModelValueRef.current = value;
                        setPendingModelValue(value);
                        void prepareNewSessionModels();
                      }}
                    />
                    {projects.length === 0 && <Button type="button" size="sm" variant="ghost" onClick={() => setProjectDialogOpen(true)}><Plus />Add project</Button>}
                  </div>
                  <Button size="icon-sm" onClick={() => void startNewSession()} disabled={creating || !draft.trim() || !projectId || !selectedAgent?.available} aria-label="Start session and send message">{creating ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}</Button>
                </div>
              </div>
              {selectedAgent && !selectedAgent.available && <p className="mt-2 text-xs text-destructive">Executable not found: {selectedAgent.command}</p>}
              {Object.keys(syncErrors).length > 0 && <p className="mt-2 text-xs text-muted-foreground">Some agents could not sync history. Session creation remains available when their ACP server can start.</p>}
            </div>
          </div>
        ) : selected ? <>
          <header className="macos-window-drag-region flex h-10 shrink-0 items-center justify-between border-b px-3"><div className="flex min-w-0 items-center gap-2"><h1 className="min-w-0 truncate text-xs font-semibold">{selected.title}</h1><SessionDetailsDialog session={selected} onSessionChanged={(session) => patchSession(session.id, () => session)} /><AgentIcon session={selected} /><Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] font-normal"><span className={cn("size-1.5 rounded-full", selected.status === "error" ? "bg-destructive" : "bg-emerald-500")} />{selected.status === "running" ? "Working" : selected.status === "error" ? "Offline" : "Ready"}</Badge></div><Button variant={terminalOpen ? "secondary" : "ghost"} size="icon-sm" aria-label="Toggle terminal panel" aria-pressed={terminalOpen} onClick={() => setTerminalOpen((open) => !open)}><SquareTerminal /></Button></header>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col">
              <ScrollArea ref={conversationRef} data-slot="conversation-scroll-area" className="min-h-0 flex-1"><div className="mx-auto w-full max-w-3xl px-3 py-4"><div className="space-y-3"><ConversationTimeline session={selected} onResolvePermission={resolvePermission} />{selected.status === "running" && selected.pendingPermissions.length === 0 && <SidebarStatus icon={<LoaderCircle className="animate-spin" />} label="Agent is working" />}{selected.error && <SessionError message={selected.error} />}</div></div></ScrollArea>
              <div className="shrink-0 px-3 pb-3 pt-2"><div className="mx-auto max-w-3xl">{pageError && <p className="mb-2 text-xs text-destructive">{pageError}</p>}{syncErrors[selected.agentId] && <p className="mb-2 text-xs text-muted-foreground">History sync: {syncErrors[selected.agentId]}</p>}{loadingSessionId === selected.id ? <div role="status" aria-live="polite" className="mb-2 flex items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" /><span>Loading conversation</span></div> : null}<div className="rounded-[9px] border bg-card p-2 focus-within:ring-1"><Textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={`Message ${selected.agentName}…`} className="min-h-12 resize-none border-0 bg-transparent px-2 py-2 text-xs shadow-none focus-visible:ring-0" disabled={selected.status === "error" || loadingSessionId === selected.id} /><div className="flex items-center justify-between gap-2 px-1 pb-1"><ModelSelect id={`session-${selected.id}-model`} session={selected} disabled={selected.status === "running" || selected.status === "error" || loadingSessionId === selected.id || updatingModelSessionId === selected.id} onChange={(session, option, value) => { if (session) void changeModel(session, option, value); }} />{selected.status === "running" ? <Button size="icon-sm" variant="secondary" onClick={stopSession} aria-label={`Stop ${selected.agentName}`}><CircleStop /></Button> : <Button size="icon-sm" onClick={() => void sendMessage()} disabled={!draft.trim() || selected.status === "error" || loadingSessionId === selected.id} aria-label="Send message"><ArrowUp /></Button>}</div></div></div></div>
            </div>
            <TerminalPanel sessionId={selected.id} cwd={selected.cwd} open={terminalOpen} height={terminalHeight} onHeightChange={setTerminalHeight} onClose={() => setTerminalOpen(false)} />
          </div>
        </> : null}
      </section>
    </main>
  );
}

function SessionDetailsDialog({
  session,
  onSessionChanged,
}: {
  session: SessionSummary;
  onSessionChanged: (session: SessionSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [titleMode, setTitleMode] = useState<SessionSummary["titleMode"]>(
    session.titleMode,
  );
  const [customTitle, setCustomTitle] = useState(
    session.customTitle ?? session.agentTitle,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setTitleMode(session.titleMode);
      setCustomTitle(session.customTitle ?? session.agentTitle);
      setError(null);
    }
  }

  async function saveTitlePreference() {
    setSaving(true);
    setError(null);
    try {
      const updated = await window.myagents.sessions.updateTitle(
        session.id,
        titleMode,
        customTitle,
      );
      onSessionChanged(updated);
      setOpen(false);
    } catch (saveError) {
      setError(getError(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-label="Session details" />}>
        <Info />
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Session details</DialogTitle>
          <DialogDescription>
            View the ACP identifier and choose how MyAgents manages this session name.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 py-1">
          <div className="grid gap-2">
            <Label>ACP session ID</Label>
            <p className="break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
              {session.acpSessionId}
            </p>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Session name</legend>
            <label className={cn("flex cursor-pointer gap-3 rounded-lg border p-3", titleMode === "default" && "border-foreground/30 bg-muted/40")}>
              <input
                type="radio"
                name={`session-title-mode-${session.id}`}
                value="default"
                checked={titleMode === "default"}
                onChange={() => setTitleMode("default")}
                className="mt-0.5 size-4 accent-foreground"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">Default</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  Keep the name synchronized with the Agent.
                </span>
                <span className="mt-1 block break-words text-xs">{session.agentTitle}</span>
              </span>
            </label>
            <label className={cn("flex cursor-pointer gap-3 rounded-lg border p-3", titleMode === "custom" && "border-foreground/30 bg-muted/40")}>
              <input
                type="radio"
                name={`session-title-mode-${session.id}`}
                value="custom"
                checked={titleMode === "custom"}
                onChange={() => setTitleMode("custom")}
                className="mt-0.5 size-4 accent-foreground"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Custom</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  Use a MyAgents-only name that Agent synchronization cannot overwrite.
                </span>
                <Input
                  value={customTitle}
                  onChange={(event) => setCustomTitle(event.target.value)}
                  onFocus={() => setTitleMode("custom")}
                  disabled={titleMode !== "custom"}
                  maxLength={200}
                  className="mt-2"
                  aria-label="Custom session name"
                />
              </span>
            </label>
          </fieldset>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            type="button"
            onClick={() => void saveTitlePreference()}
            disabled={saving || (titleMode === "custom" && !customTitle.trim())}
          >
            {saving && <LoaderCircle className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [registryPage, setRegistryPage] = useState(0);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<
    string,
    { ok: boolean; message: string }
  >>({});
  const [codexCommand, setCodexCommand] = useState("codex");
  const [savingCodexCommand, setSavingCodexCommand] = useState(false);
  const [confirmingRemovalId, setConfirmingRemovalId] = useState<string | null>(
    null,
  );
  const registrySectionRef = useRef<HTMLElement>(null);

  function loadRegistry() {
    if (registry.length > 0 || registryLoading) return;
    setRegistryLoading(true);
    setRegistryError(null);
    void window.myagents.agents.registry()
      .then(setRegistry)
      .catch((error) => setRegistryError(getError(error)))
      .finally(() => setRegistryLoading(false));
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setCodexCommand(
        agents.find(({ id }) => id === "codex")?.displayCommand ?? "codex",
      );
      loadRegistry();
    }
  }

  const filteredRegistry = useMemo(() => {
    const query = registryQuery.trim().toLowerCase();
    return registry
      .filter(
        (agent) =>
          !query ||
          agent.name.toLowerCase().includes(query) ||
          agent.id.toLowerCase().includes(query) ||
          agent.description.toLowerCase().includes(query),
      );
  }, [registry, registryQuery]);
  const registryPageCount = Math.max(
    1,
    Math.ceil(filteredRegistry.length / REGISTRY_PAGE_SIZE),
  );
  const visibleRegistry = useMemo(
    () => filteredRegistry.slice(
      registryPage * REGISTRY_PAGE_SIZE,
      (registryPage + 1) * REGISTRY_PAGE_SIZE,
    ),
    [filteredRegistry, registryPage],
  );

  function changeRegistryPage(nextPage: number) {
    setRegistryPage(nextPage);
    requestAnimationFrame(() => {
      registrySectionRef.current?.scrollIntoView({ block: "start" });
    });
  }

  async function installAgent(registryId: string) {
    setInstallingId(registryId);
    setRegistryError(null);
    try {
      const nextAgents = await window.myagents.agents.install(registryId);
      onAgentsChanged(nextAgents);
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

  async function deleteAgent(id: string) {
    setRemovingId(id);
    setRegistryError(null);
    try {
      const nextAgents = await window.myagents.agents.remove(id);
      onAgentsChanged(nextAgents);
      setRegistry((current) =>
        current.map((agent) =>
          agent.id === id ? { ...agent, installed: false } : agent,
        ),
      );
      setConfirmingRemovalId(null);
    } catch (error) {
      setRegistryError(getError(error));
    } finally {
      setRemovingId(null);
    }
  }

  async function saveCodexCommand() {
    setSavingCodexCommand(true);
    setRegistryError(null);
    try {
      const nextAgents = await window.myagents.agents.configureCodex(codexCommand);
      onAgentsChanged(nextAgents);
      setCodexCommand(
        nextAgents.find(({ id }) => id === "codex")?.displayCommand ?? "codex",
      );
      setTestResults((current) => {
        const next = { ...current };
        delete next.codex;
        return next;
      });
    } catch (error) {
      setRegistryError(getError(error));
    } finally {
      setSavingCodexCommand(false);
    }
  }

  async function testAgent(id: string) {
    setTestingId(id);
    setTestResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const result = await window.myagents.agents.test(id);
      onAgentsChanged(result.agents);
      setTestResults((current) => ({
        ...current,
        [id]: { ok: true, message: result.message },
      }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [id]: { ok: false, message: getError(error) },
      }));
    } finally {
      setTestingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open settings" />}>
        <Settings />
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] overflow-hidden sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Tabs.Root defaultValue="agents" className="min-w-0">
          <Tabs.List aria-label="Settings sections" className="flex border-b">
            <Tabs.Tab value="agents" className="-mb-px border-b-2 border-transparent px-3 pb-2.5 pt-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:border-foreground data-active:text-foreground">
              Agents
            </Tabs.Tab>
            <Tabs.Tab value="appearance" className="-mb-px border-b-2 border-transparent px-3 pb-2.5 pt-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:border-foreground data-active:text-foreground">
              Appearance
            </Tabs.Tab>
            {window.myagents.telemetry && (
              <Tabs.Tab value="privacy" className="-mb-px border-b-2 border-transparent px-3 pb-2.5 pt-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:border-foreground data-active:text-foreground">
                Privacy
              </Tabs.Tab>
            )}
          </Tabs.List>

          <Tabs.Panel value="agents" className="outline-none">
            <ScrollArea className="max-h-[64vh] min-w-0 w-full overflow-x-hidden pr-4">
              <div className="space-y-6 py-5">
                <section>
                  <Label>Installed</Label>
                  <div className="mt-2 space-y-2">
                    {agents.length === 0 && (
                      <p className="rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                        No Agents added yet.
                      </p>
                    )}
                    {agents.map((agent) => {
                      const testResult = testResults[agent.id];
                      return (
                        <div key={agent.id} className="rounded-lg border px-3 py-2.5">
                          <div className="flex items-center gap-3">
                            <span className={cn("size-2 shrink-0 rounded-full", agent.available ? "bg-emerald-500" : "bg-destructive")} aria-label={agent.available ? "Available" : "Unavailable"} role="img" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-semibold">{agent.name}</p>
                              <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                                <p className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                                  {agent.displayCommand}
                                </p>
                                {agent.adapter ? (
                                  <Badge
                                    variant="outline"
                                    className="h-4 px-1.5 font-mono text-[9px] font-normal text-muted-foreground"
                                    aria-label={`Adapter: ${agent.adapter}`}
                                  >
                                    {agent.adapter}
                                  </Badge>
                                ) : null}
                              </div>
                            </div>
                            {agent.capabilities && <span className="text-[10px] text-muted-foreground">{agent.capabilities.loadSession ? "load" : agent.capabilities.resumeSession ? "resume" : "new only"}{agent.capabilities.listSessions ? " · list" : ""}</span>}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={testingId !== null || savingCodexCommand}
                              onClick={() => void testAgent(agent.id)}
                              aria-label={`Test ${agent.name}`}
                            >
                              {testingId === agent.id && <LoaderCircle className="animate-spin" />}
                              Test
                            </Button>
                            {confirmingRemovalId === agent.id ? (
                              <div
                                className="flex shrink-0 items-center gap-1"
                                role="group"
                                aria-label={`Confirm removing ${agent.name}`}
                              >
                                <span className="mr-1 text-[10px] text-muted-foreground">
                                  Remove?
                                </span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={removingId !== null}
                                  onClick={() => setConfirmingRemovalId(null)}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={removingId !== null}
                                  onClick={() => void deleteAgent(agent.id)}
                                >
                                  {removingId === agent.id && (
                                    <LoaderCircle className="animate-spin" />
                                  )}
                                  Remove
                                </Button>
                              </div>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={removingId !== null}
                                onClick={() => setConfirmingRemovalId(agent.id)}
                                aria-label={`Remove ${agent.name}`}
                              >
                                <Trash2 />
                              </Button>
                            )}
                          </div>
                          {agent.id === "codex" && (
                            <div className="mt-3 border-t pt-3">
                              <Label htmlFor="codex-command" className="text-[11px]">
                                Codex command
                              </Label>
                              <div className="mt-1.5 flex gap-2">
                                <Input
                                  id="codex-command"
                                  value={codexCommand}
                                  onChange={(event) => setCodexCommand(event.target.value)}
                                  placeholder="codex or /absolute/path/to/codex"
                                  className="h-8 font-mono text-xs"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={savingCodexCommand || !codexCommand.trim()}
                                  onClick={() => void saveCodexCommand()}
                                >
                                  {savingCodexCommand && <LoaderCircle className="animate-spin" />}
                                  Save
                                </Button>
                              </div>
                              <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                                MyAgents uses this user-installed Codex executable through codex-acp.
                              </p>
                            </div>
                          )}
                          {testResult && (
                            <p
                              role={testResult.ok ? "status" : "alert"}
                              className={cn(
                                "mt-2 text-[10px] leading-4",
                                testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                              )}
                            >
                              {testResult.message}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section ref={registrySectionRef}>
                  <Label>Official ACP Registry</Label>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    Install an Agent yourself first. MyAgents verifies its command and ACP handshake before adding it.
                  </p>
                  <div className="relative mt-2"><Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input value={registryQuery} onChange={(event) => { setRegistryQuery(event.target.value); setRegistryPage(0); }} placeholder="Search agents" className="pl-8" /></div>
                  {registryLoading ? <SidebarStatus icon={<LoaderCircle className="animate-spin" />} label="Loading registry" /> : <><div className="mt-2 space-y-1.5">{visibleRegistry.map((agent) => <div key={agent.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{agent.name} <span className="font-normal text-muted-foreground">{agent.version}</span></p><p className="truncate text-[10px] text-muted-foreground">{agent.description}</p></div><Button size="sm" variant="outline" disabled={agent.installed || installingId !== null} onClick={() => void installAgent(agent.id)}>{installingId === agent.id ? <LoaderCircle className="animate-spin" /> : agent.installed ? <Check /> : <Plus />}{agent.installed ? "Added" : installingId === agent.id ? "Verifying" : "Add"}</Button></div>)}</div>{visibleRegistry.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">No agents found.</p>}<div className="mt-3 flex items-center justify-between border-t pt-3"><p className="text-[10px] text-muted-foreground">{filteredRegistry.length} agents · Page {registryPage + 1} of {registryPageCount}</p><div className="flex items-center gap-1"><Button type="button" variant="outline" size="icon-xs" aria-label="Previous registry page" disabled={registryPage === 0} onClick={() => changeRegistryPage(Math.max(0, registryPage - 1))}><ChevronLeft /></Button><Button type="button" variant="outline" size="icon-xs" aria-label="Next registry page" disabled={registryPage + 1 >= registryPageCount} onClick={() => changeRegistryPage(Math.min(registryPageCount - 1, registryPage + 1))}><ChevronRight /></Button></div></div></>}
                </section>
                {registryError && <p role="alert" className="text-xs leading-5 text-destructive">{registryError}</p>}
              </div>
            </ScrollArea>
          </Tabs.Panel>

          <Tabs.Panel value="appearance" className="py-6 outline-none">
            <div className="space-y-7">
              <section>
                <h2 className="text-sm font-medium">Color theme</h2>
                <p className="mb-4 mt-1 text-xs text-muted-foreground">Choose how MyAgents looks on this device.</p>
                <ThemeSettings />
              </section>
              <section>
                <h2 className="text-sm font-medium">Font</h2>
                <p className="mb-4 mt-1 text-xs text-muted-foreground">Choose the interface font. Code and terminal text stay monospaced.</p>
                <FontSettings />
              </section>
            </div>
          </Tabs.Panel>
          {window.myagents.telemetry && (
            <Tabs.Panel value="privacy" className="py-6 outline-none">
              <TelemetrySettings api={window.myagents.telemetry} />
            </Tabs.Panel>
          )}
        </Tabs.Root>
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

function Message({ message, isStreaming }: { message: ChatMessage; isStreaming: boolean }) {
  const user = message.role === "user";
  if (user) {
    return <article className="ml-auto max-w-[85%] rounded-lg bg-muted px-2 py-2"><p className="select-text whitespace-pre-wrap break-words text-[12px] leading-[17px] text-foreground/90">{message.content}</p></article>;
  }

  return (
    <article>
      <Streamdown
        className="select-text break-words text-[12px] leading-[17px] text-foreground/90"
        components={streamdownComponents}
        isAnimating={isStreaming}
        linkSafety={streamdownLinkSafety}
        mode={isStreaming ? "streaming" : "static"}
        plugins={streamdownPlugins}
      >
        {message.content}
      </Streamdown>
    </article>
  );
}

function ExternalLinkSafetyModal({
  isOpen,
  onClose,
  onConfirm,
  url,
}: LinkSafetyModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open external link?</DialogTitle>
          <DialogDescription>
            You&apos;re about to visit an external website.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-32 overflow-y-auto break-all rounded-lg bg-muted p-3 font-mono text-xs">
          {url}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Open link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentIcon({ session }: { session: SessionSummary }) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconUrl = failedIconUrl === session.agentIconUrl
    ? undefined
    : session.agentIconUrl;

  return (
    <span
      role="img"
      aria-label={session.agentName}
      title={session.agentName}
      className="flex size-4 shrink-0 items-center justify-center text-foreground"
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          width={16}
          height={16}
          className="size-3.5 dark:invert"
          onError={() => setFailedIconUrl(iconUrl)}
        />
      ) : (
        <Bot className="size-3.5" aria-hidden="true" />
      )}
    </span>
  );
}

type ConversationRenderItem =
  | Extract<ConversationItem, { type: "message" | "permission" }>
  | { type: "tools"; key: string; activities: ToolActivity[] };

function groupConversationItems(
  conversation: ConversationItem[],
): ConversationRenderItem[] {
  const items: ConversationRenderItem[] = [];
  for (const item of conversation) {
    if (item.type !== "tool") {
      items.push(item);
      continue;
    }
    const previous = items.at(-1);
    if (previous?.type === "tools") {
      previous.activities.push(item.activity);
    } else {
      items.push({
        type: "tools",
        key: `tools-${item.activity.id}`,
        activities: [item.activity],
      });
    }
  }
  return items;
}

function ConversationTimeline({
  session,
  onResolvePermission,
}: {
  session: SessionSummary;
  onResolvePermission: (
    permission: PermissionRequest,
    optionId?: string,
  ) => Promise<void>;
}) {
  const items = groupConversationItems(session.conversation);
  const lastMessage = session.messages.at(-1);

  return items.map((item) => {
    if (item.type === "message") {
      return (
        <Message
          key={`message-${item.message.id}`}
          message={item.message}
          isStreaming={
            session.status === "running" &&
            item.message.role === "assistant" &&
            item.message.id === lastMessage?.id
          }
        />
      );
    }
    if (item.type === "permission") {
      return (
        <Permission
          key={`permission-${item.permission.id}`}
          permission={item.permission}
          onResolve={onResolvePermission}
        />
      );
    }
    return <ActivityGroup key={item.key} activities={item.activities} />;
  });
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
