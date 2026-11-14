/**
 * THE DESKTOP WINDOW'S FRAME: the host built from the door in force, and the mail's places in it over the mail
 * ground. Every entry renders the node the window drew for that door, and nothing under any further condition the
 * mount had (`status`, the first run standing). Everything is memoized on its parts, so a poll of the gate that
 * changes nothing hands the frame the same record (`todays-host-is-stable.test.tsx`).
 *
 * WHAT THE WINDOW HANDS OF ITS OWN: the reader over the letter's renderer, and the managed Account section's
 * native action for opening the browser.
 */
import { useMemo, type ReactNode } from "react";
import { connectWireOver, NONE, type FeatureEntry, type HostConnectionState, type HostDevice, type Signal } from "@ohmail/app/host";
import {
  browserMailParts, browserOpenLink, MAILBOXES_NOTICES, MailFrame, useBrowserMail,
} from "../../webapp/app/shell/browser-mail";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import type { OhmailEngine } from "@ohmail/client-engine";
import { MailboxFilings } from "../../webapp/app/shell/MailboxFilings";
import { MailboxSelfCheck } from "../../webapp/app/shell/MailboxSelfCheck";
import {
  desktopDroppedFilesEnabled, isWithheldFileDrop, looksLikeWithheldFileDrag, takeDroppedFiles,
} from "@ohmail/app-logic/write/dropped-files";
import { desktopFileShell } from "../../webapp/app/shell/open-attachment";
import { cloudSuggestWire } from "./cloud-suggest.js";
import type { StorageFacts } from "../../webapp/app/shell/storage-state";
import type { EngineStatus } from "./bridge-fetch.js";
import { BUILD_SHA, BUILD_VERSION } from "./build-id.js";
import { DefaultMailRow, useDefaultMailNotice } from "./DesktopDefaultMail.js";
import { DesktopAbout } from "./DesktopAbout.js";
import { DesktopAiAccount } from "./DesktopAiAccount.js";
import { DesktopDevices } from "./DesktopDevices.js";
import { DesktopMailboxes, readMirrorFreshness } from "./DesktopMailboxes.js";
import { DesktopScreening } from "./DesktopScreening.js";
import { DesktopSettings } from "./DesktopSettings.js";
import { DesktopStorageNotice } from "./DesktopStorageNotice.js";
import { DesktopStorage, DesktopSubscription } from "./DesktopSubscription.js";
import { DesktopWebSection } from "./DesktopWebSection.js";
import { useAppLocale } from "./DesktopLocale.js";
import { accountDoorFor, flavorOf, hostDoorFor, selfHostedServerOf, type HostedSession } from "./doors.js";
import { desktopHost } from "./host-contract.js";
import type { LinkSlot } from "./link-in.js";
import { awayOverBridge } from "./local-away.js";
import type { LocalAiStatus } from "./local-ai.js";
import { consentOverBridge, consentOverBridgeStandalone } from "./local-consent.js";
import { draftReplyOverBridgeFor } from "./local-draft-reply.js";
import { filingsOverBridge } from "./local-filings.js";
import { gapLettersOverBridge } from "./local-gap-letters.js";
import { localImageDoor } from "./local-images.js";
import { trashOverBridge } from "./local-trash.js";
import { junkOverBridge } from "./local-junk.js";
import { readMailboxFacts } from "./local-mailbox-facts.js";
import { olderBodyOverBridge } from "./local-older-body.js";
import { organizerNoticeOverBridge } from "./local-organizer-notice.js";
import { profileImportOverBridge } from "./local-profile-import.js";
import { checkMailboxHere } from "./local-self-check.js";
import { desktopEmitterFor } from "./notice-emitter.js";
import { openWeb } from "./native.js";
import { desktopNotificationHost } from "./notify-host.js";
import { reuseSweepsOverBridge } from "./reuse-sweeps-wire.js";
import type { ReuseSweepLine } from "../../webapp/app/shell/reuse-sweeps";
import { useRecheckWhileShown, useSweepsAnswer, useSweepsFrameNotice } from "../../webapp/app/shell/ReuseSweepNotice";

