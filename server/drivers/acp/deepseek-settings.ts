// OpenMausBot's self-hosted OpenAI-compatible endpoint for dsh: written as the
// llm-pi-ai provider block of the active profile's legacy settings.yaml. dsh
// 0.2.2-rc.1 imports that file into the active profile on launch and renames
// it, so the write happens before every dsh spawn and re-writes the file when
// the config changes. The provider block names the key only by env var
// (apiKeyEnv); the key's value rides in the child process env and never in
// this file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const CUSTOM_OPENAI_PROVIDER = "custom-openai";
export const CUSTOM_OPENAI_API_KEY_ENV = "CUSTOM_OPENAI_API_KEY";

export interface CustomOpenAIProviderSpec {
  baseUrl: string;
  apiKeyEnv: string;
  /** Model ids to serve; omitted lets dsh discover the endpoint's model list. */
  models?: string[];
}

/** The llm-pi-ai provider block dsh 0.2.2 expects: the OpenAI completions api
 * and its plain-OpenAI compat flags, the baseURL, and the credential ref by
 * name; `models` entries are `{ id }` objects whose caps fall back to the
 * route defaults. */
export function customOpenAIProviderBlock(spec: CustomOpenAIProviderSpec): Record<string, unknown> {
  const block: Record<string, unknown> = {
    api: "openai-completions",
    baseURL: spec.baseUrl,
    apiKeyEnv: spec.apiKeyEnv,
    compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
  };
  if (spec.models?.length) block.models = spec.models.map((id) => ({ id }));
  return block;
}

/** Merge one provider block into the settings document at `path`, touching
 * nothing else in it. A document that does not parse is left untouched.
 * @returns false when the existing file could not be parsed. */
export function writeCustomOpenAISettings(spec: CustomOpenAIProviderSpec, path: string): boolean {
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
    root = doc as Record<string, unknown>;
  }
  const entry = (root["llm-pi-ai"] && typeof root["llm-pi-ai"] === "object" && !Array.isArray(root["llm-pi-ai"])
    ? root["llm-pi-ai"]
    : {}) as Record<string, unknown>;
  const providers = (entry.providers && typeof entry.providers === "object" && !Array.isArray(entry.providers)
    ? entry.providers
    : {}) as Record<string, unknown>;
  providers[CUSTOM_OPENAI_PROVIDER] = customOpenAIProviderBlock(spec);
  entry.providers = providers;
  root["llm-pi-ai"] = entry;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(root), "utf8");
  return true;
}

/** The provider spec from the launch environment; null while the endpoint is
 * not fully set (baseUrl and key together). A malformed model list degrades
 * to discovery, never to a failed boot. */
export function customOpenAIProviderFromEnv(env: Record<string, string | undefined>): CustomOpenAIProviderSpec | null {
  const baseUrl = env.CUSTOM_OPENAI_BASE_URL?.trim();
  const apiKey = env[CUSTOM_OPENAI_API_KEY_ENV]?.trim();
  if (!baseUrl || !apiKey) return null;
  let models: string[] | undefined;
  const raw = env.CUSTOM_OPENAI_MODELS?.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) models = parsed.filter((id): id is string => typeof id === "string" && id !== "");
    } catch {
      models = undefined;
    }
  }
  return { baseUrl, apiKeyEnv: CUSTOM_OPENAI_API_KEY_ENV, ...(models?.length ? { models } : {}) };
}

/** Write the block into the profile's legacy settings.yaml before a dsh spawn;
 * a no-op while the endpoint is unset. File failures stay silent: the spawn
 * must not break over a missing BYOM endpoint, and dsh boots without it.
 * @param dshHomeDir The DSH home for this launch ($DSH_HOME or its default). */
export function ensureCustomOpenAIProvider(
  env: Record<string, string | undefined>,
  dshHomeDir: string,
  profile: string = "acp",
): void {
  const spec = customOpenAIProviderFromEnv(env);
  if (!spec) return;
  try {
    writeCustomOpenAISettings(spec, join(dshHomeDir, "profiles", profile, "settings.yaml"));
  } catch {
    // dsh boots with whatever the profile already carries; a failed write
    // only means the BYOM endpoint is absent from this launch.
  }
}
