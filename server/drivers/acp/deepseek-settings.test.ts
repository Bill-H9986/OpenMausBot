import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  customOpenAIProviderBlock,
  customOpenAIProviderFromEnv,
  ensureCustomOpenAIProvider,
  writeCustomOpenAISettings,
} from "./deepseek-settings.ts";

const spec = { baseUrl: "https://v4.example.test", apiKeyEnv: "CUSTOM_OPENAI_API_KEY" };

function settingsAt(root: string, profile: string = "acp"): string {
  return join(root, "profiles", profile, "settings.yaml");
}

describe("customOpenAIProviderBlock", () => {
  it("writes the OpenAI-completions api, the endpoint, the credential ref and the plain-OpenAI compat flags", () => {
    expect(customOpenAIProviderBlock(spec)).toEqual({
      api: "openai-completions",
      baseURL: "https://v4.example.test",
      apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    });
  });

  it("lists model ids as { id } entries and omits the field for an empty list", () => {
    expect(customOpenAIProviderBlock({ ...spec, models: ["glm-4"] }).models).toEqual([{ id: "glm-4" }]);
    expect(customOpenAIProviderBlock({ ...spec, models: [] })).not.toHaveProperty("models");
    expect(customOpenAIProviderBlock(spec)).not.toHaveProperty("models");
  });
});

describe("writeCustomOpenAISettings", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates the profile's settings.yaml with the provider block", () => {
    root = mkdtempSync(join(tmpdir(), "dsh-settings-"));
    const path = settingsAt(root);
    expect(writeCustomOpenAISettings(spec, path)).toBe(true);
    const doc = parseYaml(readFileSync(path, "utf8")) as { "llm-pi-ai": { providers: Record<string, unknown> } };
    expect(doc["llm-pi-ai"].providers["custom-openai"]).toEqual(customOpenAIProviderBlock(spec));
  });

  it("merges only the custom-openai block, leaving every other field of the document", () => {
    root = mkdtempSync(join(tmpdir(), "dsh-settings-"));
    const path = settingsAt(root);
mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, [
      "llm-pi-ai:",
      "  providers:",
      "    openrouter:",
      "      apiKeyEnv: OPENROUTER_API_KEY",
      "      baseURL: https://openrouter.example",
      "ui:",
      "  theme: dark",
    ].join("\n"), "utf8");
    expect(writeCustomOpenAISettings(spec, path)).toBe(true);
    const doc = parseYaml(readFileSync(path, "utf8")) as Record<string, any>;
    expect(doc["llm-pi-ai"].providers.openrouter).toEqual({ apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.example" });
    expect(doc.ui).toEqual({ theme: "dark" });
    expect(doc["llm-pi-ai"].providers["custom-openai"]).toEqual(customOpenAIProviderBlock(spec));
  });

  it("replaces the custom-openai block on a second write, still touching nothing else", () => {
    root = mkdtempSync(join(tmpdir(), "dsh-settings-"));
    const path = settingsAt(root);
    writeCustomOpenAISettings(spec, path);
    const next = { ...spec, baseUrl: "https://other.example.test", models: ["m1", "m2"] };
    expect(writeCustomOpenAISettings(next, path)).toBe(true);
    const doc = parseYaml(readFileSync(path, "utf8")) as Record<string, any>;
    expect(doc["llm-pi-ai"].providers["custom-openai"]).toEqual(customOpenAIProviderBlock(next));
  });

  it("leaves a document it cannot parse untouched", () => {
    root = mkdtempSync(join(tmpdir(), "dsh-settings-"));
    const path = settingsAt(root);
mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "llm-pi-ai: [not a mapping", "utf8");
    expect(writeCustomOpenAISettings(spec, path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("llm-pi-ai: [not a mapping");
  });
});

describe("customOpenAIProviderFromEnv", () => {
  it("needs the endpoint and the key together", () => {
    expect(customOpenAIProviderFromEnv({ CUSTOM_OPENAI_BASE_URL: "https://v4.example.test" })).toBeNull();
    expect(customOpenAIProviderFromEnv({ CUSTOM_OPENAI_API_KEY: "ck" })).toBeNull();
  });

  it("reads the model list from JSON, degrading a malformed list to discovery", () => {
    const env = { CUSTOM_OPENAI_BASE_URL: "https://v4.example.test", CUSTOM_OPENAI_API_KEY: "ck" };
    const withModels = customOpenAIProviderFromEnv({ ...env, CUSTOM_OPENAI_MODELS: JSON.stringify(["glm-4", ""]) });
    expect(withModels?.models).toEqual(["glm-4"]);
    expect(customOpenAIProviderFromEnv({ ...env, CUSTOM_OPENAI_MODELS: "not json" })).toEqual({ baseUrl: "https://v4.example.test", apiKeyEnv: "CUSTOM_OPENAI_API_KEY" });
    expect(customOpenAIProviderFromEnv(env)).toEqual({ baseUrl: "https://v4.example.test", apiKeyEnv: "CUSTOM_OPENAI_API_KEY" });
  });
});

describe("ensureCustomOpenAIProvider", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stays a no-op while the endpoint is unset", () => {
    root = mkdtempSync(join(tmpdir(), "dsh-settings-"));
    ensureCustomOpenAIProvider({ CUSTOM_OPENAI_BASE_URL: "https://v4.example.test" }, root);
    expect(existsSync(settingsAt(root))).toBe(false);
  });

  it("writes the active profile's settings.yaml from the launch environment", () => {
    root = mkdtempSync(join(tmpdir(), "dsh-settings-"));
    ensureCustomOpenAIProvider({ CUSTOM_OPENAI_BASE_URL: "https://v4.example.test", CUSTOM_OPENAI_API_KEY: "ck" }, root);
    const doc = parseYaml(readFileSync(settingsAt(root), "utf8")) as Record<string, any>;
    expect(doc["llm-pi-ai"].providers["custom-openai"].baseURL).toBe("https://v4.example.test");
  });
});
