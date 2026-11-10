import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState, CloudPlanSnapshot } from "../../electron/cloud-account.mjs";
import type { CloudOffer, CloudTrial } from "../../electron/cloud-home.mjs";
import { withTourFinished } from "@/lib/guided-tour";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING, LOCAL_VIEWER, markWelcomeFinished, MET_CHIEF_HINT, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { createDesktopPrefs, registerDesktopPrefs } from "../../electron/desktop-prefs.mjs";
import { createUpdatesConsent, registerUpdatesConsent } from "../../electron/updates-consent.mjs";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], state: {} as any, updater: null as any, dispatch: null as any, brand: "default",
  viewerEmail: undefined as string | null | undefined }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn().mockResolvedValue({}),
  CLOUD_LINK_SETTINGS: { type: "toggleAppSettings", open: true, section: "cloudAccount", cloudLink: true } }));
vi.mock("@/lib/analytics", () => ({ emailGateDone: () => false, track: vi.fn() }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => f.updater }));
// Who MausBot belongs to: unknown (as before the session answers) unless a test says otherwise.
vi.mock("@/lib/default-bot", async original => ({ ...await original<typeof import("@/lib/default-bot")>(), useViewerEmail: () => f.viewerEmail }));
vi.mock("@/lib/brand", () => ({ brandStatus: () => ({ brand: { name: "OpenMausBot" }, source: f.brand, file: "" }), productName: () => "MausBot" }));
vi.mock("./Avatar", async original => ({ ...await original<typeof import("./Avatar")>(), MausAvatar: () => null }));
vi.mock("@/components/EngineLibrary", () => ({ engineReady: (instance: { snapshot: { state: string; authenticated?: boolean } }) =>
  instance.snapshot.state === "available" && instance.snapshot.authenticated !== false }));
import { AppNotices } from "./AppNotices";
import { TwoPlacesCard } from "./TwoPlacesCard";
import { track } from "@/lib/analytics";
import { ADVANCED_MODE_KEY, setAdvancedMode } from "@/lib/interface-mode";
import { SIMPLE_MODE_PROMPT_KEY } from "@/lib/simple-mode-prompt";
import { api } from "@/state/store";

