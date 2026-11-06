import type { AnyProviderDriver } from "../contracts.ts";
import { DeepSeekAgentDriver } from "./acp/deepseek.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [DeepSeekAgentDriver, OpenAICompatDriver];
