/**
 * SETTINGS → ABOUT, on the desktop — who publishes this, which build is running, and where the
 * mail actually lives.
 *
 * The shared client's About pane is injected by whoever mounts the shell, because the facts in it
 * differ by surface: the hosted client reads its account's mailbox list and names the operator of
 * the hosted service. Neither is right here. A standalone install has no account, and the operator
 * of a service you are not using is not the answer to "who published the app in front of me". So
 * the pane was absent on the desktop entirely — and it is the one screen in the product whose whole
 * job is to answer the questions somebody asks before trusting an app with their mail.
 *
 * Everything here is a FACT the window already holds or a constant compiled into it. Nothing is
 * fetched, because nothing needs to be: the version comes from the manifest at build time, the
 * mailbox and the door come from the status the shell already answered with, and the rest is the
 * licence and the addresses, which do not vary.
 */

import { SettingsNote, SettingsRow, SettingsSection, SettingsSubhead } from "@ohmail/ui";

import type { EngineStatus } from "./bridge-fetch.js";
import { BUILD_LABEL } from "./build-id.js";
import { DOOR_COPY, machineWord } from "./door-copy.js";
import { hostLabelOf, isDesktopHost } from "./doors.js";
import { DesktopUpdate } from "./DesktopUpdate.js";

/* WHAT THIS INSTALL DOES WITH THE MAILBOX BELOW — "organizes" or "reads". One rule, two
   panes and one confirmation bullet; see `install-role.ts` for the measured defect and
   why the predicate is the shared one. `useMailboxFacts` is the NON-throwing accessor,
   so a pane mounted without the provider keeps the sentence it always had. */
import { useMailboxFacts } from "../../webapp/app/shell/MailStateProvider";
import { readerHolder, screenerMode } from "../../webapp/app/shell/mail-state";
import { mailboxRowWhy } from "./install-role.js";

export function DesktopAbout({ status }: { status: EngineStatus }) {
  const readOnly = readerHolder(screenerMode(useMailboxFacts()));
  /* What the two doors are called on screen — the same words the Desktop pane uses. Resolved
     inside the render rather than held as a module constant, because both halves are catalogue
     reads now and a constant would freeze whichever locale happened to be set when this module
     was first imported. */
  const door: Record<string, string> = {
    local: DOOR_COPY.aboutDoorLocalValue,
    cloud: DOOR_COPY.aboutDoorCloudValue,
  };
  /* THE OTHER COMPUTER, when this install reads through one. Both the value and its sentence
     change: "An ohmail Cloud account · the organizing happens on our servers" names a service
     that has nothing to do with this install. */
  const host = hostLabelOf(status.baseUrl);
  const paired = isDesktopHost(status) && host !== null;
  return (
    <SettingsSection>
      <SettingsRow
        label={DOOR_COPY.aboutAppLabel}
        description={DOOR_COPY.aboutAppWhy}
        value={BUILD_LABEL}
      />
      <SettingsRow
        label={DOOR_COPY.aboutPublisher}
        description={DOOR_COPY.aboutPublisherWhy}
        value="TrafficFlow GmbH"
      />
      <SettingsRow
        label={DOOR_COPY.aboutLicence}
        description={DOOR_COPY.aboutLicenceWhy}
        value="AGPL-3.0"
      />

      {/* THE APP'S OWN UPDATE, directly under the version it is about. It used to live only in
          the menu bar, which is not drawn on every desktop this app runs on
          (`src-tauri/src/frame.rs`) — so on those it was an affordance nobody could reach.
          `DesktopUpdate` is a subhead and one row and owns no layout: whoever restyles Settings
          next can move the element without rewiring anything, and it renders nothing at all
          where the shell answers nothing. */}
      <DesktopUpdate />

      <SettingsSubhead>{DOOR_COPY.aboutInstallHead}</SettingsSubhead>

      <SettingsRow
        label={DOOR_COPY.mailboxLabel}
        description={mailboxRowWhy(readOnly, paired ? host : null)}
        value={status.address ?? "—"}
      />
      <SettingsRow
        label={DOOR_COPY.aboutOpenedThrough}
        description={
          paired
            /* "Nothing about your mail is sent to us" IS THE CONTROL for the privacy invariant on
               this door, and it is stated on the pane rather than only in a test: a paired
               install's engine dials one origin — the one on the pairing link — and never the
               hosted service. If that stops being true this sentence is the first false thing
               here, which is why it is said where somebody looks for it. */
            ? DOOR_COPY.aboutDoorHostWhy(host, machineWord())
            : status.mode === "cloud"
              ? DOOR_COPY.aboutDoorCloudWhy
              : status.mode === "local"
                ? DOOR_COPY.aboutDoorLocalWhy
                : DOOR_COPY.doorNoneWhy
        }
        value={
          paired
            ? DOOR_COPY.aboutDoorHostValue
            : status.mode ? (door[status.mode] ?? status.mode) : DOOR_COPY.doorNotChosen
        }
      />

      {/* THE CLAIM THE WHOLE PRODUCT RESTS ON, said where somebody looks for it. It is true on
          both doors and it is the reason leaving is cheap: the copy on this machine can be
          deleted without losing anything, because it was never the master. */}
      <SettingsNote>{DOOR_COPY.aboutMailNote}</SettingsNote>
      {/* THE SUBPROCESSOR LIST IS ABOUT THE HOSTED SERVICE, so it is named on the door that uses
          one and not on the other. On the local door this computer opens the mail server itself
          and nothing about the mail reaches us — so there is no company in that path for the list
          to describe, and pointing at it offers to explain a policy that does not govern the
          install being read. The same argument `AboutSection` makes for a self-host build. Privacy
          and the source stay on both doors: the first governs the app itself, the second is what
          lets anyone check either claim. */}
      <SettingsNote>
        {/* THE SUBPROCESSOR LIST GOES WITH THE HOSTED DOOR AND NOT WITH THIS ONE, on exactly the
            argument the local door already makes: there is no company in a paired install's mail
            path for that list to describe, so pointing at it would offer to explain a policy that
            does not govern the install being read. */}
        {status.mode === "cloud" && !paired ? DOOR_COPY.aboutLinksCloud : DOOR_COPY.aboutLinksLocal}
      </SettingsNote>
    </SettingsSection>
  );
}
