/**
 * WHAT EVERY BROWSER HOST HANDS THE FRAME FOR MAIL, the same on the web, the desktop and the paired page: each mail
 * place that is seated on the ground and `none` for every other, Settings over the sections that are registered, the
 * mail's stages, the ground to stand above them, the address bar and the window as the browser has them, the look
 * the host stands under, the host's reader over the ground, and the host's way back.
 *
 * A place that is not seated yet is `none` here: it has no entry in the rail and no page, and an address that names
 * it lands on the Ohbox (the frame's rule). So is Settings over a host that hands no section's part. The phone hands
 * the frame its own supplies and picks from `mailPlaces()` by id.
 *
 * The browser's window is the host's to name (only a shell touches it), and it is read once per mount: the address
 * and the window's facts are made from the one handed first. The look is the host's to read too (its theme) and is
 * handed in as it stands now; the frame is told when it changes, and the record stays.
 *
 * WHAT A HOST ALONE CAN HAND is ONE record (`MailHostParts`), the hook's last argument: a host names it once, as a
 * constant of its own module, and keeps it for its page's life. It is read at the mount and never again, so nothing
 * made from it (the stages, Settings' sections, the reading column) is made a second time by a draw.
 */
import { createElement, useLayoutEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { PLACE_IDS, type FrameOvers, type FramePlaces, type PlaceEntry } from "../frame/contract.js";
import { browserWindowFacts, fragmentAddress } from "../host/browser/index.js";
import {
  createFeed,
  NONE,
  type Appearance,
  type FrameSupplies,
  type HostSession,
  type None,
  type ReaderEntry,
} from "../host/index.js";
import { keySheetOver } from "../keys/sheet/index.js";
import { paletteOver } from "../palette/index.js";
import type { SubjectRulePartProps } from "../screener/index.js";
import type { SettingsAbove } from "../settings/place.js";
import { MailGround } from "./MailGround.js";
import { mailSettings, type MailPaneParts } from "./panes.js";
import { mailPlaces, type MailPlaces } from "./places.js";
import { mailStages, type MailStageParts } from "./stages.js";

/**
 * THE HOST'S OWN PARTS, every one named: what differs by host and nothing else. A part a host does not have is `none`
 * inside its member, never a member left out. A new kind of part is a member here, never a further argument of
 * `useMailSupplies`.
 */
export interface MailHostParts {
  /** The host's reader over the ground (`mailReader`, made once at the host's module scope); `none`: no column. */
  readonly reader: ReaderEntry | None;
  /** What only this host can hand the mail's stages (`stages.ts`). */
  readonly stageParts: MailStageParts;
  /** What only this host can hand Settings' sections (`panes.ts`): its doors, `none` where it has none. */
  readonly paneParts: MailPaneParts;
  /** A host's provider shared by Settings' columns for the duration of a visit. */
  readonly settingsAbove?: SettingsAbove;
  /** The subject-rule sheet, where the host has the existing editor. */
  readonly subjectRule?: ComponentType<SubjectRulePartProps>;
  readonly contactScreening?: ReaderEntry["Screening"];
}

/** Every place by id: its own entry where it is seated, Settings where a section is registered, else `none`. */
function placesOf(settings: PlaceEntry | None): FramePlaces {
  const seated: MailPlaces = settings === NONE ? mailPlaces() : { ...mailPlaces(), settings };
  return Object.fromEntries(PLACE_IDS.map((id) => [id, seated[id] ?? NONE])) as FramePlaces;
}

const sameLook = (a: Appearance, b: Appearance): boolean =>
  a.face === b.face && a.scheme === b.scheme && a.layout === b.layout;

const MAIL_OVERS: FrameOvers = { palette: paletteOver, keys: keySheetOver };

export function useMailSupplies(
  browser: Window,
  look: Appearance,
  recover: HostSession["recover"],
  own: MailHostParts,
): FrameSupplies {
  const [made] = useState(() => {
    const { pathname, search, hash } = browser.location;
    // Desktop releases already in use send the pane in the query.
    if (
      pathname === "/mailbox" &&
      hash === "#/settings" &&
      new URLSearchParams(search).get("settings") === "mailboxes"
    ) {
      browser.history.replaceState(browser.history.state, "", pathname + search + "#/settings/mailboxes");
    }
    return {
      above: own.subjectRule
        ? ({ children }: { children: ReactNode }) =>
            createElement(MailGround, { subjectRule: own.subjectRule, children })
        : MailGround,
      places: placesOf(mailSettings(own.paneParts, own.settingsAbove)),
      stages: mailStages(own.stageParts),
      reader:
        own.reader !== NONE && own.contactScreening
          ? { ...own.reader, Screening: own.contactScreening }
          : own.reader,
      address: fragmentAddress(browser),
      window: browserWindowFacts(browser),
      appearance: createFeed<Appearance>(look, sameLook),
    };
  });
  useLayoutEffect(() => made.appearance.set(look), [made, look]);
  /* The calendar's entry is `none` until the switch of products is mounted: its line is that mount's. */
  return useMemo(() => ({ ...made, overs: MAIL_OVERS, calendar: NONE, recover }), [made, recover]);
}
