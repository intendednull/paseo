import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, connect as tcpConnect, type Socket } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { resolveDaemonVersion } from "../daemon-version.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

const OFFLINE_MESSAGE = "Cannot reach host. Check the connection; retrying automatically.";

/** What the test plugin's hook does, decided by the test through a local HTTP endpoint. */
type WakeReply = { skipped: true } | { error: string } | { result: unknown } | "hang";
interface WakeEvent {
  host: { serverId: string; label: string | null; metadata: Record<string, string> };
  operation: string;
  caller: { agentId: string; labels: Record<string, string> } | null;
  deadline: string;
}

async function wakeEndpoint() {
  const events: WakeEvent[] = [];
  const cancels: string[] = [];
  let onWake: (event: WakeEvent) => Promise<WakeReply> = async () => ({ skipped: true });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url?.endsWith("/cancelled")) {
        cancels.push(body);
        response.end("{}");
        return;
      }
      const event = JSON.parse(body) as WakeEvent;
      events.push(event);
      void onWake(event).then((reply) => {
        if (reply === "hang") return;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(reply));
        return undefined;
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing wake endpoint port");
  return {
    url: `http://127.0.0.1:${address.port}/wake`,
    events,
    cancels,
    handle(next: typeof onWake) {
      onWake = next;
    },
  };
}