export interface DesktopFrameProps {
  engine: OhmailEngine;
  status: EngineStatus;
  session: HostedSession;
  /** The hosted session was refused and the window's card says so. */
  sessionRefused: boolean;
  sealFailed: boolean;
  paired: boolean;
  hostLabel: string | null;
  freshness: { state: "unknown" | "stale" | "current"; asOf: string | null } | null;
  account: string | null;
  storage: StorageFacts | null;
  mayLinkOut: boolean;
  /** The service serves a page for the account's subscription. */
  manageOffered: boolean;
  withdrawManage: () => void;
  rereadAccess: () => void;
  reuseSweeps: readonly ReuseSweepLine[];
  /** Reads the hosted session again: OK in another window ends the sweeps' notice here too. */
  recheckSweeps: () => Promise<unknown>;
  ai: LocalAiStatus | null;
  setAi: (ai: LocalAiStatus | null) => void;
  onStatus: Parameters<typeof DesktopSettings>[0]["onStatus"];
  openOverlay: (overlay: "doors" | "cloud" | "host") => void;
  takeOver: () => void;
  /** The first-run stage stands: the default-mail ask waits behind it. */
  firstRunOpen: boolean;
  firstRun: FirstRunHost | undefined;
  takesMailLinks: boolean;
  scope: string;
  liveNoticeScope?: () => string | null;
  onUnread: (unread: number) => void;
  /** Load it now over the bridge (the gate's own door, where the deadline census reads it). */
  liveBody: LiveBodyWire;
  links: LinkSlot;
  connection: Signal<HostConnectionState | null>;
}

const DESKTOP_MAIL_PARTS = browserMailParts({ mailboxes: NONE, account: NONE });
const ACCOUNT_IN_BROWSER = { open: () => openWeb("account").then(() => true, () => false) };
const MANAGED_MAIL_PARTS = browserMailParts({
  mailboxes: NONE,
  account: { useBrowserDoor: () => ACCOUNT_IN_BROWSER },
});

const entry = (name: FeatureEntry["name"], node: ReactNode, notice?: FeatureEntry["notice"]): FeatureEntry =>
  ({ name, render: () => node, ...(notice ? { notice } : {}) });

