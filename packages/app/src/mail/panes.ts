/**
 * THE MAIL'S SETTINGS, ONE RECORD OF PANES FOR EVERY HOST: the registration of each section, by its id, and the place
 * that draws them. A shell that shows mail takes its Settings from here, as it takes its places from `mailPlaces()`
 * and its stages from `mailStages()`.
 *
 * THE RECORD IS TOTAL: every section of the menu has its line, its registration or `none`. A section that is `none`
 * is in no menu and has no page; its address shows the section that stands for none. A forgotten id does not compile.
 *
 * A PANE ADDS ONE LINE, and its shape is one of two:
 * - a pane that reads the ground alone: `<id>: <pane>Pane,` (a registration its own folder exports);
 * - a pane that needs what only a host can hand (a door, a slot): its folder types `<Pane>PaneParts` and exports
 *   `<pane>Pane(parts)`; `MailPaneParts` gains `<id>: <Pane>PaneParts | None`, and the line is
 *   `<id>: parts.<id> === NONE ? NONE : <pane>Pane(parts.<id>),`. A host names that member in the one record of its
 *   own parts (`MailHostParts.paneParts`), `none` where it has no such door.
 * Nothing else of this file moves for a pane, and no host lists, orders or changes one.
 *
 * THE WAY BETWEEN SECTIONS is the frame's address, here and nowhere else: a section is `#/settings/<id>`, the menu
 * `#/settings`. A pane that holds a leave (an edit not saved) is asked through this one way; none does yet.
 *
 * THE PLACE STANDS ONLY WHERE A SECTION IS REGISTERED: over a host that hands no pane's part there is no Settings in
 * the rail and no page, and its address leads to the Ohbox (the frame's rule), never to an empty menu.
 */
import { useMemo } from "react";
import { useConsent } from "@ohmail/app-logic/consent";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { accountPane, type AccountPaneParts } from "../account/account/pane.js";
import { devicesPane, type DevicesPaneParts } from "../account/devices/pane.js";
import { invitesPane, type InvitesPaneParts } from "../account/invites/pane.js";
import { securityPane, type SecurityPaneParts } from "../account/security/pane.js";
import { storagePane, type StoragePaneParts } from "../account/storage/pane.js";
import type { PlaceEntry, PlaceRail } from "../frame/contract.js";
import { useFrame } from "../frame/index.js";
import { NONE, type None } from "../host/index.js";
import { mailboxesPane, type MailboxesParts } from "../mailboxes/pane/pane.js";
import { useProfileImportState } from "../profile-import/ground.js";
import { SavedProfileSettings } from "../profile-import/SavedProfileSettings.js";
import type { SettingsBeside, SettingsPane, SettingsPanes } from "../settings/contract.js";
import { paneOf } from "../settings/facts.js";
import { useFoldersSummary, useSignaturesSummary } from "../settings/consent-summary.js";
import { useAwaySummary } from "../settings/away/summary.js";
import { useRulesSummary } from "../settings/rules/summary.js";
import { rememberSettingsMenu } from "../settings/menu.js";
import { lazyView } from "../frame/lazy-view.js";
import { settingsPlaceWith, type SettingsAbove } from "../settings/place-with.js";

const SettingsList = lazyView(() =>
  import("../settings/place.js").then(({ SettingsList }) => ({ default: SettingsList })),
);
const SettingsReading = lazyView(() =>
  import("../settings/SettingsReading.js").then(({ SettingsReading }) => ({ default: SettingsReading })),
);

/** What a host alone can hand the mail's panes, by pane: `none` where it has nothing of that section to hand. */
export interface MailPaneParts {
  readonly screener: SettingsPane["Body"] | None;
  readonly ai: SettingsPane["Body"] | None;
  readonly help: SettingsPane["Body"] | None;
  readonly general: SettingsPane["Body"] | None;
  readonly notifications: SettingsPane["Body"] | None;
  readonly rules: SettingsPane["Body"] | None;
  readonly tags: SettingsPane["Body"] | None;
  readonly about: SettingsPane["Body"] | None;
  readonly mailboxes: MailboxesParts | None;
  readonly desktop: SettingsPane["Body"] | None;
  readonly devices: DevicesPaneParts | SettingsPane["Body"] | None;
  readonly invites: InvitesPaneParts | None;
  readonly security: SecurityPaneParts | None;
  readonly billing: SettingsPane["Body"] | None;
  readonly storage: StoragePaneParts | SettingsPane["Body"] | None;
  readonly away: SettingsPane["Body"] | None;
  readonly folders: SettingsPane["Body"] | None;
  readonly signatures: SettingsPane["Body"] | None;
  readonly account: AccountPaneParts | None;
}

