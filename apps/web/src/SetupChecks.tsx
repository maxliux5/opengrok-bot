import { AlertCircle, CheckCircle2, CircleDashed } from "lucide-react";
import type { SetupCheck } from "@opengrok/contracts";

export default function SetupChecks({ checks }: { checks: SetupCheck[] }) {
  return <ul className="setup-checks" aria-label="检查结果" aria-live="polite">
    {checks.map(check => {
      const Icon = check.status === "ok" ? CheckCircle2 : check.status === "unchecked" ? CircleDashed : AlertCircle;
      return <li key={check.id} className={`setup-check ${check.status}`} data-check={check.id}>
        <Icon size={18} aria-label={{ ok: "通过", warning: "待处理", error: "失败", unchecked: "未验证" }[check.status]} />
        <div><strong>{check.label}</strong><span>{check.detail}</span></div>
      </li>;
    })}
  </ul>;
}
