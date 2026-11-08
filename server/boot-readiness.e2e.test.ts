// Real server, fake ACP CLI with a slow `--version` probe (each probe may run to its 8 s timeout).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-acp-cli.ts");
// The static catalog the driver would fall back to names wire ids the fake does not offer,
// so seed the startup model cache the way a finished read would have.
const CACHED_MODEL = "fake-model";

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

function instanceOf(home: string, more: Record<string, unknown> = {}) {
  return {
    driver: "deepseekAgent",
    displayName: "Verification fixture",
    environment: {
      FAKE_ACP_MODELS: CACHED_MODEL,
      DEEPSEEK_API_KEY: "sk-fixture",
      FAKE_ACP_VERSION_HOLD_FILE: join(home, "hold-version"),
      FAKE_ACP_VERSION_LOG: join(home, "version-probes.log"),
      FAKE_ACP_RPC_APPEND_FILE: join(home, "turn-rpcs.log"),
      ...more,
    },
    config: { cli: FAKE_CLI },
  };
}

function freshHome(more: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "omb-boot-readiness-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(join(home, "providers", "engine-models"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: {
      claude: instanceOf(home),
      ...Object.fromEntries(Object.entries(more).map(([id, value]) => [id, value instanceof Object && "driver" in (value as object) ? value : { ...instanceOf(home), ...(value as Record<string, unknown>) }])),
    },
  }));
  writeFileSync(join(home, "providers", "engine-models", "claude.json"), JSON.stringify({
    default: CACHED_MODEL, options: [{ id: CACHED_MODEL, label: "Fake model" }],
  }));
  return home;
}

function heldProbes(log: string): number[] {
  return existsSync(log) ? [...readFileSync(log, "utf8").matchAll(/^version (\d+)$/gm)].map((match) => Number(match[1])) : [];
}

function assertAlive(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow();
}

