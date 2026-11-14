"use client";

/**
 * WHAT THE WEB HANDS THE HOST CONTRACT: today's hosted wires by name (the very objects the old shell fell back to),
 * the account's entries, and the account strip's two notices. Values live at module scope where today's did, so a
 * wire keeps one identity for the life of the page.
 */
import { useMemo, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { NONE, type FeatureEntry, type FrameSupplies, type HostContract } from "@ohmail/app/host";
import type { FrameNotice } from "@ohmail/app/frame";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import { liveBodyLoaded, liveBodyPath, liveBodyRefused, type LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { mirrorOwnerOf } from "@ohmail/app-logic/session/sync-scheduler";
import { ApiError, account, api, apiConfigured, away, boundApiOwner, mailboxes as mailboxApi } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { signOut } from "../../sign-out";
import { CLOUD_WIRE as DRAFT_REPLY_WIRE } from "../../shell/draft-reply";
import { dayStamp } from "../../shell/format";
import type { GapLettersTransport } from "../../shell/GapLettersNotice";
import { cloudWire as junkWire } from "../../shell/junk-window";
import { MailboxFilings, type MailboxFilingsApi } from "../../shell/MailboxFilings";
import { MailboxSelfCheck } from "../../shell/MailboxSelfCheck";
import { browserNoticePage, noticeWordingOf, webNoticeEmitter } from "../../shell/notice-emitter";
import { browserNotificationHost, type NotificationHost } from "../../shell/notification-settings";
import { CLOUD_OLDER_BODY } from "../../shell/older-body";
import type { OrganizerNoticeTransport } from "../../shell/OrganizerNotice";
import { HOSTED as PROFILE_IMPORT } from "../../shell/ProfileImportCard";
import { ScreeningSection } from "../../shell/ScreeningSection";
import { CLOUD_WIRE as SUGGEST_WIRE } from "../../shell/screener-suggest";
import { cloudWire as trashWire } from "../../shell/trash-window";
import { AboutSection } from "./AboutSection";
import { AccountSection } from "./AccountSection";
import { AiSection } from "./AiSection";
import { CloudStorageNotice } from "./CloudStorageNotice";
import { CLOUD_CONSENT, CLOUD_SEED_REVIEW } from "./consent-over-api";
import { DevicesSection } from "./DevicesSection";
import { webConnectWire } from "./connect-wire";
import { webHost, type WebSupplies } from "./host";
import { InvitesSection } from "./InvitesSection";
import { useLifecycleNotice } from "./lifecycle-notice";
import { MailboxSection } from "./MailboxSection";
import { PasswordSection } from "./PasswordSection";
import { useReuseSweepFeed } from "./reuse-sweep-feed";
import { useRecheckWhileShown, useSweepsAnswer } from "../../shell/ReuseSweepNotice";
import type { ReuseSweepLine } from "../../shell/reuse-sweeps";
import { SecuritySection } from "./SecuritySection";
import { sendSurfaceFor } from "./send-surface";
import { StorageSection } from "./StorageSection";
import { SubscriptionSection } from "./SubscriptionSection";

/** The staged ceiling where this page can PUT the files, else none (`send-surface.ts`). Compiled. */
export const SEND_SURFACE = sendSurfaceFor(SELF_HOST_BUILD, process.env.NEXT_PUBLIC_STAGING_ORIGIN);

/** Load it now on the Cloud API: the letter's text for this view, from `GET /messages/:id/live-body`. */
export const liveBodyOverApi: LiveBodyWire = async (messageId) => {
  try {
    return liveBodyLoaded(await api<unknown>(liveBodyPath(messageId)));
  } catch (err) {
    return liveBodyRefused(err instanceof ApiError ? err.status : 0);
  }
};

/** Acknowledging the organizer notice and answering a gap offer: one route each, on this door's client. */
export const organizerNoticeOverApi: OrganizerNoticeTransport = (id) => mailboxApi.dismissOrganizerNotice(id);
export const gapLettersOverApi: GapLettersTransport = (id, answer) => mailboxApi.answerGapLetters(id, answer);

/** Settings → Mailboxes' waiting filings, on the Cloud API. Module scope: one identity per load. */
const filingsApi: MailboxFilingsApi = {
  read: mailboxApi.filings, retry: mailboxApi.retryFilings, leave: mailboxApi.leaveFilings,
};

/** The two ways back the web has: the sign-in page, or a full load of the app, which asks the session again. */
export const webRecover = (how: "signIn" | "reload"): void => window.location.assign(how === "signIn" ? "/login" : "/mailbox");

const signOutHere = async (): Promise<void> => {
  await signOut(readOwner() ?? undefined);
};
const accessHere: Exclude<WebSupplies["reads"]["access"], typeof NONE> = () => account.access() as Promise<unknown> as ReturnType<Exclude<WebSupplies["reads"]["access"], typeof NONE>>;

/** A feature that draws nothing of its own in today's views. */
/** The connect form's calls on the app's page: a sign-in started here is for the account this window is bound to. */
const CONNECT_WIRE = webConnectWire({ owner: () => boundApiOwner(), returned: "page" });

const drawsNothing = (): ReactNode => null;
const entryOf = (name: FeatureEntry["name"], node: ReactNode, notice?: FeatureEntry["notice"]): FeatureEntry =>
  ({ name, render: () => node, ...(notice ? { notice } : {}) });

/** No sweeps listed: one array, so the answer's filter reads the same input between renders. */
const NO_SWEEPS: readonly ReuseSweepLine[] = [];

/**
 * THE ACCOUNT'S STRIP, as notices: a trial running out, a grace, a payment that failed, the catch-up after a closure
 * lifts, and the sign-ins ohmail ended because an older copy used them again. Called by the frame in a part of its
 * own, so it may use hooks.
 */
export function useAccountNotices(): readonly FrameNotice[] {
  const t = useTranslations("accountLifecycle");
  const tLock = useTranslations("accessLock");
  const ts = useTranslations("settings");
  const { notice, busy, mintRefusal, putAway, toManage } = useLifecycleNotice();
  const { sweeps, acknowledge, recheck } = useReuseSweepFeed();
  useRecheckWhileShown(sweeps !== null, recheck);
  const answer = useSweepsAnswer(sweeps ?? NO_SWEEPS, acknowledge);
  const out: FrameNotice[] = [];
  if (notice !== null) {
    if (notice.kind === "caughtUp") {
      out.push({ kind: "caughtUp", title: t("caughtUp", { date: dayStamp(notice.since) }), acts: [{ label: t("dismiss"), onPress: putAway }] });
    } else {
      const date = dayStamp(notice.deadline);
      out.push({
        kind: notice.kind === "grace" ? "grace" : notice.kind === "pastDue" ? "payment" : "trial",
        hot: notice.kind !== "trialEnding",
        title: notice.kind === "grace" ? t("graceEnds", { date }) : notice.kind === "pastDue" ? t("paymentFailed", { date }) : t("trialEnds", { date }),
        ...(mintRefusal !== null ? { line: tLock(mintRefusal === "unverified" ? "mintUnverified" : "mintFailed") } : {}),
        acts: [
          { label: notice.kind === "pastDue" ? t("fixPayment") : t("subscribe"), onPress: () => { if (!busy) void toManage(); } },
          { label: t("later"), onPress: putAway },
        ],
      });
    }
  }
  if (answer.shown.length > 0) {
    out.push({
      kind: "signInCopies",
      title: ts("reuseSweepsTitle", { count: answer.shown.length }),
      acts: [{ label: ts("reuseSweepsOk"), onPress: answer.ok }],
    });
  }
  return out;
}

/** What the page has learned before it builds the record: its hooks' answers, held by `CloudShell`. */
export interface WebWords {
  readonly server: { readonly pairing: boolean; readonly remoteImages: boolean; readonly searchPeople: boolean };
  readonly invites: boolean;
  readonly subscriptionPage: boolean;
  readonly withdrawManage: () => void;
  readonly storageBlock: boolean;
  readonly account: string | null;
  readonly firstRun: FirstRunHost | undefined;
  readonly mailboxFacts: Exclude<WebSupplies["reads"]["mailboxes"], typeof NONE>;
  readonly resolve: WebSupplies["session"]["resolve"];
  readonly confirmed: WebSupplies["session"]["confirmed"];
}

/**
 * THE WEB'S HOST, built once per engine and per answer. Every part is memoized on its parts, so a render of the entry
 * with nothing changed hands the frame the same record (`web-host-is-stable.test.tsx`).
 */
export function useWebHost(engine: HostContract["engine"], words: WebWords, frame: FrameSupplies): HostContract {
  const { server, invites, subscriptionPage, withdrawManage, storageBlock, account: confirmed, firstRun } = words;
  /* WHOSE KEYS TODAY'S VIEWS KEEP: the account the engine's mirror is named for, read off the engine itself, never a
     second read of the session's marker (which another tab may have moved since the engine was opened). */
  const scope = useMemo(() => mirrorOwnerOf(engine), [engine]);
  const devices = server.pairing;
  const features = useMemo((): WebSupplies["features"] => ({
    account: entryOf("account", <><PasswordSection /><AccountSection /></>),
    mailboxes: entryOf("mailboxes", <><MailboxSection subscriptionPane={subscriptionPage} /><MailboxFilings api={filingsApi} /><MailboxSelfCheck check={mailboxApi.selfCheck} /></>),
    ai: entryOf("ai", <AiSection />),
    subscription: entryOf("subscription", <SubscriptionSection onNowhere={withdrawManage} />),
    storage: entryOf("storage", <StorageSection />),
    storageCard: entryOf("storageCard", <CloudStorageNotice />),
    accountStrip: { name: "accountStrip", render: drawsNothing, notice: useAccountNotices },
    invites: entryOf("invites", <InvitesSection />),
    security: entryOf("security", <SecuritySection />),
    about: entryOf("about", <AboutSection />),
    devices: entryOf("devices", devices ? <DevicesSection /> : null),
    screener: entryOf("screener", <ScreeningSection />),
    help: { name: "help", render: drawsNothing },
  }), [subscriptionPage, withdrawManage, devices]);
  const notifications = useWebNotifications();
  const supplies = useMemo((): WebSupplies => ({
    session: { resolve: words.resolve, confirmed: words.confirmed, signOut: signOutHere },
    reads: { mailboxes: words.mailboxFacts, access: accessHere },
    wires: {
      organizerNotice: organizerNoticeOverApi,
      gapLetters: gapLettersOverApi,
      liveBody: liveBodyOverApi,
      away,
      profileImport: PROFILE_IMPORT,
      consent: CLOUD_CONSENT,
      olderBody: CLOUD_OLDER_BODY,
      junk: junkWire,
      trash: trashWire,
      suggest: SUGGEST_WIRE,
      draftReply: DRAFT_REPLY_WIRE,
      images: NONE,
      firstRun: firstRun ?? NONE,
      screening: NONE,
      autoFiled: NONE,
      seedReview: apiConfigured() ? CLOUD_SEED_REVIEW : NONE,
      folderSummary: NONE,
      connect: CONNECT_WIRE,
      mailboxes: NONE,
    },
    features,
    notifications,
    frame,
  }), [words.resolve, words.confirmed, words.mailboxFacts, firstRun, features, frame, notifications]);
  return useMemo(() => webHost(engine, {
    selfHost: SELF_HOST_BUILD,
    server: { pairing: server.pairing, remoteImages: server.remoteImages, searchPeople: server.searchPeople },
    invites,
    subscriptionPage,
    storageBlock,
    sendSurface: SEND_SURFACE,
    foldersStorable: CLOUD_CONSENT.foldersStorable,
    scope,
    account: confirmed,
    build: { version: process.env.NEXT_PUBLIC_APP_VERSION ?? null, commit: process.env.NEXT_PUBLIC_BUILD ?? null },
  }, supplies), [engine, server.pairing, server.remoteImages, server.searchPeople, invites, subscriptionPage, storageBlock, scope, confirmed, supplies]);
}

/**
 * THE BROWSER'S NOTIFICATIONS, WITH THE PAGE'S EMITTER. Made once for the page's life: the caller
 * takes back what was drawn whenever the emitter it is handed changes, so the emitter keeps one
 * identity and reads the person's words at the moment it draws.
 */
function useWebNotifications(): NotificationHost {
  const t = useTranslations("frame.systemNotice");
  const say = useRef(t);
  say.current = t;
  return useMemo(() => ({
    ...browserNotificationHost,
    emitter: webNoticeEmitter(browserNoticePage, () => noticeWordingOf((key, values) => say.current(key, values))),
  }), []);
}
