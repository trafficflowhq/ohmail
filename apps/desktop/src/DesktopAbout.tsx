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
import { DesktopUpdate } from "./DesktopUpdate.js";

/** What the two doors are called on screen. The same words the Desktop pane uses. */
const DOOR: Record<string, string> = {
  local: "Your own mail server",
  cloud: "An ohmail Cloud account",
};

export function DesktopAbout({ status }: { status: EngineStatus }) {
  return (
    <SettingsSection>
      <SettingsRow
        label="ohmail for desktop"
        description="The build running in this window."
        value={__OHMAIL_VERSION__}
      />
      <SettingsRow
        label="Published by"
        description="The company that writes and signs this app."
        value="TrafficFlow GmbH"
      />
      <SettingsRow
        label="Licence"
        description="Free software. The source of this app is published, and you may build it yourself."
        value="AGPL-3.0"
      />

      {/* THE APP'S OWN UPDATE, directly under the version it is about. It used to live only in
          the menu bar, which is not drawn on every desktop this app runs on
          (`src-tauri/src/frame.rs`) — so on those it was an affordance nobody could reach.
          `DesktopUpdate` is a subhead and one row and owns no layout: whoever restyles Settings
          next can move the element without rewiring anything, and it renders nothing at all
          where the shell answers nothing. */}
      <DesktopUpdate />

      <SettingsSubhead>This install</SettingsSubhead>

      <SettingsRow
        label="Mailbox"
        description="The mailbox this copy of ohmail organizes."
        value={status.address ?? "—"}
      />
      <SettingsRow
        label="Opened through"
        description={
          status.mode === "cloud"
            ? "A hosted account. The organizing happens on our servers and this app keeps a copy."
            : status.mode === "local"
              ? "This computer opens your mailbox directly. Nothing about your mail is sent to us."
              : "No mailbox has been chosen on this install yet."
        }
        value={status.mode ? (DOOR[status.mode] ?? status.mode) : "Not chosen"}
      />

      {/* THE CLAIM THE WHOLE PRODUCT RESTS ON, said where somebody looks for it. It is true on
          both doors and it is the reason leaving is cheap: the copy on this machine can be
          deleted without losing anything, because it was never the master. */}
      <SettingsNote>
        Your mail lives in your mailbox, on your own server. ohmail files it into folders there,
        where every other mail app you own can see them, and keeps a copy on this computer so the
        app is fast and works offline. Stop using ohmail and your mail is exactly where you left
        it.
      </SettingsNote>
      <SettingsNote>
        Privacy and the list of companies we rely on: ohmail.app/privacy and
        ohmail.app/subprocessors. Source: github.com/trafficflowhq/ohmail.
      </SettingsNote>
    </SettingsSection>
  );
}
