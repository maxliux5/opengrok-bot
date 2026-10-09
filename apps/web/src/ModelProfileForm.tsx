import { useState, type FormEvent } from "react";
import { AlertCircle, PlugZap, Save } from "lucide-react";
import type { ModelProfile, ModelProbeResult } from "@opengrok/contracts";
import { api, json } from "./client";
import SetupChecks from "./SetupChecks";

export function SavedModelTest({ profileId }: { profileId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ModelProbeResult | null>(null);
  const [error, setError] = useState("");
  async function test() {
    setBusy(true); setResult(null); setError("");
    try { setResult(await api<ModelProbeResult>(`/model-profiles/${profileId}/test`, json("POST", {}))); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="model-test">
    <button type="button" className="secondary-button" disabled={busy || !profileId} onClick={() => void test()}>
      <PlugZap size={16} />{busy ? "测试中" : "测试当前模型"}</button>
    {result && <SetupChecks checks={result.checks} />}
    {error && <div className="inline-error" role="alert"><AlertCircle size={16} />{error}</div>}
  </div>;
}

export default function ModelProfileForm({ onSaved, requireTest = false }: {
  onSaved: (profile: ModelProfile) => void; requireTest?: boolean;
}) {
  const [name, setName] = useState(requireTest ? "主模型" : "");
  const [provider, setProvider] = useState<ModelProfile["provider"]>("openai-compatible");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [capabilities, setCapabilities] = useState<ModelProfile["capabilities"]>({
    text: true, tools: true, vision: false, streaming: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<{ signature: string; result: ModelProbeResult } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const testOnly = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "test";
    const input = { name, provider, modelId, apiKey, capabilities,
      baseUrl: provider === "anthropic" ? anthropicBaseUrl || null : baseUrl };
    const signature = JSON.stringify(input);
    setBusy(true); setError("");
    try {
      if (testOnly || requireTest && !(probe?.signature === signature && probe.result.ok)) {
        const result = await api<ModelProbeResult>("/model-profiles/test", json("POST", input));
        setProbe({ signature, result });
        if (!result.ok || testOnly) return;
      }
      const { profile } = await api<{ profile: ModelProfile }>("/model-profiles", json("POST", input));
      setApiKey(""); setProbe(null); onSaved(profile);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <form className="form-stack" onSubmit={submit} onChangeCapture={() => setProbe(null)}>
    <fieldset className="model-fields" disabled={busy}>
      <label>配置名称<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label>
      <label>供应商协议<select value={provider} onChange={event => setProvider(event.target.value as typeof provider)}>
        <option value="openai-compatible">OpenAI 兼容接口</option><option value="anthropic">Anthropic</option>
      </select></label>
      <label>模型 ID<input value={modelId} onChange={event => setModelId(event.target.value)} maxLength={160}
        placeholder="填写供应商提供的模型 ID" required /></label>
      {provider === "openai-compatible"
        ? <label>API 地址<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required /></label>
        : <label>API 地址（可选）<input type="url" value={anthropicBaseUrl} onChange={event => setAnthropicBaseUrl(event.target.value)}
          placeholder="https://api.anthropic.com/v1" /></label>}
      <label>API Key<input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)}
        maxLength={1000} autoComplete="off" placeholder={provider === "anthropic" ? "必填" : "本机模型可留空"}
        required={provider === "anthropic"} /></label>
      <fieldset className="capability-options"><legend>模型能力</legend>
        <label><input type="checkbox" checked disabled />文本</label>
        {(["tools", "vision", "streaming"] as const).map(key => <label key={key}>
          <input type="checkbox" checked={capabilities[key]}
            onChange={event => setCapabilities(current => ({ ...current, [key]: event.target.checked }))} />
          {{ tools: "工具调用", vision: "视觉输入", streaming: "流式输出" }[key]}
        </label>)}
      </fieldset>
    </fieldset>
    {probe && <SetupChecks checks={probe.result.checks} />}
    {error && <div className="inline-error" role="alert"><AlertCircle size={16} />{error}</div>}
    <div className="setup-actions">
      <button className="secondary-button" type="submit" value="test" disabled={busy}><PlugZap size={16} />测试连接</button>
      <button className="primary-button" type="submit" value="save" disabled={busy}><Save size={16} />
        {busy ? "处理中" : requireTest ? "测试并保存模型" : "保存配置"}</button>
    </div>
  </form>;
}