const DAY = 86_400_000, NOW = new Date(2026, 9, 9, 12).getTime();
const plans = [
  { tier: "starter", label: "Starter", amount: 1500, trialDays: 7 },
  { tier: "pro", label: "Pro", amount: 4900, trialDays: 7 },
  { tier: "max", label: "Max", amount: 9900, trialDays: 7 },
];
const TRIAL_OFFER: CloudOffer = { plans, recommended: "pro", creditUsd: 5, refundDays: 14 };
const PLAIN_OFFER: CloudOffer = { plans: plans.map(({ trialDays: _days, ...plan }) => plan), recommended: "pro", refundDays: 14 };
const signedOut: CloudAccountState = { status: "signed-out" };
const free: CloudAccountState = { status: "connected", account: { id: "a", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const paid = (extra: Partial<CloudAccountState> = {}): CloudAccountState => ({ ...free, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: NOW + 30 * DAY, version: 2 }, ...extra });
const trial = (state: CloudTrial["state"], extra: Partial<CloudTrial> = {}): CloudTrial =>
  ({ state, tier: "pro", endsAt: NOW + DAY, amount: 4900, chargeAt: NOW + DAY, holdUntil: null, deleteAt: null, keep: "none", ...extra });

let storage: Map<string, string>;
let account: CloudAccountState;
let snapshot: CloudPlanSnapshot | Error;
let offer: CloudOffer | null;
let viewer: WelcomeViewer | null;
let bridges: { cloud: Record<string, ReturnType<typeof vi.fn>>; plan: Record<string, ReturnType<typeof vi.fn>> };
let accountListeners: Set<(next: CloudAccountState) => void>;
let now: number;

const PRELOAD = readFileSync(join(process.cwd(), "electron", "preload.cjs"), "utf8").replace(/\r\n/g, "\n");
const LOCAL_ORIGIN = "http://127.0.0.1:8799", MY_CLOUD = "https://omb-u-1.fly.dev", VPS = "https://bots.example.test";
type Page = "local" | "cloud" | "server";
type Handler = (event: { page: Page; returnValue?: unknown }, ...args: unknown[]) => unknown;
interface Desktop {
  handlers: Map<string, Handler>; listeners: Map<string, Handler>; saved: { seen?: string[] } | null; offered: boolean;
  /** This computer's own workspace config.json, as main reads it. */
  config: unknown;
}
let desk: Desktop;

// Main's own record for this one desktop, behind its real IPC.
function desktopMachine(): Desktop {
  const machine: Desktop = { handlers: new Map(), listeners: new Map(), saved: null, offered: true,
    config: { onboarding: { completedAt: "2026-09-01", version: 1, hintsSeen: [] } } };
  registerDesktopPrefs({
    ipcMain: { handle: (channel, handler) => void machine.handlers.set(channel, handler as Handler), on: (channel, listener) => void machine.listeners.set(channel, listener as Handler) },
    read: () => machine.saved, write: value => { machine.saved = JSON.parse(JSON.stringify(value)); }, page: event => (event as { page: Page }).page,
    cloudOffered: async () => machine.offered, localConfig: () => machine.config, now: () => now,
  });
  return machine;
}

// The real preload, as this desktop's window loads it for a page; the Cloud account and plan answer from this file's fakes.
function windowOn(origin: string, { click = true } = {}) {
  const page: Page = origin === LOCAL_ORIGIN ? "local" : origin === MY_CLOUD ? "cloud" : "server";
  let ogb: Record<string, unknown> = {};
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL_ORIGIN}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: click } }, TextEncoder,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name: string, value: Record<string, unknown>) => { ogb = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: (channel: string) => { const event = { page, returnValue: undefined as unknown }; desk.listeners.get(channel)?.(event); return event.returnValue; },
        invoke: async (channel: string, ...args: unknown[]) => desk.handlers.get(channel)?.({ page }, ...args) } }),
  });
  const fakes: Record<string, unknown> = { cloudAccount: bridges.cloud, cloudPlan: bridges.plan, openExternal: vi.fn(async () => true), organization: undefined };
  return { ...ogb, ...Object.fromEntries(Object.entries(fakes).filter(([key]) => key in ogb)) };
}
const showWindow = (origin: string, options?: { click?: boolean }) => {
  vi.stubGlobal("window", { ogb: windowOn(origin, options), addEventListener: vi.fn(), removeEventListener: vi.fn() });
};

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const render = () => { f.index = 0; f.effects = []; return renderToStaticMarkup(createElement(AppNotices, { viewer })); };
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) { render(); f.effects.forEach(effect => effect()); await flush(); } return render(); }
const launch = () => { f.values = []; return settle(); };
type Node = ReactElement<Record<string, any>>;
const nodes = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return nodes((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
};
const tree = () => { f.index = 0; f.effects = []; return nodes(AppNotices({ viewer })); };
const press = (label: string) => {
  const button = tree().find(node => node.type === "button" && (renderToStaticMarkup(node).includes(`>${label}<`) || node.props["aria-label"] === label));
  expect(button, label).toBeTruthy(); button!.props.onClick();
};
/** A bot has answered once, in this launch: what a new install has after its first chat. */
const FIRST_REPLY = [{ tasks: [{ threadId: "first", usage: { turns: 1 } }] }];
let session: Map<string, string>;
const returning = () => { f.state.bots = [{ tasks: [{ threadId: "t", createdAt: 1, usage: { turns: 2 } }] }]; };
const launchCardsSeen = () => { desk.saved = { seen: [] }; storage.set(SIMPLE_MODE_PROMPT_KEY, "1"); };

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  storage = new Map(); f.values = []; f.index = 0; f.effects = []; f.updater = null; f.brand = "default"; f.dispatch = vi.fn(); now = NOW; desk = desktopMachine();
  setLocale("en"); viewer = LOCAL_VIEWER; account = signedOut; snapshot = { status: "none" }; offer = TRIAL_OFFER;
  session = new Map(); f.viewerEmail = undefined;
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
  f.state = { connected: true, hydrated: true, bots: structuredClone(FIRST_REPLY), groups: [], routines: [], instances: [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }],
    config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: withTourFinished(undefined) } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const patch = JSON.parse(String((init as RequestInit).body));
    f.state.config.onboarding.hintsSeen = patch.onboarding.hintsSeen;
    return f.state.config;
  });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  launchCardsSeen();
  accountListeners = new Set();
  bridges = {
    cloud: { state: vi.fn(async () => account), onState: vi.fn((listener: (next: CloudAccountState) => void) => { accountListeners.add(listener); return () => accountListeners.delete(listener); }),
      offer: vi.fn(async () => offer), begin: vi.fn(async () => account),
      signInAgain: vi.fn(async () => account), connectHome: vi.fn(async () => account), openDashboard: vi.fn(async () => account) },
    plan: { state: vi.fn(async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }), manage: vi.fn(async () => {}), noticeSeen: vi.fn(async () => {}) },
  };
  showWindow(LOCAL_ORIGIN);
  vi.stubGlobal("document", { activeElement: null, body: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLocale("en"); });

