# 本机运行与恢复

当前是个人单机部署。正式 Web 入口监听 `https://127.0.0.1:8443/`，API、computer-host、desktop-runtime 分别监听本机 `3848`、`3842`、`3843`。PostgreSQL 和桌面由 Docker Compose 管理；桌面网络准备、宿主机出口网关、API、两只 Worker、Host、Web 由 systemd 用户服务守护，每分钟运行一次监测。HTTPS 使用本机自签证书，公开域名、可信证书、外部告警接收方和异机备份尚未交付，不能将以下步骤当作公网发布说明。旧 HTTP 开发进程 `5173/3840` 已停止，按需手动启动。

## 启动与停机

仓库根目录先执行 `pnpm install`、`pnpm dev:init`、`pnpm --filter @opengrok/web build`、`pnpm tls:init`。本机首次启用用户服务：

```sh
node scripts/install-user-services.mjs --dry-run
node scripts/install-user-services.mjs
systemctl --user enable --now opengrok-network.service opengrok-egress.service \
  opengrok-containers.service opengrok-host.service \
  opengrok-api.service opengrok-worker.service opengrok-worker-2.service \
  opengrok-web.service opengrok-monitor.timer
```

安装脚本仅更新自己管理的 unit；已存在不同内容时先检查，再使用 `--replace`。首次安装会把当前 `OPENGROK_BROWSER_PROXY`、`OPENGROK_EGRESS_PORT`、`http_proxy`、`https_proxy`、`no_proxy` 保存到权限 0600 的 `.local/service-proxy.env`；以后 `--replace` 只更新 unit，显式更换代理配置须另加 `--replace-proxy`。该文件不含数据库或模型密钥。需要用户退出登录后服务仍运行时，由管理员启用 `loginctl enable-linger <用户名>`；当前机器已启用。启动脚本需要可用的免交互 sudo Docker 权限和已经构建的桌面镜像；镜像首次准备见 README。检查 `systemctl --user status opengrok-*.service opengrok-monitor.timer`、`OPENGROK_MIN_WORKERS=2 pnpm monitor`，再打开 [本机 Web](https://127.0.0.1:8443/)。

`OPENGROK_BROWSER_PROXY` 现在只用于宿主机出口网关连接上游代理；桌面 Compose 固定使用本机网关。重跑安装脚本不会覆盖已保存的代理配置。2026-10-06 Chromium sandbox 升级时曾暴露未保存的上游代理，现由 `.local/service-proxy.env` 持久配置。桌面 Compose 使用固定的 [Playwright v1.63.0 seccomp 配置](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json)，其 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`；升级 Docker 或 Playwright 时须重新验证沙箱启动、网页登录和桌面截图。

桌面公网规则：`opengrok-network.service` 先创建但不启动桌面，给其 IPv4-only 网桥安装 `DOCKER-USER` 和 `INPUT` 规则；转发方向仅允许到本机配置的上游 DNS 的 UDP/TCP 53，其余一律拒绝；到宿主机只允许已建立连接和网桥网关的 TCP 3888。`opengrok-egress.service` 在该网桥网关监听，HTTP 仅允许公开地址的 80 端口，HTTPS CONNECT 仅允许公开地址的 443 端口；解析结果含任意私网地址即拒绝，并固定所选 IP。可见浏览器和受审批的 shell 都使用网关。恢复网桥可与正式网桥并存，防火墙校验允许精确绑定其他网桥的受管规则排在前面，宽泛或同网桥的前置规则仍会报错。`opengrok-containers.service` 在启动桌面前验证防火墙和网关健康，Host 重建桌面前再次验证防火墙。桌面 Docker 重启策略为 `no`，避免 daemon 自启桌面先于用户服务安装规则。

本机验收：正式零账号、电脑空闲时重建后，浏览器 `browser_open -> browser_read` 成功读取公开 Sauce Demo；容器内直连 `https://example.com` 被拒，经网关访问公开 HTTPS 返回 200，访问云元数据 HTTP 返回 403，受管 shell 的相同正反请求分别返回 200/403；`pnpm monitor` 返回 `ok`。一次性第二网桥的桌面又验证了公开 HTTP 200、HTTPS 网页可读、直连拒绝、元数据 403，以及两套防火墙规则并存时正式规则仍通过校验。可重复检查 `sudo -n "$(command -v node)" scripts/desktop-firewall.mjs verify desktop_default 3888` 与 `pnpm monitor`；网关健康检查的地址应先从 `docker network inspect desktop_default` 读取，再访问其 `3888/health`。网桥地址会随重建变化。DNS 查询本身仍可能成为数据外传通道，非代理感知的桌面程序无法访问公网；Docker daemon 或宿主防火墙重载瞬间的规则保持性尚未故障注入。此边界只面向受信任的单用户部署，不能作为不受信程序或公网多租户隔离依据。

网关故障回归会短暂停止正式出口网关，只在正式工作空间零账号且电脑空闲时运行：`OPENGROK_ALLOW_EGRESS_FAILURE_TEST=1 node tests/egress-failure-smoke.mjs`。脚本先检查正常公网代理路径，停网关后要求桌面直连仍失败、代理请求失败、Web/API/Host 继续可用且监测报 `egressGateway_unavailable`；随后在 `finally` 中恢复网关并要求监测回到 `ok`。2026-10-06 本机复跑通过，故障期间 `pnpm monitor` 退出码 2，恢复后退出码 0。请勿在有账号、活动任务或真实网页会话时绕过脚本前置条件手工停网关。

浏览器网络策略的隔离回归在一次性、无外网容器中运行，不接触正式 profile：

```sh
sudo -n docker run --rm --network none --user 10001:10001 \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=$PWD/infra/desktop/seccomp_profile.json" \
  -v "$PWD/tests/browser-network-policy-smoke.mjs:/probe.mjs:ro" \
  --entrypoint node opengrok-desktop:0.1.0 /probe.mjs
```

成功输出包括 `privateHttpRequests:0`、`privateWebSocketUpgrades:0`、`close:1008`，以及 Service Worker 允许/阻止模式的活跃数 `1/0`。此测试覆盖浏览器路由，不证明 shell 或其他桌面程序的网络隔离。

有任务运行、等待审批或等待电脑时，先让其完成或从 Web 明确取消并核对终态。停机顺序：两个 Worker、API、Host，最后 `docker compose -f infra/desktop/compose.yaml stop desktop`；PostgreSQL 保持运行供 `pg_dump` 使用。不要在受管 shell 或浏览器动作状态未知时直接宣称备份具有一致业务语义。

本机守护进程停机可执行：

```sh
systemctl --user stop opengrok-monitor.timer opengrok-web.service \
  opengrok-worker.service opengrok-worker-2.service \
  opengrok-api.service opengrok-host.service opengrok-containers.service
sudo -n env DOCKER_CONFIG="$HOME/.docker" docker compose -f infra/desktop/compose.yaml stop desktop
systemctl --user stop opengrok-egress.service
```

PostgreSQL 保持运行以供离线备份，网络防火墙规则也保留。恢复时先 `systemctl --user restart opengrok-network.service`，再启动 `opengrok-egress.service`、`opengrok-containers.service`，最后启动 Host、API、两个 Worker、Web 和监测 timer。手动停机不会删除持久卷。服务日志用 `journalctl --user -u opengrok-worker.service -u opengrok-worker-2.service -n 100 --no-pager` 查看。

## 本机 HTTPS 入口

正式 API unit 指定 `OPENGROK_SETUP_TOKEN_FILE` 为 `.local/setup.token` 的绝对路径。`install-user-services.mjs` 在首次安装或从无口令的旧 unit 升级时生成 256-bit 随机口令，文件权限 0600；`--dry-run` 不生成。用户首次打开 Web，从本机读取该文件内容填入“初始化口令”，并自己选择用户名与密码。缺失/错误口令均不会创建账号；成功建号后文件删除，数据库事务仍保证只能创建一个账号。口令不要放进聊天、日志或仓库。同 UID 进程可读取用户私有文件，当前只面向受信任的个人部署。若建号前误删文件，API 会返回 503；需先核对数据库仍无账号、停用 API，再在本机安全地生成新的 0600 口令文件。

证书和私钥保存在已忽略的 `.local/tls`，`pnpm tls:init` 不会覆盖现有证书。systemd 用户服务已用 `OPENGROK_HTTPS=1` 启动 API，并将 Web 代理至 `3848`。单独调试时可停掉对应 service，再手动运行：

```sh
set -a; source .local/dev.env; set +a
OPENGROK_API_PORT=3848 OPENGROK_HTTPS=1 \
  OPENGROK_SETUP_TOKEN_FILE="$PWD/.local/setup.token" \
  OPENGROK_WEB_ORIGIN=https://127.0.0.1:8443 pnpm dev:api

OPENGROK_API_TARGET=http://127.0.0.1:3848 pnpm serve:web
```

第二条命令在独立终端执行。浏览器须信任本机证书，生产环境应换成可信证书和受控域名。2026-10-06 已检查正式入口的 HTTPS 页面、API 代理和未认证 WebSocket 拒绝。在独立数据库、数据目录与桌面容器的 `8444` HTTPS 实例上，登录 Cookie 含 `Secure`、`HttpOnly`、`SameSite=Lax`；已通过 `wss` 桌面画面、人类接管登录、归还后 Agent 回读及未认证连接以 `1008` 关闭的 Web E2E。390px 与 320px 手机视口通过原尺寸裁剪、拖动画面、回到适应窗口及无横向溢出的回归；390px 下人工接管后经触摸、输入和屏幕回车导航公开站点。复杂应用的手机触控仍待更多场景验证。正式 `8443` 工作空间尚无账号，因此还没有正式账号的已认证桌面验收。

账号创建后，侧栏底部钥匙按钮可修改密码：API 验证当前密码，事务内更新密码摘要、撤销旧会话并发放新 Cookie；本机 API 同时关闭已连接的桌面 WebSocket 和任务事件流。`node tests/password-web-smoke.mjs` 在全新隔离库与 Web 端口 `5174` 验证未认证拒绝、同密码拒绝、错误当前密码不撤销会话、正确改密后旧会话与旧密码失效、新密码登录、第二会话已建立的 SSE 主动结束，以及 1280px/390px 弹窗无溢出。`OPENGROK_PASSWORD_HTTPS_TEST=1 node tests/password-web-smoke.mjs` 改用已有 `.local/tls` 自签证书和构建后的 Web，在独立 HTTPS `8444` 验证同一流程及登录/改密 Cookie 的 `Secure`、`HttpOnly`、`SameSite=Lax` 属性。测试产生的排队 Run 会取消；测试库和 `.local/password-web-*` 目录保留供检查。正式 `8443` 目前仍无账号，不能以隔离测试代替真实个人账号的改密验收。

隔离 HTTPS 回归 `OPENGROK_PASSWORD_HTTPS_TEST=1 OPENGROK_PASSWORD_SETUP_TOKEN_TEST=1 node tests/password-web-smoke.mjs` 还验证口令文件暂时缺失时返回 503、数据库仍无账号，文件恢复后才可完成首次建号；该测试使用独立数据库，不消耗正式口令。

## GitHub Issues 连接器

连接器默认关闭，正式实例没有配置外部仓库或令牌。选择专用测试仓库后，在已被 Git 忽略的 `.local/github.env` 中配置以下两项，并将文件权限设为 `0600`：

```text
OPENGROK_GITHUB_REPOSITORY=owner/repo
OPENGROK_GITHUB_TOKEN=<仅授予该仓库 Issues 读写权限的令牌>
```

API 和两只 Worker 的 systemd unit 会读取该可选环境文件；Host、桌面容器和 Web 静态服务不读取。更改后运行 `node scripts/install-user-services.mjs --replace`，再重启 `opengrok-api.service`、`opengrok-worker.service` 和 `opengrok-worker-2.service`。先确认没有活动 Run 或待审批操作。登录后的 Bot 设置会显示固定仓库，未配置时无法新启用 `github_issues` 能力；已有 Bot 的该能力可撤销。令牌不会交给模型，模型只能提交标题和正文，Web 审批展示全文。创建后的 Issue 正文含隐藏操作 ID 标记，用于丢响应核对。GitHub API 返回不确定结果且标记尚未找到时，任务保留 `unknown`，操作者先检查仓库，不能直接重复发送。同一仓库超过最近 1000 条 Issue 时，自动扫描可能找不到旧标记，仍需人工核对。[GitHub Issues API 权限说明](https://docs.github.com/en/rest/issues/issues)

`tests/github-issue-smoke.mts` 只连接本机假 GitHub API，已验证拒绝零写入、桌面/手机审批、成功回读、批准后撤销能力零写入、明确 403 零创建和丢响应不重复创建。真实仓库写入尚未执行；验收时应使用明确授权的测试仓库，创建后回读、再由操作者清理测试 Issue，并保留外部 URL 和 Run 回执。

## 基本监测

部署后的双 Worker 检查运行 `OPENGROK_MIN_WORKERS=2 pnpm monitor`；启动脚本会读取 `.local/dev.env` 和本机 CA。检查 Web/API/Host/桌面、出口网关和防火墙健康、Worker 20 秒心跳、可执行队列等待、例程预约/投递积压、近 1 小时失败 Run 与例程投递、模型步骤及预算 token 估计、成果所在磁盘可用率。输出 JSON，退出码 `0=ok`、`1=warn`、`2=critical`；`modelUsageLastHour.budgetedTokens` 是预算计数，不能当账单金额。`opengrok-monitor.timer` 每分钟调用同一命令，结果留在 `journalctl --user -u opengrok-monitor.service`；没有外部通知接收方。已验证正常、阈值告警、API 断连和当前网关/防火墙健康分支。

隔离的例程墙钟长跑服务 `opengrok-wallclock-20261006.service` 计划在 2026-10-07 12:58（北京时间）完成第二次自然触发后退出。它使用 `opengrok_wallclock_20261006` 库，不属于正式 Web 服务。查看 `systemctl --user status opengrok-wallclock-20261006.service` 和 `journalctl --user -u opengrok-wallclock-20261006.service --no-pager -n 40`；成功标志是 `second_verified`，其中两次计划时点相差 24 小时、各有唯一 Run。该 unit 由 `systemd-run` 创建，当前进程故障会自动重启，但主机重启后瞬态 unit 不会自动恢复；若发生重启，需重新启动测试并在验收记录中注明中断，不能把缺少日志当作通过。首次自然触发和随后一次服务重启已通过，见 [PLAN.md](PLAN.md)。

## 离线备份

`scripts/backup.mjs` 只接受当前本机端口与进程布局。它检查 systemd 用户服务已停、API/Host/runtime/VNC 端口已关闭、Worker 已停止、桌面容器已停止；在线调用会在写出前拒绝。自定义服务端口或其他启动器仍须操作者额外核对。输出目录必须尚不存在。备份数据和密钥放在互不包含的不同目录：

```sh
node scripts/backup.mjs create /private/opengrok-data-YYYYMMDD /separate-secret-store/opengrok-keys-YYYYMMDD
node scripts/backup.mjs verify /private/opengrok-data-YYYYMMDD /separate-secret-store/opengrok-keys-YYYYMMDD
```

数据包含 PostgreSQL custom dump、成果目录、桌面 home/workspace 两卷、SQLite host journal 和逐文件 SHA-256 清单。密钥包含数据库连接配置、模型加密主密钥、Host token、桌面 runtime token；若已配置 GitHub，密钥包还包含 `.local/github.env`。密钥目录权限 0700、文件 0600。`verify` 检查清单摘要、tar 路径、`pg_restore` 可解析性及 SQLite `quick_check`；旧版不含 GitHub 配置的密钥包仍可验证，本机旧快照已回归通过。本机 `.local/backup-*` 只用于演练，与源数据同盘，不能作为灾难恢复副本；生产备份还需异机存放、加密、保留期和定期恢复演练。不要将任一备份包提交到 Git。

备份过程中绝不重启桌面或 API。完成并校验后，按“启动与停机”中的顺序恢复容器、Host、API、Worker、Web 和监测 timer。重新打开 Web 核对 Host `ready`、API 健康和历史任务。

## 隔离恢复

恢复只允许新目录、新数据库和新 Docker 卷。命令在目标已存在时拒绝覆盖；失败时保留部分目标供检查，不自动删除：

```sh
node scripts/backup.mjs restore /private/opengrok-data-YYYYMMDD \
  /separate-secret-store/opengrok-keys-YYYYMMDD \
  /private/opengrok-restored-YYYYMMDD opengrok_restore_yyyymmdd
```

目标目录生成 `restore.env` 与 `restore-manifest.json`，后者记录新卷名、恢复数据库名和已校验的历史成果数。恢复命令逐条核对成果文件的字节数和 SHA-256，并对 journal 做 `quick_check`。它不会自动切换正式服务。用独立端口启动恢复桌面、Host、API 与 Worker 时，Host 设置 `OPENGROK_RUNTIME_URL`、`OPENGROK_VNC_PORT` 和 `OPENGROK_DESKTOP_MANAGED=0`；API 设置 `OPENGROK_VNC_WS_URL`。禁用桌面生命周期管理可防止隔离 Host 的“确保/重启桌面”命令碰到正式 Compose 容器。所有恢复进程使用目标 `restore.env`，不得混用正式 `DATABASE_URL` 或 `.local/host-journal.sqlite`。

新出口策略下，恢复桌面也必须拥有**独立 IPv4 网桥、独立防火墙链和绑定该网桥的网关**。先用 `OPENGROK_ALLOW_ISOLATED_EGRESS_TEST=1 node tests/isolated-desktop-egress-smoke.mjs` 检查当前主机支持这条路径；可选传入 `OPENGROK_RESTORE_MANIFEST=<恢复目录>/restore-manifest.json`、`OPENGROK_RESTORE_EXPECT_PATH=<工作文件相对路径>` 与 `OPENGROK_RESTORE_EXPECT_SHA256=<摘要>`，脚本会克隆恢复卷并验证指定文件，不修改原卷，结束时删除克隆卷和网络探针。三项恢复参数齐备时设置 `OPENGROK_ISOLATED_AGENT_TEST=1`，可用克隆桌面卷、全新测试数据库与固定响应模型验收 Host/API/Worker 报告链；再设置 `OPENGROK_ISOLATED_RESTORED_DB_TEST=1`，脚本还会克隆恢复数据库、成果和 host journal，在副本重设测试密码，通过 API 核对旧成果后执行新任务。它会保留隔离测试数据库和 `.local/restore-agent-*` 目录供检查，临时容器、卷、网桥与规则链自动清理。实际恢复时先创建专用 Docker bridge（不要使用默认 `bridge` 或直接复用正式 `desktop_default`），运行 `sudo -n "$(command -v node)" scripts/desktop-firewall.mjs apply <恢复网桥名> 3888 <唯一大写链前缀>`，在另一终端以 `OPENGROK_EGRESS_NETWORK=<恢复网桥名> node scripts/start-egress.mjs` 启动对应网关；宿主机需要上游代理时只给该网关配置 `OPENGROK_BROWSER_PROXY`。确认网关健康后，再用 `--network <恢复网桥名> --restart no --cap-drop NET_RAW`、当前 seccomp 文件、回环发布端口和 `--env-file <恢复目录>/desktop.env` 启动桌面，传入 `OPENGROK_BROWSER_PROXY=gateway` 与 `OPENGROK_EGRESS_PORT=3888`，仅挂载 `restore-manifest.json` 指定的 home/workspace 两卷。不要将含数据库或模型密钥的 `restore.env` 整份注入桌面。接入恢复 Host 前先验证浏览器能打开公开站点、容器直连公网被拒、私网地址返回 403；清理时先停恢复容器和网关，再 `desktop-firewall.mjs remove`，最后删除专用网桥，保留恢复卷供核对。

2026-10-06 演练：快照 `66a9d8a4-f2de-4547-bb50-bfbc9ecb5463` 恢复到数据库 `opengrok_restore_artifacts_20261006` 和新卷。恢复命令核对 1 条历史成果；隔离 API 下载成果 `510b44eb-b08a-440c-8777-e31c16899d49` 得到 SHA-256 `d28a731dad3d8d6632afe505751d078cc6574fce5cc989592950b793a652d0b9`，新 Run `be823241-dcdf-4964-9b7e-16dacce737da` 成功。恢复桌面从新 home/workspace 卷启动，`/workspace/probe.txt` 的运行时回读 SHA-256 为 `75b07bb3ffb3b8ad63e79b983fbef8fd0ee8e7292144b4e7d3b57bd682074087`，浏览器读取固定公开文档 5016 字符。恢复 Host 连接该桌面后的 Run `bfb14108-1783-4b2a-ae9b-7aa436eff3d5` 完成浏览器读取与新报告发布；其 2 条电脑回执只在恢复 journal，正式 journal 为 0。测试使用固定响应模型验证恢复机制，未证明任意站点的登录会话跨机器仍有效。

出口网关上线后的独立网桥探针在临时 `opengrok_restore_smoke_a6db9a5f` 上完成：可见浏览器读出公开 Sauce Demo，容器直连 `https://example.com` 报 `ECONNREFUSED`，云元数据 HTTP 经网关返回 403，宿主机可经回环发布端口读取 runtime。随后以快照 `66a9d8a4-f2de-4547-bb50-bfbc9ecb5463` 的两只恢复卷为只读源，在临时 `opengrok_restore_smoke_89339137` 上克隆并启动桌面；运行时读回 `probe.txt` 摘要 `75b07bb3ffb3b8ad63e79b983fbef8fd0ee8e7292144b4e7d3b57bd682074087`，公开网页与私网拒绝路径再次通过。两次测试的临时容器、克隆卷、网桥和 `OG_ISO_*` 规则均已清理，正式 `pnpm monitor` 保持 `ok`。这证明恢复数据和当前网络策略能在同一运行时共存；恢复 API/Worker 的完整任务链尚未在该克隆网络里复跑。

## 升级与故障

升级前执行完整离线备份并记录镜像、锁文件和迁移版本；恢复服务时 API 会执行数据库迁移。浏览器 profile 可能无法由旧 Chromium 读取，回滚必须使用升级前配套快照。Worker 租约失效后只能由新 epoch 续跑；Host journal 的 `unknown` 需要核对，不可盲目重放非幂等动作。网页不可达先查 API `/api/health`，再查 Host `/state`、桌面 `/health`、PostgreSQL 与 Worker 日志；成果打不开时同时核对数据库 `artifacts.storage_path`、成果文件和 SHA-256。每分钟监测已覆盖水位与积压，但外部通知、通知值班人和告警噪声控制仍待发布设计。
