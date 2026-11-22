"use client";

/**
 * THE WEB'S DOORS OF SETTINGS' SECTIONS, named once for the page's life: what only this host can hand a section of
 * the mail's Settings (`MailPaneParts`). The mail entry makes the sections' registrations itself; a host hands its
 * doors, as hooks, and nothing else.
 *
 * THE MAILBOXES SECTION: the second factor's dialog over the web's step-up door, for the presses the server asks it
 * for (a removal, an erasure, organizing here); the web has no calendar's half of a mailbox.
 *
 * THE ACCOUNT SECTION, the way out: who is signed in, sign this browser out, the way to the page that deletes the
 * account, and the way back to a live session (the session's door, `account-door.ts`); the password form's door
 * (`password-door.ts`) and the second factor's dialog over the web's step-up door, as the join page hands its form
 * the factor. The sentences of a sign-out that stayed are the pane's own.
 */
import { confirmedAccountForScope } from "@ohmail/app/host";
import { mirrorOwnerOf } from "@ohmail/app-logic/session/sync-scheduler";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { PaneBodyProps } from "@ohmail/app/settings";
import { BrowserFoldersPane, BrowserNotificationsPane, BrowserSignaturesPane } from "./browser-settings-panes";
import { BrowserSettingsAbove } from "./browser-settings-panes";
import { WebRulesPane } from "./WebRulesPane";
import { useText } from "@ohmail/app/text";
import { standingOf } from "./subscription-door";
import { accessFeedFor, onAccessFeed } from "../../api-client";
import { useFrame } from "@ohmail/app/frame";
import { useWriting } from "@ohmail/app/write";
import { HelpContactPane } from "./HelpContactPane";
import { QrCode } from "../../shell/QrCode";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { WebScreenerPane } from "./WebScreenerPane";
import { useProfileImportState } from "@ohmail/app/profile-import";
import { SavedProfileSection } from "../../shell/ProfileImportCard";
import { WebTagsPane } from "./WebTagsPane";
import { AboutSection } from "./AboutSection";
import { AiSection } from "./AiSection";
import { WebGeneralPane } from "./WebGeneralPane";
import { AwaySettings } from "@ohmail/app/settings/away";
import { useDevicesDoor, useDevicesWatch } from "./devices-door";
import { useStorageDoor } from "./storage-door";
import { useInvitesDoor } from "./invites-door";
import { useSecurityDoor } from "./security-door";
import { NONE } from "@ohmail/app/host";
import { NO_PANE_PARTS, type MailPaneParts } from "@ohmail/app/mail";
import type { AccountDoor, GatedAsk } from "@ohmail/app/account";
import { useAccountDoor } from "./account-door";
import { usePasswordDoor } from "./password-door";
import { StepUp } from "./StepUp";
import { captureFaceOwner, webRecover } from "./web-supplies";

/** The way to the sign-in page: the host's own way back to a live session. */
const toSignIn = (): void => webRecover("signIn");

/** The web's session door of the Account section: one door for the page's life. */
function useWebAccountDoor(): AccountDoor {
  return useAccountDoor(toSignIn);
}

function useSettingsOwner(): string | null {
  return confirmedAccountForScope(useFrame().host);
}

function useWebAccess() {
  const owner = useSettingsOwner();
  return useSyncExternalStore(onAccessFeed, () => accessFeedFor(owner), () => null)?.answer;
}

function useWebBillingSummary() {
  const access = useWebAccess();
  const t = useText("settings");
  const own = useText("accountSubscription");
  const standing = access?.metered ? standingOf(access.lifecycle) : null;
  if (standing?.state === "trial") {
    return { value: own("trial"), detail: standing.ends ? t("webPlanTrialEnds", { when: standing.ends }) : undefined };
  }
  if (standing?.state === "overdue") return { value: own("overdue"), hot: true };
  if (standing?.state === "grace") return { value: own("trialEnded"), hot: true };
  if (standing?.state === "active") return { value: own("active") };
  return null;
}

function useWebMailboxLimit() {
  const access = useWebAccess();
  return access?.metered ? access.mailboxes : null;
}