describe("the free trial's notice, here and on My Cloud", () => {
  it("shows the notice main says is due, tells main once, and stays up until it is closed", async () => {
    const running = trial("active", { switchTo: { tier: "starter", amount: 1500 } });
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active", credit: { grantedUsd: 5, remainingUsd: 3.2, state: "active" } };
    offer = { ...PLAIN_OFFER };
    const html = await launch();
    expect(html).toContain("Your free trial ends on"); expect(html).toContain("Includes $5 of Claude credit: $3.20 left.");
    expect(html).toContain("Prefer Starter at $15?");
    expect(bridges.cloud.offer, "the trial's notice needs nothing from the offer").not.toHaveBeenCalled();
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    snapshot = { ...snapshot, notice: undefined };
    expect(await settle()).toContain("Your free trial ends on");
    expect(bridges.plan.noticeSeen).toHaveBeenCalledOnce();
    press("Manage subscription"); await flush();
    expect(bridges.plan.manage).toHaveBeenCalledOnce();
    expect(render()).toBe("");
    expect(await launch()).not.toContain("Your free trial");
  });

  it("on My Cloud's own page, only the trial's notice, after its sign-in and setup checklist", async () => {
    viewer = { hosted: false, canSave: true, cloudHome: true };
    showWindow(MY_CLOUD);
    returning();
    snapshot = { status: "none", trial: trial("ended", { deleteAt: NOW + 3 * DAY, keep: "checkout" }), notice: "ended" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"];
    expect(await launch()).toContain("Your free trial has ended");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: false } }];
    expect(await launch()).toBe("");
    f.state.instances = [{ instanceId: "claude", snapshot: { state: "available", authenticated: true } }];
    snapshot = { status: "none" };
    expect(await launch()).toBe("");
    expect(bridges.cloud.offer).not.toHaveBeenCalled();
    snapshot = new Error("only available in this app's window");
    expect(await launch()).toBe("");
  });
});

describe("the first conversation after meeting the Chief", () => {
  it("holds every corner notice, an account's own too, until the person has written and had a reply", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), MET_CHIEF_HINT];
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toBe("");
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch()).toContain("Your free trial ends on");
  });

  it("changes nothing for an install whose first run came before: its notices keep their own rules", async () => {
    const running = trial("active");
    account = paid({ trial: running }); snapshot = { status: "paid", tier: "pro", trial: running, notice: "active" };
    f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }];
    expect(await launch()).toContain("Your free trial ends on");
  });
});

describe("This computer's Cloud sign-in card", () => {
  it("an ended sign-in on a paid plan asks to sign in again, and it is for good once closed", async () => {
    account = { status: "reauth-required", message: "expired", lastPlan: { tier: "pro", active: true } }; returning();
    expect(await launch()).toContain("Sign in again to reach the Cloud");
    press("Sign in again"); await flush();
    expect(bridges.cloud.signInAgain).toHaveBeenCalledOnce();
  });
});

