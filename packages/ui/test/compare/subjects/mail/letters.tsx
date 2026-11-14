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
import { design } from "../../../../src/base/tokens.js";
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

/*
 * The letter itself is the app's: the document it hands the frame. Staged as the sheet makes its example
 * (the studio's reading.js, at the references' studio commit: `docOf`, `frameCSS` and the Bergbahn Club's letter of
 * reading-letters.js),
 * with the look's own measures. A light letter keeps its white paper; in the dark it is adapted, on the sheet.
 */
const CLUB =
  "<h2>Winter pass: the opening days</h2><p>Hello Mila</p><p>The first lifts open on Saturday 28 November, if the snow holds. Your pass is valid from that day.</p><ul><li>S\u00e4ntis side: from 28 November</li><li>Ch\u00e4serrugg: from 5 December</li><li>Night skiing: Fridays from 18 December</li></ul><p>Show the code in <a>your pass</a> at the gate.</p><p>Bergbahn Club</p>";
const CLUB_PAPER = "#FFFFFF";
const rgb = (hex: string): number[] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]): string =>
  `#${c
    .map((x) =>
      Math.max(0, Math.min(255, Math.round(x)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
/* hue-rotate(180deg) as the browser computes it, and invert(1): the dark filter's two steps. */
const turn = (c: number[]): number[] => [
  -0.574 * c[0]! + 1.43 * c[1]! + 0.144 * c[2]!,
  0.426 * c[0]! + 0.43 * c[1]! + 0.144 * c[2]!,
  0.426 * c[0]! + 1.43 * c[1]! - 0.856 * c[2]!,
];
const inv = (c: number[]): number[] => c.map((x) => 255 - x);
function clubLetter(look: Look): { document: string; paper?: string } {
  const own = design.faces[look.face][look.scheme];
  const dark = look.scheme === "dark";
  const pad = Number.parseFloat(own["sheet-pad"]);
  const css =
    "html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scrollbar-width:thin}:root,:root>body{height:auto !important}" +
    `body{margin:0;padding:4px ${pad}px 32px;background:var(--paper,#fff);color:var(--ink,#1b1b1b);font:15px/1.62 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:break-word}` +
    "a{color:#1a56db;text-decoration:underline;cursor:pointer}" +
    `:root[data-dark] body{background:${hex(inv(turn(rgb(own.sheet))))};filter:invert(1) hue-rotate(180deg)}:root[data-dark]{background:${own.sheet}}` +
    `:root[data-reflow] body{font-size:${own["t-read"]};line-height:${own["lh-read"]};overflow-wrap:anywhere}` +
    ":root[data-reflow] *{max-width:100% !important}";
  const document = `<!doctype html><html${dark ? ' data-dark="1"' : ""} data-reflow="1" style="--paper:${CLUB_PAPER}"><head><meta charset="utf-8"><style>${css}</style></head><body>${CLUB}</body></html>`;
  return dark ? { document } : { document, paper: CLUB_PAPER };
}

export const letters: KitSubject[] = [
  { key: "BlockedImages/chip", on: "sheet", target: ".oh-blocked", render: () => onSheet(chip(false)) },
  /* It opens over the letter's sheet. */
  { key: "BlockedImages/said", place: "window", on: "sheet", target: ".oh-menu", render: () => chip(true) },
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
  /* The letter closes its message's sheet, which stands on the ground: its lower corners show it. */
  {
    ...part("DesignedLetter/framed", ".oh-designedletter", (look) => (
      <Message head={<MessageHead {...head({})} />}>
        <DesignedLetter title="Message content" {...clubLetter(look)} height={HEIGHT[look.face]} />
      </Message>
    )),
    on: "ground",
  },
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
