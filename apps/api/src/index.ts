import { readFile, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { z, ZodError } from "zod";
import { botInput, handoffRequestInput, memoryInput, messageInput, modelProfileInput,
  routineInput, skillDefinitionInput } from "@opengrok/contracts";
import {
  DomainError, cancelRun, changePassword, createBot, createConversation, createModelProfile,
  createHandoff, listHandoffLinks,
  closeRunWithUnknownEffects,
  createSession, deleteMemory, getArtifact, getBot, getConversation, getRun, getRunPartial,
  hasOwner, listArtifacts, listBots, listConversations, listEvents,
  listMemories, listMessages, listModelProfiles, listRuns, login, logout,
  listPendingEffects, listShellCommands, requestShellStop,
  migrate, ownerForSession, putMemory, setupOwner, submitMessage, updateBot,
  hostRequest,
  invalidateComputerPlans,
  bindSkill, createSkill, getSkill, listRunSkillVersions, listSkillVersions, listSkills,
  skillDraftFromRun, unbindSkill, updateSkill,
  createRoutine, defaultRunBudget, getRoutine, listRoutineOccurrences, listRoutines,
  testRoutine, updateRoutine,
  listApprovals, decideApproval,
  githubIssueConnectorStatus,
  diagnoseWorkspace, getModelProfile, probeModel,
} from "@opengrok/core";

const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const setupTokenFile = process.env.OPENGROK_SETUP_TOKEN_FILE;
const vncWsUrl = new URL(process.env.OPENGROK_VNC_WS_URL || "ws://127.0.0.1:6080");
if (vncWsUrl.protocol !== "ws:" || vncWsUrl.hostname !== "127.0.0.1" || vncWsUrl.pathname !== "/") {
  throw new Error("VNC WebSocket 只能连接本机入口");
}
await app.register(cookie);
await app.register(websocket);
await migrate();

const desktopSockets = new Set<WebSocket>();
const eventStreams = new Set<ServerResponse>();
let desktopTransition = false;

function allowedOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.host === request.headers.host || origin === (process.env.OPENGROK_WEB_ORIGIN || "http://127.0.0.1:5173");
  } catch { return false; }
}

app.addHook("onRequest", async (request, reply) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method) &&
    request.headers.origin && !allowedOrigin(request)) {
    reply.code(403).send({ error: "请求来源不被允许", code: "origin_denied" });
  }
});

function closeDesktopSockets() {
  for (const socket of desktopSockets) socket.close(1001, "Control changed");
  desktopSockets.clear();
}

function closeEventStreams() {
  for (const stream of eventStreams) stream.end();
  eventStreams.clear();
}

type Actor = { id: string; username: string };
const idParams = z.object({ id: z.uuid() });
const botParams = z.object({ botId: z.uuid() });
const conversationParams = z.object({ conversationId: z.uuid() });
const runParams = z.object({ runId: z.uuid() });
const memoryParams = z.object({ botId: z.uuid(), memoryId: z.uuid() });
const botSkillParams = z.object({ botId: z.uuid(), skillId: z.uuid() });

async function actor(request: FastifyRequest): Promise<Actor> {
  const current = await ownerForSession(request.cookies.opengrok_session);
  if (!current) throw new DomainError("请先登录", 401, "not_authenticated");
  return current;
}

function setSessionCookie(reply: { setCookie: (name: string, value: string, options: object) => unknown }, token: string) {
  reply.setCookie("opengrok_session", token, {
    httpOnly: true, sameSite: "lax", secure: process.env.OPENGROK_HTTPS === "1",
    path: "/", maxAge: 30 * 24 * 60 * 60,
  });
}

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    reply.code(400).send({ error: "输入格式有误", code: "invalid_input", issues: error.issues });
    return;
  }
  if (error instanceof DomainError) {
    reply.code(error.statusCode).send({ error: error.message, code: error.code });
    return;
  }
  app.log.error(error);
  reply.code(500).send({ error: "服务暂不可用", code: "internal_error" });
});

