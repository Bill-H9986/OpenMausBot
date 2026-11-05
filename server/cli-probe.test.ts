import { expect, it } from "vitest";

import { testCliBinary } from "./cli-probe.ts";
import { clientInstall } from "./contracts.ts";
import { DeepSeekAgentDriver } from "./drivers/acp/deepseek.ts";

it("offers the install steps for a CLI that is missing, without the server-only download pins", async () => {
  const result = await testCliBinary("omb-missing-cli-for-this-test", DeepSeekAgentDriver);
  expect(result.ok).toBe(false);
  expect(result.install).toEqual(clientInstall(DeepSeekAgentDriver.install));
  expect(result.install?.command?.win32).toBeDefined();
});
