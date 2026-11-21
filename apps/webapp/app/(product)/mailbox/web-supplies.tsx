"use client";

/**
 * WHAT THE WEB HANDS THE HOST CONTRACT: today's hosted wires by name (the very objects the old shell fell back to),
 * the account's entries, and the account strip's two notices. Values live at module scope where today's did, so a
 * wire keeps one identity for the life of the page.
 */
import { readSessionFamily } from "../../signed-out-signal";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTimeZone, useTranslations } from "next-intl";
import { NONE, type FrameSupplies, type GapLettersWire, type OrganizerNoticeWire, type HostContract, type HostDevice } from "@ohmail/app/host";
import { calendar } from "@ohmail/app/calendar";
import { calendarSetupPortOf } from "@ohmail/app-logic/calendar/setup";
import { calendarPortOf, type CalendarPort } from "@ohmail/app-logic/calendar";
import type { FrameNotice } from "@ohmail/app/frame";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import { liveBodyLoaded, liveBodyPath, liveBodyRefused, type LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { isolatedScopeOf } from "../../shell/engine-config";
import { mirrorOwnerOf } from "@ohmail/app-logic/session/sync-scheduler";
import { sessionMayAsk, subscribeSessionRevival, subscribeSessionTruth } from "@ohmail/app-logic/session/session-truth";
import { mailboxTotalOf } from "@ohmail/app-logic/search";
import { ApiError, account, api, apiConfigured, away, boundApiFamily, boundApiOwner, screenerAutoFiled, screeningSettings, mailboxes as mailboxApi } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { signOut, subscribeTabRetirement } from "../../sign-out";
import { dayStamp } from "../../shell/format";
import { cloudWire as junkWire } from "./junk-wire";
import { useOhmarchyNotice } from "./appearance-notice";
import { browserNoticePage, noticeWordingOf, subscribeBrowserNoticeOpening, webNoticeEmitter } from "../../shell/notice-emitter";
import { browserNotificationHost, type NotificationHost } from "../../shell/notification-settings";
import { browserOpenLink, MAILBOXES_NOTICES } from "../../shell/browser-mail";
import { useAppLocale } from "../../shell/LocaleContext";
import { cloudOlderBodyFor } from "../../shell/older-body";
import { profileImportFor } from "../../profile-import-wire";
import { suggestWireFor } from "./suggest-wire";
import { cloudWire as trashWire } from "../../shell/trash-window";
import { CLOUD_WIRE as DRAFT_REPLY_WIRE } from "./draft-reply-wire";
import { CLOUD_CONSENT, cloudConsent, cloudSeedReview } from "./consent-over-api";
import { WEB_IMAGES } from "./image-wire";
import { awayFeedOver, useAwayNotice } from "@ohmail/app/settings/away";
import { webConnectWire } from "./connect-wire";
import { webDeviceSignIn } from "./device-sign-in";
import { webMailboxesWire } from "./mailboxes-wire";
import { webHost, type WebSupplies } from "./host";
import { openCalendarNotice, openMailNotice } from "./web-notice-open";
import { useLifecycleNotice } from "./lifecycle-notice";
import { useReuseSweepFeed } from "./reuse-sweep-feed";
import { useRecheckWhileShown, useSweepsAnswer, useSweepsFrameNotice } from "../../shell/ReuseSweepNotice";
import type { ReuseSweepLine } from "../../shell/reuse-sweeps";

/** Load it now on the Cloud API: the letter's text for this view, from `GET /messages/:id/live-body`. */
export const liveBodyOverApi: LiveBodyWire = async (messageId) => {
  try {
    return liveBodyLoaded(await api<unknown>(liveBodyPath(messageId)));
  } catch (err) {
    return liveBodyRefused(err instanceof ApiError ? err.status : 0);
  }
};

/** Acknowledging the organizer notice and answering a gap offer: one route each, on this door's client. */
export const organizerNoticeOverApi: OrganizerNoticeWire = (id) => mailboxApi.dismissOrganizerNotice(id);
export const gapLettersOverApi: GapLettersWire = (id, answer) => mailboxApi.answerGapLetters(id, answer);

/** The two ways back the web has: the sign-in page, or a full load of the app, which asks the session again. */
export const webRecover = (how: "signIn" | "reload"): void => window.location.assign(how === "signIn" ? "/login" : "/mailbox");

const signOutHere = async (): Promise<void> => {
  await signOut(readOwner() ?? undefined);
  window.location.assign("/");
};

/** Keep the account whose mounted wire General is using, even if the browser marker has moved. */
export function captureFaceOwner(owner: string | null): () => boolean {
  if (owner === null) return () => false;
  const family = boundApiFamily(owner) ?? readSessionFamily();
  return () => boundApiOwner() === owner && readOwner() === owner && readSessionFamily() === family;
}

const accessHere: Exclude<WebSupplies["reads"]["access"], typeof NONE> = () => account.access() as Promise<unknown> as ReturnType<Exclude<WebSupplies["reads"]["access"], typeof NONE>>;

/** A feature that draws nothing of its own in today's views. */
/** The connect form's calls on the app's page: a sign-in started here is for the account this window is bound to. */
const CONNECT_WIRE = webConnectWire({ owner: boundApiOwner, returned: "page", device: webDeviceSignIn });
/** Settings' Mailboxes section's calls on the app's page: one wire for the page's life; standing it asks nothing. */
const MAILBOXES_WIRE = webMailboxesWire();

const drawsNothing = (): ReactNode => null;
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
  const { notice, busy, mintRefusal, putAway, toManage } = useLifecycleNotice();
  const { sweeps, acknowledge, recheck } = useReuseSweepFeed();
  useRecheckWhileShown(sweeps !== null, recheck);
  const answer = useSweepsAnswer(sweeps ?? NO_SWEEPS, acknowledge);
  const sweepsNotice = useSweepsFrameNotice(answer.shown, answer.ok);
  const appearanceNotice = useOhmarchyNotice(() => {
    const owner = readOwner();
    return () => readOwner() === owner;
  });
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
  if (sweepsNotice !== null) out.push(sweepsNotice);
  if (appearanceNotice !== null) out.push(appearanceNotice);
  return out;
}

