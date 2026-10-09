import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import {
  Activity, AlertCircle, BookOpen, Bot as BotIcon, Brain, Check, ChevronDown, Clock3, Compass,
  Download, Eye, FileText, GitBranch, History, Image as ImageIcon, KeyRound, LogOut, Maximize2, Menu,
  MessageSquare, Monitor, Pencil, Plus, Send, Settings2, Square, TerminalSquare, Trash2, X,
} from "lucide-react";
import type { Artifact, Bot, Conversation, HandoffLink, Memory, Message, ModelProfile, Run, ShellCommand,
  Skill, SkillDefinition, SkillVersion, ToolCapability } from "@opengrok/contracts";
import type { Routine, RoutineOccurrence } from "@opengrok/contracts";
import { api, json, type BotResponse, type ConversationResponse, type SubmitResponse } from "./client";
import Desktop from "./Desktop";
import RoutinePane from "./Routines";
import ModelProfileForm, { SavedModelTest } from "./ModelProfileForm";
import Onboarding from "./Onboarding";

type Phase = "loading" | "setup" | "login" | "ready";
type Pane = "computer" | "artifacts" | "memories" | "skills" | "routines" | "approvals" | "activity";
type Approval = {
  id: string; runId: string; toolName: string; target: string;
  args: Record<string, unknown>; expiresAt: string; status: string;
  previewArtifactId: string | null; previewWidth: number | null; previewHeight: number | null;
};
type PendingEffect = { operationId: string; name: string; args: Record<string, unknown>; status: string };
type PartialOutput = { status: "started" | "interrupted" | null; text: string };

const paneItems: Array<{ id: Pane; label: string; icon: typeof Monitor }> = [
  { id: "computer", label: "电脑", icon: Monitor },
  { id: "artifacts", label: "成果", icon: FileText },
  { id: "memories", label: "记忆", icon: Brain },
  { id: "skills", label: "技能", icon: BookOpen },
  { id: "routines", label: "例程", icon: Clock3 },
  { id: "approvals", label: "审批", icon: Check },
  { id: "activity", label: "活动", icon: Activity },
];
const capabilityItems: Array<{ id: ToolCapability; label: string }> = [
  { id: "public_web", label: "网页浏览" },
  { id: "workspace", label: "工作文件" },
  { id: "artifact", label: "成果发布" },
  { id: "memory", label: "长期记忆" },
  { id: "shell", label: "终端（逐次审批）" },
  { id: "desktop", label: "桌面画面与键鼠（逐次审批）" },
  { id: "delegate", label: "委派给其他 Bot" },
  { id: "github_issues", label: "GitHub Issues（逐次审批）" },
];
const initialBotCapabilities: ToolCapability[] = ["public_web", "workspace", "artifact", "memory"];

function shellStatus(item: ShellCommand) {
  if (item.result?.stoppedByUser) return "已停止";
  if (item.status === "dispatching" || item.status === "unknown") {
    return item.stopRequestedAt ? "停止请求已发出" : item.status === "unknown" ? "回执待核对" : "派发中";
  }
  if (item.result?.timedOut) return "已超时";
  return ({ proposed: "待校验", waiting_approval: "等待审批", authorized: "已批准",
    succeeded: "已完成", failed: "失败" } as Record<string, string>)[item.status] || item.status;
}

