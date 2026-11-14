import type { ReactNode } from "react";
import {
  BlockedImages,
  DesignedLetter,
  FileNotArrived,
  Files,
  FileTile,
  LetterColumns,
  LetterHistory,
  LetterQuote,
  LetterViews,
  Message,
  MessageHead,
  TextNotKept,
  type LetterView,
  type MessageHeadProps,
} from "../../../../src/mail/index.js";
import type { KitSubject, Look } from "../../harness.js";
import * as W from "./world.js";

const shut = () => {};
/** A part of a letter stands on a read message's sheet. */
const onSheet = (node: ReactNode) => (
  <div style={{ ["--oh-soft" as string]: "var(--soft-sheet)", ["--oh-under" as string]: "var(--sheet)" }}>
    {node}
  </div>
);
const part = (key: string, target: string, render: (look: Look) => ReactNode): KitSubject => ({
  key,
  place: "block",
  on: "sheet",
  target,
  render: (look) => onSheet(render(look)),
});

const tracker = { caption: "Tracker blocked", sentence: "A tracking pixel was blocked." };
const chip = (open: boolean) => <BlockedImages {...tracker} open={open} onOpen={shut} onClose={shut} />;
const head = (more: Partial<MessageHeadProps>): MessageHeadProps => ({
  sender: W.person("Drehscheibe", "brief@drehscheibe-magazin.example"),
  menu: { label: "Message" },
  stamp: { when: "06:40", full: false, title: "Full dates" },
  to: [{ word: "to", people: [{ name: "you" }] }],
  details: { label: "details", open: false, lines: [] },
  ...more,
});

const storageFull = {
  label: "Text on your mail server",
  line: "Your storage is full, so Cloud does not keep this letter's text.",
  more: { label: "Storage" },
  fine: "It loads for this view only and is not stored.",
};
const kept = (state: string, props: object): KitSubject =>
  part(`TextNotKept/${state}`, ".oh-notkept", () => <TextNotKept kind="kept" {...storageFull} {...props} />);

const recipes = (
  <FileTile
    kind="PDF"
    name="glaze-recipes.pdf"
    size="240 KB"
    main={{ label: "Preview glaze-recipes.pdf" }}
    save={{ label: "Download glaze-recipes.pdf" }}
  />
);
const film = (
  <FileNotArrived kind="MOV" name="kiln-room.mov" state="large" line="212 MB, too large to fetch" />
);
const files = (state: string, plan: ReactNode): KitSubject =>
  part(`FileNotArrived/${state}`, ".oh-files", () => (
    <Files summary="3 attachments">
      {recipes}
      {plan}
      {film}
    </Files>
  ));

const history = (state: string, open: boolean): KitSubject =>
  part(`LetterHistory/${state}`, ".oh-history", () => (
    <LetterHistory label={open ? "Hide history" : "Show history"} open={open} />
  ));

/** The line of views ends past the letter's column, at the quiet word's own edge. */
const views = (state: string, first: LetterView): KitSubject =>
  part(`LetterViews/${state}`, ".oh-letterviews", () => (
    <div style={{ marginRight: "var(--cap-q)" }}>
      <LetterViews label="View" views={[first, { id: "flip", label: "Show as text", touchOnly: true }]} />
    </div>
  ));

const LEDGER = [
  "Date        Text                                   Debit      Credit",
  "02.01.2026  Opening balance                                   12,480.00",
  "03.01.2026  Rent studio January                    1,650.00",
  "05.01.2026  Clay, 250 kg                             412.50",
  "06.01.2026  Workshop «Glaze & Fire», 12 places                 1,440.00",
  "08.01.2026  Electricity kiln, December               286.40",
  "…",
].join("\n");

/** How tall the reference's letter stands in each face. */
const HEIGHT = { paper: 422, ohmarchy: 336 };

export const letters: KitSubject[] = [
  { key: "BlockedImages/chip", on: "sheet", target: ".oh-blocked", render: () => onSheet(chip(false)) },
  { key: "BlockedImages/said", place: "window", target: ".oh-menu", render: () => chip(true) },
  part("MessageHead/noted", ".oh-messagehead", () => <MessageHead {...head({ note: chip(false) })} />),
  part("MessageHead/marks", ".oh-messagehead", () => (
    <MessageHead
      {...head({
        sender: W.PETRA,
        stamp: { when: "Wed 21 Oct 11:02", full: true, title: "Short times" },
        marks: [{ text: "Answered by the away responder", when: "Wed 21 Oct 11:02" }],
      })}
    />
  )),
  views("images", { id: "images", label: "Show images", icon: "image" }),
  views("adapted", { id: "adapt", label: "Original", icon: "sun" }),
  part("DesignedLetter/framed", ".oh-designedletter", (look) => (
    <Message head={<MessageHead {...head({})} />}>
      <DesignedLetter title="Message content" document="" height={HEIGHT[look.face]} />
    </Message>
  )),
  kept("kept", { act: { label: "Load it now" } }),
  kept("loading", { act: { label: "Loading from your mail server…", busy: true } }),
  kept("gone", {
    warn: "Your mail server no longer holds this letter where ohmail last saw it.",
    act: { label: "Load it now" },
  }),
  part("TextNotKept/loaded", ".oh-notkept-source", () => (
    <TextNotKept
      kind="loaded"
      line="Loaded from your mail server for this view and not stored on Cloud."
      more={{ label: "Storage" }}
    />
  )),
  part("TextNotKept/refused", ".oh-warnrow", () => (
    <TextNotKept
      kind="refused"
      warn="The full message didn't load, so this is its preview."
      way={{ label: "Try again" }}
    />
  )),
  part("TextNotKept/fine", ".oh-notkept-fine", () => (
    <TextNotKept kind="fine" line="Loading this message from your mail server…" live />
  )),
  files(
    "set",
    <FileNotArrived
      kind="PDF"
      name="evening-plan.pdf"
      state="failed"
      line="Your mail server did not answer."
      way={{ label: "Try again", full: "Try again: evening-plan.pdf" }}
    />,
  ),
  files(
    "fetching",
    <FileNotArrived kind="PDF" name="evening-plan.pdf" state="fetching" line="Fetching from your mailbox…" />,
  ),
  part("FileNotArrived/list", ".oh-files", () => (
    <Files>
      <FileNotArrived
        state="list"
        line="This message's files could not be loaded."
        way={{ label: "Try again" }}
      />
    </Files>
  )),
  history("folded", false),
  history("shown", true),
  part("LetterQuote/nested", ".oh-history-quoted", () => (
    <div className="oh-history-quoted">
      <LetterQuote attribution="On Fri 6 Nov 2026 at 18:31, Mila Brunner wrote:">
        {
          "Hi Flurina\n\nFor January I can offer Saturday the 16th or the 30th, both from ten. Could we take fourteen people this time? The waiting list is long.\n\nMila"
        }
        <LetterQuote attribution="On Thu 5 Nov 2026 at 09:10, Flurina Caduff wrote:">
          Three people asked for the waiting list again. Do you have dates for January yet?
        </LetterQuote>
      </LetterQuote>
    </div>
  )),
  part("LetterColumns/ledger", ".oh-lettercolumns", () => <LetterColumns>{LEDGER}</LetterColumns>),
];
