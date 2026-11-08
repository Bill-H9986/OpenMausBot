// The engine instance a fresh install starts with.
// instanceConfigs (config.ts) copies every entry before it changes one.
import type { InstanceConfigMap } from "./contracts.ts";

export const OPENAI_API_INSTANCE = "openai";
export const OPENROUTER_API_INSTANCE = "openrouter";
export const XAI_API_INSTANCE = "xaiApi";
export const CLAUDE_API_INSTANCE = "claudeApi";

export const DEFAULT_FLEET: InstanceConfigMap = {
  deepseek: { driver: "deepseekAgent" },
};