async function boot(home: string) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: verificationServerEnvironment({ ...process.env }, home, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const get = async (path: string) => {
    const response = await fetch(base + path, { headers: { origin: base } });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>;
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { get, control, stop };
}

it("makes a first run's starter bot on the engine a new bot gets", async () => {
  const home = freshHome();
  const server = await boot(home);
  await expect.poll(async () => (await server.get("/api/bots?messages=0")).bots[0]?.modelSelection, { timeout: 15_000 })
    .toMatchObject({ instanceId: "claude", model: expect.stringMatching(/.+/) });
  const [starter] = (await server.get("/api/bots?messages=0")).bots;
  const member = (await server.control("new-bot", "--name", "Room member")).bot;
  expect(member.modelSelection).toEqual(starter.modelSelection);
});

it("answers on a later start while an engine CLI is still being probed, and runs turns once it has answered", async () => {
  const home = freshHome();
  const gate = join(home, "hold-version");
  const probes = join(home, "version-probes.log");
  const rpcs = join(home, "turn-rpcs.log");
  const first = await boot(home);
  const [starter] = (await first.get("/api/bots?messages=0")).bots;
  const member = (await first.control("new-bot", "--name", "Room member")).bot;
  const room = (await first.control("new-channel", "--name", "Start room", "--members", member.id)).channel;
  await first.stop();

  // Hold the next start's CLI probes: health must not wait for them, and a
  // turn on the engine waits for its probe to answer.
  writeFileSync(gate, "");
  rmSync(probes, { force: true });
  const server = await boot(home);
  let held = 0;
  await expect.poll(() => {
    const pids = heldProbes(probes);
    held = pids[pids.length - 1] ?? 0;
    return held;
  }, { timeout: 10_000 }).toBeGreaterThan(0);
  assertAlive(held);

  await server.control("send", "--bot", starter.id, "--task", starter.threadId, "--text", "Right after the start");
  await server.control("send-channel", "--channel", room.id, "--text", "Right after the start, in a room");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  // The engine's probe is still held, so no turn has reached the CLI.
  expect(existsSync(rpcs) ? readFileSync(rpcs, "utf8") : "").not.toContain("session/new");
  assertAlive(held);
  unlinkSync(gate);

  expect((await server.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
  expect((await server.control("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
  // The turn reached the CLI once its own probe had answered.
  await expect.poll(() => readFileSync(rpcs, "utf8"), { timeout: 10_000 }).toContain("session/new");
  const { instances } = await server.get("/api/instances");
  expect(instances.find((instance: { instanceId: string }) => instance.instanceId === "claude")?.snapshot)
    .toMatchObject({ state: "available", authenticated: true });
}, 60_000);

it("runs a turn on a later start once its own engine has answered, while another engine's CLI is still being probed", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-boot-slow-engine-"));
  homes.push(scratch);
  const slowGate = join(scratch, "hold-slow"), slowProbes = join(scratch, "slow-probes.log");
  writeFileSync(slowGate, "");
  const home = freshHome({
    slow: {
      environment: {
        FAKE_ACP_MODELS: CACHED_MODEL, FAKE_ACP_VERSION_HOLD_FILE: slowGate,
        FAKE_ACP_VERSION_LOG: slowProbes, DEEPSEEK_API_KEY: "sk-fixture",
      },
    },
  });
  writeFileSync(join(home, "providers", "engine-models", "slow.json"), JSON.stringify({
    default: CACHED_MODEL, options: [{ id: CACHED_MODEL, label: "Fake model" }],
  }));
  const first = await boot(home);
  // The starter bot lands on the fast engine while the slow one's probe is held.
  await expect.poll(async () => (await first.get("/api/bots?messages=0")).bots[0]?.modelSelection?.instanceId, { timeout: 15_000 }).toBe("claude");
  const [starter] = (await first.get("/api/bots?messages=0")).bots;
  await first.stop();

  rmSync(slowProbes, { force: true });
  const rpcs = join(home, "turn-rpcs.log");
  const server = await boot(home);
  let held = 0;
  await expect.poll(() => {
    const pids = heldProbes(slowProbes);
    held = pids[pids.length - 1] ?? 0;
    return held;
  }, { timeout: 10_000 }).toBeGreaterThan(0);

  await server.control("send", "--bot", starter.id, "--task", starter.threadId, "--text", "Right after the start");
  expect((await server.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
  expect(existsSync(rpcs) ? readFileSync(rpcs, "utf8") : "").toContain("session/new");
  assertAlive(held);
  unlinkSync(slowGate);
}, 60_000);

it("starts the words a later start restored before a message sent while the engines are read", async () => {
  const home = freshHome();
  const gate = join(home, "hold-version");
  const probes = join(home, "version-probes.log");
  const first = await boot(home);
  const [starter] = (await first.get("/api/bots?messages=0")).bots;
  await first.stop();
  // Words still queued for the conversation when the last run stopped.
  const db = new DatabaseSync(join(home, "messages.db"));
  try {
    db.prepare("INSERT INTO chat_followups(id, kind, owner_id, thread_id, send_id, status, payload) VALUES (?, 'bot', ?, ?, NULL, 'pending', ?)")
      .run("queued_before_restart", starter.id, starter.threadId, JSON.stringify({ text: "Queued before the restart" }));
  } finally { db.close(); }

  writeFileSync(gate, "");
  rmSync(probes, { force: true });
  const server = await boot(home);
  await expect.poll(() => heldProbes(probes).length, { timeout: 10_000 }).toBeGreaterThan(0);
  await server.control("send", "--bot", starter.id, "--task", starter.threadId, "--text", "Sent while the engines are read");
  unlinkSync(gate);

  const said = async () => ((await server.get(`/api/threads/${starter.threadId}/messages?limit=100`)).messages as Array<{ role: string; text?: string }>)
    .filter((message) => message.role === "user").map((message) => message.text);
  await expect.poll(said, { timeout: 30_000 }).toHaveLength(2);
  expect(await said()).toEqual(["Queued before the restart", "Sent while the engines are read"]);
  expect((await server.control("wait", "--bot", starter.id, "--task", starter.threadId, "--timeout", "30")).status).toBe("settled");
}, 60_000);
