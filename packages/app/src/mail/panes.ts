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
import { useMailState } from "@ohmail/app-logic/mail-state";
import { accountPane, type AccountPaneParts } from "../account/account/pane.js";
import type { PlaceEntry, PlaceRail } from "../frame/contract.js";
import { useFrame } from "../frame/index.js";
import { NONE, type HostContract, type None } from "../host/index.js";
import { mailboxesPane, type MailboxesParts } from "../mailboxes/pane/pane.js";
import type { PaneId, SettingsBeside, SettingsPanes } from "../settings/contract.js";
import { paneOf } from "../settings/facts.js";
import { menuOf } from "../settings/menu.js";
import { settingsPlace } from "../settings/place.js";

/** What a host alone can hand the mail's panes, by pane: `none` where it has nothing of that section to hand. */
export interface MailPaneParts {
  readonly mailboxes: MailboxesParts | None;
  readonly account: AccountPaneParts | None;
}

/** The mail's panes over one host's parts. Call it once per mount: a registration made again is a pane mounted again. */
export function mailPanes(parts: MailPaneParts): SettingsPanes {
  return {
    general: NONE,
    notifications: NONE,
    mailboxes:
      parts.mailboxes === NONE
        ? NONE
        : paneOf("mailboxes", mailboxesPane({ ...parts.mailboxes, mailState: useMailState })),
    screener: NONE,
    ai: NONE,
    away: NONE,
    rules: NONE,
    tags: NONE,
    folders: NONE,
    signatures: NONE,
    desktop: NONE,
    devices: NONE,
    billing: NONE,
    storage: NONE,
    invites: NONE,
    security: NONE,
    account: parts.account === NONE ? NONE : accountPane(parts.account),
    about: NONE,
    help: NONE,
  };
}

/** The way between sections: the frame's address, through the frame's own command. No link's section is kept here. */
function useSettingsBeside(): SettingsBeside {
  const { commands } = useFrame();
  return useMemo(
    () => ({ go: (pane) => commands.go({ place: "settings", sub: pane }), startAt: null }),
    [commands],
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

/** The sections each Settings place made here was made over, by the place itself: what its menu can list. */
const MADE = new WeakMap<PlaceEntry, SettingsPanes>();

/** The mail's Settings place over one host's parts, or `none` where no section is registered. Once per mount. */
export function mailSettings(parts: MailPaneParts): PlaceEntry | None {
  const panes = mailPanes(parts);
  if (Object.values(panes).every((pane) => pane === NONE)) return NONE;
  const place: PlaceEntry = { ...settingsPlace(panes, useSettingsBeside), rail: RAIL };
  MADE.set(place, panes);
  return place;
}

/**
 * WHERE A WAY INTO SETTINGS LEADS ON THIS HOST, for a part of the ground that names a section (the rail's foot names
 * Mailboxes): that section where the host's menu lists it, else the first section the menu does list, so a press
 * never opens a section that is not there or a Settings with nothing drawn. Null where the host hands no Settings,
 * or one that was not made here: nothing is known of its sections then.
 */
export function settingsSection(host: HostContract, asked: PaneId): PaneId | null {
  const place = host.features.places.settings;
  const panes = place === NONE ? undefined : MADE.get(place);
  if (panes === undefined) return null;
  const menu = menuOf(host, panes);
  return (menu.find((pane) => pane.id === asked) ?? menu[0])?.id ?? null;
}
