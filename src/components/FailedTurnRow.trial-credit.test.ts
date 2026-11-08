import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceInfo, Message } from "@/state/store";
import { failedTurnTool } from "../../shared/failed-turn";
import { TRIAL_CREDIT_REFUSED } from "../../shared/trial-credit";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: {}, instances: [] as InstanceInfo[], bots: [] }, dispatch: fixture.dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "darwin" }, localComputer: { available: true } }, ready: true }),
  useCaptionChrome: () => ({}),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => null }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { FailedTurnRow } = await import("./ChatView");
const engine = { instanceId: "trial-credit", trialCredit: "used_up" } as unknown as InstanceInfo;
const stored = (kind: keyof typeof TRIAL_CREDIT_REFUSED): NonNullable<Message["tool"]> => failedTurnTool(TRIAL_CREDIT_REFUSED[kind], { setup: kind !== "paused" });
const show = (tool: NonNullable<Message["tool"]>, onRetry?: () => void) => {
  const html = renderToStaticMarkup(createElement(FailedTurnRow, { tool, engine, onRetry }));
  return { html, buttons: (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).map(button => button.replace(/<[^>]+>/g, "")) };
};

beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

describe("a turn the trial's Claude credit refused", () => {
  it("is said in the reader's language, never the server's English, with connect your own AI as the next step", () => {
    setLocale("zh");
    const usedUp = show(stored("used_up"));
    expect(usedUp.html).toContain("你的试用 Claude 额度已用完。");
    expect(usedUp.html).not.toContain("Your trial Claude credit is used up");
    expect(usedUp.buttons).toEqual(["连接你自己的 AI"]);
    expect(show(stored("ended")).html).toContain("Cloud 上已无法再使用试用 Claude 额度。");
    expect(show(stored("too_low")).html).toContain("不足以进行这段对话");
    const paused = show(stored("paused"), vi.fn());
    expect(paused.html).toContain("试用 Claude 额度目前已暂停。");
    expect(paused.buttons.some(label => label.includes("连接你自己的 AI"))).toBe(false);
  });

  it("used up or gone, is a quiet note with the one way on, never an error; paused and too low stay errors", () => {
    for (const kind of ["used_up", "ended"] as const) {
      const { html, buttons } = show(stored(kind));
      expect(html).toContain(`role="note" data-trial-credit-notice="${kind}"`);
      expect(html).not.toMatch(/danger|lucide-triangle-alert|lucide-alert-triangle/);
      expect(buttons).toEqual(["Connect your own AI"]);
    }
    for (const kind of ["paused", "too_low"] as const) expect(show(stored(kind), vi.fn()).html).toContain("danger");
  });

  it("is told apart by its words alone, whichever engine the turn ran on", () => {
    const html = renderToStaticMarkup(createElement(FailedTurnRow, { tool: stored("used_up"), engine: undefined }));
    expect(html).toContain("Your trial Claude credit is used up. Sign in with your own Claude or ChatGPT account, or add an API key, to keep your bots working.");
    expect(html).toContain("Connect your own AI");
  });
});
