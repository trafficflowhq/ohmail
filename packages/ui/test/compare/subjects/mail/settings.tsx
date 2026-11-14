import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { Avatar, Button, Seg, Slot, Tag } from "../../../../src/base/index.js";
import { SettingLine, SettingsHead, SettingsSheet } from "../../../../src/mail/index.js";
import type { KitSubject, Look } from "../../harness.js";
import * as W from "./world.js";

/** A Settings pane's parts: its head on the ground, reaching over the column's ring as it does in the pane; a sheet as wide as the pane's column draws it. */
const head = (key: string, node: ReactNode): KitSubject => ({
  key,
  place: "block",
  target: ".oh-settingshead",
  render: () => <div style={{ padding: "0 var(--ringw)" }}>{node}</div>,
});
const sheet = (key: string, node: ReactNode): KitSubject => ({
  key,
  place: "block",
  target: ".oh-sheet",
  render: (look) => <div style={{ paddingTop: below(key, look) }}>{node}</div>,
});

/**
 * Where the pane's sheet stood a fraction of a pixel down its scrolled column, the subject stands it on the
 * same fraction. Left to the harness, the fraction is set by moving the whole page, and a block as wide as
 * a phone's column then stands past the window's edge.
 */
function below(key: string, look: Look): number {
  const file = new URL(
    `../../../reference/mail/${key}@${look.face}-${look.scheme}-${look.device}.json`,
    import.meta.url,
  );
  const { target } = JSON.parse(readFileSync(file, "utf8")) as { target: [number, number, number, number] };
  /* The data file keeps four places; a box stands on 64ths of a pixel. */
  return Math.round((target[1] - Math.floor(target[1])) * 64) / 64;
}

const quiet = (word: string, icon?: "copy") => (
  <Button kind="quiet" size="s" icon={icon}>
    {word}
  </Button>
);

export const settings: KitSubject[] = [
  head("SettingsHead/rest", <SettingsHead title="Notifications" />),
  head("SettingsHead/hot", <SettingsHead title="Notifications" hot />),
  head("SettingsHead/count", <SettingsHead title="Devices" count="2" />),
  sheet(
    "SettingsSheet/lines",
    <SettingsSheet title="Notify about">
      <SettingLine label="New mail in Ohbox" toggle={{ on: true }} />
      <SettingLine label="A new sender is waiting" toggle={{ on: true }} />
      <SettingLine label="A scheduled message was sent" toggle={{ on: true }} />
      <SettingLine label="A device paired or was signed out" toggle={{ on: false }} />
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/wants",
    <SettingsSheet wants={{ word: "Blocked", line: "In this device’s system settings." }}>
      <SettingLine label="Notify me on this device" tag="This device" toggle={{ on: true }} off />
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/choice",
    <SettingsSheet>
      <SettingLine label="Language">
        <Seg
          label="Language"
          options={[
            { value: "en", label: "English" },
            { value: "de", label: "Deutsch" },
          ]}
          value="en"
        />
      </SettingLine>
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/sign",
    <SettingsSheet title="ohmail on Linux" sign="desktop" aside={<Tag>This computer</Tag>}>
      <SettingLine label="Connected through" value="ohmail Cloud" />
      <SettingLine label="Mailboxes" value="2 · reader" />
      <SettingLine label="Connection" value="Reachable · 09:24" />
      <SettingLine label="Mail engine" value="Running" />
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/person",
    <SettingsSheet title={W.ME.name} person={W.ME} aside={<Tag>ohmail Cloud</Tag>}>
      <SettingLine label="Signed in as" value={W.ME.address} />
      <SettingLine label="Password">{quiet("Change password")}</SettingLine>
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/aside",
    <SettingsSheet title="Diagnostics" aside={quiet("Copy", "copy")}>
      <SettingLine label="App" value="1.0.11 · build aa2b412" />
      <SettingLine label="Platform" value="Linux" />
      <SettingLine label="Mailbox" value="IMAP" />
      <SettingLine label="Last sync error" value="Mailbox full" />
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/slot",
    <SettingsSheet title="Model" aside={<Tag>Working</Tag>}>
      <SettingLine label="Where the model runs" narrow="under" onPress={() => undefined}>
        <Slot>ohmail Cloud</Slot>
      </SettingLine>
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/sub",
    <SettingsSheet>
      <SettingLine label="Use AI for suggestions and drafts" toggle={{ on: true }} />
      <SettingLine label="Draft reply" toggle={{ on: true }} sub />
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/lead",
    <SettingsSheet>
      <SettingLine label="Use folders" toggle={{ on: true }} />
      {[W.ME.address, "hello@milabrunner.example"].map((address) => (
        <SettingLine
          key={address}
          label={address}
          lead={<Avatar name={address} address={address} size="s" />}
          toggle={{ on: true }}
        />
      ))}
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/under",
    <SettingsSheet>
      <SettingLine label="What happens to your mail" narrow="under">
        {quiet("Privacy")}
        {quiet("Subprocessors")}
        {quiet("Imprint")}
      </SettingLine>
    </SettingsSheet>,
  ),
  sheet(
    "SettingsSheet/detail",
    <SettingsSheet title="Signed in" aside="2">
      <SettingLine
        label="ohmail on Linux"
        icon="desktop"
        tag="This computer"
        value="Linux · Reader"
        narrow="detail"
      />
      <SettingLine label="ohmail on a phone" icon="phone" value="Android · Reader" narrow="detail">
        {quiet("Sign out")}
      </SettingLine>
      <SettingLine label="2 other web sessions" icon="desktop">
        {quiet("Sign out all")}
      </SettingLine>
    </SettingsSheet>,
  ),
];
