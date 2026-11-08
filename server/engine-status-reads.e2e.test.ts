// Real server, fake ACP CLI whose `--version` probe is logged: an engine's CLI is probed once per answer, not once per reader.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-acp-cli.ts");
const MODEL = "fake-model";

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "omb-engine-status-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  const gate = join(home, "hold-version");
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { claude: {
      driver: "deepseekAgent",
      displayName: "Verification fixture",
      environment: {
        FAKE_ACP_MODELS: MODEL,
        FAKE_ACP_VERSION_HOLD_FILE: gate,
        FAKE_ACP_VERSION_LOG: join(home, "version-probes.log"),
        FAKE_ACP_LAUNCH_COUNT_FILE: join(home, "launches.log"),
        DEEPSEEK_API_KEY: "sk-fixture",
      },
      config: { cli: FAKE_CLI },
    } },
  }));
  return home;
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
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status, `${method} ${path}`).toBe(200);
    return response.json() as Promise<any>;
  };
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { call, control: (...args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>, stop };
}

const claudeStatus = (body: { instances: Array<{ instanceId: string; snapshot: Record<string, unknown> }> }) =>
  body.instances.find((instance) => instance.instanceId === "claude")!.snapshot;
const versionProbes = (home: string): string[] => {
  const log = join(home, "version-probes.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
};
const launches = (home: string): number => {
  const file = join(home, "launches.log");
  return existsSync(file) ? Number.parseInt(readFileSync(file, "utf8").trim(), 10) || 0 : 0;
};

it("probes the engine's CLI once on a later start while the engine list is read", async () => {
  const home = freshHome();
  const first = await boot(home);
  await first.call("GET", "/api/instances");
  await first.stop();

  rmSync(join(home, "version-probes.log"), { force: true });
  rmSync(join(home, "launches.log"), { force: true });
  // The probe is held until the release file appears, so every reader overlaps it.
  writeFileSync(join(home, "hold-version"), "");

  const server = await boot(home);
  await expect.poll(() => versionProbes(home).length, { timeout: 10_000 }).toBe(1);
  const lists = [server.call("GET", "/api/instances"), server.call("GET", "/api/instances"), server.call("GET", "/api/instances")];
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect({ probes: versionProbes(home).length, launches: launches(home) }).toEqual({ probes: 1, launches: 1 });

  rmSync(join(home, "hold-version"), { force: true });
  for (const list of await Promise.all(lists)) expect(claudeStatus(list)).toMatchObject({ state: "available", authenticated: true });
  expect(claudeStatus(await server.call("GET", "/api/instances"))).toMatchObject({ state: "available", authenticated: true });
  expect({ probes: versionProbes(home).length, launches: launches(home) }).toEqual({ probes: 1, launches: 1 });
}, 60_000);

it("reuses the last read and probes again after a model refresh", async () => {
  const home = freshHome();
  const server = await boot(home);
  const engines = () => server.call("GET", "/api/instances");

  expect(claudeStatus(await engines())).toMatchObject({ state: "available", authenticated: true });
  const once = launches(home);
  expect(once).toBe(1);

  // A read inside the reuse window answers from the finished probe, without spawning the CLI again.
  await engines();
  expect(launches(home)).toBe(once);

  // Settings' Refresh re-reads the engine's catalog and forgets the status read, so the next list probes again.
  const refreshed = await server.call("POST", "/api/instances/claude/refresh-models", {});
  expect(claudeStatus(refreshed)).toMatchObject({ state: "available", authenticated: true });
  const afterRefresh = launches(home);
  expect(afterRefresh).toBeGreaterThan(once);
  expect(claudeStatus(await engines())).toMatchObject({ state: "available", authenticated: true });
  expect(launches(home)).toBe(afterRefresh);
}, 60_000);
