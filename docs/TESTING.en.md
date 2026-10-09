# Development and testing

[Back to README](../README.en.md) · [简体中文](TESTING.md)

Run commands from the repository root. The [operations guide](../OPERATIONS.md) covers managed services, network rules, and backups. Historical test records are in the [implementation plan](../PLAN.md).

## Start a manual development environment

Use the Linux, Node.js, pnpm, Docker, and sudo prerequisites from the README. Do not start development services on ports already used by the managed systemd instance. Parallel environments need separate databases, data directories, desktop runtimes, and service ports.

Prepare the dependencies, desktop image, and restricted network:

```sh
pnpm install
pnpm dev:init
sudo -n env DOCKER_CONFIG="$HOME/.docker" docker compose -f infra/desktop/compose.yaml build desktop
node scripts/prepare-desktop-network.mjs
```

Run `node scripts/start-egress.mjs` in a separate terminal and keep it running. Set `OPENGROK_BROWSER_PROXY` first if the host needs an upstream proxy. Then run `node scripts/start-containers.mjs` in another terminal.

Open three terminals. In each one, load the environment and start one service:

```sh
set -a
. .local/dev.env
set +a
pnpm dev:host
```

Replace the last command with `pnpm dev:api` and `pnpm dev:worker` in the other two terminals. Finally, run `pnpm dev:web` and open the [HTTP development entry point](http://127.0.0.1:5173/). Without `OPENGROK_SETUP_TOKEN_FILE`, a development instance does not require an initialization token. Use that mode only for trusted local testing.

## Run routine checks

```sh
pnpm test
pnpm -r typecheck
pnpm --filter @opengrok/web build
```

`pnpm test` runs core, desktop-runtime, and egress-gateway tests. It does not run the standalone E2E scripts below or make real-model calls.

## Test first-use onboarding

Prepare `.local/dev.env`, the `opengrok-postgres` container, the `opengrok-desktop:0.1.0` image, and the `desktop_default` bridge with its gateway and firewall. The test needs passwordless sudo and free ports `3841/3844/3845/6081/8444`.

```sh
pnpm tls:init
pnpm --filter @opengrok/web build
pnpm exec tsx tests/onboarding-web-smoke.mjs
```

The script creates a fresh database, data directory, and blank Linux desktop. It reuses the restricted egress network without accessing the managed account or desktop volumes. A local fixed-response model drives the default checks:

- Signup, automatic onboarding, model save, pre-created Bot configuration, and reuse after reload.
- Missing Worker and recovery, a stopped host, and read-only artifact storage.
- OpenAI-compatible and Anthropic probes with streaming and non-streaming responses, text-only mode, and a missing tool call.
- Invalid keys, a 20-second timeout, concurrent probes, unauthenticated requests, and an invalid Origin.
- Retesting changed input, refusal to save a failed model through the wizard, and no Run creation during a probe.
- Markdown publication and preview, source links, and SHA-256 verification.
- Nonblank noVNC video, actual keyboard navigation, Agent rejection during takeover, and page readback after returning control.
- No horizontal overflow at 320px and 390px, and model-profile saves through the existing Bot settings form.
- No test key or private upstream error body in API results or connection-test logs.

Set `OPENGROK_TEST_CHROMIUM_EXECUTABLE=/path/to/chromium` for system Chromium. Otherwise, the test uses Playwright's installed browser. Cleanup stops temporary services, removes the temporary desktop, and clears test model keys. Databases, screenshots, and `.local/onboarding-*` logs remain for inspection. Do not upload that private evidence.

### Use a real model

Put the test endpoint and key in Git-ignored `.local/test-proxy.json` with mode `0600`. The format below and an existing `providers.cliproxy` object are supported:

```json
{"baseUrl":"https://your-proxy.example/v1","apiKey":"your-test-key"}
```

```sh
export OPENGROK_TEST_PROXY_CONFIG="$PWD/.local/test-proxy.json"
OPENGROK_ONBOARDING_REAL_MODEL=traex/Gemini-3-Flash-Preview \
  pnpm exec tsx tests/onboarding-web-smoke.mjs
```

Replace the model ID with one offered by your proxy. Only the wizard save, report task, and saved-profile retest use the real model. Protocol variants and failure cases still use the fixture. Real requests incur model charges. Configuration can contain trusted key-loading commands, so never load an untrusted configuration file.

On 2026-10-09, both the complete fixture regression and the real TraeX Gemini workflow passed. The real report was checked against its recorded page read, and Agent readback matched actual takeover navigation. [PLAN.md](../PLAN.md) records Run IDs, artifacts, and fixes from failed attempts. One workflow does not establish general task quality; use the [frozen evaluation](../eval/README.md) for that scope.

## Select a regression by scenario

Read each script's preconditions first. Many historical scripts need preconfigured isolated services and must not use the managed database. Paths below are relative to the repository root.

| Scenario | Scripts | Environment and scope |
| --- | --- | --- |
| Signup and password changes | `tests/password-web-smoke.mjs` | Creates an isolated database; use `OPENGROK_PASSWORD_HTTPS_TEST=1` for HTTPS and `OPENGROK_PASSWORD_SETUP_TOKEN_TEST=1` for initialization-token checks |
| Budgets and capabilities | `tests/budget-smoke.mts`, `tests/capability-smoke.mts`, `tests/capability-approval-smoke.mts` | Isolated database; seven budget boundaries, capability snapshots, revocation, and host rejection |
| Control transitions | `tests/control-pending-smoke.mjs`, `tests/control-host-busy-smoke.mts`, `tests/control-web-pending-smoke.mjs` | Configure the independent runtime or isolated Host/API required by each script |
| Web takeover login | `tests/web-login-takeover-smoke.mjs` | Public demo site; requires `OPENGROK_WEB_SMOKE_PASSWORD`; HTTPS can use `OPENGROK_WEB_SMOKE_ORIGIN=https://127.0.0.1:8444/` |
| Terminal and cancellation | `tests/cancel-inflight-smoke.mts`, `tests/shell-stop-smoke.mjs`, `tests/web-cancel-approval-smoke.mjs` | Targeted stops, early stop intent, and cancellation during approval; follow each script's isolation requirements |
| Terminal Web receipts | `tests/shell-command-stop-smoke.mts`, `tests/web-shell-command-smoke.mjs` | The former accepts `OPENGROK_STOP_VIA_WEB=1`; the latter checks desktop and mobile receipts |
| Multi-Bot handoff | `tests/handoff-smoke.mts`, `tests/handoff-agent-smoke.mts`, `tests/handoff-web-smoke.mts` | Fresh `opengrok_handoff_20261006` database and API `3841`; agent fixture on `3850`, Web preview on `8444` |
| Handoff crash recovery | `tests/handoff-recovery-smoke.mts` | Fresh `opengrok_handoff_recovery_20261006` database and dedicated `.local/handoff-recovery-20261006`; starts its own fake model and Worker |
| GitHub Issue approval | `tests/github-issue-smoke.mts` | Fresh `opengrok_github_YYYYMMDD` database and dedicated data directory; writes only to a local fake API and updates test images under `docs/screenshots/` |
| Two-Worker concurrency | `tests/parallel-bots-smoke.mts` | Fresh `opengrok_parallel_YYYYMMDD` database in both `OPENGROK_DB_NAME` and `OPENGROK_PARALLEL_DB_NAME`; no managed desktop access |
| Desktop input and approval | `tests/desktop-runtime-smoke.mjs`, `tests/desktop-approval-invalid-smoke.mts` | The former operates a real desktop; the latter rejects out-of-bounds and stale observations. Check the target runtime first |

## Run other real-model regressions

Except for standalone vision and handoff probes, real-model tests generally require an isolated database, API on `3841`, Worker, and Host on `3844`. For parallel environments, set a separate `OPENGROK_DATA_DIR`, runtime/VNC ports, and database. Set the test Host's `OPENGROK_DESKTOP_MANAGED=0`. Do not share the managed Host journal.

Proxy tests explicitly read `OPENGROK_TEST_PROXY_CONFIG`. When reusing the isolated database's `smoke` account, set `OPENGROK_TEST_PASSWORD`. Web takeover scripts use `OPENGROK_WEB_SMOKE_PASSWORD`.

| Purpose | Script and options |
| --- | --- |
| Reports and cross-conversation preferences | `pnpm exec tsx tests/real-traex-smoke.mts`; for Claude, add `OPENGROK_TEST_PROVIDER=anthropic OPENGROK_TEST_MODEL_ID=agy/claude-sonnet-4-6` |
| Switch models on one Bot | `tests/real-provider-switch.mts` |
| Real Web form interaction | `tests/real-traex-interactive.mts` |
| Standalone image input | `tests/traex-vision-smoke.mts` |
| Screenshot understanding and actual page checks | `tests/real-traex-vision-run.mts` |
| Desktop input with human-supplied coordinates | `tests/real-traex-desktop-run.mts`; this does not establish autonomous positioning |
| Real parent-Bot delegation decisions | `tests/real-handoff-traex.mts`; fresh `opengrok_real_handoff_YYYYMMDD` database and matching `.local/` directory, fixed-response child Bot, no API, Host, or desktop needed |

The [evaluation document](../eval/README.md) contains frozen cases, version requirements, runner commands, and review criteria. Tool execution success and report accuracy are separate measures.

## Test restarts and network failures

Some scripts below modify the running desktop or gateway. Back up first. Run them only when the managed workspace has no account, the computer is idle, and there are no important sessions. Do not bypass script preconditions.

| Impact | Script and explicit opt-in |
| --- | --- |
| Rebuild the desktop and check login persistence | `OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1 node tests/login-persistence-smoke.mjs` |
| Rebuild the desktop and check recovery | `OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1 node tests/restart-smoke.mjs` |
| Kill isolated services, lose a receipt, and rebuild the desktop | `tests/service-restart-smoke.mts`; fresh `opengrok_restart_*` database, dedicated `.local/restart-*`, and `OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1` |
| Briefly stop the managed gateway | `OPENGROK_ALLOW_EGRESS_FAILURE_TEST=1 node tests/egress-failure-smoke.mjs` |
| Run Gemini on the current idle desktop | `OPENGROK_ALLOW_REAL_EGRESS_TEST=1 OPENGROK_REAL_EGRESS_DB=opengrok_real_egress_<fresh_suffix> node tests/real-traex-egress-runner.mjs` |

The independent egress test, `OPENGROK_ALLOW_ISOLATED_EGRESS_TEST=1 node tests/isolated-desktop-egress-smoke.mjs`, uses a disposable second bridge and blank desktop. A restore manifest, relative workspace path, and expected SHA-256 enable checks on cloned restored volumes. `OPENGROK_ISOLATED_AGENT_TEST=1` adds a fixed-model report task; `OPENGROK_ISOLATED_RESTORED_DB_TEST=1` also clones the restored database to verify old and new artifacts. Read [isolated restore](../OPERATIONS.md#隔离恢复) for parameters, safe ordering, and cleanup.

[PLAN.md](../PLAN.md) retains fault-test evidence and limitations. Reorganizing documentation does not give historical tests a new validation date.