describe("the product-updates question after the update", () => {
  const QUESTION = "Get MausBot updates?";
  const RECEIPT = "R".repeat(43);
  let saved: unknown;
  let accountAnswer: { status: string; textVersion: string } | null;
  let client: Record<string, ReturnType<typeof vi.fn>>;
  /** Main's own consent for this desktop, behind its real IPC: the real record and logic, a fake Cloud client. */
  const wireConsent = () => {
    const prefs = createDesktopPrefs({ read: () => saved, write: value => { saved = JSON.parse(JSON.stringify(value)); } });
    const consent = createUpdatesConsent({ prefs, account: () => client as never, available: async () => true, now: () => now });
    registerUpdatesConsent({ ipcMain: { handle: (channel, handler) => void desk.handlers.set(channel, handler as Handler) }, page: event => (event as { page: Page }).page, consent });
  };
  const answer = () => (saved as { updatesConsent?: { status: string } } | null)?.updatesConsent ?? null;
  const type = (value: string) => { const input = tree().find(node => node.type === "input" && node.props.type === "email")!; expect(input).toBeTruthy(); input.props.onChange({ target: { value } }); };

  beforeEach(() => {
    saved = null; accountAnswer = null;
    client = { state: vi.fn(() => account), updatesConsent: vi.fn(async () => ({ cloudContractVersion: 1, consent: accountAnswer })),
      recordUpdatesConsent: vi.fn(async (status: string, textVersion: string) => { accountAnswer = { status, textVersion }; }),
      updatesConsentByEmail: vi.fn(async () => RECEIPT), withdrawUpdatesConsent: vi.fn(async () => {}) };
    wireConsent();
  });

  it("shows once, and No thanks is kept so it is never asked again", async () => {
    desk.saved = null;
    const first = await launch();
    expect(first).toContain(QUESTION);
    for (const text of ["about new features and tips, about twice a month. You can unsubscribe any time.", "Your email", "Yes, send me updates", "No thanks"])
      expect(first).toContain(text);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="updates-consent-title"', 'type="email"', 'value=""']) expect(first).toContain(part);
    expect(first).not.toContain('type="checkbox"');
    press("No thanks"); await flush();
    expect(render()).toBe("");
    expect(answer()).toMatchObject({ status: "declined" });
    expect(client.updatesConsentByEmail).not.toHaveBeenCalled();
    expect(await launch()).not.toContain(QUESTION);
    wireConsent();
    expect(await launch(), "a restart reads it from the desktop's file").not.toContain(QUESTION);
  });

  it("waits for a new install's first reply and for a launch after the one whose welcome finished", async () => {
    desk.saved = null;
    f.state.bots = [];
    markWelcomeFinished();
    expect(await launch(), "the welcome just closed and no bot has answered").not.toContain(QUESTION);
    f.state.bots = structuredClone(FIRST_REPLY);
    expect(await launch(), "a bot has answered, but in the launch the welcome finished").not.toContain(QUESTION);
    session.clear();
    expect(await launch(), "a later launch asks").toContain(QUESTION);
  });

  it("waits while MausBot's first-launch card is due, then follows it in the same launch once it closes", async () => {
    f.viewerEmail = null;
    f.state.bots = [{ ...structuredClone(FIRST_REPLY[0]), id: "maus", defaultBot: {} }];
    expect(await launch(), "the card is due: the question waits for it").not.toContain(QUESTION);
    markLaunchDialog("mausbot"); f.state.bots[0].welcomed = true;
    expect(await launch(), "the card closed in this launch: the question follows it").toContain(QUESTION);
  });

  it("never during onboarding, the tour or Settings; it shows once they are done", async () => {
    returning();
    f.state.welcomeOpen = true; expect(await launch()).toBe("");
    f.state.welcomeOpen = false; f.state.appSettingsOpen = true; expect(await launch()).toBe("");
    f.state.appSettingsOpen = false;
    expect(await launch()).toContain(QUESTION);
  });

  it("signed out: an optional email; Yes sends it with no account and keeps the receipt. Signed in: one tap, on the account", async () => {
    await launch(); expect(await settle()).toContain(QUESTION);
    type("not-an-email"); press("Yes, send me updates"); await flush();
    expect(render()).toContain("Enter a valid email address.");
    expect(client.updatesConsentByEmail).not.toHaveBeenCalled();
    type("person@example.test"); press("Yes, send me updates");
    for (let i = 0; i < 5; i++) await flush();
    expect(client.updatesConsentByEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "person@example.test", textVersion: "2026-10-23" }));
    expect(answer()).toMatchObject({ status: "opted_in", email: "person@example.test", receipt: RECEIPT });
    expect(render()).toBe("");

    saved = null; account = free; wireConsent();
    await launch(); const signedIn = await settle();
    expect(signedIn).toContain(QUESTION); expect(signedIn).not.toContain('type="email"');
    press("Yes, send me updates");
    for (let i = 0; i < 5; i++) await flush();
    expect(client.recordUpdatesConsent).toHaveBeenCalledWith("opted_in", "2026-10-23");
    expect(answer()).toMatchObject({ status: "opted_in", account: "a" });
    expect(await launch()).not.toContain(QUESTION);
  });

  it("not on a branded build, a saved server's page, or in a remote client's window; My Cloud's own page asks too", async () => {
    f.brand = "file"; expect(await launch()).not.toContain(QUESTION);
    f.brand = "default";
    viewer = { hosted: true, canSave: true }; showWindow(VPS); expect(await launch()).not.toContain(QUESTION);
    showWindow(LOCAL_ORIGIN); viewer = LOCAL_VIEWER; (window.ogb as Record<string, any>).remoteClient.active = true;
    expect(await launch()).not.toContain(QUESTION);
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    expect(await launch()).toContain(QUESTION);
    expect(answer()).toBeNull();
  });
});