function CapabilityControls({ value, onChange, legend = "工具能力", githubConnector }: {
  value: ToolCapability[]; onChange: (next: ToolCapability[]) => void; legend?: string;
  githubConnector?: { configured: boolean; repository: string | null };
}) {
  return <fieldset className="capability-options"><legend>{legend}</legend>
    {capabilityItems.map(item => <label key={item.id}>
      <input type="checkbox" checked={value.includes(item.id)}
        disabled={item.id === "github_issues" && githubConnector?.configured === false && !value.includes(item.id)}
        onChange={event => onChange(event.target.checked
        ? [...value, item.id] : value.filter(capability => capability !== item.id))} />
      <span>{item.id === "github_issues" && githubConnector
        ? githubConnector.configured ? `GitHub Issues（${githubConnector.repository}，逐次审批）` : "GitHub Issues（未配置）"
        : item.label}</span>
    </label>)}
  </fieldset>;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function runLabel(status: Run["status"]) {
  const labels: Record<Run["status"], string> = {
    queued: "排队中", running: "工作中", waiting_approval: "等待审批",
    waiting_user: "等待你", waiting_computer: "等待电脑", reconciling: "核对中",
    verifying: "验证成果", canceling: "正在停止", succeeded: "已完成",
    failed: "失败", canceled: "已取消",
  };
  return labels[status];
}

function AuthScreen({ phase, setupTokenRequired, onReady }: {
  phase: "setup" | "login"; setupTokenRequired: boolean; onReady: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api(phase === "setup" ? "/setup" : "/login", json("POST", {
        username, password, ...(phase === "setup" && setupTokenRequired ? { setupToken } : {}),
      }));
      onReady();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <main className="auth-screen">
    <div className="auth-brand"><span className="brand-mark"><BotIcon size={20} /></span><span>OpenGrok Bot</span></div>
    <form className="auth-form" onSubmit={submit}>
      <h1>{phase === "setup" ? "创建你的工作空间" : "欢迎回来"}</h1>
      <label>用户名<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} minLength={2} required autoFocus /></label>
      <label>密码<input type="password" autoComplete={phase === "setup" ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} minLength={phase === "setup" ? 12 : 1} required /></label>
      {phase === "setup" && setupTokenRequired && <label>初始化口令<input type="password" autoComplete="off"
        value={setupToken} onChange={event => setSetupToken(event.target.value)} maxLength={500} required /></label>}
      {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
      <button className="primary-button" disabled={busy}>{busy ? "请稍候" : phase === "setup" ? "创建空间" : "登录"}</button>
    </form>
  </main>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={event => event.stopPropagation()}>
      <div className="modal-heading"><h2>{title}</h2><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div>
      {children}
    </div>
  </div>;
}

function PasswordModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmation) { setError("两次输入的新密码不一致"); return; }
    setSaving(true); setError("");
    try {
      await api("/account/password", json("POST", { currentPassword, newPassword }));
      onChanged();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  return <Modal title="修改密码" onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      <label>当前密码<input type="password" autoComplete="current-password" value={currentPassword}
        onChange={event => setCurrentPassword(event.target.value)} required autoFocus /></label>
      <label>新密码<input type="password" autoComplete="new-password" minLength={12} maxLength={500}
        value={newPassword} onChange={event => setNewPassword(event.target.value)} required /></label>
      <label>确认新密码<input type="password" autoComplete="new-password" minLength={12} maxLength={500}
        value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></label>
      {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
      <button className="primary-button" disabled={saving}>{saving ? "保存中" : "更新密码"}</button>
    </form>
  </Modal>;
}

function SettingsModal({ bot, profiles, githubConnector, onClose, onSaved, onProfile }: {
  bot: Bot; profiles: ModelProfile[]; onClose: () => void;
  onSaved: (bot: Bot) => void; onProfile: (profile: ModelProfile) => void;
  githubConnector: { configured: boolean; repository: string | null };
}) {
  const [tab, setTab] = useState<"bot" | "model">("bot");
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [profileId, setProfileId] = useState(bot.modelProfileId || "");
  const [capabilities, setCapabilities] = useState<ToolCapability[]>(bot.capabilities);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveBot(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const result = await api<BotResponse>(`/bots/${bot.id}`, json("PATCH", {
        name, description, instructions, modelProfileId: profileId || null, capabilities,
        expectedRevision: bot.revision,
      }));
      onSaved(result.bot); onClose();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  return <Modal title="Bot 设置" onClose={onClose}>
    <div className="modal-tabs"><button className={tab === "bot" ? "active" : ""} onClick={() => setTab("bot")}>Bot</button><button className={tab === "model" ? "active" : ""} onClick={() => setTab("model")}>模型配置</button></div>
    {tab === "bot" ? <form className="form-stack" onSubmit={saveBot}>
      <label>名称<input value={name} onChange={event => setName(event.target.value)} maxLength={48} required /></label>
      <label>职责<input value={description} onChange={event => setDescription(event.target.value)} maxLength={300} /></label>
      <label>工作指令<textarea value={instructions} onChange={event => setInstructions(event.target.value)} rows={5} maxLength={8000} /></label>
      <label>模型<select value={profileId} onChange={event => setProfileId(event.target.value)}>
        <option value="">尚未选择</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.modelId}</option>)}
      </select></label>
      {profileId && <SavedModelTest key={profileId} profileId={profileId} />}
      <CapabilityControls value={capabilities} onChange={setCapabilities} githubConnector={githubConnector} />
      <button type="button" className="text-button" onClick={() => setTab("model")}><Plus size={15} /> 添加模型配置</button>
      {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
      <button className="primary-button" disabled={saving}>{saving ? "保存中" : "保存 Bot"}</button>
    </form> : <ModelProfileForm onSaved={profile => {
      onProfile(profile); setProfileId(profile.id); setTab("bot");
    }} />}
  </Modal>;
}

function HandoffModal({ parentRun, bots, artifacts, onClose, onCreated }: {
  parentRun: Run; bots: Bot[]; artifacts: Artifact[]; onClose: () => void;
  onCreated: (link: HandoffLink) => Promise<void>;
}) {
  const targets = bots.filter(item => item.id !== parentRun.botId && item.modelProfileId);
  const availableArtifacts = artifacts.filter(item => item.mimeType === "text/markdown; charset=utf-8");
  const [targetBotId, setTargetBotId] = useState(targets[0]?.id || "");
  const [task, setTask] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [deliverable, setDeliverable] = useState<"answer" | "report">("answer");
  const [artifactIds, setArtifactIds] = useState<string[]>([]);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const target = targets.find(item => item.id === targetBotId);
  const canReport = Boolean(target?.capabilities.includes("public_web") &&
    target.capabilities.includes("artifact"));

  function changeInput(update: () => void) {
    update(); setRequestId(crypto.randomUUID()); setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!targetBotId || !task.trim() || !acceptance.trim() || saving) return;
    setSaving(true); setError("");
    try {
      const result = await api<{ run: Run }>(`/runs/${parentRun.id}/handoffs`, json("POST", {
        requestId, targetBotId, task: task.trim(), acceptance: acceptance.trim(),
        deliverable, artifactIds,
      }));
      const links = await api<{ children: HandoffLink[] }>(`/runs/${parentRun.id}/handoffs`);
      const child = links.children.find(item => item.id === result.run.id);
      if (!child) throw new Error("交接已创建，但暂时无法读取子任务链接");
      await onCreated(child);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  return <Modal title="交接给其他 Bot" onClose={onClose}>
    <form className="form-stack handoff-form" onSubmit={submit}>
      <label>目标 Bot<select value={targetBotId} onChange={event => changeInput(() => {
        setTargetBotId(event.target.value); setDeliverable("answer"); setArtifactIds([]);
      })} required>
        {targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>任务<textarea value={task} onChange={event => changeInput(() => setTask(event.target.value))}
        rows={4} maxLength={4000} required /></label>
      <label>验收标准<textarea value={acceptance} onChange={event => changeInput(() => setAcceptance(event.target.value))}
        rows={3} maxLength={2000} required /></label>
      <fieldset className="handoff-fieldset"><legend>交付形式</legend><div className="segmented">
        <button type="button" className={deliverable === "answer" ? "active" : ""}
          onClick={() => changeInput(() => setDeliverable("answer"))}>对话</button>
        <button type="button" className={deliverable === "report" ? "active" : ""}
          disabled={!canReport} title={!canReport ? "目标 Bot 需要网页浏览和成果发布能力" : undefined}
          onClick={() => changeInput(() => setDeliverable("report"))}>报告</button>
      </div></fieldset>
      {!!availableArtifacts.length && <fieldset className="handoff-fieldset"><legend>引用本次任务成果（最多 3 份）</legend>
        {availableArtifacts.map(item => <label className="handoff-artifact" key={item.id}>
          <input type="checkbox" checked={artifactIds.includes(item.id)}
            disabled={!target?.capabilities.includes("artifact") ||
              artifactIds.length >= 3 && !artifactIds.includes(item.id)}
            onChange={event => changeInput(() => setArtifactIds(current => event.target.checked
              ? [...current, item.id] : current.filter(id => id !== item.id)))} />
          <span>{item.title}</span>
        </label>)}
      </fieldset>}
      {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
      <button className="primary-button" disabled={saving || !targetBotId || !task.trim() || !acceptance.trim()}>
        {saving ? "交接中" : "创建子任务"}
      </button>
    </form>
  </Modal>;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [setupTokenRequired, setSetupTokenRequired] = useState(false);
  const [username, setUsername] = useState("");
  const [bots, setBots] = useState<Bot[]>([]);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [previewArtifact, setPreviewArtifact] = useState<Artifact | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [githubConnector, setGithubConnector] = useState<{ configured: boolean; repository: string | null }>({
    configured: false, repository: null,
  });
  const [pendingEffects, setPendingEffects] = useState<PendingEffect[]>([]);
  const [shellCommands, setShellCommands] = useState<ShellCommand[]>([]);
  const [runSkills, setRunSkills] = useState<SkillVersion[]>([]);
  const [handoffs, setHandoffs] = useState<{ parent: HandoffLink | null; children: HandoffLink[] }>({
    parent: null, children: [],
  });
  const [partialOutput, setPartialOutput] = useState<PartialOutput>({ status: null, text: "" });
  const [pane, setPane] = useState<Pane>("computer");
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [composer, setComposer] = useState("");
  const [deliverable, setDeliverable] = useState<"answer" | "report">("answer");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");

  const selectedBot = bots.find(item => item.id === selectedBotId) || null;
  const canReport = Boolean(selectedBot?.capabilities.includes("public_web") &&
    selectedBot.capabilities.includes("artifact"));
  const selectedRun = runs.find(item => item.id === selectedRunId) || null;
  const selectedProfile = profiles.find(item => item.id === selectedBot?.modelProfileId);

  useEffect(() => { if (!canReport) setDeliverable("answer"); }, [canReport]);

  const loadWorkspace = useCallback(async () => {
    const [botResponse, profileResponse, connectorResponse] = await Promise.all([
      api<{ bots: Bot[] }>("/bots"), api<{ profiles: ModelProfile[] }>("/model-profiles"),
      api<{ configured: boolean; repository: string | null }>("/connectors/github"),
    ]);
    setBots(botResponse.bots); setProfiles(profileResponse.profiles); setGithubConnector(connectorResponse);
    setOnboardingOpen(!botResponse.bots.some(bot => bot.modelProfileId));
    setSelectedBotId(current => botResponse.bots.some(item => item.id === current) ? current : botResponse.bots[0]?.id || null);
  }, []);

  const initialize = useCallback(async () => {
    try {
      const bootstrap = await api<{ initialized: boolean; setupTokenRequired: boolean }>("/bootstrap");
      setSetupTokenRequired(bootstrap.setupTokenRequired);
      if (!bootstrap.initialized) { setPhase("setup"); return; }
      const session = await api<{ user: { username: string } }>("/session");
      setUsername(session.user.username);
      await loadWorkspace();
      setPhase("ready");
    } catch (cause) {
      if ((cause as { status?: number }).status === 401) setPhase("login");
      else { setPhase("login"); setToast((cause as Error).message); }
    }
  }, [loadWorkspace]);

  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    if (phase !== "ready" || !selectedBotId) return;
    let live = true;
    api<{ conversations: Conversation[] }>(`/bots/${selectedBotId}/conversations`)
      .then(result => {
        if (!live) return;
        setConversations(result.conversations);
        setSelectedConversationId(current => result.conversations.some(item => item.id === current) ? current : result.conversations[0]?.id || null);
      }).catch(cause => { if (live) setToast((cause as Error).message); });
    return () => { live = false; };
  }, [phase, selectedBotId]);

  const refreshConversation = useCallback(async (conversationId: string) => {
    const [messageResponse, runResponse] = await Promise.all([
      api<{ messages: Message[] }>(`/conversations/${conversationId}/messages`),
      api<{ runs: Run[] }>(`/conversations/${conversationId}/runs`),
    ]);
    setMessages(messageResponse.messages); setRuns(runResponse.runs);
    setSelectedRunId(current => runResponse.runs.some(item => item.id === current)
      ? current : runResponse.runs.at(-1)?.id || null);
  }, []);

  useEffect(() => {
    if (!selectedConversationId) { setMessages([]); setRuns([]); setSelectedRunId(null); return; }
    void refreshConversation(selectedConversationId).catch(cause => setToast((cause as Error).message));
  }, [selectedConversationId, refreshConversation]);

  useEffect(() => {
    setPreviewArtifact(null); setPreviewText(""); setPreviewError("");
    if (!selectedRunId) { setArtifacts([]); return; }
    api<{ artifacts: Artifact[] }>(`/runs/${selectedRunId}/artifacts`)
      .then(result => setArtifacts(result.artifacts)).catch(cause => setToast((cause as Error).message));
  }, [selectedRunId, selectedRun?.status]);

  async function openArtifact(item: Artifact) {
    setPreviewArtifact(item); setPreviewText(""); setPreviewError("");
    if (item.mimeType === "image/png") return;
    try {
      const response = await fetch(`/api/artifacts/${item.id}/content`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`打开成果失败 (${response.status})`);
      setPreviewText(await response.text());
    } catch (cause) { setPreviewError((cause as Error).message); }
  }

  useEffect(() => {
    if (!selectedBotId) return;
    api<{ memories: Memory[] }>(`/bots/${selectedBotId}/memories`)
      .then(result => setMemories(result.memories)).catch(cause => setToast((cause as Error).message));
  }, [selectedBotId, pane]);

  useEffect(() => {
    if (phase !== "ready") return;
    let live = true;
    const refresh = () => {
      void api<{ approvals: Approval[] }>("/approvals")
        .then(result => { if (live) setApprovals(result.approvals); })
        .catch(cause => { if (live && pane === "approvals") setToast((cause as Error).message); });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [phase, pane]);

  useEffect(() => {
    if (!selectedRunId || selectedRun?.status !== "reconciling") { setPendingEffects([]); return; }
    api<{ effects: PendingEffect[] }>(`/runs/${selectedRunId}/pending-effects`)
      .then(result => setPendingEffects(result.effects)).catch(cause => setToast((cause as Error).message));
  }, [selectedRunId, selectedRun?.status]);

  const refreshShellCommands = useCallback(async (runId: string) => {
    const result = await api<{ commands: ShellCommand[] }>(`/runs/${runId}/shell-commands`);
    setShellCommands(result.commands);
  }, []);

  useEffect(() => {
    if (!selectedRunId) { setShellCommands([]); return; }
    void refreshShellCommands(selectedRunId).catch(cause => setToast((cause as Error).message));
  }, [selectedRunId, selectedRun?.status, refreshShellCommands]);

  useEffect(() => {
    if (!selectedRunId) { setRunSkills([]); return; }
    let live = true;
    api<{ versions: SkillVersion[] }>(`/runs/${selectedRunId}/skills`)
      .then(result => { if (live) setRunSkills(result.versions); })
      .catch(cause => { if (live) setToast((cause as Error).message); });
    return () => { live = false; };
  }, [selectedRunId]);

  const refreshHandoffs = useCallback(async (runId: string) => {
    const links = await api<{ parent: HandoffLink | null; children: HandoffLink[] }>(
      `/runs/${runId}/handoffs`);
    setHandoffs(links);
  }, []);

  useEffect(() => {
    if (!selectedRunId) { setHandoffs({ parent: null, children: [] }); return; }
    let live = true;
    const refresh = () => {
      void api<{ parent: HandoffLink | null; children: HandoffLink[] }>(
        `/runs/${selectedRunId}/handoffs`)
        .then(links => { if (live) setHandoffs(links); })
        .catch(cause => { if (live && pane === "activity") setToast((cause as Error).message); });
    };
    setHandoffs({ parent: null, children: [] });
    refresh();
    const timer = pane === "activity" ? window.setInterval(refresh, 5000) : undefined;
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [selectedRunId, pane]);

  useEffect(() => {
    let live = true;
    setPartialOutput({ status: null, text: "" });
    if (!selectedRunId) return;
    api<PartialOutput>(`/runs/${selectedRunId}/partial`)
      .then(result => { if (live) setPartialOutput(result); })
      .catch(cause => { if (live) setToast((cause as Error).message); });
    return () => { live = false; };
  }, [selectedRunId, selectedRun?.status]);

  useEffect(() => {
    if (!selectedRunId || !selectedConversationId) return;
    let live = true;
    const stream = new EventSource(`/api/runs/${selectedRunId}/events`);
    stream.onmessage = () => {
      void refreshConversation(selectedConversationId);
      void refreshShellCommands(selectedRunId);
      void api<{ artifacts: Artifact[] }>(`/runs/${selectedRunId}/artifacts`).then(result => setArtifacts(result.artifacts));
      void api<PartialOutput>(`/runs/${selectedRunId}/partial`)
        .then(result => { if (live) setPartialOutput(result); });
    };
    return () => { live = false; stream.close(); };
  }, [selectedRunId, selectedConversationId, refreshConversation, refreshShellCommands]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function createNewConversation() {
    if (!selectedBotId) return;
    try {
      const result = await api<ConversationResponse>(`/bots/${selectedBotId}/conversations`, json("POST", {}));
      setConversations(current => [result.conversation, ...current]);
      setSelectedConversationId(result.conversation.id);
      setSidebarOpen(false); setMobileView("chat");
    } catch (cause) { setToast((cause as Error).message); }
  }

  async function sendMessage(input = composer, format = deliverable): Promise<boolean> {
    if (!selectedBot || !selectedBot.modelProfileId || !input.trim() || sending ||
      format === "report" && !canReport) return false;
    const text = input.trim();
    setSending(true);
    try {
      let conversationId = selectedConversationId;
      if (!conversationId) {
        const result = await api<ConversationResponse>(`/bots/${selectedBot.id}/conversations`, json("POST", {}));
        conversationId = result.conversation.id;
        setConversations(current => [result.conversation, ...current]);
        setSelectedConversationId(conversationId);
      }
      const response = await api<SubmitResponse>(`/conversations/${conversationId}/messages`, json("POST", {
        text, requestId: crypto.randomUUID(), deliverable: format,
      }));
      setComposer(""); setSelectedRunId(response.run.id);
      await refreshConversation(conversationId);
      setSelectedRunId(response.run.id);
      return true;
    } catch (cause) { setToast((cause as Error).message); return false; }
    finally { setSending(false); }
  }

  async function stopRun() {
    if (!selectedRun) return;
    try {
      await api(`/runs/${selectedRun.id}/cancel`, json("POST", {}));
      if (selectedConversationId) await refreshConversation(selectedConversationId);
    } catch (cause) { setToast((cause as Error).message); }
  }

  async function stopShellCommand(item: ShellCommand) {
    if (!selectedRunId || !window.confirm("请求停止这条终端命令？已经发生的外部操作仍会保留在记录中。")) return;
    try {
      await api(`/runs/${selectedRunId}/shell-commands/${item.operationId}/stop`, json("POST", {}));
      await refreshShellCommands(selectedRunId);
    } catch (cause) { setToast((cause as Error).message); }
  }

  async function addMemory(kind: "preference" | "fact", content: string) {
    if (!selectedBotId) return;
    try {
      await api(`/bots/${selectedBotId}/memories`, json("POST", { kind, content }));
      const result = await api<{ memories: Memory[] }>(`/bots/${selectedBotId}/memories`);
      setMemories(result.memories);
    } catch (cause) { setToast((cause as Error).message); }
  }

  async function removeMemory(item: Memory) {
    try {
      await api(`/bots/${item.botId}/memories/${item.id}`, json("DELETE", { expectedRevision: item.revision }));
      setMemories(current => current.filter(entry => entry.id !== item.id));
    } catch (cause) { setToast((cause as Error).message); }
  }

  async function decideApproval(item: Approval, decision: "approve" | "reject") {
    try {
      await api(`/approvals/${item.id}/decision`, json("POST", { decision }));
      const result = await api<{ approvals: Approval[] }>("/approvals");
      setApprovals(result.approvals);
      if (selectedConversationId) await refreshConversation(selectedConversationId);
    } catch (cause) { setToast((cause as Error).message); }
  }

  async function closeUnknownRun() {
    if (!selectedRunId || !window.confirm("电脑操作结果仍未知。确认停止此任务，并在历史中保留未核对记录？")) return;
    try {
      await api(`/runs/${selectedRunId}/close-unknown`, json("POST", { acknowledge: true }));
      if (selectedConversationId) await refreshConversation(selectedConversationId);
    } catch (cause) { setToast((cause as Error).message); }
  }

  async function signOut() {
    try { await api("/logout", json("POST", {})); setPhase("login"); }
    catch (cause) { setToast((cause as Error).message); }
  }

  async function openRoutineOccurrence(routine: Routine, occurrence: RoutineOccurrence) {
    try {
      const response = await api<{ conversations: Conversation[] }>(`/bots/${routine.botId}/conversations`);
      setSelectedBotId(routine.botId);
      setConversations(response.conversations);
      setSelectedConversationId(occurrence.conversationId);
      setSelectedRunId(occurrence.runId);
      setMobileView("chat");
    } catch (cause) { setToast((cause as Error).message); }
  }

  async function openHandoffRun(link: HandoffLink) {
    try {
      const response = await api<{ conversations: Conversation[] }>(`/bots/${link.botId}/conversations`);
      setSelectedBotId(link.botId);
      setConversations(response.conversations);
      setSelectedConversationId(link.conversationId);
      await refreshConversation(link.conversationId);
      setSelectedRunId(link.id);
      setPane("activity"); setMobileView("chat"); setSidebarOpen(false);
    } catch (cause) { setToast((cause as Error).message); }
  }

  const active = selectedRun && !["succeeded", "failed", "canceled"].includes(selectedRun.status);
  const groupedMessages = useMemo(() => messages, [messages]);

  if (phase === "loading") return <div className="boot-screen"><BotIcon size={24} /> OpenGrok Bot</div>;
  if (phase === "setup" || phase === "login") return <AuthScreen phase={phase}
    setupTokenRequired={setupTokenRequired} onReady={() => void initialize()} />;

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div className="sidebar-brand"><span className="brand-mark"><BotIcon size={19} /></span><strong>OpenGrok Bot</strong><button className="icon-button mobile-close" title="关闭导航" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
      <div className="sidebar-section-title"><span>Bots</span><button className="icon-button" title="新建 Bot" onClick={() => setNewBotOpen(true)}><Plus size={17} /></button></div>
      <nav className="bot-list" aria-label="Bot 列表">
        {bots.map(item => <button key={item.id} className={`bot-row ${selectedBotId === item.id ? "selected" : ""}`} onClick={() => { setSelectedBotId(item.id); setSelectedConversationId(null); setSidebarOpen(false); }}>
          <span className="bot-avatar"><BotIcon size={18} /></span><span className="bot-row-text"><strong>{item.name}</strong><small>{item.description || "个人 Bot"}</small></span>
        </button>)}
      </nav>
      <div className="sidebar-divider" />
      <div className="sidebar-section-title"><span>对话</span><button className="icon-button" title="新建对话" onClick={() => void createNewConversation()} disabled={!selectedBotId}><Plus size={17} /></button></div>
      <nav className="conversation-list" aria-label="对话列表">
        {conversations.map(item => <button key={item.id} className={`conversation-row ${selectedConversationId === item.id ? "selected" : ""}`} onClick={() => { setSelectedConversationId(item.id); setSidebarOpen(false); setMobileView("chat"); }}>
          <MessageSquare size={16} /><span>{item.title}</span>
        </button>)}
      </nav>
      <div className="sidebar-footer"><span>{username}</span><div className="sidebar-footer-actions">
        <button className="icon-button" title="使用向导" onClick={() => {
          setOnboardingOpen(true); setSidebarOpen(false); setMobileView("chat");
        }}><Compass size={17} /></button>
        <button className="icon-button" title="修改密码" onClick={() => setPasswordOpen(true)}><KeyRound size={17} /></button>
        <button className="icon-button" title="退出登录" onClick={() => void signOut()}><LogOut size={17} /></button>
      </div></div>
    </aside>
    {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}

    <main className={`chat-column ${mobileView !== "chat" ? "mobile-hidden" : ""}`}>
      <header className="chat-header"><button className="icon-button mobile-menu" title="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
        <div className="chat-title"><strong>{selectedBot?.name || "选择 Bot"}</strong><small>{selectedProfile ? selectedProfile.modelId : "尚未配置模型"}</small></div>
        <div className="header-actions">{active && <span className={`run-chip ${selectedRun?.status || ""}`}><span className="status-dot online" />{runLabel(selectedRun!.status)}</span>}
          <button className="icon-button" title="Bot 设置" disabled={!selectedBot} onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button>
          <button className="workspace-toggle" onClick={() => setMobileView("workspace")}>工作区 <ChevronDown size={15} /></button>
        </div>
      </header>

      <div className="message-scroll" key={onboardingOpen ? "onboarding" : selectedConversationId || "empty"}>
        {onboardingOpen ? <Onboarding bots={bots} profiles={profiles} bot={selectedBot}
          onProfile={profile => setProfiles(current => [profile, ...current])}
          onBot={bot => { setBots(current => [bot, ...current.filter(item => item.id !== bot.id)]); setSelectedBotId(bot.id); setSelectedConversationId(null); }}
          onChooseBot={id => { setSelectedBotId(id); setSelectedConversationId(null); }}
          onReport={async text => {
            const submitted = await sendMessage(text, "report");
            if (submitted) setPane("artifacts");
            return submitted;
          }}
          onComputer={() => { setPane("computer"); setMobileView("workspace"); }}
          onClose={() => setOnboardingOpen(false)} /> : <>
        {!selectedConversationId && <div className="chat-empty"><span className="large-bot-mark"><BotIcon size={31} /></span><h1>{selectedBot?.name || "OpenGrok Bot"}</h1><p>{selectedBot?.description || "创建一个 Bot 后开始工作"}</p></div>}
        {selectedConversationId && groupedMessages.length === 0 && <div className="chat-empty"><span className="large-bot-mark"><MessageSquare size={29} /></span><h1>新对话</h1><p>{selectedBot?.description}</p></div>}
        {groupedMessages.map(item => <div className={`message ${item.role}`} key={item.id}>
          {item.role === "assistant" && <span className="message-avatar"><BotIcon size={16} /></span>}
          <div className="message-body"><div className="message-content">{item.role === "assistant" ? <ReactMarkdown components={{ a: props => <a {...props} target="_blank" rel="noreferrer noopener" /> }}>{item.content}</ReactMarkdown> : item.content}</div><time>{dateLabel(item.createdAt)}</time></div>
        </div>)}
        {!!partialOutput.text && selectedRun?.status !== "succeeded" && <div className="message assistant"><span className="message-avatar"><BotIcon size={16} /></span><div className="message-body"><div className="message-content">{partialOutput.text}</div><small className="partial-status">{partialOutput.status === "interrupted" ? "未完成输出" : "生成中"}</small></div></div>}
        {active && <div className="activity-inline"><span className="spinner" /><span>{runLabel(selectedRun!.status)}</span>{selectedRun && !["canceling", "reconciling"].includes(selectedRun.status) && <button className="quiet-button" onClick={() => void stopRun()}><Square size={13} />停止</button>}</div>}
        {selectedRun?.status === "reconciling" && <div className="run-unknown"><strong>未核对的电脑操作</strong>{pendingEffects.map(item => <div key={item.operationId}><span>{item.name}</span><small>{String(item.args.url || item.args.command || item.args.ref || "")}</small><code>{item.operationId.slice(0, 8)}</code></div>)}<button className="secondary-button" onClick={() => void closeUnknownRun()}>保留未知结果并结束</button></div>}
        {selectedRun?.status === "failed" && <div className="run-error"><AlertCircle size={16} /><span>{selectedRun.error || "任务失败"}</span></div>}
        {selectedRun?.unresolvedEffects.length ? <div className="run-warning"><AlertCircle size={16} />执行已停止，{selectedRun.unresolvedEffects.length} 项外部结果待核对</div> : null}
        </>}
      </div>

      {!onboardingOpen && <div className="composer-area">
        {!selectedBot?.modelProfileId && <button className="model-hint" onClick={() => setSettingsOpen(true)}><AlertCircle size={15} />选择模型后开始任务</button>}
        <div className="composer-box"><textarea aria-label="发送消息" placeholder="给 Bot 一项任务" rows={2} value={composer} onChange={event => setComposer(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} />
          <div className="composer-toolbar"><div className="segmented" aria-label="交付形式"><button className={deliverable === "answer" ? "active" : ""} onClick={() => setDeliverable("answer")}>对话</button><button className={deliverable === "report" ? "active" : ""} onClick={() => setDeliverable("report")} disabled={!canReport} title={!canReport ? "需要网页浏览和成果发布能力" : undefined}>报告</button></div>
            <button className="send-button" title="发送任务" disabled={!composer.trim() || !selectedBot?.modelProfileId || sending} onClick={() => void sendMessage()}><Send size={17} /></button>
          </div>
        </div>
      </div>}
    </main>

    <section className={`workspace-column ${mobileView !== "workspace" ? "mobile-hidden" : ""}`}>
      <div className="workspace-header"><button className="workspace-back" onClick={() => setMobileView("chat")}>返回聊天</button><strong>工作区</strong></div>
      <div className="pane-tabs" role="tablist" aria-label="工作区视图">
        {paneItems.map(item => <button key={item.id} role="tab" aria-selected={pane === item.id} className={pane === item.id ? "active" : ""} onClick={() => setPane(item.id)} title={item.label}><item.icon size={17} /><span>{item.label}</span>{item.id === "approvals" && approvals.length > 0 && <b className="approval-count">{approvals.length}</b>}</button>)}
      </div>
      <div className="pane-content">
        {pane === "computer" && <Desktop />}
        {pane === "artifacts" && <div className="data-pane">
          {previewArtifact ? <>
            <div className="artifact-preview-heading"><button className="icon-button" title="返回成果列表" onClick={() => setPreviewArtifact(null)}><X size={17} /></button><strong>{previewArtifact.title}</strong>{previewArtifact.mimeType === "image/png" && <a className="icon-button" title="查看原图" href={`/api/artifacts/${previewArtifact.id}/content?inline=1`} target="_blank" rel="noopener noreferrer"><Maximize2 size={17} /></a>}<a className="icon-button" title="下载成果" href={`/api/artifacts/${previewArtifact.id}/content`} download><Download size={17} /></a></div>
            {previewError && <div className="inline-error"><AlertCircle size={16} />{previewError}</div>}
            {!previewError && !previewText && previewArtifact.mimeType !== "image/png" && <div className="empty-list">正在打开成果</div>}
            {!previewError && previewArtifact.mimeType === "image/png" && <img className="artifact-image" src={`/api/artifacts/${previewArtifact.id}/content?inline=1`} alt={previewArtifact.title} onError={() => setPreviewError("截图加载失败")} />}
            {previewText && <article className="artifact-markdown"><ReactMarkdown components={{ a: props => <a {...props} target="_blank" rel="noreferrer noopener" /> }}>{previewText}</ReactMarkdown></article>}
            {!!previewArtifact.sources.length && <div className="artifact-sources"><strong>来源</strong>{previewArtifact.sources.map(source => <a key={source} href={source} target="_blank" rel="noreferrer noopener">{source}</a>)}</div>}
          </> : <><div className="pane-heading"><h2>成果</h2><span>{artifacts.length}</span></div>
            {!artifacts.length && <div className="empty-list"><FileText size={23} />暂无成果</div>}
            {artifacts.map(item => <div key={item.id} className="artifact-row"><button className="artifact-open" title="预览成果" onClick={() => void openArtifact(item)}><span className="file-icon">{item.mimeType === "image/png" ? <ImageIcon size={18} /> : <FileText size={18} />}</span><span><strong>{item.title}</strong><small>{dateLabel(item.createdAt)} · {Math.max(1, Math.round(item.size / 1024))} KB</small></span><Eye size={16} /></button><a className="icon-button" title="下载成果" href={`/api/artifacts/${item.id}/content`} download><Download size={17} /></a></div>)}
          </>}
        </div>}
        {pane === "memories" && <MemoryPane memories={memories} addMemory={addMemory} removeMemory={removeMemory} updateMemory={async (item, content) => {
          try {
            await api(`/bots/${item.botId}/memories/${item.id}`, json("PATCH", { kind: item.kind, content, expectedRevision: item.revision }));
            const result = await api<{ memories: Memory[] }>(`/bots/${item.botId}/memories`);
            setMemories(result.memories);
            return true;
          } catch (cause) { setToast((cause as Error).message); return false; }
        }} />}
        {pane === "skills" && <SkillPane bot={selectedBot} selectedRun={selectedRun} />}
        {pane === "routines" && <RoutinePane bot={selectedBot} onOpen={(routine, occurrence) =>
          void openRoutineOccurrence(routine, occurrence)} />}
        {pane === "approvals" && <div className="data-pane"><div className="pane-heading"><h2>待审批</h2><span>{approvals.length}</span></div>
          {!approvals.length && <div className="empty-list"><Check size={23} />暂无待处理操作</div>}
          {approvals.map(item => <div className="approval-item" key={item.id}><strong>{({ shell_exec: "终端命令", browser_click: "网页点击", browser_fill: "网页输入", desktop_click: "桌面点击", desktop_key: "桌面按键", desktop_type: "桌面粘贴", github_issue_create: "创建 GitHub Issue" } as Record<string, string>)[item.toolName] || item.toolName}</strong><p>{item.target}</p>
            {item.previewArtifactId && <div className="approval-preview"><img src={`/api/artifacts/${item.previewArtifactId}/content?inline=1`} alt="待操作的桌面截图" />
              {item.toolName === "desktop_click" && item.previewWidth && item.previewHeight &&
                <span className="approval-point" style={{ left: `${Number(item.args.x) / item.previewWidth * 100}%`, top: `${Number(item.args.y) / item.previewHeight * 100}%` }} />}
            </div>}
            {(item.toolName === "browser_fill" || item.toolName === "desktop_type") && <div className="approval-value"><small>输入内容</small><pre>{String(item.args.value ?? item.args.text ?? "") || "（清空内容）"}</pre></div>}
            {item.toolName === "github_issue_create" && <div className="approval-value external"><small>正文（发布时附加隐藏核对标记）</small><pre>{String(item.args.body ?? "")}</pre></div>}
            <small>有效至 {dateLabel(item.expiresAt)}</small><div className="approval-actions"><button className="secondary-button" onClick={() => void decideApproval(item, "reject")}>拒绝</button><button className="primary-button" onClick={() => void decideApproval(item, "approve")}>批准</button></div></div>)}
        </div>}
        {pane === "activity" && <div className="data-pane"><div className="pane-heading"><h2>任务记录</h2><span>{runs.length}</span>
          <button className="icon-button handoff-action" title="交接给其他 Bot" aria-label="交接给其他 Bot"
            disabled={!selectedRun || selectedRun.delegationDepth >= 2 ||
              !bots.some(item => item.id !== selectedRun.botId && item.modelProfileId)}
            onClick={() => setHandoffOpen(true)}><GitBranch size={17} /></button></div>
          {selectedRun && <div className="run-budget" aria-label="当前任务用量">
            <strong>当前任务用量</strong>
            <div><span>工具调用</span><span>{selectedRun.toolCount} / {selectedRun.budget.maxToolCalls}</span></div>
            <div><span>模型 token / 续跑阈值{selectedRun.tokenUsageEstimated ? "（含估算）" : ""}</span><span>{selectedRun.tokenCount.toLocaleString("zh-CN")} / {selectedRun.budget.maxTokens.toLocaleString("zh-CN")}</span></div>
          </div>}
          {selectedRun && (handoffs.parent || handoffs.children.length > 0) &&
            <div className="handoff-links"><h3><GitBranch size={15} />任务交接</h3>
              {handoffs.parent && <button onClick={() => void openHandoffRun(handoffs.parent!)}>
                <small>上游任务 · {handoffs.parent.botName}</small>
                <strong>{handoffs.parent.task || handoffs.parent.id.slice(0, 8)}</strong>
                <span>{runLabel(handoffs.parent.status)}</span>
              </button>}
              {handoffs.children.map(item => <button key={item.id} onClick={() => void openHandoffRun(item)}>
                <small>子任务 · {item.botName}</small><strong>{item.task}</strong>
                <span>{runLabel(item.status)}{item.artifactIds.length ? ` · 引用 ${item.artifactIds.length} 份成果` : ""}</span>
              </button>)}
            </div>}
          {!!runSkills.length && <div className="run-skills"><strong>本次任务的技能版本</strong>
            {runSkills.map(item => <div key={item.skillId}>{item.name} · v{item.version}</div>)}
          </div>}
          {!!shellCommands.length && <div className="shell-history"><h3><TerminalSquare size={15} />终端命令</h3>
            {shellCommands.map(item => <div className="shell-command" key={item.operationId}>
              <div className="shell-command-heading"><span>{shellStatus(item)}</span>
                {["dispatching", "unknown"].includes(item.status) && !item.stopRequestedAt &&
                  <button className="icon-button" title="停止这条命令" onClick={() => void stopShellCommand(item)}><Square size={15} /></button>}
              </div>
              <code>$ {item.command}</code><small>/workspace · 最长 {Math.round(item.timeoutMs / 1000)} 秒 · {dateLabel(item.createdAt)}</small>
              {item.result && <details><summary>查看回执</summary>
                <div>退出码：{item.result.exitCode ?? "无"} · 信号：{item.result.signal || "无"}</div>
                {item.result.error && <pre>{item.result.error}</pre>}
                {item.result.stdout && <pre>{item.result.stdout}</pre>}
                {item.result.stderr && <pre>{item.result.stderr}</pre>}
              </details>}
            </div>)}
          </div>}
          {!!selectedRun?.unresolvedEffects.length && <div className="run-history-unknown"><strong>外部结果待核对</strong>{selectedRun.unresolvedEffects.map(effect => <div key={effect.operationId}><span>{effect.name || "电脑操作"}</span><code>{effect.operationId}</code></div>)}</div>}
          {!runs.length && <div className="empty-list"><Clock3 size={23} />暂无任务</div>}
          {[...runs].reverse().map(item => <button key={item.id} className={`run-row ${selectedRunId === item.id ? "selected" : ""}`} onClick={() => setSelectedRunId(item.id)}><span className={`run-indicator ${item.status}`} /><span><strong>{runLabel(item.status)}{item.unresolvedEffects.length ? " · 待核对" : ""}</strong><small>{dateLabel(item.createdAt)}</small></span><span className="run-id">{item.id.slice(0, 8)}</span></button>)}
        </div>}
      </div>
    </section>

    {toast && <div role="alert" className="toast"><AlertCircle size={17} />{toast}<button title="关闭消息" onClick={() => setToast("")}><X size={15} /></button></div>}
    {settingsOpen && selectedBot && <SettingsModal bot={selectedBot} profiles={profiles} githubConnector={githubConnector} onClose={() => setSettingsOpen(false)} onSaved={bot => setBots(current => current.map(item => item.id === bot.id ? bot : item))} onProfile={profile => setProfiles(current => [profile, ...current])} />}
    {passwordOpen && <PasswordModal onClose={() => setPasswordOpen(false)} onChanged={() => {
      setPasswordOpen(false); setToast("密码已更新，其他登录会话已退出");
    }} />}
    {newBotOpen && <NewBotModal profiles={profiles} githubConnector={githubConnector} onClose={() => setNewBotOpen(false)} onCreated={bot => { setBots(current => [bot, ...current]); setSelectedBotId(bot.id); setSelectedConversationId(null); setNewBotOpen(false); }} />}
    {handoffOpen && selectedRun && <HandoffModal parentRun={selectedRun} bots={bots} artifacts={artifacts}
      onClose={() => setHandoffOpen(false)} onCreated={async link => {
        await refreshHandoffs(selectedRun.id);
        setHandoffOpen(false);
        await openHandoffRun(link);
      }} />}
  </div>;
}

function MemoryPane({ memories, addMemory, removeMemory, updateMemory }: {
  memories: Memory[];
  addMemory: (kind: "preference" | "fact", content: string) => Promise<void>;
  removeMemory: (item: Memory) => Promise<void>;
  updateMemory: (item: Memory, content: string) => Promise<boolean>;
}) {
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<"preference" | "fact">("preference");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  return <div className="data-pane"><div className="pane-heading"><h2>Bot 记忆</h2><span>{memories.length}</span></div>
    <form className="memory-form" onSubmit={event => { event.preventDefault(); if (content.trim()) { void addMemory(kind, content.trim()); setContent(""); } }}>
      <select aria-label="记忆类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="preference">偏好</option><option value="fact">事实</option></select>
      <textarea aria-label="记忆内容" value={content} onChange={event => setContent(event.target.value)} placeholder="写入一条记忆" rows={2} maxLength={4000} />
      <button className="secondary-button" disabled={!content.trim()}><Plus size={16} />保存</button>
    </form>
    {!memories.length && <div className="empty-list"><Brain size={23} />暂无记忆</div>}
    <div className="memory-list">{memories.map(item => <div className="memory-item" key={item.id}>
      <div className="memory-meta"><span>{item.kind === "preference" ? "偏好" : item.kind === "fact" ? "事实" : "摘要"}</span><small>v{item.revision}</small></div>
      {editing === item.id ? <div className="memory-edit"><textarea value={draft} onChange={event => setDraft(event.target.value)} rows={4} /><div><button className="secondary-button" onClick={() => setEditing(null)}>取消</button><button className="primary-button" onClick={() => { setSaving(true); void updateMemory(item, draft).then(ok => { if (ok) setEditing(null); }).finally(() => setSaving(false)); }} disabled={!draft.trim() || saving}>{saving ? "保存中" : "保存"}</button></div></div> : <p>{item.content}</p>}
      <div className="memory-actions"><time>{dateLabel(item.updatedAt)}</time><button title="编辑记忆" onClick={() => { setEditing(item.id); setDraft(item.content); }}>编辑</button><button title="删除记忆" onClick={() => void removeMemory(item)}><Trash2 size={15} /></button></div>
    </div>)}</div>
  </div>;
}

function SkillPane({ bot, selectedRun }: { bot: Bot | null; selectedRun: Run | null }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editor, setEditor] = useState<{ initial: SkillDefinition; current?: Skill } | null>(null);
  const [history, setHistory] = useState<{ skill: Skill; versions: SkillVersion[] } | null>(null);
  const [error, setError] = useState("");
  const [bindingSkillId, setBindingSkillId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const response = await api<{ skills: Skill[] }>("/skills");
    setSkills(response.skills);
  }, []);
  useEffect(() => { void reload().catch(cause => setError((cause as Error).message)); }, [reload]);

  async function draftFromRun() {
    if (!selectedRun || selectedRun.status !== "succeeded") return;
    setError("");
    try {
      const response = await api<{ draft: SkillDefinition }>(`/runs/${selectedRun.id}/skill-draft`);
      setEditor({ initial: response.draft });
    } catch (cause) { setError((cause as Error).message); }
  }

  async function toggleBinding(item: Skill) {
    if (!bot || bindingSkillId) return;
    setError("");
    setBindingSkillId(item.skillId);
    const bound = item.boundBotIds.includes(bot.id);
    setSkills(current => current.map(value => value.skillId === item.skillId ? {
      ...value, boundBotIds: bound
        ? value.boundBotIds.filter(id => id !== bot.id) : [...value.boundBotIds, bot.id],
    } : value));
    try {
      await api(`/bots/${bot.id}/skills/${item.skillId}`, {
        method: bound ? "DELETE" : "PUT",
      });
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
      await reload().catch(() => undefined);
    } finally { setBindingSkillId(null); }
  }

  async function showHistory(item: Skill) {
    setError("");
    try {
      const response = await api<{ versions: SkillVersion[] }>(`/skills/${item.skillId}/versions`);
      setHistory({ skill: item, versions: response.versions });
    } catch (cause) { setError((cause as Error).message); }
  }

  const blank: SkillDefinition = { name: "", summary: "", inputGuide: "", steps: [""],
    verification: "", requiredCapabilities: [] };
  return <div className="data-pane">
    <div className="pane-heading skill-pane-heading"><h2>技能库</h2><span>{skills.length}</span>
      <button className="icon-button" title="新建技能" onClick={() => setEditor({ initial: blank })}><Plus size={17} /></button>
    </div>
    {selectedRun?.status === "succeeded" && selectedRun.botId === bot?.id &&
      <button className="secondary-button skill-from-run" onClick={() => void draftFromRun()}><BookOpen size={15} />从当前任务整理技能</button>}
    {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
    {!skills.length && <div className="empty-list"><BookOpen size={23} />暂无技能</div>}
    {skills.map(item => {
      const bound = Boolean(bot && item.boundBotIds.includes(bot.id));
      const missing = item.requiredCapabilities.filter(capability => !bot?.capabilities.includes(capability));
      return <div className="skill-row" key={item.skillId}>
        <div className="skill-row-heading"><strong>{item.name}</strong><small>v{item.version}</small></div>
        {item.summary && <p>{item.summary}</p>}
        <div className="skill-meta">{item.requiredCapabilities.length
          ? item.requiredCapabilities.map(capability => capabilityItems.find(value => value.id === capability)?.label || capability).join(" · ")
          : "无需工具能力"}</div>
        {missing.length > 0 && <div className="skill-missing"><AlertCircle size={13} />当前 Bot 缺少 {missing.map(capability =>
          capabilityItems.find(value => value.id === capability)?.label || capability).join("、")}</div>}
        <details className="skill-details"><summary>查看步骤与核验</summary>
          <div><strong>输入</strong><p>{item.inputGuide}</p></div>
          <ol>{item.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
          <div><strong>结果核验</strong><p>{item.verification}</p></div>
        </details>
        <div className="skill-row-actions">
          {bot && <label className="skill-binding"><input type="checkbox" checked={bound}
            disabled={bindingSkillId === item.skillId}
            onChange={() => void toggleBinding(item)} />用于当前 Bot</label>}
          <button className="icon-button" title="查看版本" onClick={() => void showHistory(item)}><History size={16} /></button>
          <button className="icon-button" title="编辑技能" onClick={() => setEditor({ initial: item, current: item })}><Pencil size={15} /></button>
        </div>
      </div>;
    })}
    {editor && <SkillEditorModal initial={editor.initial} current={editor.current}
      onClose={() => setEditor(null)} onSave={async input => {
        if (editor.current) {
          await api(`/skills/${editor.current.skillId}`, json("PATCH", {
            ...input, expectedVersion: editor.current.version,
          }));
        } else await api("/skills", json("POST", input));
        await reload();
      }} />}
    {history && <Modal title={`${history.skill.name} · 版本记录`} onClose={() => setHistory(null)}>
      <div className="skill-history">{history.versions.map(item => <div key={item.version} className="skill-history-row">
        <div><strong>v{item.version} · {item.name}</strong><time>{dateLabel(item.createdAt)}</time></div>
        {item.summary && <p>{item.summary}</p>}
        <small>输入：{item.inputGuide}</small>
        <ol>{item.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
        <small>核验：{item.verification}</small>
        {item.sourceRunId && <small>来源任务：{item.sourceRunId.slice(0, 8)}</small>}
      </div>)}</div>
    </Modal>}
  </div>;
}

function SkillEditorModal({ initial, current, onClose, onSave }: {
  initial: SkillDefinition; current?: Skill; onClose: () => void;
  onSave: (input: SkillDefinition) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [summary, setSummary] = useState(initial.summary);
  const [inputGuide, setInputGuide] = useState(initial.inputGuide);
  const [steps, setSteps] = useState(initial.steps);
  const [verification, setVerification] = useState(initial.verification);
  const [requiredCapabilities, setRequiredCapabilities] = useState(initial.requiredCapabilities);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await onSave({ name, summary, inputGuide, steps: steps.map(step => step.trim()).filter(Boolean),
        verification, requiredCapabilities, sourceRunId: initial.sourceRunId });
      onClose();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  return <Modal title={current ? `编辑技能 · v${current.version}` : "新建技能"} onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      <label>名称<input value={name} onChange={event => setName(event.target.value)} maxLength={64} required autoFocus /></label>
      <label>说明<textarea value={summary} onChange={event => setSummary(event.target.value)} maxLength={300} rows={2} /></label>
      <label>所需输入<textarea value={inputGuide} onChange={event => setInputGuide(event.target.value)} maxLength={1000} rows={3} required /></label>
      <div className="skill-steps-editor"><strong>步骤</strong>{steps.map((step, index) => <div key={index}>
        <span>{index + 1}</span><textarea aria-label={`步骤 ${index + 1}`} value={step} rows={2} maxLength={300}
          onChange={event => setSteps(currentSteps => currentSteps.map((item, position) =>
            position === index ? event.target.value : item))} />
        <button type="button" className="icon-button" title="删除步骤" disabled={steps.length === 1}
          onClick={() => setSteps(currentSteps => currentSteps.filter((_, position) => position !== index))}><Trash2 size={15} /></button>
      </div>)}<button type="button" className="text-button" disabled={steps.length >= 8}
        onClick={() => setSteps(currentSteps => [...currentSteps, ""])}><Plus size={15} />添加步骤</button></div>
      <label>结果核验<textarea value={verification} onChange={event => setVerification(event.target.value)} maxLength={1000} rows={3} required /></label>
      <CapabilityControls value={requiredCapabilities} onChange={setRequiredCapabilities} legend="所需工具能力" />
      {initial.sourceRunId && <div className="skill-source">来源任务：{initial.sourceRunId.slice(0, 8)}</div>}
      {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
      <button className="primary-button" disabled={saving || !steps.some(step => step.trim())}>{saving ? "保存中" : current ? "保存新版本" : "创建技能"}</button>
    </form>
  </Modal>;
}

function NewBotModal({ profiles, githubConnector, onClose, onCreated }: {
  profiles: ModelProfile[]; onClose: () => void; onCreated: (bot: Bot) => void;
  githubConnector: { configured: boolean; repository: string | null };
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [profileId, setProfileId] = useState(profiles[0]?.id || "");
  const [capabilities, setCapabilities] = useState<ToolCapability[]>([...initialBotCapabilities]);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await api<BotResponse>("/bots", json("POST", {
        name, description, instructions, modelProfileId: profileId || null, capabilities,
      }));
      onCreated(result.bot);
    } catch (cause) { setError((cause as Error).message); }
  }
  return <Modal title="新建 Bot" onClose={onClose}><form className="form-stack" onSubmit={submit}>
    <label>名称<input value={name} onChange={event => setName(event.target.value)} maxLength={48} required autoFocus /></label>
    <label>职责<input value={description} onChange={event => setDescription(event.target.value)} maxLength={300} /></label>
    <label>工作指令<textarea value={instructions} onChange={event => setInstructions(event.target.value)} rows={5} maxLength={8000} /></label>
    <label>模型<select value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">尚未选择</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.modelId}</option>)}</select></label>
    <CapabilityControls value={capabilities} onChange={setCapabilities} githubConnector={githubConnector} />
    {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
    <button className="primary-button">创建 Bot</button>
  </form></Modal>;
}