app.get("/api/health", async () => ({ ok: true }));
app.post("/api/onboarding/diagnostics", async request => {
  await actor(request);
  return diagnoseWorkspace();
});
const modelProbes = new Set<string>();
async function runModelProbe(ownerId: string, profile: Parameters<typeof probeModel>[0]) {
  if (modelProbes.has(ownerId)) throw new DomainError("已有模型测试正在运行", 409, "model_probe_busy");
  modelProbes.add(ownerId);
  try { return await probeModel(profile); }
  finally { modelProbes.delete(ownerId); }
}
app.post("/api/model-profiles/test", async request => {
  const owner = await actor(request);
  const input = modelProfileInput.parse(request.body);
  return runModelProbe(owner.id, { ...input, baseUrl: input.baseUrl || null, apiKey: input.apiKey || null });
});
app.post("/api/model-profiles/:id/test", async request => {
  const owner = await actor(request);
  return runModelProbe(owner.id, await getModelProfile(owner.id, idParams.parse(request.params).id));
});
app.get("/api/connectors/github", async request => {
  await actor(request);
  return githubIssueConnectorStatus();
});
app.get("/api/computer", async request => {
  await actor(request);
  try { return await hostRequest("/state", {}, 4000); }
  catch (error) { return { computer: { status: "unavailable", controlMode: "agent", controlId: null,
    detail: error instanceof Error ? error.message : String(error) } }; }
});
app.post("/api/computer/ensure", async request => {
  await actor(request);
  return hostRequest("/ensure", { method: "POST" }, 8000);
});
app.post("/api/computer/restart", async request => {
  await actor(request);
  desktopTransition = true;
  closeDesktopSockets();
  try {
    await invalidateComputerPlans();
    return await hostRequest("/restart", { method: "POST" }, 8000);
  } finally { desktopTransition = false; }
});
app.post("/api/computer/control", async request => {
  await actor(request);
  desktopTransition = true;
  closeDesktopSockets();
  try {
    await invalidateComputerPlans();
    return await hostRequest("/control", { method: "POST" }, 8000);
  }
  finally { desktopTransition = false; }
});
app.delete("/api/computer/control/:id", async request => {
  await actor(request);
  const id = idParams.parse(request.params).id;
  desktopTransition = true;
  closeDesktopSockets();
  try { return await hostRequest(`/control/${id}`, { method: "DELETE" }, 8000); }
  finally { desktopTransition = false; }
});
app.get("/desktop", { websocket: true }, async (socket, request) => {
  try {
    await actor(request);
    if (!allowedOrigin(request) || desktopTransition) throw new Error("Desktop access denied");
    const { computer } = await hostRequest<{ computer: { status: string; controlMode: string } }>("/state", {}, 4000);
    if (computer.status !== "ready") throw new Error("Desktop unavailable");
    if (computer.controlMode === "human" && desktopSockets.size > 0) throw new Error("Control connection already active");
    const upstream = new WebSocket(vncWsUrl.href, "binary");
    desktopSockets.add(socket);
    socket.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
    upstream.on("message", (data, isBinary) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
    });
    socket.on("close", () => { desktopSockets.delete(socket); upstream.close(); });
    upstream.on("close", () => { desktopSockets.delete(socket); socket.close(); });
    upstream.on("error", () => socket.close(1011, "Desktop connection failed"));
  } catch (error) {
    app.log.warn(error, "desktop websocket rejected");
    socket.close(1008, "Desktop access denied");
  }
});
app.get("/api/bootstrap", async () => {
  const initialized = await hasOwner();
  return { initialized, setupTokenRequired: !initialized && Boolean(setupTokenFile) };
});
app.post("/api/setup", async (request, reply) => {
  const body = z.object({ username: z.string().trim().min(2).max(50),
    password: z.string().min(12).max(500), setupToken: z.string().max(500).optional() }).parse(request.body);
  if (await hasOwner()) throw new DomainError("账号已初始化", 409, "already_initialized");
  if (setupTokenFile) {
    let expected: string;
    try { expected = (await readFile(setupTokenFile, "utf8")).trim(); }
    catch {
      throw new DomainError("初始化口令不可用，请检查本机服务配置", 503, "setup_unavailable");
    }
    const actual = Buffer.from(body.setupToken || "");
    const secret = Buffer.from(expected);
    if (!secret.length || actual.length !== secret.length || !timingSafeEqual(actual, secret)) {
      throw new DomainError("初始化口令错误", 403, "invalid_setup_token");
    }
  }
  const user = await setupOwner(body.username, body.password);
  if (setupTokenFile) {
    await unlink(setupTokenFile).catch(error => app.log.warn(error, "failed to remove used setup token"));
  }
  setSessionCookie(reply, await createSession(user.id));
  return { user };
});
app.post("/api/login", async (request, reply) => {
  const body = z.object({ username: z.string(), password: z.string() }).parse(request.body);
  const token = await login(body.username, body.password);
  setSessionCookie(reply, token);
  return { user: await ownerForSession(token) };
});
app.get("/api/session", async request => ({ user: await actor(request) }));
app.post("/api/logout", async (request, reply) => {
  await logout(request.cookies.opengrok_session);
  closeDesktopSockets();
  closeEventStreams();
  reply.clearCookie("opengrok_session", { path: "/" });
  return { ok: true };
});
app.post("/api/account/password", async (request, reply) => {
  const owner = await actor(request);
  const body = z.object({ currentPassword: z.string(),
    newPassword: z.string().min(12).max(500) }).parse(request.body);
  const token = await changePassword(owner.id, body.currentPassword, body.newPassword);
  closeDesktopSockets();
  closeEventStreams();
  setSessionCookie(reply, token);
  return { ok: true };
});