/** A destination daemon that can stop ("sleep") and start again with its identity and agents. */
async function sleepyHost(
  options: Pick<Parameters<typeof createTestPaseoDaemon>[0] & {}, "agentClients"> = {},
) {
  const home = await mkdtemp(join(tmpdir(), "paseo-sleepy-home-"));
  const staticDir = await mkdtemp(join(tmpdir(), "paseo-sleepy-static-"));
  let current: TestPaseoDaemon | null = await createTestPaseoDaemon({
    ...options,
    paseoHomeRoot: home,
    staticDir,
    cleanup: false,
  });
  const port = current.port;
  cleanup.push(async () => {
    await current?.close();
    await rm(home, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  });
  return {
    port,
    staticDir,
    get daemon() {
      if (!current) throw new Error("The host is asleep");
      return current;
    },
    async sleep() {
      await current?.close();
      current = null;
    },
    async wake() {
      current ??= await createTestPaseoDaemon({
        ...options,
        listenPort: port,
        paseoHomeRoot: home,
        staticDir,
        cleanup: false,
      });
    },
  };
}

async function api(instance: TestPaseoDaemon) {
  const client = createHostClient(`127.0.0.1:${instance.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await client.connect();
  const paseo = createPaseoApi(client);
  cleanup.push(async () => {
    await paseo.dispose();
    await client.close();
  });
  return { paseo, client };
}

async function status(paseo: ReturnType<typeof createPaseoApi>, expected: string) {
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[0]?.status, { timeout: 15000 })
    .toBe(expected);
}

async function installWakePlugin(
  client: Awaited<ReturnType<typeof api>>["client"],
  directory: string,
  url: string,
) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "wake-test",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    join(directory, "index.server.ts"),
    `
export default function contribute(server) {
  server.addHook("host.route.offline", async (event, { signal }) => {
    // The payload is a copy: changing it changes nothing in the daemon.
    const sent = JSON.stringify(event);
    signal.addEventListener("abort", () => {
      void fetch(${JSON.stringify(url)} + "/cancelled", { method: "POST", body: event.host.label ?? "" }).catch(() => {});
    }, { once: true });
    event.host.serverId = "srv_redirected";
    const response = await fetch(${JSON.stringify(url)}, { method: "POST", body: sent, signal });
    const reply = await response.json();
    if (reply.error) throw new Error(reply.error);
    if (reply.skipped) return { skipped: true };
    return reply.result;
  });
  return () => {};
}`,
  );
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
}

/** A TCP proxy to `target` that opens each link after `delayMs`; null holds links until destroyed. */
async function slowProxy(target: number) {
  const sockets = new Set<Socket>();
  const state = { delayMs: 0 as number | null, port: 0 };
  function forward(socket: Socket) {
    const upstream = tcpConnect(target, "127.0.0.1");
    sockets.add(upstream);
    socket.pipe(upstream).pipe(socket);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    if (state.delayMs !== null) setTimeout(forward, state.delayMs, socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy port");
  state.port = address.port;
  return state;
}

/** A on the laptop side with the wake plugin, B registered, an agent on B, and B asleep. */
async function fixture(
  options: {
    plugin?: boolean;
    hostWakeTimeoutMs?: number;
    notifyOnFinish?: boolean;
    hostAgents?: Parameters<typeof createTestAgentClients>[0];
    parentPrompts?: string[];
  } = {},
) {
  const b = await sleepyHost(
    options.hostAgents ? { agentClients: createTestAgentClients(options.hostAgents) } : {},
  );
  const a = await createTestPaseoDaemon({
    hostWakeTimeoutMs: options.hostWakeTimeoutMs,
    ...(options.parentPrompts
      ? {
          agentClients: createTestAgentClients({
            onStartTurn: (prompt) => options.parentPrompts!.push(JSON.stringify(prompt)),
          }),
        }
      : {}),
  });
  cleanup.push(() => a.close());
  const { paseo, client } = await api(a);
  const endpoint = await wakeEndpoint();
  if (options.plugin !== false)
    await installWakePlugin(client, join(a.staticDir, "wake-plugin"), endpoint.url);
  await paseo.hosts.add({
    connection: `127.0.0.1:${b.port}`,
    label: "Sleepy B",
    metadata: { "managed-by": "test" },
  });
  await status(paseo, "online");
  const serverId = (await paseo.hosts.list()).hosts[0]!.serverId!;
  const workspace = await paseo.workspaces.create({
    source: { kind: "directory", path: a.staticDir },
  });
  const parent = await workspace.agents.create({
    config: { provider: "claude/claude-test" },
    title: "Laptop parent",
    labels: { role: "lead" },
  });
  const mcp = new Client({ name: "wake-test", version: "1" });
  cleanup.push(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${a.port}/mcp/agents?callerAgentId=${parent.id}`),
    ),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await mcp.callTool({ name, arguments: args });
    return {
      isError: response.isError === true,
      body: z.record(z.string(), z.unknown()).parse(response.structuredContent),
    };
  };
  const destination = await call("create_workspace", {
    serverId,
    isolation: "local",
    path: b.staticDir,
    title: "Destination",
  });
  const child = await call("create_agent", {
    serverId,
    workspaceId: destination.body.workspaceId,
    title: "Sleepy child",
    provider: "claude/claude-test",
    initialPrompt: "First task",
    notifyOnFinish: options.notifyOnFinish ?? false,
  });
  expect(child.isError, JSON.stringify(child.body)).toBe(false);
  const agentId = String(child.body.agentId);
  if (!options.hostAgents) await (await api(b.daemon)).client.waitForFinish(agentId, 10000);
  await b.sleep();
  await status(paseo, "offline");
  const send = (prompt: string) => call("send_agent_prompt", { serverId, agentId, prompt });
  const activity = async () => {
    const direct = await api(b.daemon);
    await direct.client.waitForFinish(agentId, 10000);
    return JSON.stringify(await direct.client.fetchAgentTimeline(agentId));
  };
  const workspaceId = String(destination.body.workspaceId);
  return {
    a,
    b,
    paseo,
    client,
    endpoint,
    serverId,
    agentId,
    workspaceId,
    parent,
    call,
    send,
    activity,
    mcp,
  };
}

test("without a plugin on the hook, a send to an offline host fails at once as before", async () => {
  const { send, serverId, endpoint, call, agentId } = await fixture({ plugin: false });
  const started = Date.now();
  const failure = await send("NO_PLUGIN");
  expect(failure).toEqual({
    isError: true,
    body: { serverId, code: "host_offline", error: OFFLINE_MESSAGE },
  });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await call("get_agent_status", { serverId, agentId })).toMatchObject({
    isError: true,
    body: { code: "host_offline", error: OFFLINE_MESSAGE },
  });
  expect(endpoint.events).toEqual([]);
}, 60_000);