describe("no Use my Mac popup", () => {
  it("the page never asks main for one, whatever an older main would answer", async () => {
    const asked: unknown[] = [];
    desk.handlers.set("cloud-lending:due", async () => true);
    desk.handlers.set("cloud-lending:ask", (_event: unknown, language: unknown) => { asked.push(language); return Promise.resolve(); });
    returning();
    await launch();
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    await launch();
    expect(asked, "on this computer's page and on My Cloud's own page").toEqual([]);
  });
});


describe("the Simple mode popup after the update", () => {
  const TITLE = "Try the new Simple mode", ON = "You&#x27;re on Simple mode";
  let modal: boolean;
  const prompts = () => vi.mocked(track).mock.calls.filter(([event]) => event === "simple_mode_prompt").map(([, props]) => props);

  beforeEach(() => {
    modal = false;
    vi.stubGlobal("document", { activeElement: null, body: null, documentElement: { dataset: {} }, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => modal ? [{ closest: () => null, checkVisibility: () => true }] : [] });
    setAdvancedMode(true);
    storage.delete(SIMPLE_MODE_PROMPT_KEY);
  });

  it("shows once in each browser, claims the launch, and never comes back once it is closed", async () => {
    const html = await launch();
    expect(html).toContain(TITLE);
    for (const part of ['role="dialog"', 'aria-modal="true"', 'role="switch"', 'aria-checked="false"', "Switch any time in Settings → General."]) expect(html).toContain(part);
    expect(prompts()).toEqual([{ action: "shown", mode: "advanced" }]);
    expect(launchDialogShown()).toBe("notices");
    expect(await settle(), "shown is counted once").toContain(TITLE);
    expect(prompts()).toHaveLength(1);
    press("Done"); await flush();
    expect(render(), "nothing else in this launch after it").toBe("");
    expect(storage.get(SIMPLE_MODE_PROMPT_KEY)).toBe("1");
    expect(prompts()).toEqual([{ action: "shown", mode: "advanced" }, { action: "closed", mode: "advanced" }]);
    session.clear();
    expect(await launch()).not.toContain(TITLE);
    expect(prompts()).toHaveLength(2);
  });

  it("changes the mode live from the popup, both ways, while its words stay", async () => {
    await launch();
    press("Simple mode"); await flush();
    expect(storage.get(ADVANCED_MODE_KEY)).toBe("0");
    const on = render();
    expect(on).toContain('aria-checked="true"'); expect(on).toContain(TITLE);
    press("Simple mode"); await flush();
    expect(storage.get(ADVANCED_MODE_KEY)).toBe("1");
    expect(render()).toContain('aria-checked="false"');
    expect(prompts().slice(1)).toEqual([{ action: "toggled", mode: "simple" }, { action: "toggled", mode: "advanced" }]);
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY), "flipping never closes it").toBe(false);
  });

  it("tells someone already on Simple mode so, with the switch on", async () => {
    setAdvancedMode(false);
    const html = await launch();
    expect(html).toContain(ON); expect(html).toContain('aria-checked="true"');
    expect(prompts()).toEqual([{ action: "shown", mode: "simple" }]);
  });

  it("asks on the Cloud's own page and in a plain browser too, not only on this computer's", async () => {
    snapshot = { status: "none" }; viewer = { hosted: false, canSave: true, cloudHome: true }; f.state.config.cloudHome = true;
    f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), "cloud-setup-hidden"]; showWindow(MY_CLOUD);
    expect(await launch()).toContain(TITLE);
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    viewer = { hosted: true, canSave: true }; f.state.config.cloudHome = false;
    expect(await launch()).toContain(TITLE);
  });

  it("waits during the welcome, the tour, Settings, the quiet first chat, another dialog or a call, and skips the launch its welcome finished in", async () => {
    const waits: Array<() => void> = [
      () => { f.state.welcomeOpen = true; }, () => { f.state.tourOpen = true; }, () => { f.state.appSettingsOpen = true; }, () => { modal = true; },
      () => { f.state.liveCall = { status: "live" }; }, () => { f.state.config.onboarding.completedAt = undefined; },
      () => { f.state.config.onboarding.hintsSeen = [...withTourFinished(undefined), MET_CHIEF_HINT]; f.state.bots = [{ tasks: [{ threadId: "first", usage: { turns: 0 } }] }]; },
    ];
    for (const wait of waits) {
      const saved = structuredClone(f.state); wait();
      expect(await launch(), wait.toString()).not.toContain(TITLE);
      f.state = saved; modal = false;
    }
    expect(prompts()).toEqual([]);
    markWelcomeFinished();
    expect(await launch(), "the launch the welcome finished in").not.toContain(TITLE);
    session.clear();
    expect(await launch()).toContain(TITLE);
    expect(storage.has(SIMPLE_MODE_PROMPT_KEY)).toBe(false);
  });

});

