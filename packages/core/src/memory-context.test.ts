import { describe, expect, it } from "vitest";
import type { Memory } from "@opengrok/contracts";
import { coreMemoryContext, searchMemories } from "./memory-context.js";

function memory(id: string, content: string, kind: Memory["kind"] = "fact", updatedAt = "2026-10-06T00:00:00.000Z"): Memory {
  return { id, botId: "bot", kind, content, revision: 1, sourceMessageId: null,
    createdAt: updatedAt, updatedAt };
}

describe("Bot 记忆选择", () => {
  it("中文短词和英文词组可召回，短英文词不会命中长单词内部", () => {
    const entries = [
      memory("zh", "报告使用中文，并附来源链接"),
      memory("en", "Include source links in the report"),
      memory("go", "Go 是项目的开发语言"),
      memory("google", "Google 是一个网站"),
      memory("tax", "所得税材料在工作目录中"),
      memory("paid", "This subscription is paid"),
      memory("ai", "AI model preference"),
    ];
    expect(searchMemories(entries, "来源").map(item => item.id)).toEqual(["zh"]);
    expect(searchMemories(entries, "source links").map(item => item.id)).toEqual(["en"]);
    expect(searchMemories(entries, "Go").map(item => item.id)).toEqual(["go"]);
    expect(searchMemories(entries, "税").map(item => item.id)).toEqual(["tax"]);
    expect(searchMemories(entries, "AI").map(item => item.id)).toEqual(["ai"]);
  });

  it("相互冲突的偏好都保留版本和更新时间，不暗中选最新一条", () => {
    const old = memory("old", "报告使用中文", "preference", "2026-10-01T00:00:00.000Z");
    const newer = memory("new", "报告使用英文", "preference", "2026-10-06T00:00:00.000Z");
    const matches = searchMemories([old, newer], "报告语言");
    expect(matches.map(item => item.id)).toEqual(["new", "old"]);
    const context = coreMemoryContext([old, newer], "写报告");
    expect(context).toContain("记忆内部冲突时先向用户核对");
    expect(context).toContain("报告使用中文");
    expect(context).toContain("报告使用英文");
    expect(context).toContain("修订 1");
  });

  it("仅注入核心偏好与相关事实，并限制长度", () => {
    const entries = [
      memory("pref", "报告必须列出来源", "preference"),
      memory("relevant", "研究材料有关能源价格"),
      memory("irrelevant", "纪念日是周五"),
      ...Array.from({ length: 10 }, (_, index) => memory(`long-${index}`,
        `偏好${index}:${"x".repeat(1400)}`, "preference", `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`)),
    ];
    const context = coreMemoryContext(entries, "分析能源价格");
    expect(context).toContain("报告必须列出来源");
    expect(context).toContain("能源价格");
    expect(context).not.toContain("纪念日");
    expect(context).toContain("[已截断]");
    expect(context.length).toBeLessThan(6200);
    expect(coreMemoryContext([], "任何任务")).toBe("");
  });
});
