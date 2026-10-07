import { describe, expect, it } from "vitest";
import type { SkillVersion } from "@opengrok/contracts";
import { skillPrompt } from "./skills.js";

const skill: SkillVersion = {
  skillId: "00000000-0000-4000-8000-000000000001", version: 3,
  name: "网页研究", summary: "有来源的研究", inputGuide: "给出问题和网址。",
  steps: ["读取页面并记录依据。"], verification: "核对来源链接。",
  requiredCapabilities: ["public_web"], sourceRunId: null,
  createdAt: "2026-10-06T00:00:00.000Z",
};

describe("skillPrompt", () => {
  it("uses an immutable version only when capabilities allow it", () => {
    const allowed = skillPrompt([skill], ["public_web"]);
    expect(allowed).toContain("网页研究 (v3)");
    expect(allowed).toContain("读取页面并记录依据");
    expect(allowed).toContain("技能不会授予工具权限");
    const denied = skillPrompt([skill], ["memory"]);
    expect(denied).toContain("当前权限不足");
    expect(denied).not.toContain("读取页面并记录依据");
  });
});
