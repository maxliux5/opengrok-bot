import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Clock3, History, Pause, Pencil, Play, Plus, X } from "lucide-react";
import type { Bot, Routine, RoutineInput, RoutineOccurrence, RunBudget, Skill } from "@opengrok/contracts";
import { api, json } from "./client";

function when(value: string, timeZone?: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function occurrenceLabel(item: RoutineOccurrence) {
  if (item.status === "failed") return "投递失败";
  if (item.status === "pending") return "等待投递";
  return ({ queued: "排队中", running: "工作中", waiting_approval: "等待审批",
    waiting_user: "等待你", waiting_computer: "等待电脑", reconciling: "核对中",
    verifying: "验证成果", canceling: "正在停止", succeeded: "已完成",
    failed: "失败", canceled: "已取消" } as Record<string, string>)[item.runStatus || ""] || "已投递";
}

function RoutineEditor({ initial, bot, skills, defaults, onClose, onSaved }: {
  initial: Routine | null; bot: Bot; skills: Skill[]; defaults: RunBudget;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [timeZone, setTimeZone] = useState(initial?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [localTime, setLocalTime] = useState(initial?.localTime || "09:00");
  const [inputText, setInputText] = useState(initial?.inputText || "");
  const [deliverable, setDeliverable] = useState<RoutineInput["deliverable"]>(initial?.deliverable || "answer");
  const [skillId, setSkillId] = useState(initial?.skillId || "");
  const [budget, setBudget] = useState<RunBudget>(initial?.budget || defaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canReport = bot.capabilities.includes("public_web") && bot.capabilities.includes("artifact");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function budgetNumber(key: keyof RunBudget, value: string, scale = 1) {
    setBudget(current => ({ ...current, [key]: Math.round(Number(value) * scale) }));
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const input: RoutineInput = {
        botId: bot.id, name, timeZone, localTime, inputText, deliverable,
        budget, skillId: skillId || null,
      };
      if (initial) {
        const changedSkill = (skillId || null) !== initial.skillId;
        const body = { ...input, expectedRevision: initial.revision } as Partial<RoutineInput> & {
          expectedRevision: number;
        };
        if (!changedSkill) delete body.skillId;
        await api(`/routines/${initial.id}`, json("PATCH", body));
      } else await api("/routines", json("POST", input));
      onSaved(); onClose();
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={initial ? "编辑例程" : "新建例程"}
      onMouseDown={event => event.stopPropagation()}>
      <div className="modal-heading"><h2>{initial ? "编辑例程" : "新建例程"}</h2>
        <button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div>
      <form className="form-stack routine-editor" onSubmit={event => void save(event)}>
        <label>名称<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label>
        <div className="routine-fields"><label>每天<input type="time" value={localTime} onChange={event => setLocalTime(event.target.value)} required /></label>
          <label>时区<input value={timeZone} onChange={event => setTimeZone(event.target.value)} list="routine-timezones" required />
            <datalist id="routine-timezones"><option value="Asia/Shanghai" /><option value="UTC" />
              <option value="America/New_York" /><option value="Europe/Berlin" /></datalist></label></div>
        <label>输入来源<textarea value={inputText} onChange={event => setInputText(event.target.value)}
          rows={5} maxLength={20000} placeholder="每次执行时使用的固定任务内容" required /></label>
        <label>成果位置<select value={deliverable} onChange={event => setDeliverable(event.target.value as RoutineInput["deliverable"])}>
          <option value="answer">对话回复</option><option value="report" disabled={!canReport}>报告成果</option>
        </select></label>
        <label>技能<select value={skillId} onChange={event => setSkillId(event.target.value)}>
          <option value="">沿用 Bot 已绑定技能</option>
          {skills.map(item => <option key={item.skillId} value={item.skillId}>{item.name} · 当前 v{item.version}</option>)}
        </select></label>
        {initial?.skillId && <small className="routine-note">当前例程固定在技能 v{initial.skillVersion}；重新选择技能会使用最新版本。</small>}
        <fieldset className="routine-budget"><legend>单次预算</legend>
          <label>模型步骤<input type="number" min={1} max={100} value={budget.maxModelSteps}
            onChange={event => budgetNumber("maxModelSteps", event.target.value)} required /></label>
          <label>工具调用<input type="number" min={1} max={500} value={budget.maxToolCalls}
            onChange={event => budgetNumber("maxToolCalls", event.target.value)} required /></label>
          <label>Token<input type="number" min={1} max={1000000} value={budget.maxTokens}
            onChange={event => budgetNumber("maxTokens", event.target.value)} required /></label>
          <label>最长分钟<input type="number" min={1} max={10080} value={Math.round(budget.maxWallMs / 60000)}
            onChange={event => budgetNumber("maxWallMs", event.target.value, 60000)} required /></label>
        </fieldset>
        {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
        <button className="primary-button" disabled={saving || deliverable === "report" && !canReport}>
          {saving ? "保存中" : "保存例程"}</button>
      </form>
    </div>
  </div>;
}

export default function RoutinePane({ bot, onOpen }: {
  bot: Bot | null;
  onOpen: (routine: Routine, occurrence: RoutineOccurrence) => void;
}) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [defaults, setDefaults] = useState<RunBudget | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [occurrences, setOccurrences] = useState<RoutineOccurrence[]>([]);
  const [editor, setEditor] = useState<Routine | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const [routineResponse, skillResponse, defaultResponse] = await Promise.all([
      api<{ routines: Routine[] }>("/routines"), api<{ skills: Skill[] }>("/skills"),
      api<{ budget: RunBudget }>("/routines/defaults"),
    ]);
    setRoutines(routineResponse.routines); setSkills(skillResponse.skills);
    setDefaults(defaultResponse.budget);
  }, []);

  const refreshHistory = useCallback(async (id: string) => {
    const response = await api<{ occurrences: RoutineOccurrence[] }>(`/routines/${id}/occurrences`);
    setOccurrences(response.occurrences);
  }, []);

  useEffect(() => { void reload().catch(cause => setError((cause as Error).message)); }, [reload]);
  useEffect(() => {
    if (!selectedId) { setOccurrences([]); return; }
    void refreshHistory(selectedId).catch(cause => setError((cause as Error).message));
    const timer = window.setInterval(() => {
      void refreshHistory(selectedId).catch(() => undefined);
    }, 7000);
    return () => window.clearInterval(timer);
  }, [selectedId, refreshHistory]);

  const visible = routines.filter(item => item.botId === bot?.id);
  const selected = visible.find(item => item.id === selectedId) || null;

  async function setStatus(item: Routine) {
    setBusyId(item.id); setError("");
    try {
      await api(`/routines/${item.id}`, json("PATCH", {
        expectedRevision: item.revision, status: item.status === "active" ? "paused" : "active",
      }));
      await reload();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusyId(null); }
  }

  async function runOnce(item: Routine) {
    setBusyId(item.id); setError("");
    try {
      const response = await api<{ occurrence: RoutineOccurrence }>(`/routines/${item.id}/test`,
        json("POST", { requestId: crypto.randomUUID() }));
      setSelectedId(item.id);
      await refreshHistory(item.id);
      if (response.occurrence.status === "failed") setError(response.occurrence.error || "试跑投递失败");
      else if (response.occurrence.runId) onOpen(item, response.occurrence);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusyId(null); }
  }

  return <div className="data-pane">
    <div className="pane-heading routine-heading"><h2>例程</h2><span>{visible.length}</span>
      <button className="icon-button" title="新建例程" disabled={!bot?.modelProfileId || !defaults}
        onClick={() => setEditor("new")}><Plus size={17} /></button></div>
    {error && <div className="inline-error"><AlertCircle size={16} />{error}</div>}
    {!visible.length && <div className="empty-list"><Clock3 size={23} />暂无例程</div>}
    {visible.map(item => <div className="routine-row" key={item.id}>
      <button className="routine-open" onClick={() => setSelectedId(current => current === item.id ? null : item.id)}
        aria-expanded={selectedId === item.id}>
        <strong>{item.name}</strong><small>每天 {item.localTime} · {item.timeZone}</small>
        <small>{item.status === "active" ? `下次 ${when(item.nextFireAt, item.timeZone)}` : "已暂停"}
          {item.skillVersion ? ` · 技能 v${item.skillVersion}` : ""}</small>
      </button>
      <div className="routine-actions">
        <button className="icon-button" title="试跑一次" disabled={busyId === item.id || !bot?.modelProfileId}
          onClick={() => void runOnce(item)}><Play size={16} /></button>
        <button className="icon-button" title={item.status === "active" ? "暂停例程" : "恢复例程"}
          disabled={busyId === item.id} onClick={() => void setStatus(item)}>
          {item.status === "active" ? <Pause size={16} /> : <Clock3 size={16} />}</button>
        <button className="icon-button" title="编辑例程" onClick={() => setEditor(item)}><Pencil size={15} /></button>
      </div>
    </div>)}
    {selected && <div className="routine-history"><h3><History size={15} />{selected.name} · 运行历史</h3>
      {!occurrences.length && <div className="empty-list">尚未触发</div>}
      {occurrences.map(item => <div className="routine-occurrence" key={item.id}>
        <div><strong>{occurrenceLabel(item)}</strong><small>{item.trigger === "manual" ? "试跑" : "定时"} · {when(item.scheduledAt, selected.timeZone)}</small></div>
        {item.error && <small className="routine-error">{item.error}</small>}
        {item.runId && <button className="text-button" onClick={() => onOpen(selected, item)}>打开任务</button>}
      </div>)}
    </div>}
    {editor && bot && defaults && <RoutineEditor key={editor === "new" ? "new" : editor.id}
      initial={editor === "new" ? null : editor} bot={bot} skills={skills} defaults={defaults}
      onClose={() => setEditor(null)} onSaved={() => void reload()} />}
  </div>;
}
