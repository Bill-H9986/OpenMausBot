// The real server booted the way the image's launcher boots it (secrets over a pipe, never the environment), synthetic
// engines. No guest can connect, so what a guest left behind is written into the records while the server is stopped.
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawnWithSecrets } from "./cloud-home-start.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { markLeftBehind } from "./testing/cloud-left-behind.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const relayToken = `box_omb_${randomBytes(32).toString("base64url")}`;
let home = "";
let base = "";
let child: ChildProcess;
let log = "";
let owner = "";
let boot: () => Promise<void> = async () => {};

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** The Admin's signed pairing: it only works when the server got the secret. */
async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}

const probeOf = (name: string) => join(home, `${name}-probe.json`);
/** A wrapper around the fake ACP CLI that first reads what an engine's shell
 * could: its own environment and its parent's (the server's) starting one.
 * A turn launches with no CLI args; a version probe passes "--version". */
function probing(name: string, extra: string): string {
  const cli = join(home, `${name}-cli.mjs`);
  writeFileSync(cli, `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const environ = (pid) => { try {
  return process.platform === "linux" ? readFileSync("/proc/" + pid + "/environ", "utf8")
    : execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="]).toString();
} catch (error) { return "unreadable: " + error.message; } };
if (process.argv.length === 2) {
  writeFileSync(${JSON.stringify(probeOf(name))}, JSON.stringify({ parent: environ(process.ppid), own: JSON.stringify(process.env) }));
}
${extra}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-acp-cli.ts")).href)});
`, { mode: 0o755 });
  return cli;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-guest-shell-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });

  // An engine whose turns hold until the test writes the release file; it
  // dumps its latest start to held.json, and probes what its shell could read.
  const held = probing("held", `process.env.FAKE_ACP_MODE = "echo-gated";
 process.env.FAKE_ACP_GATE_FILE = ${JSON.stringify(join(home, "release"))};
 process.env.FAKE_ACP_DUMP = ${JSON.stringify(join(home, "held.json"))};
 process.env.FAKE_ACP_MODELS = "fake-model";`);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi", "claude"].map((id) => [id, { driver: "not-a-real-driver" }])),
      held: { driver: "deepseekAgent", displayName: "Held", config: { cli: held } },
      // An engine that cannot run a turn without its own shell (ACP).
      shelled: { driver: "deepseekAgent", displayName: "Shelled", config: { cli: join(SERVER_DIR, "testing", "fake-acp-cli.ts") }, environment: { FAKE_ACP_MODELS: "fake-model" } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  // As the launcher starts it: contract in the env, secrets on the pipe; records every process the server starts and whether fd 3 was still open.
  const spawnWatch = join(home, "spawn-watch.mjs");
  writeFileSync(spawnWatch, `import { createRequire, syncBuiltinESMExports } from "node:module";
import { appendFileSync, fstatSync } from "node:fs";
const cp = createRequire(import.meta.url)("node:child_process");
let pipe; try { pipe = fstatSync(3).ino; } catch {}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = cp[name];
  cp[name] = function (...args) {
    let open = false; try { open = pipe !== undefined && fstatSync(3).ino === pipe; } catch {}
    appendFileSync(${JSON.stringify(join(home, "spawns.log"))}, name + " " + String(args[0]).slice(0, 60) + (open ? " PIPE-OPEN" : "") + "\\n");
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
`);
  boot = async () => {
    child = spawnWithSecrets(process.execPath, ["--import", offlinePrelude, "--import", pathToFileURL(spawnWatch).href, join(SERVER_DIR, "index.ts")], {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_PUBLIC_URL: `https://${HOST}`, OMB_CLOUD_BOAT_URL: "https://cloud.example.test/api/cloud/services/boat/api/box/v1",
      OMB_CLOUD_SECRETS_FD: "3",
    }, { OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_CLOUD_BOAT_TOKEN: relayToken }, undefined, true);
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await boot();
  owner = await adminPairing();
}, hostTimeout(40_000));

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const newBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", { token: owner, body: { name, modelSelection: { instanceId, model: "fake-model" } } })).body.bot as { id: string; threadId: string };
/** Written into the server's records while it is stopped. */
async function leftBehind(of: { threadId?: string; routineId?: string }) {
  await waitForExit(child, { signal: "SIGTERM" });
  markLeftBehind(join(home, ".openmausbot"), { threadIds: of.threadId ? [of.threadId] : [], routineIds: of.routineId ? [of.routineId] : [] });
  await boot();
}
const guestThread = async (bot: { id: string }) => {
  const threadId = (await api("POST", `/api/bots/${bot.id}/tasks`, { token: owner, body: { title: "Guest's" } })).body.task.threadId as string;
  await leftBehind({ threadId });
  return threadId;
};
const ownThread = async (bot: { id: string }) => (await api("POST", `/api/bots/${bot.id}/tasks`, { token: owner, body: { title: "Mine" } })).body.task.threadId as string;
const say = (token: string, bot: { id: string }, text: string, threadId: string) =>
  api("POST", `/api/bots/${bot.id}/messages`, { token, body: { text, threadId } });