app.get("/api/bots", async request => ({ bots: await listBots((await actor(request)).id) }));
app.post("/api/bots", async request => ({
  bot: await createBot((await actor(request)).id, botInput.parse(request.body)),
}));
app.get("/api/bots/:id", async request => ({
  bot: await getBot((await actor(request)).id, idParams.parse(request.params).id),
}));
app.patch("/api/bots/:id", async request => {
  const body = botInput.partial().extend({ expectedRevision: z.number().int().positive() }).parse(request.body);
  return { bot: await updateBot((await actor(request)).id, idParams.parse(request.params).id, body) };
});

app.get("/api/bots/:botId/conversations", async request => ({
  conversations: await listConversations((await actor(request)).id, botParams.parse(request.params).botId),
}));
app.post("/api/bots/:botId/conversations", async request => ({
  conversation: await createConversation((await actor(request)).id, botParams.parse(request.params).botId),
}));
app.get("/api/conversations/:conversationId", async request => ({
  conversation: await getConversation((await actor(request)).id, conversationParams.parse(request.params).conversationId),
}));
app.get("/api/conversations/:conversationId/messages", async request => ({
  messages: await listMessages((await actor(request)).id, conversationParams.parse(request.params).conversationId),
}));
app.get("/api/conversations/:conversationId/runs", async request => {
  const owner = await actor(request);
  const conversationId = conversationParams.parse(request.params).conversationId;
  await getConversation(owner.id, conversationId);
  return { runs: await listRuns(owner.id, conversationId) };
});
app.post("/api/conversations/:conversationId/messages", async request => {
  const owner = await actor(request);
  const conversationId = conversationParams.parse(request.params).conversationId;
  return submitMessage(owner.id, conversationId, messageInput.parse(request.body));
});

