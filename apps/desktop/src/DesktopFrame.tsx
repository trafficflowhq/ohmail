/**
 * THE DESKTOP WINDOW'S FRAME: the host built from the door in force, and the mail's places in it over the mail
 * ground. Every entry renders the node the window drew for that door, and nothing under any further condition the
 * mount had (`status`, the first run standing). Everything is memoized on its parts, so a poll of the gate that
 * changes nothing hands the frame the same record (`todays-host-is-stable.test.tsx`).
 *
 * WHAT THE WINDOW HANDS OF ITS OWN: the reader over the letter's renderer, and the hosted Account section's
 * native action for opening the browser.
 */
import {
  BrowserGeneralSettings, BrowserSettingsAbove,
  BrowserFoldersPane, BrowserNotificationsPane, BrowserRulesPane, BrowserSignaturesPane, BrowserTagsPane,
  useScreenerWindowSetting, useSuggestionSettings, useUnsubscribeSetting,
} from "@ohmail/app/settings/browser";
import { ScreenerPane } from "@ohmail/app/settings/screener";
import { useFrame } from "@ohmail/app/frame";
import { NO_PANE_PARTS } from "@ohmail/app/mail";
import { AwaySettings, awayFeedOver, useAwayNotice } from "@ohmail/app/settings/away";
import { useConsent } from "@ohmail/app-logic/consent";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { useWriting } from "@ohmail/app/write";
import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from "react";
import { connectWireOver, mailboxRosterOver, NONE, type FeatureEntry, type HostConnectionState, type HostDevice, type Signal } from "@ohmail/app/host";
import {
  BrowserHelpContactPane, browserMailParts, browserOpenLink, MAILBOXES_NOTICES, MailFrame, useBrowserMail,
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
import { readSearchBy } from "@ohmail/app-logic/search";
import { bridgeFetch, type EngineStatus } from "./bridge-fetch.js";
import { BUILD_SHA, BUILD_VERSION } from "./build-id.js";
import { useDefaultMailNotice } from "./DesktopDefaultMail.js";
import { DesktopAbout } from "./DesktopAbout.js";
import { DesktopAiAccount } from "./DesktopAiAccount.js";
import { DesktopDevices } from "./DesktopDevices.js";
import { DesktopMailboxes, readMirrorFreshness } from "./DesktopMailboxes.js";
import { ownModelAutoSuggest } from "./local-auto-suggest.js";
import { DesktopScreening, DesktopUnsubscribeSettings } from "./DesktopScreening.js";
import { DesktopSettings } from "./DesktopSettings.js";
import { DesktopStorageNotice } from "./DesktopStorageNotice.js";
import { DesktopStorage, DesktopSubscription } from "./DesktopSubscription.js";
import { DesktopWebSection } from "./DesktopWebSection.js";
import { useAppLocale } from "./DesktopLocale.js";
import { DOOR_COPY } from "./door-copy.js";
import { accountDoorFor, awayDoorFor, flavorOf, hostDoorFor, selfHostedServerOf, type HostedSession } from "./doors.js";
import { desktopHost } from "./host-contract.js";
import type { LinkSlot } from "./link-in.js";
import { awayOverBridge } from "./local-away.js";
import { LocalSuggest, type LocalSuggestProps } from "./local-suggest.js";
import type { LocalAiStatus } from "./local-ai.js";
import { consentOverBridge, consentOverBridgeStandalone } from "./local-consent.js";
import { draftReplyOverBridgeFor } from "./local-draft-reply.js";
import { filingsOverBridge } from "./local-filings.js";
import { gapLettersOverBridge } from "./local-gap-letters.js";
import { localImageDoor } from "./local-images.js";
import { trashOverBridge } from "./local-trash.js";
import { junkOverBridge } from "./local-junk.js";
import { readMailboxFacts, readSearchMailboxTotal } from "./local-mailbox-facts.js";
import { desktopMailboxRequests } from "./local-mailboxes-wire.js";
import { olderBodyOverBridge } from "./local-older-body.js";
import { organizerNoticeOverBridge } from "./local-organizer-notice.js";
import { profileImportOverBridge } from "./local-profile-import.js";
import { checkMailboxHere } from "./local-self-check.js";
import { desktopEmitterFor } from "./notice-emitter.js";
import { openServerMailboxes, openWeb } from "./native.js";
import { desktopNotificationHost, desktopNotificationPreferences } from "./notify-host.js";
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

function DesktopAboutPane() {
  const about = useFrame().host.features.about;
  return about === NONE ? null : about.render();
}

function DesktopHelpPane() {
  const { host } = useFrame();
  const { writeSupport } = useWriting();
  const { mailboxes } = useMailState();
  const { version, commit, mailtoLeaves } = host.device.build;
  const accountId = host.capabilities.account === "inBrowser" && host.session.state === "live" ? host.session.account : null;
  return (
    <BrowserHelpContactPane
      host={{ surface: "desktop", version, commit, mailtoLeaves, accountId }}
      mailboxes={liveMailboxes(mailboxes)}
      onWrite={host.features.places.write === NONE ? null : writeSupport ?? null}
    />
  );
}

const DesktopInstallContext = createContext<Parameters<typeof DesktopSettings>[0] | null>(null);

function DesktopInstallPane() {
  const install = useContext(DesktopInstallContext);
  if (install === null) throw new Error("Desktop Settings requires a desktop install");
  return <DesktopSettings {...install} />;
}

function DesktopScreenerPane() {
  const install = useContext(DesktopInstallContext);
  if (install === null) throw new Error("Screener Settings requires a desktop install");
  return (
    <>
      <DesktopScreening door={install.status.mode ?? null} />
      <DesktopUnsubscribeSettings />
    </>
  );
}

const NATIVE_PANE_PARTS = {
  ...NO_PANE_PARTS,
  about: DesktopAboutPane,
  help: DesktopHelpPane,
  desktop: DesktopInstallPane,
  screener: DesktopScreenerPane,
};
const INSTALL_MAIL_PARTS = browserMailParts(NATIVE_PANE_PARTS);
const DesktopMailboxContext = createContext<Parameters<typeof DesktopMailboxes>[0] | null>(null);

function DesktopMailboxesPane({ goToSetup }: {
  goToSetup: NonNullable<Parameters<typeof DesktopMailboxes>[0]["goToSetup"]>;
}) {
  const mailboxes = useContext(DesktopMailboxContext);
  if (mailboxes === null) throw new Error("Mailboxes Settings requires a desktop door");
  return (
    <>
      <DesktopMailboxes
        key={JSON.stringify([mailboxes.scope, mailboxes.door, mailboxes.flavor, mailboxes.removalDoor?.version])}
        {...mailboxes}
        goToSetup={goToSetup}
      />
      <MailboxFilings api={filingsOverBridge} />
      {mailboxes.door === "local" ? <MailboxSelfCheck check={checkMailboxHere} /> : null}
    </>
  );
}

const MAILBOXES_PARTS = { factor: NONE, calendar: NONE, device: DesktopMailboxesPane } as const;
function DesktopAiPane() {
  const ai = useFrame().host.features.ai;
  return ai === NONE ? null : ai.render();
}

function DesktopDevicesPane() {
  const devices = useFrame().host.features.devices;
  return devices === NONE ? null : devices.render();
}

function DesktopBillingPane() {
  const subscription = useFrame().host.features.subscription;
  return subscription === NONE ? null : subscription.render();
}

function DesktopStoragePane() {
  const storage = useFrame().host.features.storage;
  return storage === NONE ? null : storage.render();
}

function DesktopOwnSuggest(props: Omit<LocalSuggestProps, "onConfigure" | "permission">) {
  const { commands } = useFrame();
  const consent = useConsent();
  return <LocalSuggest
    {...props}
    permission={{ known: consent.suggestionConsentKnown, grant: consent.readSuggestionGrant }}
    onConfigure={() => commands.go({ place: "settings", sub: "desktop" })}
  />;
}

function DesktopScreeningPane() {
  const { host } = useFrame();
  const { screener } = host.features;
  const unsubscribe = useUnsubscribeSetting();
  const window = useScreenerWindowSetting();
  const suggestions = useSuggestionSettings(
    host.capabilities.suggest === "pressed",
    host.capabilities.service === "managed",
    host.capabilities.rulesMarked,
  );
  return screener === NONE ? null : <>
    {screener.render()}
    <ScreenerPane model={{
      ohbox: null, filed: null, ...suggestions, ownSuggest: null, window, unsubscribe, review: null,
    }} />
  </>;
}

function DesktopGeneralPane() {
  return <BrowserGeneralSettings locale={useAppLocale()} />;
}

function DesktopSettingsAbove({ children }: { children: ReactNode }) {
  return <BrowserSettingsAbove preferences={desktopNotificationPreferences}>{children}</BrowserSettingsAbove>;
}

const DESKTOP_PANE_PARTS = {
  ...NATIVE_PANE_PARTS,
  mailboxes: MAILBOXES_PARTS,
  general: DesktopGeneralPane,
  notifications: BrowserNotificationsPane,
  rules: BrowserRulesPane,
  tags: BrowserTagsPane,
  folders: BrowserFoldersPane,
  signatures: BrowserSignaturesPane,
  away: AwaySettings,
  screener: DesktopScreeningPane,
  ai: DesktopAiPane,
  devices: DesktopDevicesPane,
  billing: DesktopBillingPane,
  storage: DesktopStoragePane,
};
const DESKTOP_MAIL_PARTS = {
  ...browserMailParts(DESKTOP_PANE_PARTS),
  settingsAbove: DesktopSettingsAbove,
};
const ACCOUNT_IN_BROWSER = { open: () => openWeb("account").then(() => true, () => false) };
const SECURITY_IN_BROWSER = { open: () => openWeb("security").then(() => true, () => false) };
const HOSTED_MAIL_PARTS = {
  ...DESKTOP_MAIL_PARTS,
  paneParts: {
    ...DESKTOP_PANE_PARTS,
    account: { useBrowserDoor: () => ACCOUNT_IN_BROWSER },
    security: { useBrowserDoor: () => SECURITY_IN_BROWSER },
  },
};

const entry = (name: FeatureEntry["name"], node: ReactNode, notice?: FeatureEntry["notice"]): FeatureEntry =>
  ({ name, render: () => node, ...(notice ? { notice } : {}) });

const LOCAL_SEARCH = { by: "people", mailboxTotal: readSearchMailboxTotal } as const;
const REMOTE_SEARCH = { by: () => readSearchBy(bridgeFetch), mailboxTotal: readSearchMailboxTotal };

export function DesktopFrame(p: DesktopFrameProps) {
  const { status, session, paired, hostLabel, freshness, storage, mayLinkOut } = p;
  const flavor = flavorOf(status);
  const server = selfHostedServerOf(status);
  const hostedAccount = accountDoorFor(status, session) !== null;
  const hasMailboxes = status.mode === "local" || status.mode === "cloud";
  /* What every browser host hands the frame for mail: made where the frame mounts, under the window's theme. */
  const frame = useBrowserMail(NONE, hostedAccount ? HOSTED_MAIL_PARTS : hasMailboxes ? DESKTOP_MAIL_PARTS : INSTALL_MAIL_PARTS);
  const onStatus = useStableCallback(p.onStatus);
  const mailboxes = useMemo(() => {
    if (!hasMailboxes) return NONE;
    const out =
      paired ? NONE : server !== null ? openServerMailboxes
      : flavor === "managed" ? () => openWeb("mailboxes") : NONE;
    return mailboxRosterOver(desktopMailboxRequests, status.mode === "local", out);
  }, [hasMailboxes, flavor, server, paired, status.mode, p.engine, p.scope]);
  const mailboxHost = paired ? hostLabel ?? DOOR_COPY.doorHostName : null;
  const { localDoorVersion } = status;
  const removalDoor = useMemo(() => ({ active: false, version: localDoorVersion }), [
    p.engine, p.scope, status.mode, flavor, server, paired, localDoorVersion,
  ]);
  useLayoutEffect(() => {
    removalDoor.active = true;
    return () => { removalDoor.active = false; };
  }, [removalDoor]);
  const mailboxPane = useMemo(() => ({
    removalDoor,
    door: status.mode ?? null,
    host: mailboxHost,
    flavor,
    server,
    onShellStatus: onStatus,
    scope: p.scope,
  }), [status.mode, mailboxHost, flavor, server, onStatus, p.scope, removalDoor]);
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
  const openOverlay = useStableCallback(p.openOverlay);
  const takeOver = useStableCallback(p.takeOver);
  const setAi = useStableCallback(p.setAi);
  const withdrawManage = useStableCallback(p.withdrawManage);
  const rereadAccess = useStableCallback(p.rereadAccess);
  const recheckSweeps = useStableCallback(p.recheckSweeps);
  const sweepIds = p.reuseSweeps.map((s) => s.id).join(",");
  const sweeps = useMemo(() => p.reuseSweeps, [sweepIds]);
  const install = useMemo(() => ({
    status,
    session,
    sealFailed: p.sealFailed,
    connection: paired ? freshness : null,
    defaultMail: p.takesMailLinks,
    onStatus,
    onSwitchDoor: () => openOverlay("doors"),
    onSignIn: () => openOverlay("cloud"),
    onPairAgain: () => openOverlay("host"),
    onTakeOver: takeOver,
    onAiStatus: setAi,
  }), [status, session, p.sealFailed, paired, freshness, p.takesMailLinks, onStatus, openOverlay, takeOver, setAi]);

  const awayDoor = awayDoorFor(status, session);
  const awayFeed = useMemo(
    () => awayDoor === null ? null : awayFeedOver(awayOverBridge),
    [awayDoor, p.scope, p.account],
  );
  const features = useMemo(() => {
    const hostMode = hostDoorFor(status) === "local";
    return {
      account: entry("account", (
        <DesktopWebSection place="account" copy={{ title: "webAccountTitle", why: "webAccountWhy", note: "webAccountNote" }} />
      )),
      mailboxes: entry("mailboxes", null, function useMailboxNotices() {
        return [...MAILBOXES_NOTICES(), ...useAwayNotice(awayFeed)];
      }),
      ai: entry("ai", <DesktopAiAccount />),
      subscription: entry("subscription", <DesktopSubscription onNowhere={withdrawManage} />),
      storage: entry("storage", storage ? <DesktopStorage facts={storage} linksOut={mayLinkOut} reread={rereadAccess} /> : null),
      storageCard: entry("storageCard", storage ? <DesktopStorageNotice facts={storage} linksOut={mayLinkOut} reread={rereadAccess} /> : null),
      /* The reuse sweeps the account's session read lists, acknowledged over the bridge: one notice. */
      accountStrip: entry("accountStrip", null, sweeps.length > 0 ? () => useSweepsNotice(sweeps, recheckSweeps) : undefined),
      security: entry("security", null),
      about: entry("about", <DesktopAbout status={status} />),
      desktop: entry("desktop", null),
      devices: entry("devices", hostMode ? <DesktopDevices />
        : <DesktopWebSection place="devices" copy={{ title: "webDevicesTitle", why: "webDevicesWhy", note: "webDevicesNote" }} />),
      defaultMail: entry("defaultMail", null),
      /* The one-time ask to open mail links: said in the frame's notice slot, beside the list; nothing while the first
         run stands. */
      stageCard: entry("stageCard", null, () => useDefaultMailNotice(!p.firstRunOpen)),
      screener: {
        ...entry("screener", <DesktopScreening door={status.mode ?? null} />),
        ...(status.mode === "local" ? {
          ownSuggest: (props: Pick<LocalSuggestProps, "senders" | "absorb">) => <DesktopOwnSuggest {...props} ai={p.ai} />,
        } : {}),
      },
      help: entry("help", null),
    };
    // The entries change with the door and what they draw; the callbacks above are stable.
  }, [status, storage, mayLinkOut, p.ai, p.firstRunOpen, sweeps, withdrawManage, rereadAccess, recheckSweeps, awayFeed]);

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
    search: status.mode === "local" ? LOCAL_SEARCH : REMOTE_SEARCH,
    wires: {
      organizerNotice: organizerNoticeOverBridge,
      gapLetters: gapLettersOverBridge,
      liveBody: p.liveBody,
      away: awayFeed?.wire ?? awayOverBridge,
      profileImport: profileImportOverBridge,
      images: localImageDoor,
      olderBody: olderBodyOverBridge,
      folderSummary: async (id) => {
        const response = await bridgeFetch(`/folders/${encodeURIComponent(id)}/summary`);
        return response.ok ? await response.json() : null;
      },
      junk: junkOverBridge,
      trash: trashOverBridge,
      suggest: cloudSuggestWire,
      draftReply,
      consent: { account: consentOverBridge, standalone: consentOverBridgeStandalone },
      firstRun: p.firstRun ?? NONE,
      connect,
      screening: NONE,
      autoFiled: NONE,
      ownModelAutoSuggest,
      mailboxes,
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
    p.takesMailLinks, p.scope, p.liveNoticeScope, noticeEmitter, p.account, awayFeed, draftReply, p.firstRun, connect, mailboxes,
    features, p.onUnread, language, p.connection, p.links,
    frame]);

  return (
    <DesktopInstallContext.Provider value={install}>
      <DesktopMailboxContext.Provider value={mailboxPane}>
        <MailFrame host={host} />
      </DesktopMailboxContext.Provider>
    </DesktopInstallContext.Provider>
  );
}

/** The sign-ins ohmail ended because an older copy used them again, as one notice: the advice, OK and Details. */
function useSweepsNotice(sweeps: readonly ReuseSweepLine[], recheck: () => Promise<unknown>) {
  useRecheckWhileShown(true, recheck);
  const { shown, ok } = useSweepsAnswer(sweeps, reuseSweepsOverBridge);
  const notice = useSweepsFrameNotice(shown, ok);
  return notice === null ? [] : [notice];
}