it("boots with its secrets from the launcher's pipe: the Admin's signed pairing works", () => {
  expect(owner).toMatch(/^omb_sess_/);
  expect(log).not.toContain("its secrets came in this process's environment");
});

it("reads its secrets before it starts any process: none inherits the pipe", () => {
  const spawns = existsSync(join(home, "spawns.log")) ? readFileSync(join(home, "spawns.log"), "utf8") : "";
  expect(spawns).not.toContain("PIPE-OPEN");
});

it("no engine a bot runs finds the Cloud's secrets: not in its own environment, not in the server's starting one", async () => {
  const bot = await newBot("Probe", "held");
  rmSync(probeOf("claude"), { force: true });
  const mine = await ownThread(bot);
  expect((await say(owner, bot, "Hello.", mine)).status).toBe(202);
  await expect.poll(() => existsSync(probeOf("claude")), { timeout: hostTimeout(15_000) }).toBe(true);
  const probe = JSON.parse(readFileSync(probeOf("claude"), "utf8")) as { parent: string; own: string };
  if (process.platform !== "win32") expect(probe.parent).toContain("OMB_CLOUD_MACHINE_ID=3f9c2a4e");
  for (const where of [probe.parent, probe.own]) {
    expect(where).not.toContain(secret);
    expect(where).not.toContain(relayToken);
  }
  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
}, hostTimeout(60_000));

it("a guest's request to a bot whose engine needs its shell is refused in one plain line; the owner's is not", async () => {
  const bot = await newBot("Shelled bot", "shelled");
  const guests = await guestThread(bot);
  const refused = await say(owner, bot, "Hello.", guests);
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("This conversation is from before the Cloud was only yours, and this bot's AI can't work in it. Start a new conversation.");
  expect(((await api("GET", `/api/threads/${guests}/messages`, { token: owner })).body.messages as any[]).filter((message) => message.role === "user")).toEqual([]);
  expect((await say(owner, bot, "Hello.", await ownThread(bot))).status).toBe(202);
}, hostTimeout(60_000));


it("a routine from before this update, on an engine that cannot be confined, tells the owner what to do", async () => {
  const bot = await newBot("Shelled routine bot", "shelled");
  const created = await api("POST", "/api/routines", { token: owner, body: { name: "From before", prompt: "Check the site.", botId: bot.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } });
  await leftBehind({ routineId: created.body.routine.id });
  expect((await api("POST", `/api/routines/${created.body.routine.id}/run`, { token: owner })).status).toBe(201);
  await expect.poll(async () => JSON.stringify(((await api("GET", "/api/routines", { token: owner })).body.runs ?? [])
    .filter((run: any) => run.routineId === created.body.routine.id)), { timeout: hostTimeout(15_000) })
    .toContain("This routine was made before this update. Open it and save it once to run it with full access.");
}, hostTimeout(60_000));

it("a room a guest opened with a bot whose engine needs its shell refuses the turn in one plain line", async () => {
  const bot = await newBot("Shelled room bot", "shelled");
  const room = await api("POST", "/api/groups", { token: owner, body: { memberIds: [bot.id], name: "Guest's room", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  await leftBehind({ threadId: room.body.group.threadId });
  expect((await api("POST", `/api/groups/${room.body.group.id}/messages`, { token: owner, body: { text: "Hello." } })).status).toBeLessThan(300);
  await expect.poll(async () => ((await api("GET", `/api/threads/${room.body.group.threadId}/messages`, { token: owner })).body.messages as any[])
    .some((message) => String(message.tool?.name ?? "").includes("this bot's AI can't work in it")), { timeout: hostTimeout(15_000) }).toBe(true);
}, hostTimeout(60_000));
