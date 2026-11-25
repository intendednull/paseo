import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  let onWake: (event: WakeEvent) => Promise<WakeReply> = async () => ({ skipped: true });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
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
    handle(next: typeof onWake) {
      onWake = next;
    },
  };
}

/** A destination daemon that can stop ("sleep") and start again with its identity and agents. */
async function sleepyHost() {
  const home = await mkdtemp(join(tmpdir(), "paseo-sleepy-home-"));
  const staticDir = await mkdtemp(join(tmpdir(), "paseo-sleepy-static-"));
  let current: TestPaseoDaemon | null = await createTestPaseoDaemon({
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

/** A on the laptop side with the wake plugin, B registered, an agent on B, and B asleep. */
async function fixture(options: { plugin?: boolean; hostWakeTimeoutMs?: number } = {}) {
  const b = await sleepyHost();
  const a = await createTestPaseoDaemon({ hostWakeTimeoutMs: options.hostWakeTimeoutMs });
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
    notifyOnFinish: false,
  });
  expect(child.isError, JSON.stringify(child.body)).toBe(false);
  const agentId = String(child.body.agentId);
  await (await api(b.daemon)).client.waitForFinish(agentId, 10000);
  await b.sleep();
  await status(paseo, "offline");
  const send = (prompt: string) => call("send_agent_prompt", { serverId, agentId, prompt });
  const activity = async () => {
    const direct = await api(b.daemon);
    await direct.client.waitForFinish(agentId, 10000);
    return JSON.stringify(await direct.client.fetchAgentTimeline(agentId));
  };
  return { a, b, paseo, client, endpoint, serverId, agentId, parent, call, send, activity };
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
    caller: { agentId: parent.id, labels: { role: "lead" } },
    deadline: expect.any(String),
  });
  expect(JSON.stringify(endpoint.events[0])).not.toContain("127.0.0.1");
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
