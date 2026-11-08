import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const jsonl = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
// The stand-in browser is a node script run through its shebang.
const withBrowser = process.platform !== "win32";
// Auto may land on this computer only on macOS and Windows.
const itAutoThisComputer = process.platform === "linux" ? it.skip : it;

async function fixture(test: (f: any) => Promise<void>, { thisComputer = false } = {}) {
  const session = await launchVerificationServer();
  const { dataDir, url, logPath } = session.info;
  let server: ChildProcess | undefined;
  try {
    const launchDir = join(dataDir, "launches");
    mkdirSync(launchDir, { recursive: true });
    const rpcPath = join(dataDir, "acp-rpc.jsonl");
    const acpDump = join(dataDir, "acp-dump.json");
    const userData = join(dataDir, "user-data");
    const release = join(dataDir, "release");
    // Every turn runs until `release` exists; each engine process dumps the MCP servers it mounted.
    const engine = join(dataDir, "engine.mjs");
    writeFileSync(engine, [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      'import { join } from "node:path";',
      `const dir = ${JSON.stringify(launchDir)};`,
      'if (!process.argv.includes("--version")) {',
      '  process.env.FAKE_ACP_DUMP = join(dir, `${process.pid}.json`);',
      '  process.env.FAKE_ACP_RPC_APPEND_FILE = join(dir, `${process.pid}.rpc.jsonl`);',
      '}',
      `appendFileSync("C:/temp/engine-invoked.log", JSON.stringify({ args: process.argv.slice(2), dump: process.env.FAKE_ACP_DUMP ?? null, dir, cwd: process.cwd() }) + "\\n");`,
      `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url))).href)});`,
    ].join("\n"), { mode: 0o700 });
    const browser = join(dataDir, "agent-browser.mjs");
    writeFileSync(browser, [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "session" && process.argv[3] === "list") process.stdout.write(JSON.stringify({ success: true, data: { sessions: [] } }));',
    ].join("\n"), { mode: 0o700 });
    // Add the ACP engine and the browser while the server is stopped.
    await waitForExit(session.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.config.cli = engine;
    config.instances.opencodeGo = {
      driver: "deepseekAgent", displayName: "ACP fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: { FAKE_ACP_MODELS: "fixture/warm", FAKE_ACP_RPC_APPEND_FILE: rpcPath, FAKE_ACP_DUMP: acpDump },
    };
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(join(dataDir, "providers", "engine-models"), { recursive: true });
    writeFileSync(join(dataDir, "providers", "engine-models", "claude.json"), JSON.stringify({
      default: "fake-model", options: [{ id: "fake-model", label: "Fake model" }],
    }));
    if (thisComputer) {
      // What the desktop app hands its own server once its driver is running.
      mkdirSync(userData, { recursive: true });
      writeFileSync(join(userData, "cua-connection.json"), JSON.stringify({
        mode: "embedded", status: "ready", socketPath: join(dataDir, "cua.sock"),
        mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
      }), { mode: 0o600 });
    }
    const log = openSync(logPath, "a", 0o600);
    // With this computer, started as the desktop app starts its own server, which hears the driver record over its parent port.
    server = spawn(process.execPath, ["--experimental-strip-types",
      ...(thisComputer ? ["--import", pathToFileURL(fileURLToPath(new URL("./testing/desktop-parent.mjs", import.meta.url))).href] : []),
      fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...verificationServerEnvironment({ ...process.env, FAKE_ACP_RELEASE_FILE: release }, dataDir, Number(new URL(url).port)),
        ...(withBrowser ? { OMB_AGENT_BROWSER_PATH: browser } : {}),
        ...(thisComputer ? { OMB_TEST_DESKTOP_CUA_CONNECTION: join(userData, "cua-connection.json") } : {}),
      },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
    const api = async (method: string, path: string, body?: unknown, token?: string) => {
      const response = await fetch(url + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { origin: url }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) as any };
    };
    const busy = async (bot: any, threadId: string) => (await api("GET", "/api/bots")).body.bots
      .find((entry: any) => entry.id === bot.id)?.tasks.find((task: any) => task.threadId === threadId)?.busy === true;
    const turn = async (bot: any, threadId: string, text: string) => {
      writeFileSync(release, "go");
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    };
    const hold = async (bot: any, threadId: string, text: string) => {
      rmSync(release, { force: true });
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      await expect.poll(() => busy(bot, threadId), { timeout: 15_000 }).toBe(true);
    };
    const finish = async (bot: any, threadId: string) => {
      writeFileSync(release, "go");
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    };
    const agents = async (token: string) => (await api("GET", "/api/internal/agents", undefined, token)).status;
    const acpServers = () => (JSON.parse(readFileSync(`${acpDump}.mcp.json`, "utf8")) as Array<{ name: string }>).map((server) => server.name);
    const launches = () => readdirSync(launchDir).filter((name) => /^\d+\.json$/.test(name)).map((name) => {
      const pid = Number.parseInt(name, 10);
      const dump = JSON.parse(readFileSync(join(launchDir, name), "utf8")) as {
        mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> };
      };
      const mounts = dump.mcpConfig?.mcpServers ?? {};
      const calls = jsonl(join(launchDir, name.replace(/\.json$/, ".rpc.jsonl")));
      return {
        pid,
        servers: Object.keys(mounts),
        token: mounts.agents?.env?.OMB_COMMS_TOKEN ?? null,
        control: mounts.computer?.env?.OMB_CONTROL_TOKEN ?? null,
        resume: calls.some((call: { method?: string }) => call.method === "session/resume"),
      };
    }).sort((a, b) => a.pid - b.pid);
    await test({ dataDir, cli, api, turn, hold, finish, agents, launches, rpc: () => jsonl(rpcPath), acpServers });
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await session.close();
  }
}

