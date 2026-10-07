import type { Memory } from "@opengrok/contracts";

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const ignored = new Set([
  "a", "an", "and", "are", "for", "how", "i", "in", "is", "me", "my", "of", "on", "the", "to", "what",
  "你", "我", "的", "了", "和", "在", "是", "请", "用", "有", "吗", "这", "个",
]);

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function words(value: string): string[] {
  return [...segmenter.segment(normalize(value))]
    .filter(item => item.isWordLike)
    .map(item => item.segment)
    .filter(item => !ignored.has(item));
}

export function searchMemories(memories: readonly Memory[], query: string, limit = 12): Memory[] {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  const phrase = normalize(query.trim());
  return memories.map(item => {
    const content = normalize(item.content);
    const tokens = new Set(words(item.content));
    const matches = terms.filter(term => tokens.has(term) ||
      /\p{Script=Han}/u.test(term) && content.includes(term));
    const exactPhrase = phrase.length > 1 &&
      (terms.length > 1 || /\p{Script=Han}/u.test(phrase)) && content.includes(phrase);
    return { item, score: matches.length * 2 + (exactPhrase ? 3 : 0) };
  }).filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
    .slice(0, limit).map(match => match.item);
}

export function coreMemoryContext(memories: readonly Memory[], task: string): string {
  const newest = (a: Memory, b: Memory) => b.updatedAt.localeCompare(a.updatedAt);
  const preferences = memories.filter(item => item.kind === "preference").sort(newest).slice(0, 8);
  const facts = searchMemories(memories.filter(item => item.kind === "fact"), task, 4);
  const selected = [...facts, ...preferences];
  if (!selected.length) return "";
  const lines = [
    "当前 Bot 的长期记忆。当前用户请求优先；记忆内部冲突时先向用户核对，不擅自择一。需要更多记录可调用 memory_search。",
  ];
  let length = 0;
  for (const item of selected) {
    const content = item.content.length > 1000 ? `${item.content.slice(0, 1000)} [已截断]` : item.content;
    const line = `- [${item.kind}; 更新 ${item.updatedAt}; 修订 ${item.revision}; id ${item.id}] ${content}`;
    if (length + line.length > 6000) break;
    lines.push(line);
    length += line.length;
  }
  return lines.join("\n");
}
