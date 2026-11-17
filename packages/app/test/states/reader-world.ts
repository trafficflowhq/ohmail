/**
 * THE REFERENCE'S WORLD: its people, the reading screen's letters (`open=lt-…`) and the nine conversations the
 * Ohbox's screen opens (`open=giulia-glaze`, …), as the reference's scenes hold them: who sent each, to whom, when,
 * its subject, its files, whether it is read. One table of people for both states pages (the reader's and the
 * Ohbox's). Every person and address is invented; the text is plain (no letter's design is here). The account reads
 * on Tuesday 10 November 2026, 10:30, on a clock the page holds there.
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

/** Somebody of the reference's world: the name its heads print, the address beside it. */
export interface Person {
  readonly name: string;
  readonly address: string;
}

/** The reference's people: the account's own, the Ohbox's, and the reading screen's senders. */
export const PEOPLE = {
  mila: { name: "Mila Brunner", address: "mila@lichtgrat.example" },
  ben: { name: "Ben Arnold", address: "ben@lichtgrat.example" },
  jonas: { name: "Jonas Halter", address: "jonas@lichtgrat.example" },
  rahel: { name: "Rahel Beck", address: "rahel@lichtgrat.example" },
  tobias: { name: "Tobias Frei", address: "tobias@lichtgrat.example" },
  giulia: { name: "Giulia Ferrari", address: "giulia@terracotta-milano.example" },
  petra: { name: "Petra Wyss", address: "petra@makersfest.example" },
  nadja: { name: "Nadja Lehner", address: "nadja@erdton-atelier.example" },
  anna: { name: "Anna Odermatt", address: "anna@gartenlokal-rosa.example" },
  reto: { name: "Reto Frei", address: "reto@alpmail.example" },
  lea: { name: "Lea Brunner", address: "lea@brunner-familie.example" },
  tim: { name: "Tim Berger", address: "tim@gassenblatt.example" },
  carla: { name: "Carla Meier", address: "carla@wintermarkt-lind.example" },
  flurina: { name: "Flurina Caduff", address: "flurina@haldenlicht.example" },
  hostwerk: { name: "Hostwerk", address: "support@hostwerk.example" },
  hostwerkBilling: { name: "Hostwerk", address: "billing@hostwerk.example" },
  cinderlock: { name: "Cinderlock", address: "no-reply@cinderlock.example" },
  drehscheibe: { name: "Drehscheibe", address: "brief@drehscheibe-magazin.example" },
  kino: { name: "Kino Seeblick", address: "programm@kino-seeblick.example" },
  bank: { name: "Nordufer Bank", address: "documents@nordufer-bank.example" },
  shop: { name: "Pigment & Papier", address: "shop@pigmentpapier.example" },
  kiln: { name: "Kiln 2", address: "kiln2@lichtgrat.example" },
  club: { name: "Bergbahn Club", address: "club@bergbahnclub.example" },
  ledger: { name: "Kassenblatt", address: "export@kassenblatt.example" },
  prize: { name: "Prize Desk", address: "winner@jackpot-central.example" },
  simone: { name: "Simone Aebi", address: "simone@treuhand-aebi.example" },
} as const satisfies Record<string, Person>;
export type Who = keyof typeof PEOPLE;

/** A letter's sender, as the reading screen's letters write it. */
const sender = (who: Who): { from: string; address: string } => ({
  from: PEOPLE[who].name,
  address: PEOPLE[who].address,
});