it("keeps a thread's Claude process and ACP session across turns, with agents and the browser mounted", () => fixture(async (f) => {
  const { bot } = await f.cli("new-bot", "--name", "Warm Claude");
  await f.turn(bot, bot.activeTaskId, "First question.");
  await f.turn(bot, bot.activeTaskId, "Second question.");
  const warm = f.launches();
  expect(warm.at(-1).servers).toEqual(expect.arrayContaining(withBrowser ? ["agents", "browser"] : ["agents"]));
  await f.turn(bot, bot.activeTaskId, "Third question.");
  await f.turn(bot, bot.activeTaskId, "Fourth question.");
  expect(f.launches()).toHaveLength(warm.length);

  const { bot: acp } = await f.cli("new-bot", "--name", "Warm ACP");
  const thread = acp.activeTaskId;
  expect((await f.api("PATCH", `/api/bots/${acp.id}/tasks/${thread}`, { modelSelection: { instanceId: "opencodeGo", model: "fixture/warm" } })).status).toBe(200);
  for (const text of ["First question.", "Second question.", "Third question."]) await f.turn(acp, thread, text);
  const prompts = f.rpc().filter((call: any) => call.method === "session/prompt");
  expect(prompts).toHaveLength(3);
  const pid = prompts[0].pid;
  expect(prompts.every((call: any) => call.pid === pid)).toBe(true);
  const established = f.rpc().filter((call: any) => call.pid === pid).map((call: any) => call.method)
    .filter((method: string) => method === "session/new" || method === "session/load");
  expect(established).toEqual(["session/new"]);
}), 120_000);

it("honours a thread's credential only while its turns run, and retires it on Stop, a lower approval level and bot deletion", () => fixture(async (f) => {
  const { bot } = await f.cli("new-bot", "--name", "Credential holder");
  const thread = bot.activeTaskId;
  await f.turn(bot, thread, "Warm up.");
  const token = f.launches().at(-1).token;
  expect(token).toMatch(/^[a-f0-9]{48}$/);
  expect(await f.agents(token)).toBe(401);
  await f.hold(bot, thread, "Next question.");
  expect(f.launches().at(-1).token).toBe(token);
  expect(await f.agents(token)).toBe(200);
  await f.finish(bot, thread);
  expect(await f.agents(token)).toBe(401);

  await f.hold(bot, thread, "Something long.");
  expect(await f.agents(token)).toBe(200);
  expect((await f.api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread })).status).toBe(200);
  expect(await f.agents(token)).toBe(401);
  const stopped = f.launches().length;
  await f.hold(bot, thread, "Start again.");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(stopped + 1);
  const restarted = f.launches().at(-1).token;
  expect(restarted).not.toBe(token);
  expect(await f.agents(token)).toBe(401);
  expect(await f.agents(restarted)).toBe(200);
  await f.finish(bot, thread);

  expect((await f.api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { approvalMode: "auto" })).status).toBe(200);
  await f.turn(bot, thread, "Edit freely.");
  const raised = f.launches().at(-1).token;
  expect((await f.api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { approvalMode: "ask" })).status).toBe(200);
  const before = f.launches().length;
  await f.hold(bot, thread, "Ask first now.");
  await expect.poll(() => f.launches().length, { timeout: 15_000 }).toBe(before + 1);
  const lowered = f.launches().at(-1).token;
  expect(lowered).not.toBe(raised);
  expect(await f.agents(raised)).toBe(401);
  expect(await f.agents(lowered)).toBe(200);

  expect((await f.api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  expect(await f.agents(lowered)).toBe(401);
}), 120_000);

itAutoThisComputer("keeps a thread's engine process and ACP session across turns on Auto with this computer mounted", () => fixture(async (f) => {
  const { bot } = await f.cli("new-bot", "--name", "Warm desktop");
  for (const text of ["First question.", "Second question.", "Third question.", "Fourth question."]) {
    await f.turn(bot, bot.activeTaskId, text);
  }
  const launches = f.launches();
  expect(launches).toHaveLength(1);
  expect(launches[0].servers).toEqual(expect.arrayContaining(["agents", "computer"]));
  expect(launches[0].control).toMatch(/^[a-f0-9]{48}$/);

  const { bot: acp } = await f.cli("new-bot", "--name", "Warm ACP desktop");
  const thread = acp.activeTaskId;
  expect((await f.api("PATCH", `/api/bots/${acp.id}/tasks/${thread}`, { modelSelection: { instanceId: "opencodeGo", model: "fixture/warm" } })).status).toBe(200);
  for (const text of ["First question.", "Second question.", "Third question."]) await f.turn(acp, thread, text);
  expect(f.acpServers()).toEqual(expect.arrayContaining(["agents", "computer"]));
  const prompts = f.rpc().filter((call: any) => call.method === "session/prompt");
  expect(prompts).toHaveLength(3);
  const pid = prompts[0].pid;
  expect(prompts.every((call: any) => call.pid === pid)).toBe(true);
  const established = f.rpc().filter((call: any) => call.pid === pid).map((call: any) => call.method)
    .filter((method: string) => method === "session/new" || method === "session/load");
  expect(established).toEqual(["session/new"]);
}, { thisComputer: true }), 120_000);