/** What the page has learned before it builds the record: its hooks' answers, held by `CloudShell`. */
export interface WebWords {
  readonly server: { readonly pairing: boolean; readonly remoteImages: boolean; readonly searchPeople: boolean; readonly calendar?: boolean | null };
  readonly invites: boolean;
  readonly subscriptionPage: boolean;
  readonly withdrawManage: () => void;
  readonly storageBlock: boolean;
  readonly account: string | null;
  readonly accountAddress?: string | null;
  readonly firstRun: FirstRunHost | undefined;
  readonly mailboxFacts: Exclude<WebSupplies["reads"]["mailboxes"], typeof NONE>;
  readonly resolve: WebSupplies["session"]["resolve"];
  readonly confirmed: WebSupplies["session"]["confirmed"];
}

/**
 * THE WEB'S HOST, built once per engine and per answer. Every part is memoized on its parts, so a render of the entry
 * with nothing changed hands the frame the same record (`web-host-is-stable.test.tsx`).
 */
export type WebFeatureCards = Pick<WebSupplies["features"], "mailboxes" | "subscription" | "storageCard">;

export function useWebHost(
  engine: HostContract["engine"],
  words: WebWords,
  frame: FrameSupplies,
  cards: WebFeatureCards,
  sendSurface: number | undefined,
): HostContract {
  const { server, invites, subscriptionPage, storageBlock, account: confirmed, firstRun } = words;
  /* WHOSE KEYS TODAY'S VIEWS KEEP: the account the engine's mirror is named for, read off the engine itself, never a
     second read of the session's marker (which another tab may have moved since the engine was opened). */
  const scope = useMemo(() => mirrorOwnerOf(engine), [engine]);
  /* The language's controls the page wraps around the frame (the account's locale context), as the host contract
     takes them: one record while the language and its adoption stand. */
  const controls = useAppLocale();
  const drawnLocale = controls?.locale;
  const adoptLocale = controls?.adoptLocale;
  const language = useMemo(
    (): HostDevice["language"] =>
      drawnLocale === undefined || adoptLocale === undefined ? NONE : { locale: drawnLocale, adoptLocale },
    [drawnLocale, adoptLocale],
  );
  const screeningWires = useMemo((): Pick<WebSupplies["wires"], "screening" | "autoFiled" | "consent" | "suggest" | "seedReview"> => {
    if (!apiConfigured() || scope === null || scope !== confirmed) {
      return { screening: NONE, autoFiled: NONE, consent: NONE, suggest: NONE, seedReview: NONE };
    }
    return {
      consent: cloudConsent(scope),
      suggest: suggestWireFor(scope),
      seedReview: cloudSeedReview(scope),
      screening: {
        read: () => screeningSettings.get(scope),
        change: (change) => screeningSettings.set(change, scope),
      },
      autoFiled: {
        list: () => screenerAutoFiled.get(scope),
        putBack: (ids) => screenerAutoFiled.undo(ids, scope),
      },
    };
  }, [scope, confirmed]);
  const awayFeed = useMemo(
    () => apiConfigured() && scope !== null && scope === confirmed
      ? awayFeedOver({
          state: () => away.state(scope),
          save: (next) => away.save(next, scope),
        })
      : null,
    [scope, confirmed],
  );
  useEffect(() => awayFeed?.start(), [awayFeed]);
  const features = useMemo((): WebSupplies["features"] => ({
    ...cards,
    mailboxes: {
      ...cards.mailboxes,
      notice: function useMailboxNotices() {
        return [...MAILBOXES_NOTICES(), ...useAwayNotice(awayFeed)];
      },
    },
    ai: { name: "ai", render: drawsNothing },
    storage: { name: "storage", render: drawsNothing },
    account: { name: "account", render: drawsNothing },
    accountStrip: { name: "accountStrip", render: drawsNothing, notice: useAccountNotices },
    invites: { name: "invites", render: drawsNothing },
    security: { name: "security", render: drawsNothing },
    about: { name: "about", render: drawsNothing },
    devices: { name: "devices", render: drawsNothing },
    screener: { name: "screener", render: drawsNothing },
    help: { name: "help", render: drawsNothing },
  }), [cards, awayFeed]);
  const calendarPort = useMemo(() => {
    if (server.calendar !== true || scope === null || scope !== confirmed) return NONE;
    const transport = engine.calendarTransport();
    if (!transport) return NONE;
    const setup = engine.calendarSetupTransport();
    return calendarPortOf({
      engine, transport, clock: { uuid: () => crypto.randomUUID(), now: Date.now },
      ...(typeof window === "undefined" ? {} : { online: window }),
      mayRun: () => engine.calendarQueueReady() && readOwner() === scope && sessionMayAsk(),
      settings: transport.calendarSettings,
      setSuggestionDismissed: transport.setSuggestionDismissed,
      setup: setup ? calendarSetupPortOf(setup, () => engine.syncOnce(), () => crypto.randomUUID()) : undefined,
      held: () => engine.calendarHeld(), load: (span) => engine.loadCalendar(span),
    });
  }, [engine, scope, confirmed, server.calendar]);
  useEffect(() => {
    if (calendarPort === NONE) return;
    const stop = calendarPort.activate();
    const offRetirement = subscribeTabRetirement(stop);
    const offTruth = subscribeSessionTruth(() => {
      if (!sessionMayAsk()) calendarPort.suspendWrites();
    });
    const offRevival = subscribeSessionRevival(calendarPort.resumeWrites);
    let hydrated = engine.calendarQueueReady();
    const offEngine = engine.subscribe(() => {
      if (!hydrated && engine.calendarQueueReady()) {
        hydrated = true;
        calendarPort.resumeWrites();
      }
    });
    return () => {
      offEngine();
      offRevival();
      offTruth();
      offRetirement();
      stop();
    };
  }, [calendarPort, engine]);
  const notifications = useWebNotifications(frame.address, engine, calendarPort, scope === confirmed ? confirmed : null);
  const profileImport = useMemo(
    () => apiConfigured() && scope !== null && scope === confirmed ? profileImportFor(scope) : NONE,
    [scope, confirmed],
  );
  const searchMailboxTotal = useMemo(() => scope !== null && scope === confirmed
    ? async () => mailboxTotalOf((await mailboxApi.list({ counts: true }, scope)).items)
    : undefined, [scope, confirmed]);
  const supplies = useMemo((): WebSupplies => ({
    session: { resolve: words.resolve, confirmed: words.confirmed, signOut: signOutHere },
    reads: { mailboxes: words.mailboxFacts, access: accessHere },
    searchMailboxTotal,
    wires: {
      organizerNotice: organizerNoticeOverApi,
      gapLetters: gapLettersOverApi,
      liveBody: liveBodyOverApi,
      away: awayFeed?.wire ?? NONE,
      profileImport,
      olderBody: scope !== null ? cloudOlderBodyFor(scope) : NONE,
      junk: junkWire,
      trash: trashWire,
      draftReply: DRAFT_REPLY_WIRE,
      images: apiConfigured() ? WEB_IMAGES : NONE,
      firstRun: firstRun ?? NONE,
      ...screeningWires,
      folderSummary: scope !== null && scope === confirmed
        ? (id: string) => api<{ folders: number; messages: number }>(
            `/folders/${encodeURIComponent(id)}/summary`, { expectedOwner: scope },
          )
        : NONE,
      connect: CONNECT_WIRE,
      mailboxes: MAILBOXES_WIRE,
      calendar: calendarPort,
    },
    features,
    notifications,
    language,
    openLink: browserOpenLink,
    frame: calendarPort === NONE ? frame : { ...frame, calendar },
  }), [words.resolve, words.confirmed, words.mailboxFacts, searchMailboxTotal, firstRun, features, language, frame, notifications, calendarPort, screeningWires, profileImport, scope, confirmed, awayFeed]);
  return useMemo(() => webHost(engine, {
    selfHost: SELF_HOST_BUILD,
    server: { pairing: server.pairing, remoteImages: server.remoteImages, searchPeople: server.searchPeople, calendar: server.calendar },
    invites,
    subscriptionPage,
    storageBlock,
    sendSurface,
    foldersStorable: CLOUD_CONSENT.foldersStorable,
    scope,
    isolatedScope: isolatedScopeOf(engine),
    account: confirmed,
    accountAddress: words.accountAddress,
    build: { version: process.env.NEXT_PUBLIC_APP_VERSION ?? null, commit: process.env.NEXT_PUBLIC_BUILD ?? null },
  }, supplies), [engine, server.pairing, server.remoteImages, server.searchPeople, server.calendar, invites, subscriptionPage, storageBlock, scope, confirmed, words.accountAddress, supplies, sendSurface]);
}

