<h1 align="center">OpenGrok Bot</h1>

<p align="center">A personal agent with a persistent Linux computer. Choose your model. Take over the desktop.</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="#run-locally">Run locally</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/TESTING.en.md">Testing</a>
</p>

![OpenGrok Bot chat workspace and a sourced Markdown report](docs/screenshots/report-desktop.png)

<p align="center"><sub>Real UI in an isolated demo, using a fixed-response test model. The screenshot does not establish real-model answer quality.</sub></p>

Give a Bot a name, a job, and a model, then assign work in chat. It reads pages, works with files, and publishes deliverables on a visible Linux desktop. Each Bot keeps its own memory across conversations. The background Worker continues after you close the browser.

The product takes inspiration from Grok Bot and supports OpenAI-compatible and Anthropic protocols without requiring xAI. The Web UI is currently in Chinese.

> This is a personal self-hosted prototype for a trusted Linux machine. Do not expose it directly to the public internet or untrusted users.

## What you can do

| Your task | How the Bot works |
| --- | --- |
| Research pages and deliver a report | Opens and reads sources, then publishes a Markdown file you can preview and download |
| Keep a task running in the background | Persists task state, tool receipts, and progress across client disconnections |
| Take over a computer operation | Shows the shared Linux desktop and lets you take and return control |
| Remember work preferences | Stores memory per Bot, with inspection, editing, deletion, and cross-conversation recall |
| Repeat an established task | Saves versioned skills and schedules daily routines in a chosen time zone |
| Hand work to another Bot | Passes an explicit task and artifacts, with separate child-run tracking |

Each user shares one Docker Linux computer across their Bots. Bot memories stay separate. Models supply inference; the application owns recovery, approvals, budgets, and artifact checks. The stack uses React, Fastify, PostgreSQL, Playwright, and noVNC. Read the [architecture](ARCHITECTURE.md) for the boundaries.

## Run locally

You need Linux, Node.js 22, pnpm 11, Docker Compose, and a working systemd user session. Network scripts configure the Linux firewall and require passwordless `sudo`. Check these permissions before installation. Deployment on macOS and Windows is unverified.

### 1. Prepare the project

```sh
git clone https://github.com/maxliux5/opengrok-bot.git
cd opengrok-bot
pnpm install
pnpm dev:init
sudo -n env DOCKER_CONFIG="$HOME/.docker" docker compose -f infra/desktop/compose.yaml build desktop
pnpm --filter @opengrok/web build
pnpm tls:init
```

`dev:init` generates random credentials in Git-ignored `.local/`. Image downloads need network access. If your host needs an upstream proxy, configure `OPENGROK_BROWSER_PROXY` before installing the services below. See [network and runtime configuration](OPERATIONS.md).

### 2. Start the local services

```sh
node scripts/install-user-services.mjs --dry-run
node scripts/install-user-services.mjs
systemctl --user enable --now opengrok-network.service opengrok-egress.service \
  opengrok-containers.service opengrok-host.service opengrok-api.service \
  opengrok-worker.service opengrok-worker-2.service \
  opengrok-web.service opengrok-monitor.timer
OPENGROK_MIN_WORKERS=2 pnpm monitor
```