export function DesktopFrame(p: DesktopFrameProps) {
  const { status, session, paired, hostLabel, freshness, storage, mayLinkOut } = p;
  /* The native Account action opens the managed service, and the gate already confirmed the session at mount. */
  const managedAccount = flavorOf(status) === "managed" && accountDoorFor(status, session) !== null;
  /* What every browser host hands the frame for mail: made where the frame mounts, under the window's theme. */
  const frame = useBrowserMail(NONE, managedAccount ? MANAGED_MAIL_PARTS : DESKTOP_MAIL_PARTS);
  /* The language's controls this window's own provider stands, as the host contract takes them: one record while
     the language and its adoption stand. */
  const controls = useAppLocale();
  const drawnLocale = controls?.locale;
  const adoptLocale = controls?.adoptLocale;
  const language = useMemo(
    (): HostDevice["language"] =>
      drawnLocale === undefined || adoptLocale === undefined ? NONE : { locale: drawnLocale, adoptLocale },
    [drawnLocale, adoptLocale],
  );
  const onStatus = useStableCallback(p.onStatus);
  const openOverlay = useStableCallback(p.openOverlay);
  const takeOver = useStableCallback(p.takeOver);
  const setAi = useStableCallback(p.setAi);
  const withdrawManage = useStableCallback(p.withdrawManage);
  const rereadAccess = useStableCallback(p.rereadAccess);
  const recheckSweeps = useStableCallback(p.recheckSweeps);
  const sweepIds = p.reuseSweeps.map((s) => s.id).join(",");
  const sweeps = useMemo(() => p.reuseSweeps, [sweepIds]);

  const features = useMemo(() => {
    const hostMode = hostDoorFor(status) === "local";
    return {
      account: entry("account", (
        <DesktopWebSection place="account" copy={{ title: "webAccountTitle", why: "webAccountWhy", note: "webAccountNote" }} />
      )),
      mailboxes: entry("mailboxes", (
        <>
          <DesktopMailboxes
            door={status.mode ?? null}
            host={paired ? hostLabel : null}
            flavor={flavorOf(status)}
            server={selfHostedServerOf(status)}
            onShellStatus={onStatus}
            scope={p.scope}
          />
          <MailboxFilings api={filingsOverBridge} />
          {status.mode === "local" ? <MailboxSelfCheck check={checkMailboxHere} /> : null}
        </>
      ), MAILBOXES_NOTICES),
      ai: entry("ai", <DesktopAiAccount />),
      subscription: entry("subscription", <DesktopSubscription onNowhere={withdrawManage} />),
      storage: entry("storage", storage ? <DesktopStorage facts={storage} linksOut={mayLinkOut} reread={rereadAccess} /> : null),
      storageCard: entry("storageCard", storage ? <DesktopStorageNotice facts={storage} linksOut={mayLinkOut} reread={rereadAccess} /> : null),
      /* The reuse sweeps the account's session read lists, acknowledged over the bridge: one notice. */
      accountStrip: entry("accountStrip", null, sweeps.length > 0 ? () => useSweepsNotice(sweeps, recheckSweeps) : undefined),
      security: entry("security", <DesktopWebSection place="security" copy={{ title: "webSecurityTitle", why: "webSecurityWhy" }} />),
      about: entry("about", <DesktopAbout status={status} />),
      desktop: entry("desktop", (
        <DesktopSettings
          status={status}
          session={session}
          sealFailed={p.sealFailed}
          connection={paired ? freshness : null}
          onStatus={onStatus}
          onSwitchDoor={() => openOverlay("doors")}
          onSignIn={() => openOverlay("cloud")}
          onPairAgain={() => openOverlay("host")}
          onTakeOver={takeOver}
          onAiStatus={setAi}
        />
      )),
      devices: entry("devices", hostMode ? <DesktopDevices />
        : <DesktopWebSection place="devices" copy={{ title: "webDevicesTitle", why: "webDevicesWhy", note: "webDevicesNote" }} />),
      defaultMail: entry("defaultMail", <DefaultMailRow />),
      /* The one-time ask to open mail links: said in the frame's notice slot, beside the list; nothing while the first
         run stands. */
      stageCard: entry("stageCard", null, () => useDefaultMailNotice(!p.firstRunOpen)),
      screener: entry("screener", <DesktopScreening door={status.mode ?? null} />),
      help: entry("help", null),
    };
    // The entries change with the door and what they draw; the callbacks above are stable.
  }, [status, session, paired, hostLabel, freshness, storage, mayLinkOut, p.sealFailed, p.firstRunOpen, p.scope, sweeps,
    onStatus, openOverlay, takeOver, setAi, withdrawManage, rereadAccess, recheckSweeps]);

  const draftReply = useMemo(() => draftReplyOverBridgeFor(status), [status]);
  const { noticeDocument, noticeSession } = status;
  const noticeEmitter = useMemo(() => {
    return desktopEmitterFor(noticeDocument === undefined || noticeSession === undefined
      ? null : { document: noticeDocument, session: noticeSession });
  }, [noticeDocument, noticeSession]);

  const connect = useMemo(() => p.firstRun ? connectWireOver(p.firstRun) : NONE, [p.firstRun]);
  const host = useMemo(() => desktopHost(p.engine, {
    status,
    session,
    sessionRefused: p.sessionRefused,
    hostLabel,
    subscriptionPage: p.manageOffered,
    storageBlock: storage !== null,
    linksOutToBilling: mayLinkOut,
    takesMailLinks: p.takesMailLinks,
    scope: p.scope,
    account: p.account,
    build: { version: BUILD_VERSION, commit: BUILD_SHA || null },
  }, {
    signOut: NONE,
    reads: { mailboxes: readMailboxFacts, copyAge: readMirrorFreshness, access: NONE },
    wires: {
      organizerNotice: organizerNoticeOverBridge,
      gapLetters: gapLettersOverBridge,
      liveBody: p.liveBody,
      away: awayOverBridge,
      profileImport: profileImportOverBridge,
      images: localImageDoor,
      olderBody: olderBodyOverBridge,
      junk: junkOverBridge,
      trash: trashOverBridge,
      suggest: cloudSuggestWire,
      draftReply,
      consent: { account: consentOverBridge, standalone: consentOverBridgeStandalone },
      firstRun: p.firstRun ?? NONE,
      connect,
      screening: NONE,
      autoFiled: NONE,
      ownModelAutoSuggest: NONE,
      mailboxes: NONE,
    },
    features,
    notifications: { ...desktopNotificationHost, emitter: noticeEmitter, liveNoticeScope: p.liveNoticeScope },
    frame,
    badge: p.onUnread,
    language,
    /* The webview's new-window request, which the shell opens in the person's own browser, on a press alone. */
    openLink: browserOpenLink,
    /* The file door saves and stages through the window's shell where it is armed; a preview build answers none
       and saves as a browser does. Read as the host is built: the window is armed before anything mounts. */
    saveFile: desktopFileShell(),
    pickFile: desktopDroppedFilesEnabled() ? {
      looksLikeDrag: looksLikeWithheldFileDrag,
      matchesDrop: isWithheldFileDrop,
      take: takeDroppedFiles,
    } : NONE,
    hostConnection: p.connection,
    linkIn: p.links,
  }), [p.engine, p.liveBody, status, session, p.sessionRefused, hostLabel, p.manageOffered, storage, mayLinkOut,
    p.takesMailLinks, p.scope, p.liveNoticeScope, noticeEmitter, p.account, draftReply, p.firstRun, connect, features, p.onUnread, language, p.connection, p.links,
    frame]);

  return <MailFrame host={host} />;
}

/** The sign-ins ohmail ended because an older copy used them again, as one notice: the advice, OK and Details. */
function useSweepsNotice(sweeps: readonly ReuseSweepLine[], recheck: () => Promise<unknown>) {
  useRecheckWhileShown(true, recheck);
  const { shown, ok } = useSweepsAnswer(sweeps, reuseSweepsOverBridge);
  const notice = useSweepsFrameNotice(shown, ok);
  return notice === null ? [] : [notice];
}