/** The letters in the reference's two groups, then the ones its states open alone. */
export const LETTERS: Readonly<Record<string, Plain>> = {
  "lt-journal": {
    ...sender("drehscheibe"),
    subject: "November: ash glazes, a kiln you can build, the open-studio map",
    at: "2026-11-10T06:40",
    text: "Ash glazes, from the stove to the bowl. Every winter the stove in the workshop leaves two buckets of beech ash.",
  },
  "lt-kino": {
    ...sender("kino"),
    subject: "Three nights, three films",
    at: "2026-11-09T17:00",
    text: "The week of 16 November. Doors open half an hour before; the bar stays open after the last film.",
  },
  "lt-invoice": {
    ...sender("hostwerkBilling"),
    subject: `Invoice ${INVOICE} for lichtgrat.example`,
    at: "2026-11-03T10:05",
    text: "Your invoice for the domain and the mail plan is attached. It is paid by card on 17 November.",
    files: [`${INVOICE}.pdf`],
  },
  "lt-bank": {
    ...sender("bank"),
    subject: "A new document is in your e-banking",
    at: "2026-11-02T07:30",
    text: "Your account statement for October 2026 is ready. You find it in your e-banking under Documents.",
  },
  "lt-order": {
    ...sender("shop"),
    subject: "Your order #5521 is on its way",
    at: "2026-11-04T13:37",
    text: "We packed order #5521 this morning. The parcel should reach the studio on Thursday.",
  },
  "lt-reto": {
    ...sender("reto"),
    subject: "The ridge, and a plan for Saturday",
    at: "2026-11-08T20:14",
    text: "Here is the one from the ridge I told you about. We were up before seven.",
  },
  "lt-reply": {
    ...sender("flurina"),
    subject: "Re: Workshop dates for January",
    at: "2026-11-07T08:52",
    text:
      "The 16th and the 30th both work. I would keep twelve places.\n\n" +
      "On Wed, 4 Nov 2026 at 09:12, Mila Brunner <mila@lichtgrat.example> wrote:\n" +
      "> Which dates in January suit you for the workshop?\n> We could do two Saturdays.",
  },
  "lt-log": {
    ...sender("kiln"),
    subject: "Firing log: glaze firing, 9 to 10 November",
    at: "2026-11-10T09:04",
    text: "Kiln 2 · glaze firing · programme 7 (1240 °C). Started Monday 9 November 2026, 18:00.",
  },
  "lt-club": {
    ...sender("club"),
    subject: "Winter pass: the opening days",
    at: "2026-11-06T12:00",
    text: "The first lifts open on Saturday 28 November, if the snow holds.",
  },
  "lt-export": {
    ...sender("ledger"),
    subject: "Your export: ledger 2026, January to October",
    at: "2026-11-05T23:10",
    text: "Your export is attached.",
    files: ["ledger-2026.csv"],
  },
  "lt-emptied": {
    ...sender("carla"),
    subject: "Wintermarkt Lind: stall plan and set-up times",
    at: "2025-03-14T11:20",
    text: "Dear stallholders, here is the plan for both weekends. Set-up starts on Friday at four.",
  },
  "lt-junk": {
    ...sender("prize"),
    subject: "Final notice: your reward is waiting",
    at: "2026-11-08T03:12",
    text: "Claim it today.",
  },
  "lt-raw": {
    ...sender("reto"),
    subject: "All the RAW files from the ridge",
    at: "2026-11-09T22:48",
    text: "All of them, as promised.",
  },
  "lt-expunged": {
    ...sender("tim"),
    subject: "Seats for the 21st",
    at: "2026-10-28T19:02",
    text: "Two seats in row four.",
  },
  "lt-slow": {
    ...sender("anna"),
    subject: "Menu cards: the final proof",
    at: "2026-11-06T16:05",
    text: "The final proof is attached.",
    files: ["menu-cards-proof-3.pdf"],
  },
  "lt-files": {
    ...sender("nadja"),
    subject: "Glaze evening: recipes, the plan and the film",
    at: "2026-11-04T19:20",
    text: "Hi Mila, here are the recipes and the plan for the evening. The film of the kiln follows.",
    files: ["glaze-recipes.pdf", "evening-plan.pdf"],
  },
  "lt-invite": {
    ...sender("jonas"),
    subject: "Invitation: open studio, planning",
    at: "2026-11-03T15:40",
    text: "Let us plan the open studio together.",
  },
  "lt-owa": {
    ...sender("simone"),
    subject: "Year-end meeting",
    at: "2026-11-02T10:12",
    text: "Shall we meet in the first week of December?",
  },
  "lt-away": {
    ...sender("petra"),
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

/** A tag of the account, as the reference names it and the hue it draws. */
export const TAGS = {
  pottery: { name: "Pottery Project", hue: "moss" },
  paperwork: { name: "Paperwork", hue: "ochre" },
  adventures: { name: "Adventures", hue: "rosewood" },
} as const;
export type TagId = keyof typeof TAGS;

/** A file on a letter, as its tile prints it: the name and the size (the reference's sizes, in bytes). */
export interface WorldFile {
  readonly name: string;
  readonly size: number;
}

/** One letter of a conversation, as the reference's scene holds it. */
export interface Said {
  readonly id: string;
  readonly by: Who;
  /** When it was sent, as the reference prints it (the page's clock is UTC). */
  readonly at: string;
  readonly to: readonly Who[];
  readonly cc?: readonly Who[];
  readonly subject: string;
  readonly text: string;
  /** The first words the list's row prints, where the reference writes them apart from the text. */
  readonly preview?: string;
  readonly unread?: boolean;
  readonly files?: readonly WorldFile[];
  /** It answers the letter before it and carries it as its quoted history (the body's "Show history"). */
  readonly quotes?: boolean;
}

/** A conversation the Ohbox opens, by the id of the letter its row opens (its newest). */
export interface Conversation {
  readonly subject: string;
  readonly tags: readonly TagId[];
  /** Oldest first; the last is the letter the row opens. */
  readonly letters: readonly Said[];
}

/** Everybody of a conversation but the one who writes: whom a letter of a team thread goes to. */
const others =
  (team: readonly Who[]) =>
  (by: Who): readonly Who[] =>
    team.filter((who) => who !== by);

/** Earlier letters as the reference's fixtures write them: [who, day, time, text, flags]; `u` unread, `q` quotes. */
type Before = readonly [Who, string, string, string, string?];
const thread = (key: string, subject: string, team: readonly Who[], before: readonly Before[]): Said[] => {
  const to = others(team);
  return before.map(([by, day, time, text, flags = ""], i) => ({
    id: `${key}-${i + 1}`,
    by,
    at: `${day}T${time}`,
    to: to(by),
    subject,
    text,
    unread: flags.includes("u"),
    quotes: flags.includes("q"),
  }));
};

const KILN_TEAM: readonly Who[] = ["mila", "ben", "jonas", "rahel", "tobias"];
const STUDIO_TEAM: readonly Who[] = ["mila", "jonas", "rahel", "tobias"];
const RIDGE_TEAM: readonly Who[] = ["mila", "reto", "lea", "tim"];

/** The nine conversations the Ohbox's screen opens: 58 letters (threads of 5, 12, 30, 3 and 4, and four alone). */
export const CONVERSATIONS: Readonly<Record<string, Conversation>> = {
  "giulia-glaze": {
    subject: "Glaze order #2291",
    tags: ["pottery"],
    letters: [
      {
        id: "giulia-glaze-1",
        by: "mila",
        at: "2026-11-05T16:20",
        to: ["giulia"],
        subject: "Glaze order #2291",
        text: "Buongiorno Giulia\n\nWe would like to order for the December glaze evening:\n\n6 kg sage green (SG-12)\n4 kg matte white (MW-03)\n\nDelivery to the studio in Winterthur, before the 20th if you can. Same invoice address as last time.\n\nThank you,\nMila",
      },
      {
        id: "giulia-glaze-2",
        by: "giulia",
        at: "2026-11-06T09:05",
        to: ["mila"],
        subject: "Re: Glaze order #2291",
        text: "Buongiorno Mila\n\nThe sage green is in stock. Of the matte white I have 3 kg today; the last kilo comes in on the 17th.\n\nShall I send what I have now and the rest later, or everything together after the 17th?\n\nGiulia",
      },
      {
        id: "giulia-glaze-3",
        by: "mila",
        at: "2026-11-06T11:40",
        to: ["giulia"],
        cc: ["ben"],
        subject: "Re: Glaze order #2291",
        text: "Send what you have now, please. We need the green for test tiles next week.\n\nBen (in copy) takes deliveries at the studio, mornings are best.\n\nMila",
      },
      {
        id: "ben-glaze",
        by: "ben",
        at: "2026-11-09T17:30",
        to: ["mila", "giulia"],
        subject: "Re: Glaze order #2291",
        text: "One thing for the courier: the studio is closed on Wednesday morning, the kiln technician needs the room. Thursday or Friday before noon works.\n\nBen",
        unread: true,
      },
      {
        id: "giulia-glaze",
        by: "giulia",
        at: "2026-11-10T09:12",
        to: ["mila"],
        cc: ["ben"],
        subject: "Re: Glaze order #2291",
        text: "Buongiorno Mila, buongiorno Ben\n\nGood news. The matte white came back in stock yesterday, so both glazes leave Milan today in one carton and reach you on Thursday 12 November, before noon.\n\nThe invoice is attached. Can you confirm that the delivery address is still the atelier?\n\nA presto,\nGiulia Ferrari\nTerracotta Milano",
        preview:
          "Both glazes leave Milan today and reach the studio on Thursday. The matte white came back in stock, so it is one carton after all.",
        unread: true,
        files: [{ name: "Invoice-2291.pdf", size: 84_000 }],
      },
    ],
  },
  "petra-talk": {
    subject: "Your talk is on the programme",
    tags: [],
    letters: [
      {
        id: "petra-talk",
        by: "petra",
        at: "2026-11-10T08:47",
        to: ["mila"],
        subject: "Your talk is on the programme",
        text: "Hi Mila\n\n“Wabi-sabi for web people” made the final programme. You are on Saturday 21 November at 11:00 in the main hall; yours was one of the most requested sessions.\n\nSpeaker details are attached. There is a speaker dinner on Friday evening, tell me if you eat fish.\n\nSee you in Zürich,\nPetra",
        preview:
          "“Wabi-sabi for web people” made the final programme: Saturday at 11:00 in the main hall. Speaker details attached, and there is a dinner on Friday.",
        unread: true,
        files: [
          { name: "Speaker-Info.pdf", size: 1_200_000 },
          { name: "Main-hall.jpg", size: 860_000 },
          { name: "Running-order.txt", size: 2_000 },
          { name: "Slide-template.pptx", size: 4_600_000 },
        ],
      },
    ],
  },
  "ben-kiln": {
    subject: "The kiln heats unevenly",
    tags: ["pottery"],
    letters: [
      ...thread("ben-kiln", "The kiln heats unevenly", KILN_TEAM, [
        [
          "ben",
          "2026-11-02",
          "08:14",
          "The big kiln is off again. The top shelf came out a full cone hotter than the bottom one, and the two test tiles on the left are underfired.\n\nBen",
        ],
        [
          "mila",
          "2026-11-02",
          "08:40",
          "Left side again? That was the side with the old element.\n\nMila",
          "q",
        ],
        [
          "ben",
          "2026-11-02",
          "09:05",
          "Yes. I measured it: the lower left element draws about a third less than the others. It is tired, not broken.\n\nBen",
          "q",
        ],
        [
          "jonas",
          "2026-11-02",
          "09:32",
          "Can we fire the glaze tests in the small kiln until it is sorted? I need twelve tiles by Friday for the poster photos.\n\nJonas",
        ],
        [
          "ben",
          "2026-11-02",
          "10:10",
          "The small kiln takes twelve tiles if you stand them. I will load it this evening.\n\nBen",
        ],
        [
          "rahel",
          "2026-11-03",
          "11:20",
          "I asked the supplier. A new element is CHF 148 and takes a week, or CHF 190 with courier and it is here on Monday. Which one?\n\nRahel",
        ],
        ["mila", "2026-11-03", "11:34", "Courier. The December orders will not wait a week.\n\nMila", "q"],
        [
          "tobias",
          "2026-11-04",
          "16:02",
          "For the books: is that repair or equipment? It changes which account it goes to.\n\nTobias",
        ],
        ["rahel", "2026-11-04", "16:25", "Repair. Same kiln, same part.\n\nRahel", "q"],
        [
          "ben",
          "2026-11-09",
          "17:48",
          "The element is here two hours early. I am fitting it now and will run an empty firing overnight with cones on all three shelves.\n\nBen",
        ],
        [
          "jonas",
          "2026-11-10",
          "07:41",
          "Did the cones drop? If yes I would like the Thursday firing back.\n\nJonas",
          "uq",
        ],
      ]),
      {
        id: "ben-kiln",
        by: "ben",
        at: "2026-11-10T07:58",
        to: ["mila"],
        subject: "Kiln is fixed, and Friday pizza",
        text: "Good news twice. The new element arrived early and the kiln heats evenly again; I ran an empty test firing overnight and both cones dropped where they should.\n\nAnd Friday we fire the wood oven after work. Bring nothing but appetite.\n\nBen",
        preview:
          "The new element arrived early and the kiln heats evenly again. Friday we fire the wood oven after work. Bring nothing but appetite.",
        unread: true,
        quotes: true,
      },
    ],
  },
  "hostwerk-renewal": {
    subject: "Domain renewal: lichtgrat.example expires 30 November",
    tags: ["paperwork"],
    letters: [
      {
        id: "hostwerk-renewal",
        by: "hostwerk",
        at: "2026-11-03T10:02",
        to: ["mila"],
        subject: "Domain renewal: lichtgrat.example expires 30 November",
        text: "lichtgrat.example renews on 30 November for CHF 19.00 a year. Auto-renew is off, so nothing happens unless you renew it.",
        unread: true,
      },
    ],
  },
  "petra-techcheck": {
    subject: "Invitation: Tech check, main hall",
    tags: [],
    letters: [
      {
        id: "petra-techcheck",
        by: "petra",
        at: "2026-11-10T08:39",
        to: ["mila"],
        subject: "Invitation: Tech check, main hall",
        text: "Petra Wyss invited you: Friday 20 November, 16:00, main hall. Fifteen minutes on stage for mics, slides and the clicker.",
      },
    ],
  },
  "nadja-newtime": {
    subject: "New time proposed: glaze evening planning call",
    tags: [],
    letters: [
      {
        id: "nadja-newtime",
        by: "nadja",
        at: "2026-11-10T08:35",
        to: ["mila"],
        subject: "New time proposed: glaze evening planning call",
        text: "Nadja proposed Thursday 15:00 instead of 10:00. Same half hour, and she calls you.",
      },
    ],
  },
  "anna-menu": {
    subject: "The new menu cards",
    tags: [],
    letters: [
      ...thread(
        "anna-menu",
        "The new menu cards",
        ["mila", "anna"],
        [
          [
            "mila",
            "2026-11-05",
            "08:55",
            "Hello Anna\n\nThe menu cards went to the printer this morning. Forty on the heavy stock, as agreed.\n\nMila",
          ],
          [
            "anna",
            "2026-11-06",
            "12:20",
            "Wonderful. Could ten of them be without prices? For the Sunday brunch.\n\nAnna",
          ],
        ],
      ),
      {
        id: "anna-menu",
        by: "anna",
        at: "2026-11-09T17:42",
        to: ["mila"],
        subject: "Re: The new menu cards",
        text: "The cards arrived and they are even better in the hand. Guests keep picking them up and turning them over.",
      },
    ],
  },
  "reto-photos": {
    subject: "Photos from the ridge",
    tags: ["adventures"],
    letters: [
      ...thread("reto-photos", "Photos from the ridge", RIDGE_TEAM, [
        [
          "tim",
          "2026-11-08",
          "20:15",
          "Reto, the ridge photos. You promised them before we were back at the car.\n\nTim",
        ],
        [
          "lea",
          "2026-11-08",
          "20:40",
          "To all of us, please. Mila has to see what she slept through.\n\nLea",
        ],
        ["mila", "2026-11-08", "21:02", "I regret nothing. Send the sunrise anyway.\n\nMila"],
      ]),
      {
        id: "reto-photos",
        by: "reto",
        at: "2026-11-09T14:10",
        to: ["mila"],
        subject: "Photos from the ridge",
        text: "The promised photos from the ridge. The sunrise was worth every minute of the four o'clock start. Next time you come along.",
        files: [
          { name: "grat-01.jpg", size: 2_400_000 },
          { name: "grat-02.jpg", size: 2_100_000 },
          { name: "grat-03.jpg", size: 2_800_000 },
        ],
      },
    ],
  },
  "jonas-openstudio": {
    subject: "Open studio in December: which weekend?",
    tags: [],
    letters: [
      ...thread("jonas-openstudio", "Open studio in December: which weekend?", STUDIO_TEAM, [
        [
          "rahel",
          "2026-10-26",
          "09:10",
          "Open studio in December, yes or no? The October one paid for the new shelving.\n\nRahel",
        ],
        [
          "mila",
          "2026-10-26",
          "09:42",
          "Yes. But smaller than October: one room, no workshop corner.\n\nMila",
        ],
        [
          "jonas",
          "2026-10-26",
          "10:05",
          "One room means the kiln room stays shut. Good, it is a mess.\n\nJonas",
        ],
        [
          "tobias",
          "2026-10-26",
          "11:30",
          "I can do the till again. I would like a chair this time.\n\nTobias",
        ],
        [
          "rahel",
          "2026-10-26",
          "13:15",
          "Chair noted. Which weekend, though? The 28th of November is out: Makersfest is the weekend before and Mila will be flat.\n\nRahel",
        ],
        ["mila", "2026-10-26", "13:40", "Correct.\n\nMila"],
        [
          "jonas",
          "2026-10-27",
          "08:20",
          "Then December. I asked the printer what they need: a date, and ten days.\n\nJonas",
        ],
        [
          "tobias",
          "2026-10-27",
          "09:02",
          "Mulled wine or coffee? Last time we ran out of both by three.\n\nTobias",
        ],
        [
          "rahel",
          "2026-10-27",
          "09:31",
          "Both, and more of both. I will ask Anna if the Gartenlokal lends us the big urn.\n\nRahel",
        ],
        ["mila", "2026-10-27", "10:12", "Ask her about the trestle tables too. Ours wobble.\n\nMila"],
        [
          "jonas",
          "2026-10-28",
          "16:45",
          "Poster: I would reuse the October layout and change the colour. Sage green, since we will have the glaze.\n\nJonas",
        ],
        ["rahel", "2026-10-28", "17:02", "Sage green on what? Not the brown paper again.\n\nRahel"],
        ["jonas", "2026-10-28", "17:20", "The brown paper was a hit. Carla said so.\n\nJonas"],
        ["mila", "2026-10-28", "18:05", "White paper, green type. Final answer.\n\nMila"],
        [
          "tobias",
          "2026-10-29",
          "09:15",
          "Price list: same as October, or do the bowls go up? They sold out before noon.\n\nTobias",
        ],
        ["mila", "2026-10-29", "09:50", "Bowls go up by five francs. Cups stay.\n\nMila"],
        [
          "rahel",
          "2026-10-29",
          "10:30",
          "Anna says yes to the urn and to two tables. She wants a cup in return.\n\nRahel",
        ],
        ["mila", "2026-10-29", "10:41", "She gets two.\n\nMila"],
        [
          "jonas",
          "2026-10-30",
          "14:10",
          "Seconds table: I counted 41 pieces with small faults. That is a table.\n\nJonas",
        ],
        [
          "tobias",
          "2026-10-30",
          "14:32",
          "Seconds outsold the good shelf in October. I have the numbers if anyone wants to feel bad.\n\nTobias",
        ],
        ["rahel", "2026-11-02", "08:45", "Flyers for the shops on Marktgasse: 150 or 300?\n\nRahel"],
        ["mila", "2026-11-02", "09:20", "150. Half of the last batch is still in the drawer.\n\nMila"],
        ["jonas", "2026-11-02", "11:05", "Who opens on the day? I can be there at eight.\n\nJonas"],
        ["tobias", "2026-11-02", "11:40", "Eight with Jonas. I bring the cash box and the chair.\n\nTobias"],
        [
          "rahel",
          "2026-11-03",
          "15:25",
          "Wrapping paper is ordered. Newsprint, 10 kg, arrives next week.\n\nRahel",
        ],
        [
          "mila",
          "2026-11-03",
          "16:00",
          "Thank you. Music: nothing with lyrics, people stop talking.\n\nMila",
        ],
        ["jonas", "2026-11-04", "09:35", "Noted, no lyrics. We still have no date.\n\nJonas"],
        [
          "rahel",
          "2026-11-04",
          "10:10",
          "The 5th and the 12th are both free in the hall calendar. The 19th is too close to Christmas.\n\nRahel",
        ],
        [
          "tobias",
          "2026-11-05",
          "17:50",
          "Either works for me. Somebody decide before the printer closes for the week.\n\nTobias",
        ],
      ]),
      {
        id: "jonas-openstudio",
        by: "jonas",
        at: "2026-11-06T11:05",
        to: ["mila", "rahel"],
        cc: ["tobias"],
        subject: "Open studio in December: which weekend?",
        text: "Mila, the open studio. If it is happening in December it is the 5th or the 12th, and the printer wants the date on Wednesday.\n\nThe 5th is quieter in town. The 12th shares the weekend with the market, so more people walk past and all of them are slower. I lean 12th.\n\nAlso: seconds table again? It outsold the good shelf last year, which I have decided not to take personally.\n\nJonas",
        preview:
          "The 5th or the 12th, and the printer wants the date on Wednesday. I lean 12th: it shares the weekend with the market.",
      },
    ],
  },
};

/** The letter before, as the body draws a quoted history: the line that says who wrote it, then its lines. */
function quoted(before: Said): string {
  const at = new Date(instant(before.at));
  const day = at.toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = at.toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
  const who = PEOPLE[before.by];
  const lines = before.text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
  return `On ${day} at ${time}, ${who.name} <${who.address}> wrote:\n${lines.join("\n")}`;
}

/** A conversation's letters as the engine holds them, in the account's mailbox `mailboxId`, under thread `id`. */
export function conversationLetters(id: string, mailboxId: string): EngineMessage[] {
  const c = CONVERSATIONS[id];
  if (!c) return [];
  return c.letters.map((said, i) => {
    const at = instant(said.at);
    const before = i > 0 ? c.letters[i - 1] : undefined;
    const body = said.quotes && before ? `${said.text}\n\n${quoted(before)}` : said.text;
    const person = (who: Who) => ({ name: PEOPLE[who].name, address: PEOPLE[who].address });
    return {
      id: said.id,
      accountId: "mila",
      mailboxId,
      threadId: c.letters.length > 1 ? id : null,
      messageIdHeader: null,
      subject: said.subject,
      from: person(said.by),
      to: said.to.map(person),
      cc: (said.cc ?? []).map(person),
      date: at,
      arrivedAt: at,
      folder: said.by === "mila" ? "Sent" : "INBOX",
      snippet: said.preview ?? said.text.replace(/\s+/g, " ").slice(0, 160),
      unread: said.unread ?? false,
      lastReadAt: said.unread ? null : at,
      hasAttachments: (said.files?.length ?? 0) > 0,
      attachmentCount: said.files?.length ?? 0,
      sensitivity: {
        sensitive: false,
        category: null,
        no_ai: false,
        no_forward: false,
        no_kb: false,
        priority: false,
      },
      triage: null,
      labels: i === c.letters.length - 1 ? [...c.tags] : [],
      remoteContent: "none",
      updatedAt: at,
      body,
    } as unknown as EngineMessage;
  });
}
