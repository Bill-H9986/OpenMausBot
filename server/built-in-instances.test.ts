import { describe, expect, it } from "vitest";

import { BUILT_IN_INSTANCE_DRIVERS } from "../src/lib/built-in-instances.ts";
import { instanceConfigs } from "./config.ts";

describe("the built-in instances the app's analytics names without the instance list", () => {
  it("knows the driver of every instance this server's default fleet ships", () => {
    const fleet = Object.fromEntries(Object.entries(instanceConfigs({})).map(([id, entry]) => [id, entry.driver]));
    for (const [id, driver] of Object.entries(fleet)) expect(BUILT_IN_INSTANCE_DRIVERS[id], id).toBe(driver);
  });
});
