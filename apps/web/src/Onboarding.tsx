import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Bot as BotIcon, FileText, Monitor, RefreshCw, X } from "lucide-react";
import type { Bot, ModelProfile, WorkspaceDiagnostics } from "@opengrok/contracts";
import { api, json, type BotResponse } from "./client";
import ModelProfileForm, { SavedModelTest } from "./ModelProfileForm";
import SetupChecks from "./SetupChecks";

const steps = ["工作环境", "模型连接", "配置 Bot", "首次任务"];

export default function Onboarding({ bots, profiles, bot, onProfile, onBot, onChooseBot, onReport, onComputer, onClose }: {
  bots: Bot[]; profiles: ModelProfile[]; bot: Bot | null;
  onProfile: (profile: ModelProfile) => void; onBot: (bot: Bot) => void;
  onChooseBot: (id: string) => void; onReport: (text: string) => Promise<boolean>;
  onComputer: () => void; onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [diagnostics, setDiagnostics] = useState<WorkspaceDiagnostics | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [profileId, setProfileId] = useState(bot?.modelProfileId || profiles[0]?.id || "");
  const [addingModel, setAddingModel] = useState(!profiles.length);
  const [addingBot, setAddingBot] = useState(!bots.length);
  const [name, setName] = useState(bot?.name || "研究助手");
  const [description, setDescription] = useState(bot?.description || "网页研究与来源核对");
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState("打开 https://example.com/，阅读网页，生成一份包含结论、依据和来源的中文 Markdown 报告。");
  const profile = profiles.find(item => item.id === bot?.modelProfileId);
  const canReport = Boolean(bot && profile?.capabilities.tools &&
    bot.capabilities.includes("public_web") && bot.capabilities.includes("artifact"));

  const diagnose = useCallback(async () => {
    setChecking(true); setError("");
    try { setDiagnostics(await api<WorkspaceDiagnostics>("/onboarding/diagnostics", json("POST", {}))); }
    catch (cause) { setDiagnostics(null); setError((cause as Error).message); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void diagnose(); }, [diagnose]);
  useEffect(() => {
    setName(addingBot ? "研究助手" : bot?.name || "");
    setDescription(addingBot ? "网页研究与来源核对" : bot?.description || "");
  }, [addingBot, bot?.id, bot?.name, bot?.description]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const isNew = addingBot || !bot;
      const { bot: saved } = await api<BotResponse>(isNew ? "/bots" : `/bots/${bot.id}`, json(isNew ? "POST" : "PATCH", {
        name, description, modelProfileId: profileId,
        ...(isNew ? { instructions: "报告使用中文。先给结论，再列依据和来源；只引用实际读取的网页。" }
          : { expectedRevision: bot.revision }),
      }));
      onBot(saved); setAddingBot(false); setStep(3);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function report(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try { if (await onReport(task)) onClose(); }
    finally { setBusy(false); }
  }

  return <section className="onboarding" aria-label="首次使用向导">
    <div className="setup-heading"><div><h1>开始使用</h1><p>OpenGrok Bot</p></div>
      <button className="icon-button" title="关闭使用向导" onClick={onClose}><X size={18} /></button>
    </div>
    <nav className="setup-steps" aria-label="使用向导步骤">
      {steps.map((label, index) => <button key={label} aria-current={step === index ? "step" : undefined}
        disabled={busy || index === 2 && !profiles.length || index === 3 && !bot?.modelProfileId}
        onClick={() => { setStep(index); setError(""); }}><span>{index + 1}</span>{label}</button>)}
    </nav>
    <div className="setup-step-heading"><h2>{steps[step]}</h2>
      {step === 0 && <button className="icon-button" title="重新检查环境" disabled={checking} onClick={() => void diagnose()}>
        <RefreshCw size={17} /></button>}
    </div>
    {error && <div className="inline-error" role="alert"><AlertCircle size={16} />{error}</div>}
    {step === 0 && <>
      {checking && <div className="setup-pending" role="status"><span className="spinner" />检查中</div>}
      {diagnostics && <SetupChecks checks={diagnostics.checks} />}
      <div className="setup-actions"><button className="primary-button" onClick={() => setStep(1)}>
        配置模型<ArrowRight size={16} /></button></div>
    </>}
    {step === 1 && <>
      {!!profiles.length && <div className="form-stack setup-existing">
        <label>已有模型<select value={profileId} onChange={event => setProfileId(event.target.value)}>
          {profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.modelId}</option>)}
        </select></label>
        <SavedModelTest key={profileId} profileId={profileId} />
        <div className="setup-actions"><button className="primary-button" disabled={!profileId} onClick={() => setStep(2)}>
          使用此模型<ArrowRight size={16} /></button>
          <button className="text-button" onClick={() => setAddingModel(value => !value)}>{addingModel ? "收起新模型" : "添加模型配置"}</button></div>
      </div>}
      {addingModel && <ModelProfileForm requireTest onSaved={saved => {
        onProfile(saved); setProfileId(saved.id); setAddingModel(false); setStep(2);
      }} />}
    </>}
    {step === 2 && <>
      {!!bots.length && <div className="form-stack setup-existing">
        <label>Bot<select value={addingBot ? "" : bot?.id || ""} disabled={busy} onChange={event => {
          setAddingBot(!event.target.value);
          if (event.target.value) onChooseBot(event.target.value);
        }}>
          {bots.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          <option value="">创建新 Bot</option>
        </select></label>
      </div>}
      <form className="form-stack" onSubmit={create}>
        <label>Bot 名称<input value={name} onChange={event => setName(event.target.value)} maxLength={48} required /></label>
        <label>职责<input value={description} onChange={event => setDescription(event.target.value)} maxLength={300} /></label>
        <label>模型<select value={profileId} onChange={event => setProfileId(event.target.value)} required>
          {profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.modelId}</option>)}
        </select></label>
        <button className="primary-button" disabled={busy || !profileId}><BotIcon size={16} />{busy ? "保存中" : addingBot ? "创建 Bot" : "保存 Bot"}</button>
      </form>
    </>}
    {step === 3 && <>
      <div className="setup-selected"><BotIcon size={20} /><div><strong>{bot?.name}</strong><span>{profile?.modelId}</span></div></div>
      <form className="form-stack" onSubmit={report}>
        <label>首个任务<textarea value={task} onChange={event => setTask(event.target.value)} rows={4} maxLength={20000} required /></label>
        {!canReport && <div className="inline-error"><AlertCircle size={16} />报告需要模型工具调用、网页浏览和成果发布能力</div>}
        <button className="primary-button" disabled={busy || !canReport}><FileText size={16} />{busy ? "提交中" : "生成首份报告"}</button>
      </form>
      <div className="setup-actions"><button className="secondary-button" onClick={onComputer}><Monitor size={16} />查看电脑</button>
        <button className="text-button" onClick={onClose}>进入工作台<ArrowRight size={16} /></button></div>
    </>}
    {step > 0 && <button className="text-button setup-back" onClick={() => { setStep(value => value - 1); setError(""); }}>
      <ArrowLeft size={15} />上一步</button>}
  </section>;
}