test("a plugin that skips the host leaves today's fast failure unchanged", async () => {
  const { send, serverId, endpoint } = await fixture();
  endpoint.handle(async () => ({ skipped: true }));
  expect(await send("SKIPPED")).toEqual({
    isError: true,
    body: { serverId, code: "host_offline", error: OFFLINE_MESSAGE },
  });
  expect(endpoint.events).toHaveLength(1);
}, 60_000);

test("a send to a sleeping host wakes it once, reconnects at once and delivers with the caller", async () => {
  const { b, send, serverId, endpoint, parent, activity, paseo, call, agentId } = await fixture();
  endpoint.handle(async () => {
    await b.wake();
    return { result: { serverId: "srv_redirected", connection: "127.0.0.1:1" } };
  });
  // Status reads never wake a host.
  expect(await call("get_agent_status", { serverId, agentId })).toMatchObject({
    isError: true,
    body: { code: "host_offline" },
  });
  expect(endpoint.events).toEqual([]);
  const [first, second] = await Promise.all([send("WAKE_ONE"), send("WAKE_TWO")]);
  expect(first, JSON.stringify(first.body)).toMatchObject({
    isError: false,
    body: { success: true, serverId },
  });
  expect(second, JSON.stringify(second.body)).toMatchObject({
    isError: false,
    body: { success: true, serverId },
  });
  expect(endpoint.events).toHaveLength(1);
  expect(endpoint.events[0]).toMatchObject({
    host: { serverId, label: "Sleepy B", metadata: { "managed-by": "test" } },
    operation: "send_agent_prompt",
    caller: { agentId: parent.id },
    deadline: expect.any(String),
  });
  expect(JSON.stringify(endpoint.events[0])).not.toContain("127.0.0.1");
  expect(JSON.stringify(endpoint.events[0])).not.toContain("lead");
  const timeline = await activity();
  expect(timeline).toContain("WAKE_ONE");
  expect(timeline).toContain("WAKE_TWO");
  // The plugin's return value and its edits to the payload did not move the registration.
  expect((await paseo.hosts.list()).hosts).toMatchObject([
    { serverId, status: "online", label: "Sleepy B" },
  ]);
}, 90_000);

test("a failing plugin keeps host_offline and says the message was not sent", async () => {
  const { send, serverId, endpoint } = await fixture();
  endpoint.handle(async () => ({ error: "wake: sprite is gone" }));
  const failure = await send("FAILED_WAKE");
  expect(failure).toMatchObject({ isError: true, body: { serverId, code: "host_offline" } });
  expect(String(failure.body.error)).toMatch(
    /^Host Sleepy B is asleep; waking it failed: .*wake: sprite is gone; the message was not sent\.$/,
  );
}, 60_000);

test("a wake that outlasts the daemon's bound times out and cancels the hook", async () => {
  const { send, serverId, endpoint } = await fixture({ hostWakeTimeoutMs: 1500 });
  endpoint.handle(async () => "hang");
  const started = Date.now();
  const failure = await send("SLOW_WAKE");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(failure).toMatchObject({
    isError: true,
    body: {
      serverId,
      code: "host_offline",
      error:
        "Host Sleepy B is asleep; waking it timed out: not online within 2 s; the message was not sent.",
    },
  });
}, 60_000);

test("a plugin that reports success while the host stays down fails at the bound", async () => {
  const { send, endpoint } = await fixture({ hostWakeTimeoutMs: 2000 });
  endpoint.handle(async () => ({ result: null }));
  const failure = await send("STILL_DOWN");
  expect(failure.body).toMatchObject({
    code: "host_offline",
    error: expect.stringContaining("waking it timed out"),
  });
}, 60_000);

