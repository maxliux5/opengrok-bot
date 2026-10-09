# 开发与测试

[返回 README](../README.md) · [English](TESTING.en.md)

以下命令均在仓库根目录执行。正式安装、网络规则和备份见[运行手册](../OPERATIONS.md)；历史通过记录见[实施计划](../PLAN.md)。

## 手动启动开发环境

使用与 README 相同的 Linux、Node.js、pnpm、Docker 和 sudo 前提。已有 systemd 实例时，不要同时启动占用相同端口的开发服务。需要并行开发时，为数据库、数据目录、桌面和服务端口分别配置隔离环境。

准备依赖、桌面镜像和受限网络：

```sh
pnpm install
pnpm dev:init
sudo -n env DOCKER_CONFIG="$HOME/.docker" docker compose -f infra/desktop/compose.yaml build desktop
node scripts/prepare-desktop-network.mjs
```

在独立终端运行 `node scripts/start-egress.mjs`，保持网关运行。宿主机需要上游代理时，先设置 `OPENGROK_BROWSER_PROXY`。然后在另一终端运行 `node scripts/start-containers.mjs`。

分别打开三个终端，在每个终端加载环境，再启动对应服务：

```sh
set -a
. .local/dev.env
set +a
pnpm dev:host
```

第二、第三个终端将最后一行分别换为 `pnpm dev:api` 和 `pnpm dev:worker`。最后运行 `pnpm dev:web`，打开 [HTTP 开发入口](http://127.0.0.1:5173/)。未配置 `OPENGROK_SETUP_TOKEN_FILE` 的开发实例不要求初始化口令，只能用于受信任的本机测试。

## 常规检查

```sh
pnpm test
pnpm -r typecheck
pnpm --filter @opengrok/web build
```

`pnpm test` 运行核心模块、桌面运行时与出口网关的常规测试，不会执行下面的独立 E2E 脚本，也不会触发真实模型调用。

## 首次使用端到端测试

先准备 `.local/dev.env`、`opengrok-postgres` 数据库容器、`opengrok-desktop:0.1.0` 镜像、`desktop_default` 网桥及其出口网关和防火墙。测试需要免交互 sudo，并要求 `3841/3844/3845/6081/8444` 端口空闲。

```sh
pnpm tls:init
pnpm --filter @opengrok/web build
pnpm exec tsx tests/onboarding-web-smoke.mjs
```

脚本自建全新数据库、数据目录和空白 Linux 桌面容器，复用受限出口网络，不访问正式账号或桌面卷。默认模型为本机固定响应夹具，检查以下行为：

- 建号后打开向导，保存模型、配置预建 Bot，刷新后复用已保存实体。
- Worker 缺失及恢复、host 停止和成果目录只读时的诊断。
- OpenAI 兼容与 Anthropic 协议的流式和非流式探测，文本模式及缺失工具调用。
- 错误密钥、20 秒超时、并发拒绝、未登录拒绝和非法 Origin 拒绝。
- 修改配置后重新测试，错误模型不能经向导保存，探测不创建 Run。
- 发布并打开 Markdown 报告，核对来源链接和文件 SHA-256。
- noVNC 非空画面、键盘实际导航、接管期间拒绝 Agent 操作、归还后的页面回读。
- 320px 和 390px 页面无横向溢出，原 Bot 设置表单仍可保存配置。
- API 返回值与连接测试日志不包含测试密钥或上游私密错误正文。

使用系统 Chromium 时设置 `OPENGROK_TEST_CHROMIUM_EXECUTABLE=/path/to/chromium`；未设置时使用 Playwright 已安装的浏览器。脚本结束会停止临时服务、删除临时桌面、清空测试库的模型密钥。数据库、截图和 `.local/onboarding-*` 日志保留供核对，不要上传这些私有证据。

### 使用真实模型

将测试端点与密钥放入 Git 忽略的 `.local/test-proxy.json`，文件权限设为 `0600`。配置格式如下，也兼容 `providers.cliproxy` 结构：

```json
{"baseUrl":"https://your-proxy.example/v1","apiKey":"your-test-key"}
```

```sh
export OPENGROK_TEST_PROXY_CONFIG="$PWD/.local/test-proxy.json"
OPENGROK_ONBOARDING_REAL_MODEL=traex/Gemini-3-Flash-Preview \
  pnpm exec tsx tests/onboarding-web-smoke.mjs
```

将模型 ID 换成代理实际提供的值。只有向导保存、报告任务和已保存模型复测使用真实模型，协议矩阵和故障用例仍使用夹具。测试会产生模型请求费用。配置文件可含受信任的密钥获取命令，因此不要使用不可信来源的配置文件。

2026-10-09 的完整夹具回归与真实 TraeX Gemini 路径均通过，真实报告已对照本次网页回读检查。实际接管导航与归还后的 Agent 回读一致。Run、成果标识与失败修正记录见 [PLAN.md](../PLAN.md)。单条路径通过不代表一般任务质量通过，冻结评测见 [eval/README.md](../eval/README.md)。

## 按场景选择回归

先阅读脚本的前置条件。多数历史脚本要求预建隔离服务，不能直接用正式数据库运行。下面的文件名均相对于仓库根目录。

| 场景 | 脚本 | 环境与范围 |
| --- | --- | --- |
| 建号与改密 | `tests/password-web-smoke.mjs` | 自建隔离库；`OPENGROK_PASSWORD_HTTPS_TEST=1` 启用 HTTPS，`OPENGROK_PASSWORD_SETUP_TOKEN_TEST=1` 验证初始化口令 |
| 预算与授权 | `tests/budget-smoke.mts`、`tests/capability-smoke.mts`、`tests/capability-approval-smoke.mts` | 隔离库，覆盖 7 种预算边界、授权快照、撤销与 host 拒绝 |
| 控制权交接 | `tests/control-pending-smoke.mjs`、`tests/control-host-busy-smoke.mts`、`tests/control-web-pending-smoke.mjs` | 按脚本配置独立运行时或隔离 Host/API，检查在途操作与交接 |
| Web 接管登录 | `tests/web-login-takeover-smoke.mjs` | 公开演示站点；使用 `OPENGROK_WEB_SMOKE_PASSWORD`，HTTPS 可设 `OPENGROK_WEB_SMOKE_ORIGIN=https://127.0.0.1:8444/` |
| 终端与取消 | `tests/cancel-inflight-smoke.mts`、`tests/shell-stop-smoke.mjs`、`tests/web-cancel-approval-smoke.mjs` | 验证定向停止、停止意图先到和审批等待取消，遵守各脚本的隔离配置 |
| 终端 Web 回执 | `tests/shell-command-stop-smoke.mts`、`tests/web-shell-command-smoke.mjs` | 前者可设 `OPENGROK_STOP_VIA_WEB=1`，后者检查桌面与手机回执 |
| 多 Bot 交接 | `tests/handoff-smoke.mts`、`tests/handoff-agent-smoke.mts`、`tests/handoff-web-smoke.mts` | 新库 `opengrok_handoff_20261006`、API `3841`；Agent 使用假模型 `3850`，Web 使用预览 `8444` |
| 交接崩溃恢复 | `tests/handoff-recovery-smoke.mts` | 新库 `opengrok_handoff_recovery_20261006` 与专属 `.local/handoff-recovery-20261006`，自启假模型和 Worker |
| GitHub Issue 审批 | `tests/github-issue-smoke.mts` | 新库 `opengrok_github_YYYYMMDD`、独立数据目录；只写本机假 GitHub API，会更新 `docs/screenshots/` 中的测试截图 |
| 双 Worker 并发 | `tests/parallel-bots-smoke.mts` | 新库 `opengrok_parallel_YYYYMMDD`，同时设置 `OPENGROK_DB_NAME` 与 `OPENGROK_PARALLEL_DB_NAME`；不访问正式桌面 |
| 桌面输入与审批 | `tests/desktop-runtime-smoke.mjs`、`tests/desktop-approval-invalid-smoke.mts` | 前者操作真实桌面；后者验证越界和旧观察拒绝，先核对目标运行时 |

## 其他真实模型回归

除独立视觉探测和交接探测外，真实模型回归通常需要隔离数据库、API `3841`、Worker 和 Host `3844`。并行运行时，显式配置独立的 `OPENGROK_DATA_DIR`、runtime/VNC 端口及数据库，并将测试 Host 的 `OPENGROK_DESKTOP_MANAGED` 设为 `0`。不要共用正式 Host journal。

所有代理测试显式读取 `OPENGROK_TEST_PROXY_CONFIG`。复用隔离库中的 `smoke` 账号时，设置 `OPENGROK_TEST_PASSWORD`；Web 接管脚本使用 `OPENGROK_WEB_SMOKE_PASSWORD`。

| 目的 | 脚本与选择 |
| --- | --- |
| 报告与跨对话偏好 | `pnpm exec tsx tests/real-traex-smoke.mts`；Claude 可加 `OPENGROK_TEST_PROVIDER=anthropic OPENGROK_TEST_MODEL_ID=agy/claude-sonnet-4-6` |
| 同一 Bot 切换模型 | `tests/real-provider-switch.mts` |
| 真实网页表单 | `tests/real-traex-interactive.mts` |
| 独立图像输入 | `tests/traex-vision-smoke.mts` |
| 截图理解与实际页面核对 | `tests/real-traex-vision-run.mts` |
| 人工给定坐标的桌面操作 | `tests/real-traex-desktop-run.mts`；不计作模型自主定位成功 |
| 真实父 Bot 的交接选择 | `tests/real-handoff-traex.mts`；新库 `opengrok_real_handoff_YYYYMMDD` 和对应 `.local/` 目录，子 Bot 使用固定响应模型，无需 API、Host 或桌面 |

固定题集、版本要求、运行方式和内容复核口径集中在[评测文档](../eval/README.md)。不要把工具执行通过率当作报告内容准确率。

## 涉及重启或网络故障的测试

以下部分脚本会修改正在运行的桌面或网关。先备份，只在正式工作空间零账号、电脑空闲且没有重要会话时运行；不得绕过脚本的前置检查。

| 影响 | 脚本与显式开关 |
| --- | --- |
| 重建桌面，检查登录保留 | `OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1 node tests/login-persistence-smoke.mjs` |
| 重建桌面，检查服务恢复 | `OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1 node tests/restart-smoke.mjs` |
| 杀停隔离服务、丢回执与桌面重建 | `tests/service-restart-smoke.mts`；新库 `opengrok_restart_*`、专用 `.local/restart-*` 与 `OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1` |
| 短暂停止正式网关 | `OPENGROK_ALLOW_EGRESS_FAILURE_TEST=1 node tests/egress-failure-smoke.mjs` |
| 在当前空闲桌面上运行 Gemini | `OPENGROK_ALLOW_REAL_EGRESS_TEST=1 OPENGROK_REAL_EGRESS_DB=opengrok_real_egress_<新后缀> node tests/real-traex-egress-runner.mjs` |

独立出口回归 `OPENGROK_ALLOW_ISOLATED_EGRESS_TEST=1 node tests/isolated-desktop-egress-smoke.mjs` 使用一次性第二网桥和空白桌面。传入恢复清单、相对工作文件路径及预期 SHA-256 时，可克隆恢复卷进行核对；`OPENGROK_ISOLATED_AGENT_TEST=1` 增加固定模型报告任务，`OPENGROK_ISOLATED_RESTORED_DB_TEST=1` 再克隆恢复库检查旧成果和新报告。恢复参数、安全顺序与网络清理见[隔离恢复](../OPERATIONS.md#隔离恢复)。

故障测试的通过证据与局限继续保存在 [PLAN.md](../PLAN.md)。没有重新执行的历史测试，不因文档整理获得新的验收状态。
