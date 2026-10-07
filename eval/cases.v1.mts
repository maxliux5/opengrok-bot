export const fixtureCommit = "b40fb7bb4c809f6a1ec2a47972921f799d47fbf0";
const raw = `https://raw.githubusercontent.com/chyroc/open-muse/${fixtureCommit}`;
export const fixtureUrls = {
  readme: `${raw}/README.zh-CN.md`,
  workspace: `${raw}/shared/workspace-spec.ts`,
  provider: `${raw}/shared/ma-provider.ts`,
  toolbox: `${raw}/docs/environment-toolbox.md`,
} as const;

export type EvalStep = {
  prompt: string;
  deliverable: "answer" | "report";
  newConversation?: boolean;
  toolMinimums?: Record<string, number>;
  answerIncludes?: string[];
  memoryIncludes?: string[];
  files?: Array<{ path: string; equals?: string; includes?: string[] }>;
  report?: {
    sources: string[];
    includes?: string[];
    headings?: string[];
    minChars?: number;
  };
};

export type EvalCase = {
  id: string;
  category: "research" | "file" | "memory";
  reviewQuestion: string;
  steps: EvalStep[];
};

export const evalCases: readonly EvalCase[] = [
  {
    id: "r01_workspace_resources", category: "research",
    reviewQuestion: "是否准确说明工作区的 Agent、环境、记忆三类资源及 MA 与客户端的职责边界？",
    steps: [{
      deliverable: "report",
      prompt: `只用 browser_open 和 browser_read 实际读取 ${fixtureUrls.readme}。写至少 120 字中文 Markdown 报告，说明 Open Muse 工作区的三类资源，以及关闭 App 后任务继续由谁负责。报告包含“结论”“依据”“来源”标题，来源写所读 URL，用 publish_report 交付。`,
      toolMinimums: { browser_open: 1, browser_read: 1, publish_report: 1 },
      report: { sources: [fixtureUrls.readme], headings: ["结论", "依据", "来源"],
        includes: ["Agent", "环境", "记忆"], minChars: 120 },
    }],
  },
  {
    id: "r02_workspace_spec", category: "research",
    reviewQuestion: "是否区分源码声明的云端网络、工具策略与设备自定义工具，不擅自推断生产隔离？",
    steps: [{
      deliverable: "report",
      prompt: `实际打开并读取 ${fixtureUrls.workspace}。写至少 120 字中文 Markdown 报告，逐项解释 environmentSpec、agentSpec、memoryStoreName；请原样引用源码中的 unrestricted 和 always_allow 两个配置值，并说明它们对应哪个设置。报告写来源 URL，用 publish_report 交付。`,
      toolMinimums: { browser_open: 1, browser_read: 1, publish_report: 1 },
      report: { sources: [fixtureUrls.workspace], includes: ["environmentSpec", "agentSpec",
        "memoryStoreName", "unrestricted", "always_allow"], minChars: 120 },
    }],
  },
  {
    id: "r03_provider_difference", category: "research",
    reviewQuestion: "是否准确比较 Ark 与 Claude 的 modelChoice/projects 能力差异，不声称 Claude 已端到端验证？",
    steps: [{
      deliverable: "report",
      prompt: `实际打开并读取 ${fixtureUrls.provider}。写至少 120 字中文 Markdown 报告，比较 Ark 与 Claude 的 modelChoice、projects 两个布尔值，以及各自的 agentToolset。请保留这四个源码字段名的原文，写明来源 URL，用 publish_report 交付。`,
      toolMinimums: { browser_open: 1, browser_read: 1, publish_report: 1 },
      report: { sources: [fixtureUrls.provider], includes: ["modelChoice", "projects",
        "agentToolset", "Ark", "Claude"], minChars: 120 },
    }],
  },
  {
    id: "r04_cloud_outputs", category: "research",
    reviewQuestion: "是否正确说明云端成果目录、Library 导出与短期有效链接，不把 /workspace 误当成导出目录？",
    steps: [{
      deliverable: "report",
      prompt: `实际打开并读取 ${fixtureUrls.toolbox}。写至少 120 字中文 Markdown 报告，解释哪些文件会出现在 Library、应写入哪个绝对路径、/workspace 文件是否自动导出，以及链接有效期。请原样写出 /mnt/session/outputs 和 /workspace；附来源 URL，用 publish_report 交付。`,
      toolMinimums: { browser_open: 1, browser_read: 1, publish_report: 1 },
      report: { sources: [fixtureUrls.toolbox], includes: ["/mnt/session/outputs",
        "/workspace", "Library"], minChars: 120 },
    }],
  },
  {
    id: "f01_write_read", category: "file",
    reviewQuestion: "是否真的创建并回读指定文件，而非只在答复中声称完成？",
    steps: [{
      deliverable: "answer",
      prompt: "用 workspace_write 在 /workspace 创建 {{file}}，文件内容必须恰好为 {{marker}}。随后用 workspace_read 回读这个文件，在最终答复写出回读的完整内容。",
      toolMinimums: { workspace_write: 1, workspace_read: 1 },
      answerIncludes: ["{{marker}}"], files: [{ path: "{{file}}", equals: "{{marker}}" }],
    }],
  },
  {
    id: "f02_two_files_list", category: "file",
    reviewQuestion: "是否创建两份不同内容的文件，并以目录和文件回执核验？",
    steps: [{
      deliverable: "answer",
      prompt: "用 workspace_write 创建 {{file}}，内容恰好为 {{marker}}；另创建 {{secondFile}}，内容恰好为 {{secondMarker}}。用 workspace_list 检查两份文件，再分别用 workspace_read 回读。最终答复列出两个文件名。",
      toolMinimums: { workspace_write: 2, workspace_list: 1, workspace_read: 2 },
      answerIncludes: ["{{file}}", "{{secondFile}}"],
      files: [{ path: "{{file}}", equals: "{{marker}}" },
        { path: "{{secondFile}}", equals: "{{secondMarker}}" }],
    }],
  },
  {
    id: "f03_cas_overwrite", category: "file",
    reviewQuestion: "覆盖文件时是否先读取摘要、使用 expectedSha256，并回读最终内容？",
    steps: [{
      deliverable: "answer",
      prompt: "先用 workspace_write 创建 {{file}}，内容恰好为 {{marker}}；用 workspace_read 读取当前内容和 sha256。再用 workspace_write 携带 expectedSha256 将其覆盖为 {{secondMarker}}，最后用 workspace_read 核验新内容，并在最终答复写出新内容。",
      toolMinimums: { workspace_write: 2, workspace_read: 2 },
      answerIncludes: ["{{secondMarker}}"],
      files: [{ path: "{{file}}", equals: "{{secondMarker}}" }],
    }],
  },
  {
    id: "f04_web_to_file", category: "file",
    reviewQuestion: "是否依据真实读取的网页内容写文件，且文件来源可追溯？",
    steps: [{
      deliverable: "answer",
      prompt: `实际打开并读取 ${fixtureUrls.readme}。把网页标题、工作区资源名称和完整来源 URL 写入 {{file}}，再用 workspace_read 回读。文件末尾另写一行“校验码：{{marker}}”。最终答复给出文件名。不要发布报告。`,
      toolMinimums: { browser_open: 1, browser_read: 1, workspace_write: 1,
        workspace_read: 1 },
      answerIncludes: ["{{file}}"],
      files: [{ path: "{{file}}", includes: [fixtureUrls.readme, "{{marker}}"] }],
    }],
  },
  {
    id: "m01_explicit_preference", category: "memory",
    reviewQuestion: "明确的长期偏好是否调用 remember 并保存可追溯记录？",
    steps: [{
      deliverable: "answer",
      prompt: "请记住我的长期报告偏好：每份研究报告最后都写一行“校验码：{{marker}}”。请用 remember 保存这条偏好，然后简短确认。",
      toolMinimums: { remember: 1 }, memoryIncludes: ["{{marker}}"],
    }],
  },
  {
    id: "m02_recall_new_chat", category: "memory",
    reviewQuestion: "新对话未重复原文时，Bot 是否准确回忆自己的私有事实？",
    steps: [
      {
        deliverable: "answer",
        prompt: "请记住一条长期事实：我的项目校验代号是 {{marker}}。请用 remember 保存。",
        toolMinimums: { remember: 1 }, memoryIncludes: ["{{marker}}"],
      },
      {
        newConversation: true, deliverable: "answer",
        prompt: "我的项目校验代号是什么？只根据你保存的记忆回答。",
        answerIncludes: ["{{marker}}"],
      },
    ],
  },
  {
    id: "m03_preference_to_report", category: "memory",
    reviewQuestion: "新对话报告是否沿用保存的格式偏好，且来源确实已读？",
    steps: [
      {
        deliverable: "answer",
        prompt: "请记住长期报告格式偏好：报告依次使用“结论”“依据”“来源”三个标题，最后一行写“校验码：{{marker}}”。请用 remember 保存。",
        toolMinimums: { remember: 1 }, memoryIncludes: ["{{marker}}"],
      },
      {
        newConversation: true, deliverable: "report",
        prompt: `请实际打开并读取 ${fixtureUrls.readme}，研究 Open Muse 的三类工作区资源。交付至少 120 字中文 Markdown 报告，附所读页面来源 URL。请遵循我已有的报告偏好。`,
        toolMinimums: { browser_open: 1, browser_read: 1, publish_report: 1 },
        report: { sources: [fixtureUrls.readme], headings: ["结论", "依据", "来源"],
          includes: ["{{marker}}"], minChars: 120 },
      },
    ],
  },
  {
    id: "m04_explicit_search", category: "memory",
    reviewQuestion: "模型是否真的通过 memory_search 读回保存的事实，并准确复述？",
    steps: [
      {
        deliverable: "answer",
        prompt: "请记住一条长期事实：我的校验词是 {{marker}}。请用 remember 保存。",
        toolMinimums: { remember: 1 }, memoryIncludes: ["{{marker}}"],
      },
      {
        newConversation: true, deliverable: "answer",
        prompt: "请先用 memory_search 搜索“校验词”，然后告诉我保存的校验词。",
        toolMinimums: { memory_search: 1 }, answerIncludes: ["{{marker}}"],
      },
    ],
  },
];