test("a disabled host or one with a terminal error is not woken", async () => {
  const { send, serverId, endpoint, paseo, b } = await fixture();
  endpoint.handle(async () => {
    throw new Error("must not be called");
  });
  const host = (await paseo.hosts.list()).hosts[0]!;
  await paseo.hosts.update(host.registrationId, { enabled: false });
  expect(await send("DISABLED")).toMatchObject({
    isError: true,
    body: { code: "host_disabled" },
  });
  // Another daemon at the same address: the pinned identity no longer matches, a terminal error.
  await paseo.hosts.update(host.registrationId, { enabled: true });
  const impostor = await createTestPaseoDaemon({ listenPort: b.port });
  cleanup.push(() => impostor.close());
  await status(paseo, "error");
  await impostor.close();
  expect(await send("TERMINAL")).toMatchObject({
    isError: true,
    body: { serverId, code: "server_id_mismatch" },
  });
  expect(endpoint.events).toEqual([]);
}, 60_000);

test("a session route asks for a wake explicitly; a plain route still fails at once", async () => {
  const { b, serverId, endpoint, paseo, agentId } = await fixture();
  endpoint.handle(async () => {
    await b.wake();
    return { result: undefined };
  });
  const plain = await paseo.hosts.client(serverId).catch((error: unknown) => error);
  expect(plain).toMatchObject({ code: "host_offline" });
  expect((plain as Error).message).toContain(OFFLINE_MESSAGE);
  expect(endpoint.events).toEqual([]);
  const remote = await paseo.hosts.client(serverId, { wake: true });
  cleanup.push(() => remote.dispose());
  expect(endpoint.events).toMatchObject([{ operation: "session_route", caller: null }]);
  expect((await remote.agents.ref(agentId).refresh())?.agent.title).toBe("Sleepy child");
}, 90_000);

