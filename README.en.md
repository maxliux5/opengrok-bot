# OpenGrok Bot

[English](README.en.md) | [简体中文](README.md)

OpenGrok Bot is a self-hosted personal agent in the style of a Grok Bot. You create a Bot with a name and a job, assign work in chat, and inspect its progress and deliverables. The Bot works on a persistent Docker Linux desktop, keeps Bot-specific memory across conversations, and hands control back when an action needs approval or human intervention.

The model provider is replaceable. The first release targets one person running it locally.

## Screenshots

The first-account screens come from the managed workspace before any account was created, with the token field empty. All other screens come from demo or test databases isolated from the personal workspace. The report, computer, memory, and routine examples use a fixed-response model and `example.com`; the mobile desktop image uses the public Sauce Demo site. The handoff screen uses test-authored material in a separate database. The GitHub approval screens use a local fake GitHub API and did not write to an external repository. They show working Web flows, not real-model answer quality.

### First account

![Username, password, and initialization token form on the managed local entry point](docs/screenshots/setup-desktop.png)

<img src="docs/screenshots/setup-mobile.png" alt="First-account form on a phone" width="390">

### Web research and deliverable

![Chat and a sourced Markdown report](docs/screenshots/report-desktop.png)

### Persistent Linux computer

![Observable Docker Linux desktop and browser in the Web app](docs/screenshots/computer-desktop.png)

<img src="docs/screenshots/computer-mobile-zoom.png" alt="Panning the Docker Linux desktop at native size on a phone" width="390">

### Bot memory and daily routines

![A report-format preference saved for this Bot](docs/screenshots/memory-desktop.png)

![A daily routine configured with a time zone](docs/screenshots/routines-desktop.png)

### Multi-Bot handoff

![Child Bot conversation with a link to its parent Run](docs/screenshots/handoff-desktop.png)

### GitHub Issue approval

![Repository, title, body, and per-action approval for a GitHub Issue](docs/screenshots/github-approval-desktop.png)

<img src="docs/screenshots/github-approval-mobile.png" alt="GitHub Issue approval in the mobile workspace" width="390">

### Mobile report view

<img src="docs/screenshots/report-mobile.png" alt="Markdown report and source link in the mobile workspace" width="390">

The current Web UI is in Chinese; this English README documents the same product and setup.

## Current Status

