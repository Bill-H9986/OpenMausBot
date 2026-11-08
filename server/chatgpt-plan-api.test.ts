// Real HTTP server, disposable home, fake CLI; account entry validation and lifecycle only.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CODEX = join(ROOT, "server/testing/fake-codex-app-server.ts");
let child: ChildProcess | undefined;
let home: string;
let base: string;
let logPath: string;
const evidence: Array<{ method: string; path: string; status: number }> = [];

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  evidence.push({ method, path: path.split("?")[0], status: response.status });
  return { status: response.status, body: await response.json() as Record<string, any>, headers: response.headers };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-chatgpt-api-"));
  mkdirSync(join(home, "tmp"));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  logPath = join(tmpdir(), `omb-chatgpt-api-${port}-${process.pid}.log`);
  // Non-product instance names avoid adding unrelated native CLIs to this fixture.
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    fixture: {
      driver: "deepseekAgent", config: { cli: join(ROOT, "server/testing/fake-acp-cli.ts") },
      environment: { FAKE_ACP_MODELS: "fake-model" },
    },
    chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan", cli: FAKE_CODEX } },
  } }));
  const log = openSync(logPath, "a", 0o600);
  try {
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: verificationServerEnvironment({}, home, port), stdio: ["ignore", log, log],
    });
  } finally { closeSync(log); }
  await vi.waitFor(async () => {
    if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Fixture exited: ${logPath}`);
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
    expect(health.status).toBe(200);
    expect((await health.json() as { pid: number }).pid).toBe(child!.pid);
  }, { timeout: 20_000, interval: 100 });
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (logPath) {
    writeFileSync(`${logPath}.requests.json`, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ url: base, logPath, evidencePath: `${logPath}.requests.json` }));
  }
  if (home) await removeTempDir(home);
});

describe("ChatGPT plan accounts over isolated HTTP", () => {
  it("rejects invalid account names without saving", async () => {
    const saved = readFileSync(join(home, "config.json"), "utf8");
    for (const body of [{}, { displayName: " " }, { displayName: "x".repeat(81) }, { displayName: "Bad\nName" },
      { displayName: 42 }, { displayName: "Injected", environment: { OPENAI_API_KEY: "synthetic-injection" } }]) {
      expect((await api("POST", "/api/instances/chatgpt-accounts", body)).status).toBe(400);
    }
    expect((await api("POST", "/api/instances/chatgpt-accounts", { displayName: "Wrong type" }, { "content-type": "text/plain" })).status).toBe(415);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(saved);
  });

  it("renames and removes an added account, but never the built-in one", async () => {
    const created = await api("POST", "/api/instances/chatgpt-accounts", { displayName: "Side plan" });
    expect(created.status).toBe(201);
    const id = created.body.instanceId as string;
    const renamed = await api("PATCH", `/api/instances/${id}`, { displayName: "Client plan" });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.instances.find((row: { instanceId: string }) => row.instanceId === id).displayName).toBe("Client plan");
    expect((await api("PATCH", `/api/instances/${id}`, { configDir: "/elsewhere" })).status).toBe(400);
    expect((await api("DELETE", "/api/instances/chatgpt")).status).toBe(400);
    const removed = await api("DELETE", `/api/instances/${id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.instances.some((row: { instanceId: string }) => row.instanceId === id)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).instances).not.toHaveProperty(id);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).instances).toHaveProperty("chatgpt");
  });
});