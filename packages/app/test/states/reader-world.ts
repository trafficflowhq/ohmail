/**
 * THE READING SCREEN'S LETTERS, as the reference names them (`open=lt-…`): who sent each, when, its subject and the
 * first words its row shows. Every person and address is invented; the text is plain (no letter's design is here).
 * The account reads on Tuesday 10 November 2026, 10:30, on a clock the page holds there.
 */
import type { EngineMessage } from "@ohmail/client-engine";

export const NOW = new Date("2026-11-10T10:30:00.000Z");

/** The invoice's number, as the reference draws it (written in parts, so no line reads as a run id). */
const INVOICE = ["HW", "2026", "1187"].join("-");

interface Plain {
  readonly from: string;
  readonly address: string;
  readonly subject: string;
  /** When it arrived, as the reference prints it (the page's clock is UTC). */
  readonly at: string;
  readonly text: string;
  readonly tag?: string;
  readonly files?: readonly string[];
}

/** The letters in the reference's two groups, then the ones its states open alone. */
export const LETTERS: Readonly<Record<string, Plain>> = {
  "lt-journal": {
    from: "Drehscheibe",
    address: "brief@drehscheibe-magazin.example",
    subject: "November: ash glazes, a kiln you can build, the open-studio map",
    at: "2026-11-10T06:40",
    text: "Ash glazes, from the stove to the bowl. Every winter the stove in the workshop leaves two buckets of beech ash.",
  },
  "lt-kino": {
    from: "Kino Seeblick",
    address: "programm@kino-seeblick.example",
    subject: "Three nights, three films",
    at: "2026-11-09T17:00",
    text: "The week of 16 November. Doors open half an hour before; the bar stays open after the last film.",
  },
  "lt-invoice": {
    from: "Hostwerk",
    address: "billing@hostwerk.example",
    subject: `Invoice ${INVOICE} for lichtgrat.example`,
    at: "2026-11-03T10:05",
    text: "Your invoice for the domain and the mail plan is attached. It is paid by card on 17 November.",
    files: [`${INVOICE}.pdf`],
  },
  "lt-bank": {
    from: "Nordufer Bank",
    address: "documents@nordufer-bank.example",
    subject: "A new document is in your e-banking",
    at: "2026-11-02T07:30",
    text: "Your account statement for October 2026 is ready. You find it in your e-banking under Documents.",
  },
  "lt-order": {
    from: "Pigment & Papier",
    address: "shop@pigmentpapier.example",
    subject: "Your order #5521 is on its way",
    at: "2026-11-04T13:37",
    text: "We packed order #5521 this morning. The parcel should reach the studio on Thursday.",
  },
  "lt-reto": {
    from: "Reto Frei",
    address: "reto@alpmail.example",
    subject: "The ridge, and a plan for Saturday",
    at: "2026-11-08T20:14",
    text: "Here is the one from the ridge I told you about. We were up before seven.",
  },
  "lt-reply": {
    from: "Flurina Caduff",
    address: "flurina@haldenlicht.example",
    subject: "Re: Workshop dates for January",
    at: "2026-11-07T08:52",
    text:
      "The 16th and the 30th both work. I would keep twelve places.\n\n" +
      "On Wed, 4 Nov 2026 at 09:12, Mila Brunner <mila@lichtgrat.example> wrote:\n" +
      "> Which dates in January suit you for the workshop?\n> We could do two Saturdays.",
  },
  "lt-log": {
    from: "Kiln 2",
    address: "kiln2@lichtgrat.example",
    subject: "Firing log: glaze firing, 9 to 10 November",
    at: "2026-11-10T09:04",
    text: "Kiln 2 · glaze firing · programme 7 (1240 °C). Started Monday 9 November 2026, 18:00.",
  },
  "lt-club": {
    from: "Bergbahn Club",
    address: "club@bergbahnclub.example",
    subject: "Winter pass: the opening days",
    at: "2026-11-06T12:00",
    text: "The first lifts open on Saturday 28 November, if the snow holds.",
  },
  "lt-export": {
    from: "Kassenblatt",
    address: "export@kassenblatt.example",
    subject: "Your export: ledger 2026, January to October",
    at: "2026-11-05T23:10",
    text: "Your export is attached.",
    files: ["ledger-2026.csv"],
  },
  "lt-emptied": {
    from: "Carla Meier",
    address: "carla@wintermarkt-lind.example",
    subject: "Wintermarkt Lind: stall plan and set-up times",
    at: "2025-03-14T11:20",
    text: "Dear stallholders, here is the plan for both weekends. Set-up starts on Friday at four.",
  },
  "lt-junk": {
    from: "Prize Desk",
    address: "winner@jackpot-central.example",
    subject: "Final notice: your reward is waiting",
    at: "2026-11-08T03:12",
    text: "Claim it today.",
  },
  "lt-raw": {
    from: "Reto Frei",
    address: "reto@alpmail.example",
    subject: "All the RAW files from the ridge",
    at: "2026-11-09T22:48",
    text: "All of them, as promised.",
  },
  "lt-expunged": {
    from: "Tim Berger",
    address: "tim@gassenblatt.example",
    subject: "Seats for the 21st",
    at: "2026-10-28T19:02",
    text: "Two seats in row four.",
  },
  "lt-slow": {
    from: "Anna Odermatt",
    address: "anna@gartenlokal-rosa.example",
    subject: "Menu cards: the final proof",
    at: "2026-11-06T16:05",
    text: "The final proof is attached.",
    files: ["menu-cards-proof-3.pdf"],
  },
  "lt-files": {
    from: "Nadja Lehner",
    address: "nadja@erdton-atelier.example",
    subject: "Glaze evening: recipes, the plan and the film",
    at: "2026-11-04T19:20",
    text: "Hi Mila, here are the recipes and the plan for the evening. The film of the kiln follows.",
    files: ["glaze-recipes.pdf", "evening-plan.pdf"],
  },
  "lt-invite": {
    from: "Jonas Halter",
    address: "jonas@lichtgrat.example",
    subject: "Invitation: open studio, planning",
    at: "2026-11-03T15:40",
    text: "Let us plan the open studio together.",
  },
  "lt-owa": {
    from: "Simone Aebi",
    address: "simone@treuhand-aebi.example",
    subject: "Year-end meeting",
    at: "2026-11-02T10:12",
    text: "Shall we meet in the first week of December?",
  },
  "lt-away": {
    from: "Petra Wyss",
    address: "petra@makersfest.example",
    subject: "Makersfest: room plan for the main hall",
    at: "2026-10-21T11:02",
    text: "Hi Mila, the room plan for the main hall is attached. Your talk is second after the opening.",
    files: ["main-hall-plan.pdf"],
  },
};

export const GROUPS = [
  { title: "Designed", ids: ["lt-journal", "lt-kino", "lt-invoice", "lt-bank", "lt-order"] },
  { title: "Text and history", ids: ["lt-reto", "lt-reply", "lt-log", "lt-club", "lt-export"] },
] as const;

/** The instant a time names: the comparison's browser reads the clock in UTC, as the reference prints it. */
const instant = (local: string): string => new Date(`${local}:00.000Z`).toISOString();

export function engineLetter(id: string, p: Plain): EngineMessage {
  const at = instant(p.at);
  return {
    id,
    accountId: "mila",
    mailboxId: "mb-studio",
    threadId: null,
    messageIdHeader: null,
    subject: p.subject,
    from: { name: p.from, address: p.address },
    to: [{ name: null, address: "mila@lichtgrat.example" }],
    cc: [],
    date: at,
    arrivedAt: at,
    folder: "INBOX",
    snippet: p.text.slice(0, 120),
    unread: false,
    lastReadAt: at,
    hasAttachments: (p.files?.length ?? 0) > 0,
    attachmentCount: p.files?.length ?? 0,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: p.tag ? [p.tag] : [],
    remoteContent: "none",
    updatedAt: at,
    body: p.text,
  } as unknown as EngineMessage;
}