app.get("/api/runs/:runId", async request => ({
  run: await getRun((await actor(request)).id, runParams.parse(request.params).runId),
}));
app.get("/api/runs/:runId/handoffs", async request => {
  const owner = await actor(request);
  return listHandoffLinks(owner.id, runParams.parse(request.params).runId);
});
app.post("/api/runs/:runId/handoffs", async request => {
  const owner = await actor(request);
  const input = handoffRequestInput.parse(request.body);
  const { requestId, ...task } = input;
  return createHandoff(owner.id, runParams.parse(request.params).runId,
    requestId, "user", task);
});
app.get("/api/runs/:runId/partial", async request => {
  const owner = await actor(request);
  const runId = runParams.parse(request.params).runId;
  await getRun(owner.id, runId);
  return getRunPartial(owner.id, runId);
});
app.get("/api/runs/:runId/shell-commands", async request => ({
  commands: await listShellCommands((await actor(request)).id, runParams.parse(request.params).runId),
}));
app.post("/api/runs/:runId/shell-commands/:operationId/stop", async request => {
  const owner = await actor(request);
  const params = z.object({ runId: z.uuid(), operationId: z.uuid() }).parse(request.params);
  const stop = await requestShellStop(owner.id, params.runId, params.operationId);
  try {
    const delivery = await hostRequest<{ stopping: boolean; pending: boolean }>(
      `/operations/${params.operationId}/stop`, { method: "POST" }, 4000,
    );
    return { stop, delivery: delivery.stopping ? "stopping" : "pending" };
  } catch (error) {
    app.log.warn({ error, operationId: params.operationId }, "shell stop delivery uncertain");
    return { stop, delivery: "unknown" };
  }
});
app.post("/api/runs/:runId/cancel", async request => {
  const owner = await actor(request);
  const runId = runParams.parse(request.params).runId;
  const run = await cancelRun(owner.id, runId);
  const pending = await listPendingEffects(owner.id, runId);
  await Promise.all(pending.filter(effect => effect.name === "shell_exec").map(async effect => {
    try {
      await hostRequest(`/operations/${effect.operationId}/stop`, { method: "POST" }, 4000);
    } catch (error) {
      app.log.warn({ error, operationId: effect.operationId }, "shell stop request did not reach the runtime");
    }
  }));
  return { run };
});
app.get("/api/runs/:runId/pending-effects", async request => ({
  effects: await listPendingEffects((await actor(request)).id, runParams.parse(request.params).runId),
}));
app.post("/api/runs/:runId/close-unknown", async request => {
  z.object({ acknowledge: z.literal(true) }).parse(request.body);
  return { run: await closeRunWithUnknownEffects((await actor(request)).id, runParams.parse(request.params).runId) };
});
app.get("/api/runs/:runId/events", async (request, reply) => {
  const owner = await actor(request);
  const runId = runParams.parse(request.params).runId;
  await getRun(owner.id, runId);
  const query = z.object({ after: z.coerce.number().int().nonnegative().optional() }).parse(request.query);
  const header = Number(request.headers["last-event-id"]);
  let cursor = Number.isSafeInteger(header) && header >= 0 ? header : query.after || 0;
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  let closed = false;
  eventStreams.add(reply.raw);
  request.raw.on("close", () => { closed = true; eventStreams.delete(reply.raw); });
  while (!closed) {
    try {
      const events = await listEvents(owner.id, runId, cursor);
      for (const event of events) {
        reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.sequence;
      }
      if (!events.length) reply.raw.write(": heartbeat\n\n");
    } catch (error) {
      app.log.error(error);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  eventStreams.delete(reply.raw);
  reply.raw.end();
});

app.get("/api/bots/:botId/memories", async request => ({
  memories: await listMemories((await actor(request)).id, botParams.parse(request.params).botId),
}));
app.post("/api/bots/:botId/memories", async request => ({
  memory: await putMemory((await actor(request)).id, botParams.parse(request.params).botId, memoryInput.parse(request.body)),
}));
app.patch("/api/bots/:botId/memories/:memoryId", async request => {
  const ids = memoryParams.parse(request.params);
  return { memory: await putMemory((await actor(request)).id, ids.botId, {
    ...memoryInput.extend({ expectedRevision: z.number().int().positive() }).parse(request.body),
    memoryId: ids.memoryId,
  }) };
});
app.delete("/api/bots/:botId/memories/:memoryId", async request => {
  const ids = memoryParams.parse(request.params);
  const body = z.object({ expectedRevision: z.number().int().positive() }).parse(request.body);
  return { memory: await deleteMemory((await actor(request)).id, ids.botId, ids.memoryId, body.expectedRevision) };
});

app.get("/api/model-profiles", async request => ({
  profiles: await listModelProfiles((await actor(request)).id),
}));

app.get("/api/skills", async request => ({ skills: await listSkills((await actor(request)).id) }));
app.post("/api/skills", async request => ({
  skill: await createSkill((await actor(request)).id, skillDefinitionInput.parse(request.body)),
}));
app.get("/api/skills/:id", async request => ({
  skill: await getSkill((await actor(request)).id, idParams.parse(request.params).id),
}));
app.patch("/api/skills/:id", async request => {
  const body = skillDefinitionInput.extend({ expectedVersion: z.number().int().positive() })
    .parse(request.body);
  return { skill: await updateSkill((await actor(request)).id, idParams.parse(request.params).id,
    body.expectedVersion, body) };
});
app.get("/api/skills/:id/versions", async request => ({
  versions: await listSkillVersions((await actor(request)).id, idParams.parse(request.params).id),
}));
app.put("/api/bots/:botId/skills/:skillId", async request => {
  const ids = botSkillParams.parse(request.params);
  return { skill: await bindSkill((await actor(request)).id, ids.botId, ids.skillId) };
});
app.delete("/api/bots/:botId/skills/:skillId", async request => {
  const ids = botSkillParams.parse(request.params);
  await unbindSkill((await actor(request)).id, ids.botId, ids.skillId);
  return { ok: true };
});
app.get("/api/runs/:runId/skills", async request => {
  const owner = await actor(request);
  const runId = runParams.parse(request.params).runId;
  await getRun(owner.id, runId);
  return { versions: await listRunSkillVersions(owner.id, runId) };
});
app.get("/api/runs/:runId/skill-draft", async request => ({
  draft: await skillDraftFromRun((await actor(request)).id, runParams.parse(request.params).runId),
}));

app.get("/api/routines/defaults", async request => {
  await actor(request);
  return { budget: defaultRunBudget };
});
app.get("/api/routines", async request => ({
  routines: await listRoutines((await actor(request)).id),
}));
app.post("/api/routines", async request => ({
  routine: await createRoutine((await actor(request)).id, routineInput.parse(request.body)),
}));
app.get("/api/routines/:id", async request => ({
  routine: await getRoutine((await actor(request)).id, idParams.parse(request.params).id),
}));
app.patch("/api/routines/:id", async request => {
  const body = routineInput.partial().extend({
    expectedRevision: z.number().int().positive(),
    status: z.enum(["active", "paused"]).optional(),
  }).parse(request.body);
  return { routine: await updateRoutine((await actor(request)).id, idParams.parse(request.params).id,
    body.expectedRevision, body) };
});
app.get("/api/routines/:id/occurrences", async request => ({
  occurrences: await listRoutineOccurrences((await actor(request)).id, idParams.parse(request.params).id),
}));
app.post("/api/routines/:id/test", async request => {
  const body = z.object({ requestId: z.uuid() }).parse(request.body);
  return { occurrence: await testRoutine((await actor(request)).id,
    idParams.parse(request.params).id, body.requestId) };
});

app.get("/api/approvals", async request => ({
  approvals: await listApprovals((await actor(request)).id),
}));
app.post("/api/approvals/:id/decision", async request => {
  const owner = await actor(request);
  const id = idParams.parse(request.params).id;
  const body = z.object({ decision: z.enum(["approve", "reject"]) }).parse(request.body);
  return { approval: await decideApproval(owner.id, id, body.decision) };
});
app.post("/api/model-profiles", async request => ({
  profile: await createModelProfile((await actor(request)).id, modelProfileInput.parse(request.body)),
}));

app.get("/api/runs/:runId/artifacts", async request => {
  const owner = await actor(request);
  const runId = runParams.parse(request.params).runId;
  await getRun(owner.id, runId);
  return { artifacts: await listArtifacts(owner.id, runId) };
});
app.get("/api/artifacts/:id", async request => ({
  artifact: await getArtifact((await actor(request)).id, idParams.parse(request.params).id),
}));
app.get("/api/artifacts/:id/content", async (request, reply) => {
  const item = await getArtifact((await actor(request)).id, idParams.parse(request.params).id);
  const content = await readFile(item.storagePath);
  const inline = (request.query as { inline?: string }).inline === "1" && item.mimeType === "image/png";
  reply.header("content-type", item.mimeType);
  reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.title)}`);
  reply.header("x-content-type-options", "nosniff");
  return reply.send(content);
});

await app.listen({ host: process.env.OPENGROK_HOST || "127.0.0.1", port: Number(process.env.OPENGROK_API_PORT || 3840) });