The first account on the managed local Web service requires an initialization token. The user-service installer creates a random token in Git-ignored `.local/setup.token` with mode `0600`. Read it locally on first visit to the [HTTPS page](https://127.0.0.1:8443/), then choose your own username and password. The token file is removed after successful account creation. Development instances may use an isolated database without `OPENGROK_SETUP_TOKEN_FILE`; the managed service always enables this check. This prevents other local processes without the token from claiming the account, but processes running as the same Unix user remain in the trusted boundary. The managed workspace still has no account.

As of 2026-10-06, this is a working local prototype. The Web app, API, persistent Worker, PostgreSQL, computer-host, and Docker Linux desktop are connected. Fixed-response tests cover Web research through a readable Markdown deliverable, continuing after the client disconnects, Bot-private memory, command approval, desktop takeover, and both OpenAI-compatible and Anthropic model protocols. Model text streams by default and is persisted incrementally; non-streaming responses are configurable.

Tool schemas, authorization, execution location, and receipts live in one registry. The implemented tools cover public Web browsing, workspace text files, screenshots, and run-scoped staged reports. Full desktop screenshots, per-action approval for mouse and keyboard input, and command status and stop requests are connected. A Run snapshots its initial capability ceiling: later grants apply only to new Runs, while revocations take effect immediately. New Bots start with terminal and full-desktop access disabled.

Real `Gemini-3-Flash-Preview` through TraeX Proxy completed a sourced report, cross-conversation formatting preference, approved form interaction, workspace readback, and a screenshot in an isolated test database. A run using manually supplied desktop coordinates succeeded and its final value was independently checked. Two attempts where Gemini estimated desktop coordinates itself failed, so autonomous visual positioning is not yet reliable. Real Claude Sonnet through the TraeX Proxy Anthropic protocol also completed the report contract, and a model switch on the same Bot preserved history, preference, files, and browser state. On a frozen 12-task set repeated three times, mechanical checks passed 36/36 for both models; reviewed quality passed 31/36 for Gemini and 26/36 for Claude after correcting one missed error. A later complete run of the same set with `traex/GPT-6-Astra` passed 36/36 mechanically and after manual review. Gemini and Astra meet this task-set quality gate; Claude Sonnet remains below 30/36. See [eval/README.md](eval/README.md) for the method and limitations. All three model IDs currently share one TraeX Proxy; upstream identity, independent gateway failover, and cost evaluation remain open.

The local HTTPS entry point on this machine is [https://127.0.0.1:8443/](https://127.0.0.1:8443/). Its certificate is self-signed. The production workspace has no account yet: set the initial password on first visit, then add your model profile in Bot settings. Services listen on loopback. Remote or public deployment still needs a trusted certificate, a domain, and a separate network boundary.

After login, the key button at the bottom of the sidebar changes the password and invalidates other login sessions. `tests/password-web-smoke.mjs` passed old-password rejection, new-password login, closure of an existing event stream, and the 390px mobile dialog in an isolated test database. With `OPENGROK_PASSWORD_HTTPS_TEST=1`, the same flow on self-signed HTTPS port `8444` verified `Secure`, `HttpOnly`, and `SameSite=Lax` on the login and rotated cookies. The production workspace still has no account; you choose its initial password in the Web app.

An isolated HTTPS test instance on port `8444` passed an authenticated Web end-to-end check: secure session cookie, nonblank desktop video over `wss`, human takeover to log in to a public demo site, and Agent readback after returning control. An unauthenticated desktop WebSocket was closed with code `1008`. At 390px and 320px, the mobile Web app switched between fit-to-window and native-size clipped desktop views, supported panning, and had no horizontal page overflow. At 390px, human takeover, touch focus, text entry, and the on-screen Enter button navigated the shared browser to a public site. More complex mobile desktop workflows remain unverified. The production workspace on `8443` still has no account, so its authenticated desktop flow has not been tested with a real account.

Each new Run receives a fixed budget: 12 model steps, 30 tool calls, a 40,000-token continuation threshold, and a 24-hour wall-clock limit by default. A model call is limited to 120 seconds and 2,048 output tokens; an artifact is limited to 2 MB. The activity view shows tool and token consumption. Wall-clock time includes queueing and human waits. If the provider omits usage data, estimated tokens are shown and used only for budget protection. Usage arrives after a model call, so the final call can exceed the threshold. Environment variables beginning with `OPENGROK_MAX_` configure these limits for new Runs.

The skill library supports drafting from successful Runs, human edits, immutable versions, binding one skill to multiple Bots, and version snapshots on each Run. Daily routines support IANA time zones, fixed input, per-run budgets, optional fixed skill versions, pause, manual test runs, and execution history. Durable occurrence records deduplicate scheduled delivery. Isolated tests cover missed-day coalescing, concurrent delivery, immediate capability revocation, and approval expiration. A persisted scheduled occurrence was dispatched once after a Worker restart, and its Run recovered after a second Worker crash. A separate wall-clock test fired naturally at the scheduled minute and still had exactly one occurrence and Run after a service restart; it remains active until the next day's firing. In an isolated simulated site failure, routine history displayed the Web error, the computer operation was dispatched once, and the next day's schedule remained intact. A real external outage and long-term stability remain unverified.

The first multi-Bot handoff loop is working. In the activity view, you can assign a task, acceptance criteria, and up to three explicit Markdown artifact references to another Bot. A Bot can initiate the same handoff only when its `delegate` capability is enabled. The child Run gets its own conversation and Bot-private memory, and both sides can navigate the parent-child status. Depth, descendant count, total allocated budget, and ancestor cycles are limited. Isolated API, agent-tool, desktop Web, and mobile Web tests passed. A fault-injection test also killed a Worker after the child Run was committed but before the parent tool result was saved; recovery completed both Runs with exactly one child. In a focused TraeX Gemini trial, all three explicit handoff requests succeeded on the first call, while neither of two explicit self-service requests delegated. The child Bot used a fixed-response model, so this checks task-marker transfer and execution, not review quality. Child results are not yet automatically merged into the parent answer; broader delegation quality remains unverified.

GitHub Issues is the first business-connector candidate. A Bot needs the explicit `github_issues` capability. It drafts a title and body; the Web app shows the fixed target repository and full body for per-action approval. Only then does the Worker create the issue and read back its title, body, and URL. A durable operation ID and hidden marker allow reconciliation after a lost response without automatically posting twice. An isolated fake-GitHub test passed rejection with zero writes, desktop/mobile Web approval, readback after approval, zero writes after capability revocation, zero created issues on a definite 403, and one physical creation after a lost response. Real repository writes and business outcomes remain unverified. The connector is unconfigured by default; see [OPERATIONS.md](OPERATIONS.md).

The local deployment now runs two Workers. Different Bots can make model calls concurrently while the host serializes access to their shared computer. An isolated two-Worker test observed two overlapping model calls, one computer operation at a time, and two successful receipts. When the host was killed with one operation active and another queued, the active operation remained unknown for reconciliation; the queued operation was recorded as never dispatched. The authenticated production workspace is still empty, so real GUI load and delegation quality remain to be assessed.

An offline backup has been restored into an isolated database, data directory, and desktop volume: old reports opened via the API, a new Run succeeded, and restored files and browser pages remained readable. Local self-signed HTTPS, systemd user services, and a minute-by-minute monitor are running; the monitor records exit codes and journal entries but has no external notification receiver. Container rebuild tests preserved workspace file hashes and a test cookie with `Max-Age`. A public demo site's login also survived a rebuild, but that does not establish persistence for every website, MFA flow, or session lifetime. See [OPERATIONS.md](OPERATIONS.md) for recovery steps.

An isolated service-restart regression also passed: the Worker progressed while the API was down; after the old Worker exited, a lost computer response was reconciled from its durable receipt with only one physical navigation; a new Run published a report after the desktop was rebuilt. The test permits a rebuild only while the managed workspace has no account and the computer is idle. Restart behavior for an authenticated personal workspace remains unverified.

Still open: Claude reaching the frozen quality gate, reliable autonomous desktop coordinates, off-machine backup retention, public deployment, and the first real business connector. The remaining unchecked items in [PLAN.md](PLAN.md) are still active.

## Run Locally

You need Node.js 22, pnpm 11, and an accessible Docker daemon with Compose. From a fresh checkout, prepare the image and network first:

```sh
pnpm install
pnpm dev:init
sudo -n env DOCKER_CONFIG="$HOME/.docker" docker compose -f infra/desktop/compose.yaml build desktop
node scripts/prepare-desktop-network.mjs
```

Run `node scripts/start-egress.mjs` in its own terminal and keep it running. Then run `node scripts/start-containers.mjs` to start PostgreSQL and the desktop.

`pnpm dev:init` creates the Git-ignored `.local/dev.env` with a random database password. In separate terminals, source it and start the host, API, and Worker:

```sh
set -a; source .local/dev.env; set +a
pnpm dev:host
```

Repeat the `source` command in each terminal before `pnpm dev:api` and `pnpm dev:worker`. Once the host is running, start the Web app:

```sh
pnpm dev:web
```

Real-model tests and evaluations require `OPENGROK_TEST_PROXY_CONFIG="$PWD/.local/test-proxy.json"`. Keep this file at mode `0600` with `{"baseUrl":"https://your-proxy.example/v1","apiKey":"your-test-key"}`; an existing `providers.cliproxy` object is also accepted. `.local/` is Git-ignored, so keep actual credentials there. For the `smoke` account in a shared isolated test database, set `OPENGROK_TEST_PASSWORD` to that account's password; Web takeover tests use `OPENGROK_WEB_SMOKE_PASSWORD`. Set `OPENGROK_TEST_CHROMIUM_EXECUTABLE=/path/to/chromium` to use a system Chromium in Web tests; otherwise they use Playwright's installed browser.

The network scripts use this machine's configured passwordless sudo access. If the host needs an upstream HTTPS proxy, set `OPENGROK_BROWSER_PROXY=http://host:port` for `start-egress.mjs`; that upstream address stays on the host. The desktop uses the local gateway. The bridge firewall rejects direct outbound connections except upstream DNS, while the gateway accepts public HTTP on port `80` and HTTPS on port `443`, checks every DNS answer, and pins the selected IP. Approved shell commands inherit the same HTTP proxy. DNS requests can still carry data, and this is not a hostile-program or public multi-tenant isolation boundary. Do not mount the Docker socket into the desktop container. See [OPERATIONS.md](OPERATIONS.md) for the exact policy and checks.

Run the local checks with:

```sh
pnpm test
pnpm -r typecheck
pnpm --filter @opengrok/web build
```

`OPENGROK_ALLOW_EGRESS_FAILURE_TEST=1 node tests/egress-failure-smoke.mjs` briefly stops the managed egress gateway and verifies that direct access stays blocked, monitoring raises a critical issue, and recovery succeeds. It refuses to run unless the managed workspace has no account and the computer is idle.

`OPENGROK_ALLOW_ISOLATED_EGRESS_TEST=1 node tests/isolated-desktop-egress-smoke.mjs` checks the same policy on a disposable second bridge and empty desktop, then removes its resources. With a restore manifest, relative workspace path, and expected SHA-256, it clones the restored volumes and checks the old file under that network. Add `OPENGROK_ISOLATED_AGENT_TEST=1` for a fixed-response Host/API/Worker report task; also add `OPENGROK_ISOLATED_RESTORED_DB_TEST=1` to clone the restored database and artifacts, log in through the API, verify an old artifact, and publish a new report. This local combined test passed on 2026-10-06; off-machine recovery and real-model quality need separate validation.

For a real-model check through the current gateway, run `OPENGROK_ALLOW_REAL_EGRESS_TEST=1 OPENGROK_REAL_EGRESS_DB=opengrok_real_egress_<fresh_suffix> node tests/real-traex-egress-runner.mjs`. It creates an isolated database and API/Worker/Host, reuses the idle managed desktop, runs TraeX Gemini through report and memory flows, stops the isolated services, and clears the test model key. One complete run passed on 2026-10-06; see [PLAN.md](PLAN.md) for the evidence boundary.

Most end-to-end scripts under `tests/` use an isolated test database and fixed-response models. Real TraeX tests require an isolated API on port `3841`, a Worker, a Host on port `3844`, and a test database. The test services need their own `OPENGROK_DATA_DIR`, desktop runtime/VNC ports, and database when run alongside the normal deployment. Never point those scripts at the personal production database. The scripts read model-proxy credentials from the private file named by `OPENGROK_TEST_PROXY_CONFIG`. `tests/real-traex-smoke.mts` tests Gemini reports and memory; `tests/real-provider-switch.mts` tests switching from Gemini to Claude on one Bot. See the Chinese [README.md](README.md) and [eval/README.md](eval/README.md) for the full test matrix and exact commands.

`tests/service-restart-smoke.mts` deliberately kills its isolated API and Worker, injects a lost Host response, rebuilds the managed desktop, and verifies scheduled-routine deduplication and recovery. It requires a fresh `opengrok_restart_*` database, a dedicated `.local/restart-*` data directory, and `OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1`; it checks that the managed workspace has no account and the computer is idle before starting.

Multi-Bot regression scripts are `tests/handoff-smoke.mts`, `tests/handoff-agent-smoke.mts`, and `tests/handoff-web-smoke.mts`. They require a fresh `opengrok_handoff_20261006` database and isolated API on `3841`. The agent test starts a fixed-response model on `3850` and an isolated Worker; the Web test uses a preview on `8444` pointed at that API. `tests/handoff-recovery-smoke.mts` instead requires a fresh `opengrok_handoff_recovery_20261006` database and dedicated `.local/handoff-recovery-20261006` data directory; it runs its own fake model and Worker, injects a crash after child creation, and verifies receipt recovery without duplication. Do not run them against the personal workspace database.

`tests/github-issue-smoke.mts` requires a fresh `opengrok_github_YYYYMMDD` database and dedicated `.local/` directory. It starts a fake model, fake GitHub API, API, Worker, and Web preview; checks rejection, desktop/mobile approval, readback, capability revocation, a definite 403, and lost-response recovery; and writes screenshots under `docs/screenshots/`. Its test token reaches only the local fake API. A real write requires a separately authorized test repository.

`tests/real-handoff-traex.mts` uses real TraeX Gemini for the parent and a fixed-response child Bot. It requires a fresh `opengrok_real_handoff_YYYYMMDD` database and matching dedicated `.local/` data directory, starts its own isolated Worker, checks three positive and two negative delegation cases, and clears the test model key on exit. It needs no API, Host, or desktop. This focused trial does not replace the frozen task set or a real business-outcome evaluation.

`tests/parallel-bots-smoke.mts` requires a fresh `opengrok_parallel_YYYYMMDD` database named in both `OPENGROK_DB_NAME` and `OPENGROK_PARALLEL_DB_NAME`. It starts two Workers, a fake model, a fake desktop runtime, and an isolated host to verify parallel inference, serialized computer operations, and queued receipts across a host restart. It does not touch the managed desktop.

## First Acceptance Path

1. Create a research Bot and choose a configured model with the required capabilities.
2. Ask it to research a question in the visible browser and publish a report with sources.
3. Close the client while it works, then reopen it to inspect progress and the result.
4. Tell the Bot a report-format preference and check that the memory was saved.
5. Start a new conversation and verify that the next report follows that preference.
6. Rebuild the desktop container and check that workspace files and a test site's login still work.

## Architecture and Safety Boundaries

- Each user has one persistent computer. Bot memories are private to each Bot; files and website logins on that user's computer are shared across the user's Bots.
- The API, Worker, and database own durable product state. Rebuilding the desktop does not delete Bots, conversations, Runs, or memory.
- The agent and user operate the same visible browser. New agent computer operations pause during human takeover.
- Model adapters supply inference. The application owns Run recovery, memory, tool permissions, and deliverable validation.
- The first release uses one repository, PostgreSQL, and Docker Compose, without Redis, Kubernetes, or an additional workflow platform.
- Chromium runs as a non-root user with `chromiumSandbox` enabled by a pinned Playwright seccomp profile; this was verified in a local container. Browser routes reject private HTTP(S) and WebSocket targets using the URL and current DNS results, and Service Workers are disabled so they cannot bypass request routing; offline features on Service Worker-dependent sites may be affected. The managed desktop now has a host egress gateway and bridge firewall: direct public, private, and host connections are rejected, while public web pages work through the gateway. Its Docker restart policy is `no`; the startup service verifies the firewall and gateway before starting the desktop. This depends on the local Docker/iptables topology; a Docker daemon or host firewall reload has not yet been fault-injected for a momentary policy gap. Canceling a Run or stopping a command cannot undo effects already produced or terminate a process that escaped its managed process group. Full desktop screenshots may contain private information and can be sent to the selected model provider; that capability is off by default. Use the current build only in a trusted personal local environment.

## Documentation

- [PLAN.md](PLAN.md) (Chinese): scope, milestones, acceptance cases, and release gates.
- [ARCHITECTURE.md](ARCHITECTURE.md) (Chinese): domain objects, module ownership, Docker desktop, model adapters, Run recovery, memory, approvals, and API sketches.
- [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) (Chinese): alternatives, chosen tradeoffs, and reassessment conditions.
- [eval/README.md](eval/README.md) (Chinese): frozen tasks, review method, two-model baseline, and reproduction steps.
- [OPERATIONS.md](OPERATIONS.md) (Chinese): local operations, offline backup, isolated restore, upgrades, and troubleshooting.