test("a hanging or throwing hook delays or fails only its own host's route", async () => {
  const hanging = await sleepyHost();
  const throwing = await sleepyHost();
  const awake = await sleepyHost();
  const a = await createTestPaseoDaemon({ hostWakeTimeoutMs: 15_000 });
  cleanup.push(() => a.close());
  const { paseo, client } = await api(a);
  const endpoint = await wakeEndpoint();
  await installWakePlugin(client, join(a.staticDir, "wake-plugin"), endpoint.url);
  const hosts = { hanging, throwing, awake };
  for (const [label, host] of Object.entries(hosts))
    await paseo.hosts.add({ connection: `127.0.0.1:${host.port}`, label });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts.map((host) => host.status), {
      timeout: 15000,
    })
    .toEqual(["online", "online", "online"]);
  const serverIds = Object.fromEntries(
    (await paseo.hosts.list()).hosts.map((host) => [host.label!, host.serverId!]),
  );
  const mcp = new Client({ name: "wake-isolation", version: "1" });
  cleanup.push(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${a.port}/mcp/agents`)),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await mcp.callTool({ name, arguments: args });
    return {
      isError: response.isError === true,
      body: z.record(z.string(), z.unknown()).parse(response.structuredContent),
    };
  };
  const workspace = async (label: keyof typeof hosts) =>
    call("create_workspace", {
      serverId: serverIds[label],
      isolation: "local",
      path: hosts[label].staticDir,
      title: `${label} workspace`,
    });
  await hanging.sleep();
  await throwing.sleep();
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts.map((host) => host.status), {
      timeout: 15000,
    })
    .toEqual(["offline", "offline", "online"]);
  endpoint.handle(async (event) =>
    event.host.label === "hanging" ? "hang" : { error: "wake: no such sprite" },
  );
  const started = Date.now();
  const stuck = workspace("hanging");
  await expect.poll(() => endpoint.events.length).toBe(1);
  // While one host's hook hangs, an online host and another offline host are unaffected.
  const online = await workspace("awake");
  expect(online, JSON.stringify(online.body)).toMatchObject({ isError: false });
  const failed = await workspace("throwing");
  expect(failed.body).toMatchObject({
    code: "host_offline",
    error: expect.stringContaining("Host throwing is asleep; waking it failed:"),
  });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(endpoint.events.map((event) => event.host.label)).toEqual(["hanging", "throwing"]);
  expect((await stuck).body).toMatchObject({
    code: "host_offline",
    error: expect.stringContaining("Host hanging is asleep; waking it timed out"),
  });
  expect((await workspace("awake")).isError).toBe(false);
}, 90_000);

test("a finish observation of a child on a sleeping host retries without waking it", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  cleanup.push(async () => release());
  const parentPrompts: string[] = [];
  const { endpoint, agentId, paseo } = await fixture({
    notifyOnFinish: true,
    hostAgents: { beforeTurnComplete: () => held },
    parentPrompts,
  });
  endpoint.handle(async () => {
    throw new Error("an observation must not wake the host");
  });
  // The parent's finish subscription keeps observing the running child while its host sleeps,
  // until it gives up on the unreachable host; none of its attempts reach the hook.
  await expect
    .poll(() => parentPrompts.join("\n"), { timeout: 60_000, interval: 500 })
    .toContain("after three failed attempts");
  expect(parentPrompts.join("\n")).toContain(agentId);
  expect(endpoint.events).toEqual([]);
  expect((await paseo.hosts.list()).hosts[0]?.status).not.toBe("online");
}, 120_000);

test("a host destroyed while still registered fails at once and says so", async () => {
  const { send, serverId, endpoint } = await fixture();
  endpoint.handle(async () => ({ result: { missing: true } }));
  const started = Date.now();
  expect(await send("GONE")).toMatchObject({
    isError: true,
    body: {
      serverId,
      code: "host_offline",
      error: "Host Sleepy B no longer exists (destroyed); the message was not sent.",
    },
  });
  expect(Date.now() - started).toBeLessThan(5000);
}, 60_000);

test("MCP progress during a wake keeps a client with a short timeout waiting", async () => {
  const { b, mcp, serverId, agentId, endpoint } = await fixture();
  endpoint.handle(async () => {
    // Longer than the client's timeout below; progress every 10 s resets it.
    await new Promise((resolve) => setTimeout(resolve, 14_000));
    await b.wake();
    return { result: undefined };
  });
  const progress: string[] = [];
  const response = await mcp.callTool(
    { name: "send_agent_prompt", arguments: { serverId, agentId, prompt: "SLOW_WAKE_PROGRESS" } },
    undefined,
    {
      timeout: 12_000,
      resetTimeoutOnProgress: true,
      onprogress: (update) => progress.push(String(update.message)),
    },
  );
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(progress.length).toBeGreaterThanOrEqual(1);
  expect(progress[0]).toMatch(new RegExp(`^Waking host ${serverId}: \\d+ s so far$`));
}, 90_000);

test("a wake that hits the daemon's bound sends hook.cancel to the plugin", async () => {
  const { send, endpoint } = await fixture({ hostWakeTimeoutMs: 1500 });
  endpoint.handle(async () => "hang");
  expect((await send("CANCEL_ON_TIMEOUT")).body).toMatchObject({
    error: expect.stringContaining("waking it timed out"),
  });
  await expect.poll(() => endpoint.cancels).toEqual(["Sleepy B"]);
}, 60_000);

test("a send whose caller goes away stops waiting and is never delivered; the wake continues", async () => {
  const { a, b, parent, serverId, agentId, endpoint, paseo, activity } = await fixture();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  endpoint.handle(async () => {
    await released;
    await b.wake();
    return { result: undefined };
  });
  // The daemon sees a cancel when the call's HTTP request closes (an interrupted agent's client).
  const caller = new Client({ name: "wake-cancel", version: "1" });
  await caller.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${a.port}/mcp/agents?callerAgentId=${parent.id}`),
    ),
  );
  const cancelled = caller
    .callTool({
      name: "send_agent_prompt",
      arguments: { serverId, agentId, prompt: "CANCELLED_SEND" },
    })
    .catch((error: unknown) => error);
  await expect.poll(() => endpoint.events.length).toBe(1);
  await caller.close();
  expect(await cancelled).toBeInstanceOf(Error);
  await new Promise((resolve) => setTimeout(resolve, 500));
  release();
  // The shared wake still brings the host online, but the cancelled prompt never goes out.
  await status(paseo, "online");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(await activity()).not.toContain("CANCELLED_SEND");
}, 90_000);

