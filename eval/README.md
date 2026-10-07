# 冻结任务集 v1

这组回归检验个人 Bot 的研究、文件和记忆工作流。`cases.v1.mts` 固定 12 题，每个模型重复 3 次，共 36 次尝试；研究资料固定到 Open Muse commit `b40fb7bb4c809f6a1ec2a47972921f799d47fbf0` 的公开原始文件。任务分类为研究 4、文件 4、记忆 4。模型调用走 TraeX Proxy，网页仍要由同屏 Chromium 实际打开并读取。

## 运行边界

- 仅对个人受信本机运行。需要已启动的桌面 runtime、隔离测试 API `3841`、测试 Worker、测试 Host `3844` 和独立评测数据库。旧实例使用 `opengrok_test` 与 runtime `3843`；新评测可以使用 `opengrok_eval_YYYYMMDD`、独立数据目录及 runtime `3845`，避免占用正式电脑。Host、API、Worker 必须共用评测数据目录和数据库配置。
- 评测程序同时校验 API 地址、数据库名和登录会话在同一数据库中。隔离库名必须是 `opengrok_test` 或带日期的 `opengrok_eval_YYYYMMDD`（可加单字母后缀）；runtime 地址只接受本机 `3843` 或 `3845`。运行前必须将 `OPENGROK_TEST_PROXY_CONFIG` 指向私有 JSON 文件，支持顶层 `baseUrl`/`apiKey` 或已有的 `providers.cliproxy` 结构；文件及其中的命令型密钥只应来自可信来源。评测仅在测试数据库创建模型配置，结束时将该配置中的加密密钥清空。评测日志不要写入仓库或公开分享，它包含任务文本、Run ID 和可能的私人偏好。
- API 启动时运行迁移。测试账号需事先在隔离 API 创建，密码通过 `OPENGROK_EVAL_PASSWORD` 传入。所有连接测试数据库的进程均应使用相同的隔离数据库配置，例如本机旧测试实例使用 `env -u DATABASE_URL OPENGROK_DB_NAME=opengrok_test OPENGROK_DB_PORT=55432`。使用独立数据目录时，`DATABASE_URL` 还须指向实际 PostgreSQL socket。不能把评测进程指向正式数据库。
- 评测只覆盖公开网页、受控工作文件和记忆；不会批准终端、浏览器输入或桌面键鼠动作。旧实例的测试 Host 共享正式持久电脑；使用独立 runtime `3845` 时浏览器和工作卷也隔离。

本机旧测试 PostgreSQL 实例的启动参数示例；每行应在独立终端执行，并先停止开发 Host `3842`。若使用其他测试数据库端口，统一修改这四个进程的 `OPENGROK_DB_PORT`：

```sh
env -u DATABASE_URL OPENGROK_DB_NAME=opengrok_test OPENGROK_DB_PORT=55432 \
  OPENGROK_HOST_PORT=3844 OPENGROK_BROWSER_PROXY="$https_proxy" pnpm dev:host
env -u DATABASE_URL OPENGROK_DB_NAME=opengrok_test OPENGROK_DB_PORT=55432 \
  OPENGROK_API_PORT=3841 OPENGROK_HOST_URL=http://127.0.0.1:3844 pnpm dev:api
env -u DATABASE_URL OPENGROK_DB_NAME=opengrok_test OPENGROK_DB_PORT=55432 \
  OPENGROK_HOST_URL=http://127.0.0.1:3844 pnpm dev:worker
```

评测终端同样先清除 `DATABASE_URL` 并设测试数据库参数，再在仓库根目录运行：

```sh
unset DATABASE_URL
export OPENGROK_DB_NAME=opengrok_test OPENGROK_DB_PORT=55432
export OPENGROK_TEST_PROXY_CONFIG="$PWD/.local/test-proxy.json"
# 若宿主机未安装 Playwright 浏览器，可指定已安装的 Chromium 可执行文件：
# export OPENGROK_TEST_CHROMIUM_EXECUTABLE=/path/to/chromium
OPENGROK_EVAL_PASSWORD='测试账号密码' pnpm exec tsx eval/run.mts --list
OPENGROK_EVAL_PASSWORD='测试账号密码' pnpm exec tsx eval/run.mts
OPENGROK_EVAL_PROVIDER=anthropic OPENGROK_EVAL_MODEL_ID=agy/claude-sonnet-4-6 \
  OPENGROK_EVAL_PASSWORD='测试账号密码' pnpm exec tsx eval/run.mts
```

单题诊断用 `--case r04_cloud_outputs --repeats 3`。程序默认把追加式 JSONL 账本写到被 Git 忽略的 `.local/eval/results-v1.jsonl`；可用 `OPENGROK_EVAL_RESULTS` 指定私有路径。每条记录包含固定夹具 commit、任务清单和 runner 的 SHA-256；后续 runner 另记录应用源码快照 hash 与 `OPENGROK_EVAL_VARIANT`。修改清单需升版本，不能覆盖既有失败记录。

## 计分与复核

机械检查读取数据库中的工具回执、API 成果元数据和原始文件，核对 Run 状态、必需工具、来源是否真正被 `browser_read`、成果字节摘要、工作文件内容与 CAS 摘要、记忆来源和跨对话答复。它不能判断研究内容是否正确。4 道研究题和 `m03_preference_to_report` 必须逐份人工阅读报告，核对任务 `reviewQuestion`、原始资料的事实边界和结论；其余 7 题用确定性检查验收。

