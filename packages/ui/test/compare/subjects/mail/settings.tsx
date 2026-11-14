import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { Avatar, Button, Field, InfoMark, RadioLines, Seg, Slot, Tag } from "../../../../src/base/index.js";
import {
  FigureLine,
  FigureTable,
  ScaleBar,
  SettingActs,
  LookPicture,
  RuleLine,
  SettingArea,
  SettingFilter,
  SettingLine,
  SettingNote,
  SettingsHead,
  SettingsSheet,
  SettingTile,
  SettingTiles,
  TagLine,
  type RowPerson,
} from "../../../../src/mail/index.js";
import { PAD, type KitSubject, type Look } from "../../harness.js";
import * as W from "./world.js";

/** A Settings pane's parts: its head on the ground, reaching over the column's ring as it does in the pane; a sheet as wide as the pane's column draws it. */
const head = (key: string, node: ReactNode): KitSubject => ({
  key,
  place: "block",
  target: ".oh-settingshead",
  render: () => <div style={{ padding: "0 var(--ringw)" }}>{node}</div>,
});
const sheet = (key: string, node: ReactNode | ((look: Look) => ReactNode)): KitSubject => ({
  key,
  place: "block",
  target: ".oh-sheet",
  render: (look) => (
    <div style={{ paddingTop: below(key, look) }}>{typeof node === "function" ? node(look) : node}</div>
  ),
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

/**
 * A sheet that stood lower in a phone's pane than the window holds it whole: the subject stands it at the same
 * height, so the window's foot cuts it where it cut the reference (what lay under the foot was read as nothing
 * there). Elsewhere it stands as `sheet` stands it.
 */
const tallSheet = (key: string, node: (look: Look) => ReactNode): KitSubject => ({
  key,
  place: "block",
  target: ".oh-sheet",
  render: (look) => {
    const file = new URL(
      `../../../reference/mail/${key}@${look.face}-${look.scheme}-${look.device}.json`,
      import.meta.url,
    );
    const { target } = JSON.parse(readFileSync(file, "utf8")) as { target: [number, number, number, number] };
    return (
      <div style={{ paddingTop: look.device === "phone" ? target[1] - PAD : below(key, look) }}>
        {node(look)}
      </div>
    );
  },
});

/** A part of a sheet, read alone where it stands on the pane's sheet, as wide as the sheet's lines. */
const part = (key: string, target: string, node: ReactNode): KitSubject => ({
  key,
  place: "block",
  on: "sheet",
  target,
  render: () => node,
});

const quiet = (word: string, icon?: "copy") => (
  <Button kind="quiet" size="s" icon={icon}>
    {word}
  </Button>
);

/** The rules of the invented world: who, where their mail goes, where the rule came from, and the sender when it is one. */
const RULES: [string, string, string, RowPerson?][] = [
  [W.GIULIA.address, "Ohbox", "Screener decision · 14 messages", W.GIULIA],
  ["makersfest.example", "Ohbox", "Whole domain · Screener decision"],
  ["lichtgrat.example", "Ohbox", "You wrote to them"],
  [
    "mara@skylarknotes.example",
    "News",
    "Screener decision",
    W.person("Skylark Notes", "mara@skylarknotes.example"),
  ],
  [W.ERDTON.address, "Receipts", "Suggestion", W.ERDTON],
  ["fashion-deals.example", "Screened out", "Whole domain · Screener decision"],
];

/** The tags of the invented world: name, hue, and how many messages carry it. */
const TAGS: [string, number, string][] = [
  ["Pottery Project", 150, "4 messages"],
  ["Paperwork", 78, "3 messages"],
  ["Adventures", 25, "2 messages"],
];

/** The Tags pane's sheet: each tag at rest (or the first being renamed), then the line that names a new one. */
const tags = (state: "rest" | "rename" | "taken") => (
  <SettingsSheet>
    {TAGS.map(([name, hue, count], i) =>
      state === "rename" && i === 0 ? (
        <TagLine
          key={name}
          hue={hue}
          field={{ label: "Name", value: name, onChange: () => undefined }}
          acts={
            <>
              <Button kind="two" size="s">
                Save
              </Button>
              {quiet("Cancel")}
            </>
          }
        />
      ) : (
        <TagLine
          key={name}
          hue={hue}
          name={name}
          colour={{ label: `Colour of ${name}` }}
          value={count}
          acts={
            <>
              {quiet("Rename")}
              {quiet("Delete")}
            </>
          }
        />
      ),
    )}
    <TagLine
      hue={150}
      field={{
        label: "New tag",
        value: state === "taken" ? "Paperwork" : "",
        placeholder: "Name a new tag",
        onChange: () => undefined,
      }}
      refusal={state === "taken" ? "You already have “Paperwork”." : undefined}
      acts={
        <Button kind="two" size="s">
          Add
        </Button>
      }
    />
  </SettingsSheet>
);

export const settings: KitSubject[] = [
  /* The three drawings of Storage and a sheet's own acts, each as it stands on its sheet. */
  {
    key: "FigureLine/rest",
    place: "block",
    on: "sheet",
    target: ".oh-figureline",
    render: () => (
      <FigureLine figure="235 MB" of="of 5 GB · trial" info={<InfoMark label="About storage" />} />
    ),
  },
  {
    key: "ScaleBar/rest",
    place: "block",
    on: "sheet",
    target: ".oh-scalebar-bar",
    render: () => (
      <ScaleBar
        label="235 MB of 5 GB"
        parts={[{ share: 3.96 }, { share: 0.74, kind: "second" }]}
        marks={[{ at: 100 }]}
      />
    ),
  },
  {
    key: "FigureTable/rest",
    place: "block",
    on: "sheet",
    target: ".oh-figuretable",
    render: () => (
      <FigureTable
        columns={["Mailbox", "Messages", "Kept now", "Expected"]}
        rows={[
          { id: "a", name: "mila@lichtgrat.example", hue: 28, figures: ["7,912", "198 MB", "198 MB"] },
          { id: "b", name: "hello@milabrunner.example", hue: 210, figures: ["1,494", "37 MB", "37 MB"] },
        ]}
        sum={{ name: "Total", figures: ["9,406", "235 MB", "235 MB"] }}
      />
    ),
  },
  {
    key: "SettingActs/rest",
    place: "block",
    on: "sheet",
    target: ".oh-settingacts",
    render: () => (
      <SettingActs>
        <Button kind="quiet" size="s" icon="copy">
          Copy the link
        </Button>
        <Button kind="two" size="s">
          Revoke
        </Button>
      </SettingActs>
    ),
  },
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
  tallSheet("SettingsSheet/look", (look) => {
    /* General's Appearance sheet: the page's own face is the one chosen, both pictures in the page's scheme. */
    const sample = [
      { who: W.GIULIA.name, address: W.GIULIA.address, time: "09:12" },
      { who: W.PETRA.name, address: W.PETRA.address, time: "08:47" },
    ] as const;
    return (
      <SettingsSheet title="Appearance">
        <SettingLine label="Theme">
          <Seg
            label="Theme"
            options={[
              { value: "light", label: "Light" },
              { value: "auto", label: "Auto" },
              { value: "dark", label: "Dark" },
            ]}
            value={look.scheme}
          />
        </SettingLine>
        <SettingLine label="Look" narrow="under">
          <Seg
            label="Look applies on"
            options={[
              { value: "all", label: "All devices" },
              { value: "this", label: "This device" },
            ]}
            value="all"
          />
        </SettingLine>
        <SettingTiles label="Look">
          <SettingTile name="oh" on={look.face === "paper"}>
            <LookPicture face="paper" scheme={look.scheme} title="Ohbox" rows={sample} />
          </SettingTile>
          <SettingTile name="ohmarchy" tag="follows Omarchy" on={look.face === "ohmarchy"}>
            <LookPicture face="ohmarchy" scheme={look.scheme} title="Ohbox" rows={sample} />
          </SettingTile>
        </SettingTiles>
        <SettingLine label="Text size" narrow="under">
          <Seg
            label="Text size"
            options={["90", "100", "110", "125", "150"].map((v) => ({ value: v, label: `${v}%` }))}
            value="100"
          />
        </SettingLine>
      </SettingsSheet>
    );
  }),
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
  /* The plans with their prices: how they are billed is the sheet's own choice, at its head's end. */
  sheet(
    "SettingsSheet/aside-seg",
    <SettingsSheet
      title="Plans"
      aside={
        <Seg
          label="Billing"
          value="month"
          options={[
            { value: "month", label: "Monthly" },
            { value: "year", label: "Yearly" },
          ]}
        />
      }
    >
      <RadioLines
        label="Plans"
        value="plus"
        options={[
          { value: "solo", label: "Solo", note: "2 mailboxes · 1,000 credits · 2 GB", figure: "$9" },
          {
            value: "plus",
            label: "Plus",
            tag: "Your plan",
            note: "5 mailboxes · 2,000 credits · 5 GB",
            figure: "$15",
          },
          { value: "pro", label: "Pro", note: "10 mailboxes · 4,000 credits · 10 GB", figure: "$29" },
        ]}
      />
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
  part(
    "SettingNote/plain",
    ".oh-settingnote",
    <SettingNote>Only Screen out and Spam, at 90% or more.</SettingNote>,
  ),
  part(
    "SettingNote/warn",
    ".oh-settingnote",
    /* It stands on a sheet that wants the person: the sheet's tint. */
    <div style={{ display: "flow-root", padding: "var(--s4) 0", background: "var(--sheet-new)" }}>
      <SettingNote warn>
        You have no unused recovery codes. Without them, losing your authenticator locks you out.
      </SettingNote>
    </div>,
  ),
  sheet(
    "SettingsSheet/area",
    <SettingsSheet title="Ohbox">
      <SettingLine label="Keep my Ohbox for what’s relevant" toggle={{ on: true }} />
      <SettingLine label="File impersonations to Spam" toggle={{ on: true }} />
      <SettingArea
        label="In your words, what belongs in your Ohbox"
        value={W.OHBOX_WORDS}
        onChange={() => undefined}
      />
    </SettingsSheet>,
  ),
  sheet("SettingsSheet/filter", (look) => (
    <SettingsSheet>
      <Field
        label="Search by sender or domain"
        placeholder="Search by sender or domain"
        value=""
        onChange={() => undefined}
        bare
        sign="search"
      />
      <SettingFilter
        label={look.device === "desktop" ? undefined : "Files into"}
        act={quiet("Revoke all 6 matching")}
      >
        {look.device === "desktop" ? (
          <Seg
            label="Files into"
            options={["All", "Ohbox", "News", "Receipts", "Screened out"].map((p) => ({
              value: p,
              label: p,
            }))}
            value="All"
          />
        ) : (
          <Slot label="Files into">All</Slot>
        )}
      </SettingFilter>
    </SettingsSheet>
  )),
  sheet(
    "SettingsSheet/rules",
    <SettingsSheet>
      {RULES.map(([who, place, origin, sender]) => (
        <RuleLine
          key={who}
          who={who}
          person={sender ? { ...sender, label: sender.name, onContact: () => undefined } : undefined}
          goes={
            <>
              goes to <Slot label={`Goes to ${place}`}>{place}</Slot>
            </>
          }
          origin={origin}
          act={quiet("Revoke")}
        />
      ))}
    </SettingsSheet>,
  ),
  sheet("SettingsSheet/tags", tags("rest")),
  sheet("SettingsSheet/tags-rename", tags("rename")),
  sheet("SettingsSheet/tags-taken", tags("taken")),
];