Wait for `"status":"ok"`, then open **[https://127.0.0.1:8443/](https://127.0.0.1:8443/)**. The default certificate is locally self-signed and needs browser trust. For upgrades, service persistence after logout, shutdown, and backup, use the [operations guide](OPERATIONS.md).

### 3. Create an account and run a task

1. Read the initialization token from local `.local/setup.token`. Enter it in the Web form and choose your username and password. Keep the token out of chat and Git. Successful signup removes the file.
2. Follow the wizard through environment checks, model connection, Bot configuration, and a first task. Enter the model endpoint and key, then test and save the profile.
3. Submit the first report and open its contents and sources. In the computer view, use **接管电脑** to take control, then **归还控制** when you finish.

Reopen the wizard with the sidebar compass. Connection tests can incur a small model charge; image recognition needs separate validation. For a manually started HTTP development environment, read [development and testing](docs/TESTING.en.md).

## Screenshots

<details>
<summary>Account creation and the first-use wizard</summary>

![First-account form with an empty initialization token field](docs/screenshots/setup-desktop.png)

![Wizard checks for the database, Worker, Linux computer, and artifact storage](docs/screenshots/onboarding-desktop.png)

<p align="center">
  <img src="docs/screenshots/setup-mobile.png" alt="First-account form on a phone" width="260">
  <img src="docs/screenshots/onboarding-mobile.png" alt="Model connection checks on a phone" width="260">
</p>

</details>

<details>
<summary>Desktop takeover and mobile reports</summary>

![The shared Linux desktop viewed and controlled through noVNC](docs/screenshots/computer-desktop.png)

<p align="center">
  <img src="docs/screenshots/computer-mobile-zoom.png" alt="Panning the native-size desktop on a phone" width="260">
  <img src="docs/screenshots/report-mobile.png" alt="Report and sources on a phone" width="260">
</p>

</details>

<details>
<summary>Bot memory, daily routines, and task handoff</summary>

![A report-format preference stored for one Bot](docs/screenshots/memory-desktop.png)

![A daily routine with a configured time zone](docs/screenshots/routines-desktop.png)

![An independent child task with a link to its parent](docs/screenshots/handoff-desktop.png)

</details>

<details>
<summary>Per-action approval for GitHub Issues</summary>

![Approval shows the target repository, issue title, and body](docs/screenshots/github-approval-desktop.png)

<p align="center"><img src="docs/screenshots/github-approval-mobile.png" alt="Issue approval on a phone" width="260"></p>

</details>

Except for the signup screens, these images come from isolated demo or test databases. Reports, onboarding, memory, and routines use fixed-response models. The mobile desktop uses public Sauce Demo, and handoff material is test-authored. GitHub approval connects to a local fake API and writes nothing to an external repository.

## Validation and limits

As of 2026-10-09, real TraeX Gemini passed onboarding, page reading, report publication, and Agent readback after human takeover. Fixture regressions cover both protocols, streaming, invalid keys, timeouts, environment failures, and mobile layouts. Reproduction steps and evidence are in [testing](docs/TESTING.en.md) and the [implementation record](PLAN.md).

Reviewed results on the frozen task set are Gemini `31/36`, Claude Sonnet `26/36`, and Astra `36/36`, with a gate of `30/36`. Each model ran the same 12 tasks three times through one TraeX Proxy. These results apply only to that set. See the [evaluation method](eval/README.md) for the full scope.

- Bots belonging to one user share computer files and website sessions. They do not isolate credentials from one another.
- New Bots have terminal and full-desktop capabilities off. Relevant actions still need per-action approval after those capabilities are enabled. Full-desktop screenshots may contain private information and go to the chosen model.
- The gateway and firewall restrict direct, private-network, and host access. DNS exfiltration and possible gaps during Docker or firewall reloads remain risks. This is not strong isolation for hostile programs.
- Autonomous desktop coordinates, real GitHub writes, off-machine backup, public deployment, and long-term reliability remain unverified. Cancellation cannot undo external effects that already occurred.

## Documentation

| Topic | Read |
| --- | --- |
| Startup, HTTPS, networking, backup, and restore | [Operations](OPERATIONS.md) |
| Development, end-to-end tests, and fault injection | [Development and testing](docs/TESTING.en.md) |
| Agents, computers, memory, and state ownership | [Architecture](ARCHITECTURE.md) |
| Design tradeoffs and reassessment conditions | [Design decisions](DESIGN_DECISIONS.md) |
| Completed work, acceptance records, and next steps | [Implementation plan](PLAN.md) |
| Real-model task quality and failure cases | [Evaluation method and results](eval/README.md) |

Design, operations, implementation, and evaluation documents are currently in Chinese.
