import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "@/lib/onboarding";
import { withTourReset } from "@/lib/guided-tour";
import { CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, launchNotice, markLaunchNotice, nextNotice, noticeSeen, NOTICES, SIMPLE_MODE_NOTICE, TWO_PLACES_NOTICE, UPDATES_CONSENT_NOTICE, type NoticeFacts } from "./notices";

let storage: Map<string, string>, session: Map<string, string>;
beforeEach(() => {
  storage = new Map(); session = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const record = (hintsSeen: string[] = []): OnboardingStatus => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen });
const facts = (simple: boolean | null, consent: boolean | null, two: boolean | null, trial: boolean | null, cloud: boolean | null): NoticeFacts =>
  ({ [SIMPLE_MODE_NOTICE]: simple, [UPDATES_CONSENT_NOTICE]: consent, [TWO_PLACES_NOTICE]: two, [CLOUD_TRIAL_NOTICE]: trial, [CLOUD_NOTICE]: cloud });
const none = () => false;

it("is one queue: the Simple mode popup first, then the product-updates question, bots in two places, the trial's notice, the My Cloud card", () => {
  expect(nextNotice(facts(true, true, true, true, true), none)).toBe(SIMPLE_MODE_NOTICE);
  expect(nextNotice(facts(true, true, true, true, null), none), "nothing lower shows while the card after the update waits").toBeNull();
  expect(nextNotice(facts(true, true, true, true, true), id => id === SIMPLE_MODE_NOTICE)).toBe(UPDATES_CONSENT_NOTICE);
  expect(NOTICES).toEqual([SIMPLE_MODE_NOTICE, UPDATES_CONSENT_NOTICE, TWO_PLACES_NOTICE, CLOUD_TRIAL_NOTICE, CLOUD_NOTICE]);
  expect(nextNotice(facts(true, true, true, true, true), id => id === UPDATES_CONSENT_NOTICE)).toBe(SIMPLE_MODE_NOTICE);
  expect(nextNotice(facts(false, false, true, true, true), none)).toBe(TWO_PLACES_NOTICE);
  expect(nextNotice(facts(false, false, false, true, true), none)).toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(facts(false, false, false, false, true), none)).toBe(CLOUD_NOTICE);
  expect(nextNotice(facts(false, false, false, false, false), none)).toBeNull();
  expect(nextNotice(facts(true, true, true, true, true), () => true)).toBeNull();
});

it("one notice a launch: only the product-updates question may follow the one already shown", () => {
  const due = facts(true, true, true, true, true);
  expect(nextNotice(due, none)).toBe(SIMPLE_MODE_NOTICE);
  expect(nextNotice(due, id => id === SIMPLE_MODE_NOTICE, SIMPLE_MODE_NOTICE), "the question may follow the popup").toBe(UPDATES_CONSENT_NOTICE);
  expect(nextNotice(facts(true, false, true, true, true), id => id === SIMPLE_MODE_NOTICE, SIMPLE_MODE_NOTICE), "nothing else this launch after the popup").toBeNull();
  expect(nextNotice(facts(true, false, true, true, true), none, TWO_PLACES_NOTICE), "a reload while it is up shows it again").toBe(TWO_PLACES_NOTICE);
  expect(nextNotice(due, id => id === TWO_PLACES_NOTICE, null), "the next launch, from the top").toBe(SIMPLE_MODE_NOTICE);
});

it("a launch keeps the notice it showed first for the window's session; storage that throws keeps it for the page", () => {
  expect(launchNotice()).toBeNull();
  markLaunchNotice(CLOUD_TRIAL_NOTICE); markLaunchNotice(CLOUD_NOTICE);
  expect(launchNotice()).toBe(CLOUD_TRIAL_NOTICE);
  expect(session.get("omb.launch.notice")).toBe(CLOUD_TRIAL_NOTICE);
  session.set("omb.launch.notice", "something-else");
  expect(launchNotice(), "only a notice of the list").toBeNull();
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  markLaunchNotice(CLOUD_NOTICE);
  expect(launchNotice()).toBe(CLOUD_NOTICE);
});

it("waits while an earlier notice's answer is unknown, so a later one never shows first", () => {
  expect(nextNotice(facts(null, true, true, true, true), none)).toBeNull();
  expect(nextNotice(facts(false, null, true, true, true), none)).toBeNull();
  expect(nextNotice(facts(false, false, null, true, true), none)).toBeNull();
  expect(nextNotice(facts(false, false, false, true, true), none)).toBe(CLOUD_TRIAL_NOTICE);
});

it("a dismissal holds on this device at once and in the workspace record for good", () => {
  const seen = record(["tour.done"]);
  expect(dismissNotice(seen, CLOUD_NOTICE)).toEqual({ onboarding: { hintsSeen: ["tour.done", CLOUD_NOTICE] } });
  expect(storage.get(CLOUD_NOTICE)).toBe("1");
  expect(noticeSeen(record(), CLOUD_NOTICE)).toBe(true);
  storage.clear();
  expect(noticeSeen(record(), CLOUD_NOTICE)).toBe(false);
  expect(noticeSeen(record([CLOUD_NOTICE]), CLOUD_NOTICE)).toBe(true);
  expect(dismissNotice(record([CLOUD_NOTICE]), CLOUD_NOTICE)).toBeNull();
  expect(withTourReset(record([CLOUD_TRIAL_NOTICE, CLOUD_NOTICE, "tour.done"]))).toEqual([CLOUD_TRIAL_NOTICE, CLOUD_NOTICE]);
});

it("browser storage that throws still leaves the workspace record in charge", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(noticeSeen(record(), CLOUD_NOTICE)).toBe(false);
  expect(noticeSeen(record([CLOUD_NOTICE]), CLOUD_NOTICE)).toBe(true);
  expect(dismissNotice(record(), CLOUD_NOTICE)).toEqual({ onboarding: { hintsSeen: [CLOUD_NOTICE] } });
});
