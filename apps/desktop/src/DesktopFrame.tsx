/**
 * THE DESKTOP WINDOW'S FRAME: the host built from the door in force, and today's views in it. Every entry renders the
 * node the window drew for that door, and nothing under any further condition the mount had (`status`, the first
 * run standing). Everything is memoized on its parts, so a poll of the gate that changes nothing hands the frame the
 * same record (`todays-host-is-stable.test.tsx`).
 */
import { useMemo, type ReactNode } from "react";
import { NONE, type FeatureEntry, type HostConnectionState, type Signal } from "@ohmail/app/host";
import { useTodaysSupplies } from "../../webapp/app/shell/todays-supplies";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { LiveBodyWire } from "@ohmail/app-logic/reading/live-body";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import type { OhmailEngine } from "@ohmail/client-engine";
import { MailboxFilings } from "../../webapp/app/shell/MailboxFilings";
import { MailboxSelfCheck } from "../../webapp/app/shell/MailboxSelfCheck";
import { goSettings } from "../../webapp/app/shell/routing";
import type { StorageFacts } from "../../webapp/app/shell/storage-state";
import { TodaysFrame } from "../../webapp/app/shell/TodaysFrame";
import type { TodaysNodes } from "../../webapp/app/shell/todays-inputs";
import { useTranslations } from "next-intl";
import type { EngineStatus } from "./bridge-fetch.js";
import { BUILD_SHA, BUILD_VERSION } from "./build-id.js";
import { CloudSuggest, type CloudSuggestProps } from "./CloudSuggest.js";
import { cloudSuggestWire } from "./cloud-suggest.js";
import { DefaultMailAsk, DefaultMailRow } from "./DesktopDefaultMail.js";
import { DesktopAbout } from "./DesktopAbout.js";
import { DesktopAiAccount } from "./DesktopAiAccount.js";
import { DesktopDevices } from "./DesktopDevices.js";
import { DesktopMailboxes, readMirrorFreshness } from "./DesktopMailboxes.js";
import { DesktopScreening } from "./DesktopScreening.js";
import { desktopPaneLabel, DesktopSettings } from "./DesktopSettings.js";
import { DesktopStorageNotice } from "./DesktopStorageNotice.js";
import { DesktopStorage, DesktopSubscription } from "./DesktopSubscription.js";
import { DesktopWebSection } from "./DesktopWebSection.js";
import { flavorOf, hostDoorFor, selfHostedServerOf, suggestDoorFor, type HostedSession } from "./doors.js";
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
import { LocalSuggest } from "./local-suggest.js";
import { desktopNotificationHost } from "./notify-host.js";
import { reuseSweepsOverBridge } from "./reuse-sweeps-wire.js";
import type { ReuseSweepLine } from "../../webapp/app/shell/reuse-sweeps";
import { useRecheckWhileShown, useSweepsAnswer } from "../../webapp/app/shell/ReuseSweepNotice";

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
  onUnread: (unread: number) => void;
  /** Load it now over the bridge (the gate's own door, where the deadline census reads it). */
  liveBody: LiveBodyWire;
  links: LinkSlot;
  connection: Signal<HostConnectionState | null>;
}

const entry = (name: FeatureEntry["name"], node: ReactNode, notice?: FeatureEntry["notice"]): FeatureEntry =>
  ({ name, render: () => node, ...(notice ? { notice } : {}) });

export function DesktopFrame(p: DesktopFrameProps) {
  /* What every browser shell hands the frame: made where the frame mounts, under the window's theme. */
  const frame = useTodaysSupplies(NONE);
  const { status, session, paired, hostLabel, freshness, storage, mayLinkOut, ai } = p;
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
      )),
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
      stageCard: entry("stageCard", p.firstRunOpen ? null : <DefaultMailAsk />),
      screener: entry("screener", <DesktopScreening door={status.mode ?? null} />),
      help: entry("help", null),
    };
    // The entries change with the door and what they draw; the callbacks above are stable.
  }, [status, session, paired, hostLabel, freshness, storage, mayLinkOut, p.sealFailed, p.firstRunOpen, p.scope, sweeps,
    onStatus, openOverlay, takeOver, setAi, withdrawManage, rereadAccess, recheckSweeps]);

  const draftReply = useMemo(() => draftReplyOverBridgeFor(status), [status]);
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
      screening: NONE,
      autoFiled: NONE,
      ownModelAutoSuggest: NONE,
      mailboxes: NONE,
    },
    features,
    notifications: desktopNotificationHost,
    frame,
    badge: p.onUnread,
    hostConnection: p.connection,
    linkIn: p.links,
  }), [p.engine, p.liveBody, status, session, p.sessionRefused, hostLabel, p.manageOffered, storage, mayLinkOut,
    p.takesMailLinks, p.scope, p.account, draftReply, p.firstRun, features, p.onUnread, p.connection, p.links, frame]);

  /* What today's views take that the contract does not carry: the Screener's own suggest control, by door, and the
     name of the desktop's pane. */
  const suggestDoor = suggestDoorFor(status, session);
  /* The hosted control's run is handed its two readers: bound here, where a hook may be called. */
  const tScreener = useTranslations("screener");
  const tAiRefusal = useTranslations("aiRefusal");
  const suggestText = useMemo(
    () => ({ screener: tScreener, aiRefusal: tAiRefusal }) as unknown as CloudSuggestProps["text"],
    [tScreener, tAiRefusal],
  );
  const todays = useMemo((): TodaysNodes => ({
    screenerSuggest: suggestDoor === "local"
      ? ({ senders, absorb }) => <LocalSuggest senders={senders} absorb={absorb} ai={ai} onConfigure={() => goSettings("desktop")} />
      : suggestDoor === "cloud"
        ? ({ senders, resuggestable, unanswered, absorb, absorbStanding }) => (
          <CloudSuggest senders={senders} resuggestable={resuggestable} unanswered={unanswered} absorb={absorb} absorbStanding={absorbStanding} text={suggestText} />
        )
        : NONE,
    desktopPane: { label: desktopPaneLabel() },
  }), [suggestDoor, ai, suggestText]);

  return <TodaysFrame host={host} todays={todays} />;
}

/** The sign-ins ohmail ended because an older copy used them again, as one notice with its one answer. */
function useSweepsNotice(sweeps: readonly ReuseSweepLine[], recheck: () => Promise<unknown>) {
  const t = useTranslations("settings");
  useRecheckWhileShown(true, recheck);
  const { shown, ok } = useSweepsAnswer(sweeps, reuseSweepsOverBridge);
  if (shown.length === 0) return [];
  return [{
    kind: "signInCopies" as const,
    title: t("reuseSweepsTitle", { count: shown.length }),
    acts: [{ label: t("reuseSweepsOk"), onPress: ok }] as const,
  }];
}
