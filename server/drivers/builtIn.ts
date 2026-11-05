import type { AnyProviderDriver } from "../contracts.ts";
import { DeepSeekAgentDriver } from "./acp/deepseek.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [DeepSeekAgentDriver];