/**
 * THE BROWSER'S NOTIFICATIONS, WITH THE PAGE'S EMITTER. Made once for the page's life: the caller
 * takes back what was drawn whenever the emitter it is handed changes, so the emitter keeps one
 * identity and reads the person's words at the moment it draws.
 */
function useWebNotifications(
  address: FrameSupplies["address"], engine: HostContract["engine"], calendarPort: CalendarPort | typeof NONE, owner: string | null,
): NotificationHost {
  const t = useTranslations("frame.systemNotice");
  const say = useRef(t);
  say.current = t;
  const zone = useTimeZone() ?? "UTC";
  const mounted = useRef({ address, engine, calendarPort, owner, zone });
  mounted.current = { address, engine, calendarPort, owner, zone };
  useEffect(() => subscribeBrowserNoticeOpening((owner, family) => {
    const current = mounted.current;
    if (current.owner !== owner || boundApiFamily(owner) !== family ||
        !captureFaceOwner(owner)() || !sessionMayAsk()) return false;
    return openMailNotice(current.address, undefined, () => false);
  }), []);
  return useMemo(() => ({
    ...browserNotificationHost,
    liveNoticeScope: () => {
      const owner = mounted.current.owner;
      return captureFaceOwner(owner)() && sessionMayAsk() ? owner : null;
    },
    emitter: webNoticeEmitter(browserNoticePage, () => noticeWordingOf((key, values) => say.current(key, values)), (notice, letter) => {
      if (notice.kind !== "ohbox" && (!("eventId" in notice) || mounted.current.calendarPort === NONE)) return;
      const before = mounted.current;
      const owns = captureFaceOwner(before.owner);
      return () => {
        if (!owns() || !sessionMayAsk() || mounted.current.engine !== before.engine) return false;
        if (notice.kind === "ohbox") {
          return openMailNotice(before.address, letter, (id) => before.engine.store.get("message", id) !== undefined);
        }
        if (before.calendarPort === NONE || mounted.current.calendarPort !== before.calendarPort) return false;
        return openCalendarNotice(before.address, before.calendarPort, notice.eventId, mounted.current.zone, notice.kind === "cal_alert" ? notice.startMs : undefined);
      };
    }),
  }), []);
}
