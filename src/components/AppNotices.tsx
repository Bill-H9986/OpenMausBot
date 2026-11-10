import { useEffect, useState } from "react";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { api, useStore } from "@/state/store";
import { track } from "@/lib/analytics";
import { brandStatus } from "@/lib/brand";
import { cloudNoticeKind, cloudPlanView, cloudTrialNotice, cloudTrialView } from "@/lib/cloud-plan";
import { jobRoutine, useCloudIntent } from "@/lib/cloud-intent";
import { CLOUD_INTENT_GIVEN, cloudSetupStage } from "@/lib/cloud-setup";
import { cornerPopupWaits, firstChatQuiet, firstReplyPending } from "@/lib/corner-popup";
import { CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, launchNotice, markLaunchNotice, nextNotice, noticeSeen, SIMPLE_MODE_NOTICE, TWO_PLACES_NOTICE, UPDATES_CONSENT_NOTICE } from "@/lib/notices";
import { useTwoPlaces } from "@/lib/two-places";
import { useSimpleModePromptSeen } from "@/lib/simple-mode-prompt";
import { cloudSignInDue, welcomeFinishedThisLaunch, type WelcomeViewer } from "@/lib/onboarding";
import { launchDialogShown, markLaunchDialog } from "@/lib/launch-dialogs";
import { useUpdaterState } from "@/lib/updater";
import { engineReady } from "./EngineLibrary";
import { CLOUD_NOTICE_CARD, cloudNoticeStep, CloudNoticeCard } from "./CloudNotice";
import { CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { useDesktopNotices, useOtherDialogOpen } from "./notice-dialogs";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { UpdatesConsentDialog, updatesConsentBridge, useUpdatesConsent } from "./UpdatesConsent";
import { useMausBotWelcomeDue } from "./MausBotWelcome";
import { reportSimpleModePrompt, SimpleModePrompt } from "./SimpleModePrompt";
import { TwoPlacesCard } from "./TwoPlacesCard";

const trialKey = (trial: { state: string; endsAt: number }) => `${trial.state}:${trial.endsAt}`;
export function AppNotices({ quiet = false, viewer = null }: { quiet?: boolean; viewer?: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.ogb?.cloudAccount : undefined;
  const desktop = remote ? undefined : window.ogb?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  // Asked once main has restored the Cloud sign-in, which it waits for before answering desktopState.
  const planBridge = !remote && (bridge || (viewer?.cloudHome && (desktopState || !desktop))) ? window.ogb?.cloudPlan : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const plan = useCloudPlanSnapshot(planBridge);
  const [closed, setClosed] = useState(false);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [simpleShown, setSimpleShown] = useState(false);
  const consentHere = (local || viewer?.cloudHome === true) && brandStatus().source !== "file";
  const consent = useUpdatesConsent(consentHere ? updatesConsentBridge() : undefined);
  const [consentDone, setConsentDone] = useState(false);
  const updater = useUpdaterState();
  const intent = useCloudIntent();
  const mausBot = useMausBotWelcomeDue(viewer);
  // Bots in two places: this computer's page only, where main knows what lives here.
  const two = useTwoPlaces();
  const twoFact = !local || two.suggest === null ? false : two.suggest === undefined ? null : true;
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  const view = bridge ? cloudPlanView(account) : null;
  const record = state.config?.onboarding;
  const trialDue = cloudTrialNotice(plan);
  const consentDue = consent.state?.available === true && consent.state.due && !consentDone;
  const consentBlocked = useOtherDialogOpen(consentDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");
  const consentFact = !consentHere || consentDone ? false : consent.state === undefined ? null : consentDue ? (consentBlocked ? null : true) : false;
  // Every page with the app's chrome, desktop or Cloud, new install or not: once per browser, as the mode is.
  const simpleDue = !useSimpleModePromptSeen();
  const simpleBlocked = useOtherDialogOpen(simpleDue) || Boolean(state.liveCall && state.liveCall.status !== "ended");

  const trial = plan?.trial;
  const key = trial ? trialKey(trial) : null;
  const setupRecord = record && (intent.pending || intent.sent) ? { ...record, hintsSeen: [...record.hintsSeen, CLOUD_INTENT_GIVEN] } : record;
  const setupHere = cloudSignInDue(viewer, state, engineReady)
    || ["waiting", "shown"].includes(cloudSetupStage({ viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
      engineReady: state.instances.some(engineReady), onboarding: setupRecord, planned: Boolean(jobRoutine(state.routines, intent.sent)) }));
  const waits = cornerPopupWaits(state, updater, { quiet, idle: true, viewer, duringFirstChat: true }) || Boolean(state.cloudAdd) || state.cloudHowTo || setupHere;
  const kind = view ? cloudNoticeKind(view, account) : null;
  const cards = Boolean(bridge || planBridge);
  // No bot or room has answered yet in this launch: the first chat. The popups and the consent question wait for its
  // first reply; unknown (null) until the bots have loaded, so nothing in the queue flashes up before them.
  const firstChat = firstReplyPending(state);
  // MausBot's first-launch card goes first: the popup and the question wait while it is due. The popup skips a launch the
  // card used; the question may follow the card once it closes, as it follows the popup.
  const afterWelcome = welcomeFinishedThisLaunch() || launchDialogShown() === "mausbot" || firstChat;
  const consentWaits = welcomeFinishedThisLaunch() || firstChat;
  const mausBotFirst = mausBot.due;
  const consentNow = consentWaits === true || consentFact === false ? false : consentWaits === null || mausBotFirst ? null : consentFact;
  const launch = launchNotice();
  // After a closed popup only the product-updates question may follow in this launch; nothing else does.
  const notice = waits ? null : closed ? (consentNow === true ? UPDATES_CONSENT_NOTICE : null)
    : firstChatQuiet(state) ? null
    : cards || consentHere || simpleDue || twoFact !== false ? nextNotice({
    [SIMPLE_MODE_NOTICE]: !simpleDue || afterWelcome === true ? false : afterWelcome === null || mausBotFirst || simpleBlocked ? null : true,
    [UPDATES_CONSENT_NOTICE]: consentNow,
    [TWO_PLACES_NOTICE]: twoFact,
    [CLOUD_TRIAL_NOTICE]: planBridge && plan === null ? null : Boolean(key && (trialDue || trialOpen === key)),
    [CLOUD_NOTICE]: !view ? false : view.kind === "unknown" ? null
      : Boolean(kind && !noticeSeen(record, CLOUD_NOTICE_CARD[kind].dismissed)),
  }, () => false, launch) : null;

  const shownKey = notice === CLOUD_TRIAL_NOTICE ? key : notice;
  useEffect(() => {
    if (!shownKey || !notice) return;
    markLaunchNotice(notice);
    // The popups and the question own this launch: MausBot's first-launch card waits for a later one.
    if (shownKey === SIMPLE_MODE_NOTICE || shownKey === UPDATES_CONSENT_NOTICE) markLaunchDialog("notices");
    if (notice === CLOUD_TRIAL_NOTICE && trialOpen !== shownKey) {
      setTrialOpen(shownKey);
      void planBridge?.noticeSeen?.().catch(() => {});
    } else if (shownKey === SIMPLE_MODE_NOTICE && !simpleShown) {
      setSimpleShown(true);
      reportSimpleModePrompt("shown");
    }
  }, [shownKey]);

  const save = (id: string) => {
    const patch = dismissNotice(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => { setClosed(true); setTrialOpen(null); setFailed(false); };
  if (!notice) return null;

  if (notice === SIMPLE_MODE_NOTICE) return <SimpleModePrompt onClose={close} />;

  if (notice === UPDATES_CONSENT_NOTICE && consent.state) {
    const done = () => { setConsentDone(true); close(); };
    return <UpdatesConsentDialog signedIn={consent.state.signedIn}
      onYes={async email => { await consent.choose("opted_in", email); done(); }}
      onNo={() => { done(); void consent.choose("declined").catch(() => {}); }} />;
  }
  if (notice === CLOUD_TRIAL_NOTICE && trial) {
    const shown = cloudTrialView(trial, plan?.credit);
    const act = () => { setFailed(false); void planBridge?.manage().then(close, () => setFailed(true)); };
    return <CloudTrialNoticeCard view={shown} failed={failed} onAction={act} onClose={close} />;
  }
  if (notice === CLOUD_NOTICE && kind && bridge) {
    const act = () => {
      if (busy) return;
      setFailed(false); setBusy(true);
      void cloudNoticeStep(kind, bridge).then(next => setAccount(next), () => setFailed(true)).finally(() => setBusy(false));
    };
    return <CloudNoticeCard kind={kind} busy={busy} failed={failed} onAction={act} onNotNow={() => { close(); save(CLOUD_NOTICE_CARD[kind].dismissed); }} />;
  }
  if (notice === TWO_PLACES_NOTICE && two.suggest) {
    const { key, kind } = two.suggest;
    return <TwoPlacesCard key={key} suggest={two.suggest}
      onBring={() => { track("two_places_card", { action: "bring", kind }); return two.accept(key).then(close); }}
      onDismiss={() => { track("two_places_card", { action: "not_now", kind }); two.dismiss(key); close(); }} />;
  }
  return null;
}
