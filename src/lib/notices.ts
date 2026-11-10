import { hintSeen, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";

export const UPDATES_CONSENT_NOTICE = "updates-consent";
/** The Simple mode popup, once per browser (simple-mode-prompt.ts keeps whether it was closed). */
export const SIMPLE_MODE_NOTICE = "simple-mode-prompt";
export const CLOUD_TRIAL_NOTICE = "cloud-trial-notice";
export const CLOUD_NOTICE = "cloud-notice";
/** Bots on this computer and on another place of the person's (two-places.ts): dismissed per place, by main. */
export const TWO_PLACES_NOTICE = "two-places";

/**
 * Every notice, in the order a launch asks them: one launch shows one notice, the first one due, and only the product-updates
 * question may follow it there. The rest wait for later launches, in this order.
 */
export const NOTICES = [
  SIMPLE_MODE_NOTICE,
  UPDATES_CONSENT_NOTICE,
  TWO_PLACES_NOTICE,
  CLOUD_TRIAL_NOTICE,
  CLOUD_NOTICE,
] as const;

export type NoticeId = (typeof NOTICES)[number];

export type NoticeFacts = Record<NoticeId, boolean | null>;

/** `launch`: the notice this launch already showed (launchNotice), the only one besides the product-updates question that
 * may show again in it. Any fact still unknown (null) holds the whole queue, so a notice never flashes over one that is
 * still loading. */
export function nextNotice(facts: NoticeFacts, seen: (id: NoticeId) => boolean, launch: NoticeId | null = null): NoticeId | null {
  const showable = (id: NoticeId) => !seen(id) && (launch === null || id === launch || id === UPDATES_CONSENT_NOTICE);
  for (const id of NOTICES) if (showable(id) && facts[id] === null) return null;
  for (const id of NOTICES) if (showable(id) && facts[id]) return id;
  return null;
}

const LAUNCH_KEY = "omb.launch.notice";
// Where browser storage is blocked, this page's memory stands in for it, so a claim still holds for the page.
let launchMemory: NoticeId | null = null;
const isNotice = (id: unknown): id is NoticeId => (NOTICES as readonly unknown[]).includes(id);

/** The first notice this launch showed, kept for the window's session, so a reload is the same launch. */
export function launchNotice(): NoticeId | null {
  try {
    const id = sessionStorage.getItem(LAUNCH_KEY);
    if (isNotice(id)) return id;
  } catch {}
  return launchMemory;
}

/** The first claim of a launch holds; a later one changes nothing. */
export function markLaunchNotice(id: NoticeId): void {
  if (launchNotice()) return;
  try {
    sessionStorage.setItem(LAUNCH_KEY, id);
  } catch {
    launchMemory = id;
  }
}

const stored = (id: string): string | null => { try { return localStorage.getItem(id); } catch { return null; } };
const store = (id: string, value: string) => { try { localStorage.setItem(id, value); } catch {} };

export function noticeSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return hintSeen(record, id) || stored(id) === "1";
}

export function dismissNotice(record: OnboardingStatus | undefined, id: string): { onboarding: { hintsSeen: string[] } } | null {
  store(id, "1");
  return hintSeenPatch(record, id);
}