function useWebStorageDoor() {
  const { host } = useFrame();
  return useStorageDoor(mirrorOwnerOf(host.engine) ?? host.session.scope, confirmedAccountForScope(host));
}

function useWebDevicesDoor() {
  return useDevicesDoor(useSettingsOwner());
}

function useWebInvitesDoor() {
  return useInvitesDoor(useSettingsOwner());
}

function useWebSecurityDoor() {
  return useSecurityDoor(useSettingsOwner());
}

function SettingsFactor(ask: GatedAsk) {
  return <StepUp {...ask} expectedOwner={useSettingsOwner()} />;
}

const factor = (ask: GatedAsk) => <SettingsFactor {...ask} />;
const qr = (value: string, label: string) => <QrCode value={value} ariaLabel={label} />;

function WebAboutPane() {
  return <AboutSection owner={useSettingsOwner()} />;
}

function WebSubscriptionPane() {
  const { subscription } = useFrame().host.features;
  return subscription === NONE ? null : subscription.render();
}

function WebAiPane() {
  return <AiSection owner={useSettingsOwner()} />;
}

export function WebSettingsAbove({ children }: { readonly children: ReactNode }) {
  const { route, commands } = useFrame();
  useEffect(() => {
    // Saved Away links and the desktop browser door name the section in the query.
    const url = new URL(window.location.href);
    const sub = url.searchParams.get("settings");
    if (route.sub !== null || url.hash !== "#/settings" || (sub !== "away" && sub !== "devices")) return;
    commands.go({ place: "settings", sub }, { replace: true });
    if (window.location.hash === `#/settings/${sub}`) {
      url.hash = window.location.hash;
      url.searchParams.delete("settings");
      window.history.replaceState(window.history.state, "", url);
    }
  }, [commands, route.sub]);
  return <BrowserSettingsAbove>{children}</BrowserSettingsAbove>;
}

function WebHelpPane({ sheet }: Pick<PaneBodyProps, "sheet">) {
  const { host } = useFrame();
  const { writeSupport } = useWriting();
  const { mailboxes } = useMailState();
  const { version, commit, mailtoLeaves } = host.device.build;
  return (
    <HelpContactPane
      host={{ surface: "web", version, commit, mailtoLeaves, accountId: confirmedAccountForScope(host) }}
      sheet={sheet}
      mailboxes={liveMailboxes(mailboxes)}
      onWrite={host.features.places.write === NONE ? null : writeSupport ?? null}
    />
  );
}

export const WEB_PANE_PARTS: MailPaneParts = {
  ...NO_PANE_PARTS,
  general: () => <WebGeneralPane captureOwner={captureFaceOwner} />,
  about: WebAboutPane,
  ai: WebAiPane,
  billing: WebSubscriptionPane,
  useBillingSummary: useWebBillingSummary,
  help: WebHelpPane,
  rules: WebRulesPane,
  folders: BrowserFoldersPane,
  tags: WebTagsPane,
  screener: WebScreenerPane,
  notifications: BrowserNotificationsPane,
  signatures: BrowserSignaturesPane,
  mailboxes: { factor, calendar: NONE, savedSettings: SavedMailboxSettings, useLimit: useWebMailboxLimit },
  away: AwaySettings,
  devices: { useDoor: useWebDevicesDoor, useWatch: useDevicesWatch, factor, qr },
  storage: { useDoor: useWebStorageDoor, factor },
  invites: { useDoor: useWebInvitesDoor, factor, qr },
  security: { useDoor: useWebSecurityDoor, factor },
  account: {
    useDoor: useWebAccountDoor,
    password: { useDoor: usePasswordDoor, factor },
  },
};

function SavedMailboxSettings() {
  const state = useProfileImportState();
  const { host } = useFrame();
  const wire = host.wires.profileImport;
  if (state === null || wire === NONE || state.declined.length + state.unkept.length === 0) return null;
  return <SavedProfileSection rows={state.declined} unkept={state.unkept} actions={state.saved} />;
}