/** A host starts with no sections and supplies the doors it can actually open. */
export const NO_PANE_PARTS: MailPaneParts = {
  screener: NONE,
  ai: NONE,
  help: NONE,
  general: NONE,
  notifications: NONE,
  rules: NONE,
  tags: NONE,
  about: NONE,
  mailboxes: NONE,
  desktop: NONE,
  devices: NONE,
  invites: NONE,
  security: NONE,
  billing: NONE,
  storage: NONE,
  away: NONE,
  folders: NONE,
  signatures: NONE,
  account: NONE,
};

/** The mail's panes over one host's parts. Call it once per mount: a registration made again is a pane mounted again. */
export function mailPanes(parts: MailPaneParts): SettingsPanes {
  function useAboutSummary() {
    const version = useFrame().host.device.build.version;
    return version === null ? null : { value: version };
  }
  return {
    general: parts.general === NONE ? NONE : paneOf("general", { Body: parts.general }),
    notifications:
      parts.notifications === NONE ? NONE : paneOf("notifications", { Body: parts.notifications }),
    mailboxes:
      parts.mailboxes === NONE
        ? NONE
        : paneOf("mailboxes", mailboxesPane({ ...parts.mailboxes, mailState: useMailState })),
    screener: parts.screener === NONE ? NONE : paneOf("screener", { Body: parts.screener }),
    ai: parts.ai === NONE ? NONE : paneOf("ai", { Body: parts.ai }),
    away: parts.away === NONE ? NONE : paneOf("away", { Body: parts.away, useSummary: useAwaySummary }),
    rules: parts.rules === NONE ? NONE : paneOf("rules", { Body: parts.rules, useSummary: useRulesSummary }),
    tags: parts.tags === NONE ? NONE : paneOf("tags", { Body: parts.tags }),
    folders:
      parts.folders === NONE
        ? NONE
        : paneOf("folders", { Body: parts.folders, useSummary: useFoldersSummary }),
    signatures:
      parts.signatures === NONE
        ? NONE
        : paneOf("signatures", { Body: parts.signatures, useSummary: useSignaturesSummary }),
    desktop: parts.desktop === NONE ? NONE : paneOf("desktop", { Body: parts.desktop }),
    devices:
      parts.devices === NONE
        ? NONE
        : typeof parts.devices === "function"
          ? paneOf("devices", { Body: parts.devices })
          : devicesPane(parts.devices),
    billing: parts.billing === NONE ? NONE : paneOf("billing", { Body: parts.billing }),
    storage:
      parts.storage === NONE
        ? NONE
        : typeof parts.storage === "function"
          ? paneOf("storage", { Body: parts.storage })
          : storagePane(parts.storage),
    invites: parts.invites === NONE ? NONE : invitesPane(parts.invites),
    security: parts.security === NONE ? NONE : securityPane(parts.security),
    account: parts.account === NONE ? NONE : accountPane(parts.account),
    about: parts.about === NONE ? NONE : paneOf("about", { Body: parts.about, useSummary: useAboutSummary }),
    help: parts.help === NONE ? NONE : paneOf("help", { Body: parts.help }),
  };
}

/** The way between sections: the frame's address, through the frame's own command. No link's section is kept here. */
function useSettingsBeside(): SettingsBeside {
  const { commands, route } = useFrame();
  const place = route.place === "calsettings" ? "calsettings" : "settings";
  return useMemo(
    () => ({ go: (pane) => commands.go({ place, sub: pane }), startAt: null }),
    [commands, place],
  );
}

/** Settings in the rail: last of the last group, as the demo's rail has it, with its chord. */
const RAIL: PlaceRail = {
  group: "more",
  icon: "settings",
  label: "title",
  keyHint: "g ,",
  keyLabel: "goSettings",
};

const SAVED_MAILBOXES = { ...paneOf("mailboxes", { Body: SavedProfileSettings }), listed: () => true };

/** The mail's Settings place over one host's parts, or `none` where no section is registered. Once per mount. */
export function mailSettings(parts: MailPaneParts, Above?: SettingsAbove): PlaceEntry | None {
  const panes = mailPanes(parts);
  if (Object.values(panes).every((pane) => pane === NONE)) return NONE;
  const withoutFolders = { ...panes, folders: NONE } as const;
  function useAccountPanes() {
    const saved = useProfileImportState();
    const available = useConsent().foldersStorable ? panes : withoutFolders;
    if (parts.mailboxes === NONE && saved && (saved.declined.length > 0 || saved.unkept.length > 0)) {
      return { ...available, mailboxes: SAVED_MAILBOXES };
    }
    return available;
  }
  const sections = parts.folders === NONE && parts.mailboxes !== NONE ? panes : useAccountPanes;
  const place: PlaceEntry = {
    ...settingsPlaceWith(sections, useSettingsBeside, Above, SettingsList, SettingsReading),
    rail: RAIL,
  };
  rememberSettingsMenu(place, panes);
  return place;
}
