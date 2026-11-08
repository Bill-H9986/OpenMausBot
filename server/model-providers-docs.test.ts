// Pins each workaround the "Other model providers" docs page gives to the code it depends on: when one fails, update the page.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPENCODE_PROVIDER_ENV, PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "./config.ts";
import { OPENROUTER_FAILURES, freeLabel } from "./drivers/openrouter-free.ts";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = readFileSync(join(ROOT, "apps", "docs", "content", "docs", "providers", "model-providers.mdx"), "utf8");
function section(heading: string): string {
  const lines = PAGE.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === heading);
  expect(start, `the page has no "${heading}" heading`).toBeGreaterThanOrEqual(0);
  const level = heading.indexOf(" ");
  const end = lines.findIndex((line, index) => index > start && /^#+ /u.test(line) && line.indexOf(" ") <= level);
  return flat(lines.slice(start + 1, end < 0 ? undefined : end).join("\n"));
}
const flat = (text: string) => text.replace(/\s+/gu, " ");
describe("Keys exported on a server", () => {
  const exported = ["OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY"];
  it("reach every engine, as the page warns", () => {
    // Every engine filters its inherited environment through these two lists (or stripWorkspaceCredentialEnv).
    const filtered = new Set<string>([...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]);
    expect(exported.filter((name) => filtered.has(name))).toEqual([]);
    const env: Record<string, string | undefined> = Object.fromEntries(exported.map((name) => [name, "fake"]));
    stripWorkspaceCredentialEnv(env);
    expect(Object.keys(env).sort()).toEqual([...exported].sort());
    const text = section("### OpenCode");
    for (const name of exported) expect(text).toContain(`\`${name}\``);
    expect(text).toContain("Keys exported this way reach every engine on that server, and any bot that can run commands can read them.");
  });
  it("documents Cline's separate credential scope and native setup", () => {
    expect(PROVIDER_CREDENTIAL_ENV).toContain("CLINE_API_KEY");
    expect(OPENCODE_PROVIDER_ENV).toContain("CLINE_API_KEY");
    expect(section("### OpenCode")).toContain("`CLINE_API_KEY` is scoped to the Cline and OpenCode engines.");
    const cline = section("### Cline engine");
    expect(cline).toContain("`cline auth`");
    expect(cline).toContain("**Cline default (configured)**");
    expect(cline).toContain("An unconfigured account remains unavailable.");
  });
});
describe("Free OpenRouter models section", () => {
  it("quotes the turn errors and the picker mark the chat engine shows", () => {
    const text = section("### Free OpenRouter models");
    expect(OPENROUTER_FAILURES.credits).toMatch(/^This model needs OpenRouter credit\b/u);
    expect(text).toContain('"This model needs OpenRouter credit"');
    expect(OPENROUTER_FAILURES.privacy).toMatch(/^OpenRouter's privacy settings block this free model\b/u);
    expect(text).toContain(`"OpenRouter's privacy settings block this free model"`);
    expect(freeLabel("Gemma 4 31B", { id: "google/gemma-4-31b-it:free" })).toBe("Gemma 4 31B (free)");
    expect(text).toContain("**(free)**");
  });
});