```sh
pnpm exec tsx eval/ledger.mts summary <session-id>
pnpm exec tsx eval/reports.mts <session-id> r04_cloud_outputs
pnpm exec tsx eval/ledger.mts review <attempt-id> pass '核对来源与结论的具体理由'
pnpm exec tsx eval/ledger.mts review <attempt-id> fail '指出与原始来源冲突的具体理由'
```

人工评审采用追加事件；更正评审时再追加一条，最新决策生效，原判断仍可追溯。合格尝试要求机械检查通过，并且需要人工评审的题目得到 `pass`。所有发起尝试保留在分母，包括模型错误、超时、环境失败和人工驳回。单个 Run 成功及成果可下载，只说明交付链路有效，不等于研究事实正确。

## 2026-10-06 基线

| 模型与协议 | 机械通过 | 人工复核后合格 | Run 数 | 报告 token 合计 | 尝试耗时合计 | 失败工具调用 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `traex/Gemini-3-Flash-Preview` / OpenAI-compatible | 36/36 | 31/36 | 45 | 339,916 | 442,364 ms | 6 |
| `agy/claude-sonnet-4-6` / Anthropic | 36/36 | 26/36 | 45 | 961,360 | 944,031 ms | 0 |

基线会话 ID 分别为 `80e6b8b2-b814-4561-8745-8d304687c32f` 和 `7948253b-16dd-4814-92a7-60d1916e98d3`。两组使用相同清单 hash `006b200c6247587a843fa11e3e35f16fef87f20db6fbbf85f379f313a7725595`、runner hash `637ff48f3016d9b93cbd461fb4c972bc7901a576f8896c438443648ddc8a9d4e` 和同一修改前应用源码快照。研究题是主要短板：模型将设备工具策略泛化到全部工具，从版本号推断能力，将缩写 MA 擅自展开，并把约 7 天的导出文件保留期写成签名链接有效期。后者来源只称链接短期有效，没有给出精确 TTL。机械检查不会拦下这些语义错误。一次原标为通过的 Claude `r01` 报告把“Claude 不提供方舟独有能力”误写成“部分能力尚未端到端验证”，2026-10-06 追加更正评审后合格数由 27 降为 26，原评审事件仍保留。

聚焦试验保留为独立会话：调整来源字段提示后，Gemini 的 `r02` 三次不再触发报告发布工具失败，内容复核仍为 0/3；Claude 的 `r03` 三次复核为 3/3；加强来源范围提示后，Gemini 的 `r04` 三次复核仅为 1/3。2026-10-06 在独立 `opengrok_eval_20261006` 库与桌面上复测 Claude `r04` 两组各 3 次，机械检查均 3/3，人工复核均 0/3。第二组增加逐句核对提示后仍无改善，故未保留该提示改动。不同源码与 runner 版本的聚焦结果不可合并到基线分母，不能据此宣称整体质量改善。当前发布目标是每个声明支持的模型至少 30/36；Gemini 达标，Claude 未达标。两个模型共用 TraeX Proxy，未证明独立网关可用性。

## 2026-10-06 后续全量验证

保留原始双模型基线不变。另一轮隔离库 `opengrok_eval_20261006_g`、独立桌面和当前应用源码上，`traex/GPT-6-Astra`（OpenAI-compatible）完成同一冻结任务集的 36 次尝试、45 个 Run。机械检查 36/36；逐份复核 12 份研究报告与 3 份带偏好报告后，最终合格 36/36，失败工具调用 0。供应商报告 token 合计 357,324，尝试耗时合计 902,682 ms。会话 ID 为 `be74ad16-5502-4716-a81f-f81df0d8db97`；清单 hash 仍为 `006b200c6247587a843fa11e3e35f16fef87f20db6fbbf85f379f313a7725595`，runner hash 为 `e5e6587e054492c884c2a5973e86b1921b172fcdcd5d452193556e42713d2462`，应用源码快照 hash 为 `fab46876b1b194412cfd654b5388f0f395504beb1008bf3c33d5a9ff98e54940`。测试模型配置的加密密钥已清空，隔离库没有活动 Run。

此前同库聚焦诊断没有并入这 36 次：增加“报告简洁、删除无依据论点”的通用提示后，Claude Sonnet 的 `r04` 仍为 0/3，提示改动已撤回；Claude Opus Thinking 的 `r04` 为 2/3、`r03` 为 0/3。Astra 在正式全量前各做过一次 `r03`、`r04` 探针并通过人工复核。完整运行沿用已知的冻结题集，不能当作未见过问题的盲测；它证明该模型 ID 在此契约和题集上达到 30/36 门槛，不证明桌面视觉、交互质量、其他网站或长期稳定性。Gemini 与 Astra 的调用均经过同一 TraeX Proxy，未验证上游供应商身份和网关故障独立性；token 尚未换算成费用，Astra 的这轮耗时也不可直接与不同机器、时点的基线作纯模型延迟比较。

`semantic-probe.mts` 是离线诊断脚本，不在发布链路。用同一 Claude 再审其三份错误 `r04` 报告，三份均被误判通过；改用 Gemini 审这三份，三份均指出至少一个真实错误，但未总能列出全部错误。对旧基线的 12 份 Claude 研究报告做交叉审核，按更正后的人工标签，Gemini 标记了 10 份失败中的 9 份，放过 2 份通过中的 2 份；遗漏 1 份 `r02`，部分问题说明偏离人工复核重点。该小样本只能支持将跨模型审核作为辅助信号，尚不足以自动批准报告或替代人工评审。

上述 token 来自供应商报告，用量并非费用；未登记价格版本、输入输出计价和网关计费差异。尝试耗时包含串行测试与中间等待，不应直接当作纯模型延迟。当前评测账本及测试数据库都在本机，尚未纳入备份与正式发布链路。