test("a host that is connecting gets a grace period and no wake", async () => {
  const b = await createTestPaseoDaemon();
  cleanup.push(() => b.close());
  // A link to B that takes 3 s to open: the registration sits in "connecting" meanwhile.
  const proxy = await slowProxy(b.port);
  proxy.delayMs = 3000;
  const address = { port: proxy.port };
  // First let A pin B's identity, then restart the link so it is connecting again.
  const a = await createTestPaseoDaemon();
  cleanup.push(() => a.close());
  const { paseo, client } = await api(a);
  const endpoint = await wakeEndpoint();
  await installWakePlugin(client, join(a.staticDir, "wake-plugin"), endpoint.url);
  endpoint.handle(async () => {
    throw new Error("a connecting host must not be woken");
  });
  const host = await paseo.hosts.add({ connection: `127.0.0.1:${address.port}`, label: "Slow B" });
  await status(paseo, "online");
  const serverId = (await paseo.hosts.list()).hosts[0]!.serverId!;
  await paseo.hosts.update(host.registrationId, { enabled: false });
  await paseo.hosts.update(host.registrationId, { enabled: true });
  await status(paseo, "connecting");
  const mcp = new Client({ name: "wake-grace", version: "1" });
  cleanup.push(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${a.port}/mcp/agents`)),
  );
  const response = await mcp.callTool({
    name: "create_workspace",
    arguments: { serverId, isolation: "local", path: b.staticDir, title: "Grace" },
  });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(endpoint.events).toEqual([]);
}, 60_000);

test("a host disabled or removed mid-wait fails the wait; a label change doesn't", async () => {
  for (const change of ["disabled", "removed"] as const) {
    const { send, endpoint, paseo } = await fixture({ hostWakeTimeoutMs: 20_000 });
    // The plugin reports a wake, but the host stays down: the daemon is left waiting.
    endpoint.handle(async () => ({ result: undefined }));
    const sending = send(`MID_WAIT_${change}`);
    await expect.poll(() => endpoint.events.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const id = (await paseo.hosts.list()).hosts[0]!.registrationId;
    if (change === "disabled") await paseo.hosts.update(id, { enabled: false });
    else await paseo.hosts.remove(id);
    expect((await sending).body).toMatchObject({
      code: "host_offline",
      error: `Host Sleepy B is asleep; waking it failed: the host was ${change}; the message was not sent.`,
    });
  }
  const { b, send, endpoint, paseo, activity } = await fixture({ hostWakeTimeoutMs: 20_000 });
  // The plugin reports a wake at once; the daemon then waits for the link, mid-wait the label changes.
  endpoint.handle(async () => ({ result: undefined }));
  const sending = send("AFTER_RELABEL");
  await expect.poll(() => endpoint.events.length).toBe(1);
  const id = (await paseo.hosts.list()).hosts[0]!.registrationId;
  await paseo.hosts.update(id, { label: "Renamed B" });
  await b.wake();
  expect((await sending).isError).toBe(false);
  expect(await activity()).toContain("AFTER_RELABEL");
}, 120_000);

test("an aborted session route stops waiting", async () => {
  const { a, serverId, endpoint } = await fixture();
  endpoint.handle(async () => "hang");
  const origin = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await origin.connect();
  cleanup.push(() => origin.close());
  const person = createPaseoApi(origin);
  const opening = person.hosts.client(serverId, { wake: true }).catch((error: unknown) => error);
  await expect.poll(() => endpoint.events.length).toBe(1);
  await person.dispose();
  expect(await opening).toBeInstanceOf(Error);
}, 60_000);

test("an MCP send and a session route to one sleeping host share one wake", async () => {
  const { b, send, serverId, endpoint, paseo, activity } = await fixture();
  endpoint.handle(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await b.wake();
    return { result: undefined };
  });
  const [sent, remote] = await Promise.all([
    send("SHARED_WAKE"),
    paseo.hosts.client(serverId, { wake: true }),
  ]);
  cleanup.push(() => remote.dispose());
  expect(sent.isError, JSON.stringify(sent.body)).toBe(false);
  expect(endpoint.events).toHaveLength(1);
  expect(await activity()).toContain("SHARED_WAKE");
}, 90_000);

test("create_agent wakes a sleeping host; list_agents and list_workspaces don't", async () => {
  const { b, call, serverId, workspaceId, endpoint } = await fixture();
  endpoint.handle(async () => {
    await b.wake();
    return { result: undefined };
  });
  for (const read of ["list_agents", "list_workspaces"]) {
    expect(await call(read, { serverId })).toMatchObject({
      isError: true,
      body: { code: "host_offline", error: OFFLINE_MESSAGE },
    });
  }
  expect(endpoint.events).toEqual([]);
  const created = await call("create_agent", {
    serverId,
    workspaceId,
    title: "Woken child",
    provider: "claude/claude-test",
    initialPrompt: "Woken task",
    notifyOnFinish: false,
  });
  expect(created.isError, JSON.stringify(created.body)).toBe(false);
  expect(endpoint.events).toMatchObject([{ operation: "create_agent" }]);
}, 90_000);

test("after the connecting grace runs out the plugin is told the time actually left", async () => {
  const b = await createTestPaseoDaemon();
  cleanup.push(() => b.close());
  const proxy = await slowProxy(b.port);
  const a = await createTestPaseoDaemon({ hostWakeTimeoutMs: 40_000 });
  cleanup.push(() => a.close());
  const { paseo, client } = await api(a);
  const endpoint = await wakeEndpoint();
  await installWakePlugin(client, join(a.staticDir, "wake-plugin"), endpoint.url);
  const host = await paseo.hosts.add({ connection: `127.0.0.1:${proxy.port}`, label: "Stuck B" });
  await status(paseo, "online");
  const serverId = (await paseo.hosts.list()).hosts[0]!.serverId!;
  // From now on links hang: the restarted link stays "connecting" through the whole grace.
  proxy.delayMs = null;
  await paseo.hosts.update(host.registrationId, { enabled: false });
  await paseo.hosts.update(host.registrationId, { enabled: true });
  await status(paseo, "connecting");
  let calledAt = 0;
  endpoint.handle(async () => {
    calledAt = Date.now();
    proxy.delayMs = 0; // "the wake": links open again
    return { result: undefined };
  });
  const mcp = new Client({ name: "wake-grace-deadline", version: "1" });
  cleanup.push(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${a.port}/mcp/agents`)),
  );
  const started = Date.now();
  const response = await mcp.callTool({
    name: "create_workspace",
    arguments: { serverId, isolation: "local", path: b.staticDir, title: "After grace" },
  });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(endpoint.events).toHaveLength(1);
  expect(calledAt - started).toBeGreaterThanOrEqual(9_500);
  // The deadline counts from the start of the wake, grace included, not from the hook call.
  const deadline = Date.parse(endpoint.events[0]!.deadline);
  expect(Math.abs(deadline - (started + 40_000))).toBeLessThan(2_000);
  expect(deadline - calledAt).toBeLessThan(32_000);
}, 90_000);

test("create_workspace wakes a sleeping host", async () => {
  const { b, call, serverId, endpoint } = await fixture();
  endpoint.handle(async () => {
    await b.wake();
    return { result: undefined };
  });
  const created = await call("create_workspace", {
    serverId,
    isolation: "local",
    path: b.staticDir,
    title: "Woken workspace",
  });
  expect(created.isError, JSON.stringify(created.body)).toBe(false);
  expect(endpoint.events).toMatchObject([{ operation: "create_workspace" }]);
}, 90_000);