describe("bots in two places", () => {
  const GARAGE = { key: "server:https://garage.example.test", name: "Garage server", kind: "server" as const };
  const BODY = "Your bots live in two places, so they can&#x27;t work together. Bring them together on Garage server?";
  let suggest: { key: string; name: string; kind: "cloud" | "server" } | null;
  let accepted: string[], dismissed: string[];
  beforeEach(() => {
    suggest = GARAGE; accepted = []; dismissed = [];
    desk.handlers.set("two-places:state", async () => ({ suggest }));
    desk.handlers.set("two-places:accept", async (_event, key) => { accepted.push(String(key)); suggest = null; return { suggest }; });
    desk.handlers.set("two-places:dismiss", async (_event, key) => { dismissed.push(String(key)); suggest = null; return { suggest }; });
  });

  it("one plain card on this computer's page; bots move there only after the person confirms (#4192)", async () => {
    returning();
    const html = await launch();
    expect(html).toContain('data-notice="two-places"');
    expect(html).toContain("Bring your bots together");
    expect(html).toContain(BODY);
    press("Bring them together");
    const asking = await settle();
    expect(accepted, "one tap never moves anyone").toEqual([]);
    expect(asking).toContain("Move this computer&#x27;s bots to Garage server?");
    expect(asking, "the undo switch is My Cloud's only").not.toContain("Keep this computer&#x27;s bots on this computer");
    press("Move bots");
    await flush();
    expect(accepted).toEqual([GARAGE.key]);
    expect(track).toHaveBeenCalledWith("two_places_card", { action: "bring", kind: "server" });
    expect(await settle()).not.toContain('data-notice="two-places"');
  });

  it("Cancel on the confirm step moves nothing and keeps the card (#4192)", async () => {
    returning();
    suggest = { key: "cloud:mine", name: "My Cloud", kind: "cloud" };
    await launch();
    press("Bring them together");
    const asking = await settle();
    expect(asking).toContain("Move this computer&#x27;s bots to My Cloud?");
    expect(asking, "My Cloud names the way back").toContain("Keep this computer&#x27;s bots on this computer");
    press("Cancel");
    const after = await settle();
    expect(accepted).toEqual([]);
    expect(dismissed).toEqual([]);
    expect(after).toContain('data-notice="two-places"');
    expect(after).not.toContain("Move bots");
    expect(after).toContain("Bring them together");
    expect(tree().find(node => node.props["data-two-places-bring"])?.props.autoFocus, "focus returns to the button Cancel brought back").toBe(true);
  });

  it("Escape on the confirm step works as Cancel and never dismisses the card", async () => {
    returning();
    await launch();
    press("Bring them together");
    await settle();
    const escape = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tree().find(node => node.props.role === "group")!.props.onKeyDown(escape);
    expect(escape.stopPropagation, "the card's own Escape never sees it").toHaveBeenCalled();
    const after = await settle();
    expect(dismissed).toEqual([]);
    expect(accepted).toEqual([]);
    expect(after).toContain('data-notice="two-places"');
    expect(after).not.toContain("Move bots");
  });

  it("a different suggested place starts a fresh card, so a confirm never carries over to it", async () => {
    returning();
    await launch();
    // Children.toArray would re-key, so walk the elements as rendered.
    const find = (value: unknown): Node | undefined => {
      if (Array.isArray(value)) return value.map(find).find(Boolean);
      if (!isValidElement(value)) return undefined;
      const node = value as Node;
      if (node.type === TwoPlacesCard) return node;
      return typeof node.type === "function" ? find((node.type as (props: unknown) => ReactNode)(node.props)) : find(node.props.children);
    };
    f.index = 0; f.effects = [];
    expect(find(AppNotices({ viewer }))?.key).toBe(GARAGE.key);
  });

  it("Not now hands main the place to remember, and the card goes", async () => {
    returning();
    expect(await launch()).toContain(BODY);
    press("Not now");
    await flush();
    expect(dismissed).toEqual([GARAGE.key]);
    expect(await settle()).not.toContain('data-notice="two-places"');
    expect(await launch(), "main remembers it: never asked again").not.toContain('data-notice="two-places"');
  });

  it("never during the welcome or the tour, on a Cloud's or a server's page, or when main suggests nothing", async () => {
    returning();
    f.state.welcomeOpen = true;
    expect(await launch()).not.toContain('data-notice="two-places"');
    f.state.welcomeOpen = false; f.state.tourOpen = true;
    expect(await launch()).not.toContain('data-notice="two-places"');
    f.state.tourOpen = false;
    for (const origin of [MY_CLOUD, VPS]) {
      showWindow(origin);
      expect(await launch(), origin).not.toContain('data-notice="two-places"');
    }
    showWindow(LOCAL_ORIGIN);
    suggest = null;
    expect(await launch()).not.toContain('data-notice="two-places"');
  });

  it("is this computer's page's alone: no other page gets the bridge, and none would show it", async () => {
    returning();
    expect(windowOn(LOCAL_ORIGIN).twoPlaces).toBeDefined();
    for (const origin of [MY_CLOUD, VPS]) expect(windowOn(origin).twoPlaces, origin).toBeUndefined();
    const ask = vi.fn(async () => ({ suggest: GARAGE }));
    vi.stubGlobal("window", { ogb: { ...windowOn(MY_CLOUD), twoPlaces: { state: ask, accept: ask, dismiss: ask, onChanged: () => () => {} } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    expect(await launch(), "a Cloud's page handed the bridge anyway").not.toContain('data-notice="two-places"');
  });
});
