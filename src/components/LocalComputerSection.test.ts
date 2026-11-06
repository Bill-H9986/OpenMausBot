import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const storeFixture = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: storeFixture.config }, dispatch: vi.fn() }) };
});

import {
  LocalComputerSection,
  LocalVmIdleTimeoutSetting,
  LocalVmInventoryCard,
  computerInventoryRequest,
  confirmComputerAction,
  localVmInventoryState,
  parseLocalVmIdleTimeoutMinutes,
  perBotLocalVmDeletePlan,
  type LocalVmInventoryInstance,
} from "./LocalComputerSection";

const cloudVm: LocalVmInventoryInstance = {
  botId: "cloud-bot",
  name: "Research",
  destination: "cloud",
  container: "running",
  ready: true,
  managed: true,
  problem: null,
  inUse: false,
};


afterEach(() => setLocale("en"));

describe("computer inventory request wiring", () => {
  it("keeps every mount and refresh request observation-only", () => {
    const controller = new AbortController();
    const requests = ([
      ["status", "/api/local-computer"],
      ["local-vms", "/api/local-computer/instances"],
    ] as const).map(([kind, expectedUrl]) => ({
      expectedUrl,
      request: computerInventoryRequest(kind, controller.signal),
    }));

    for (const { expectedUrl, request: [url, init] } of requests) {
      expect(url).toBe(expectedUrl);
      expect(init).toEqual({ signal: controller.signal });
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
    }
  });

  it("does not expose a destructive request when confirmation is cancelled", () => {
    const confirm = vi.fn(() => false);
    const request = confirmComputerAction(perBotLocalVmDeletePlan(cloudVm), confirm);

    expect(request).toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      "Delete Research's private desktop? Its durable folder and website sign-ins are kept. Apps installed inside the desktop and files outside the durable folder are deleted.",
    );
  });

  it("builds the exact confirmed Local VM lifecycle request", () => {
    const confirm = vi.fn(() => true);
    const local = confirmComputerAction(perBotLocalVmDeletePlan(cloudVm), confirm);

    expect(local).toEqual([
      "/api/bots/cloud-bot/local-computer/remove",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("Local VM inventory UI", () => {
  it("shows capacity, current destinations, health, and an in-use deletion guard", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [
        cloudVm,
        {
          botId: "off-bot",
          name: "Archive",
          destination: "off",
          container: "stopped",
          ready: false,
          managed: true,
          problem: "This desktop image cannot safely resume; recreate the Local VM",
          inUse: true,
        },
      ],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("2/4 created");
    expect(markup).toContain("Current destination: Cloud");
    expect(markup).toContain("Current destination: Off");
    expect(markup).toContain("In use");
    expect(markup).toContain("Stop this bot&#x27;s turn before deleting its desktop.");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).not.toMatch(/viewer_url|workspace_path|password=/);
  });

  it("keeps state labels honest", () => {
    expect(localVmInventoryState(cloudVm)).toBe("Running");
    expect(localVmInventoryState({ ...cloudVm, ready: false })).toBe("Needs attention");
    expect(localVmInventoryState({ ...cloudVm, container: "stopped", ready: false })).toBe("Stopped");
    expect(localVmInventoryState({ ...cloudVm, inUse: true })).toBe("In use");
  });

  it("does not claim there are no VMs when the runtime cannot be inspected", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: "Start docker first",
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("Inventory unavailable");
    expect(markup).toContain("Start docker first");
    expect(markup).not.toContain("No per-bot desktops have been created");
  });

  it("disables deletion while refreshing an existing inventory", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [cloudVm],
      maxInstances: 4,
      loading: true,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("shows unmanaged containers without offering an unsafe delete action", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [{
        ...cloudVm,
        managed: false,
        ready: false,
        problem: "Container labels do not match",
      }],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("Not managed");
    expect(markup).toContain("not managed by MausBot");
    expect(markup).toContain("remove it directly in Docker or Podman");
    expect(markup).not.toContain(">Delete</button>");
    expect(markup).not.toContain("Container labels do not match");
  });
});

describe("Settings → Computers on an OMB Cloud home", () => {
  afterEach(() => { storeFixture.config = null; });
  const cards = () => [...renderToStaticMarkup(createElement(LocalComputerSection)).matchAll(/<div class="text-\[16px\] font-semibold text-ink[^"]*">([^<]+)<\/div>/g)].map((match) => match[1]);

  it("sets up a Local VM on a desktop or self-hosted server", () => {
    expect(cards()).toEqual(expect.arrayContaining(["Private desktops", "Isolation"]));
    expect(cards()).not.toContain("Cloud desktops");
  });

  it("shows no Local VM, and no steps to install one, where it cannot exist", () => {
    storeFixture.config = { cloudHome: true };
    const titles = cards();
    expect(titles).not.toContain("Private desktops");
    expect(titles).not.toContain("Isolation");
    expect(titles).not.toContain("Setup");
  });
});

describe("Local VM idle timeout setting", () => {
  it.each([["5", 5], ["30", 30], [" 480 ", 480], ["1440", 1_440]])("accepts %j", (value, minutes) => {
    expect(parseLocalVmIdleTimeoutMinutes(value)).toBe(minutes);
  });

  it.each(["", "4", "1441", "1.5", "-30", "30m", "1e2"])("rejects %j", (value) => {
    expect(parseLocalVmIdleTimeoutMinutes(value)).toBeNull();
  });

  it("shows the confirmed window as a bounded, labelled minutes field", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmIdleTimeoutSetting, {
      minutes: 30,
      disabled: false,
      onSave: async () => {},
    }));
    expect(markup).toContain('for="local-vm-idle-timeout"');
    expect(markup).toContain("Stop idle desktops after");
    expect(markup).toContain('min="5"');
    expect(markup).toContain('max="1440"');
    expect(markup).toContain('value="30"');
    expect(markup).toContain("minutes");
  });
});
