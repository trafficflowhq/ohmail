/**
 * THE SCREENER'S REGISTERED STATES, drawn by address over the fake host: the Screener's place through the real frame,
 * `ScreenerAbove` standing over it as the seating step stands it, over a model double that answers what the
 * reference shows (its people and letters, plain), and an engine that answers their bodies. The address carries the
 * reference's words (`open`, `show`, `sec`, `state`, `org`, `did`, `queue`, `only`, `how`, `oauth`, `device`, `face`,
 * `scheme`) and `lang`. With `sec=junk` the shell's Junk window is handed, answering the state the address names. The
 * rail is the frame's fed model; the report after a press is the frame's.
 */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { FailedAtGateDTO, OhmailEngine, ScreenerSenderDTO } from "@ohmail/client-engine";
import { APPLY_PILE_ORDER, type ScreenerState, type SpamRow } from "@ohmail/app-logic/screener";
import { Frame } from "../../src/frame/Frame.js";
import { useRailModel } from "../../src/frame/commands.js";
import type { PaneProps, PlaceEntry, RailModel } from "../../src/frame/contract.js";
import { NONE } from "../../src/host/index.js";
import {
  ScreenerAbove,
  screenerPlace,
  type ScreenerBeside,
  type ScreenerJunk,
  type ScreenerJunkItem,
  type ScreenerSuggest,
} from "../../src/screener/index.js";
import { ScreenerList } from "../../src/screener/ScreenerList.js";
import { fillOver, TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import screenerDe from "../../messages/screener.de.json" with { type: "json" };
import screenerEn from "../../messages/screener.en.json" with { type: "json" };
import sharedDe from "../../messages/shared.de.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };

/* The reference is drawn on Tuesday 10 November 2026 at 09:24 in Zurich: the page's clock starts there and runs on,
   so a Junk letter's day reads as the reference's ("yesterday", "Sun", "Tue 3 Nov") on any day it is drawn. */
const Real = Date;
const SHIFT = new Real("2026-11-10T08:24:00.000Z").getTime() - Real.now();
globalThis.Date = class extends Real {
  constructor(...args: ConstructorParameters<typeof Date>) {
    super(...((args.length > 0 ? args : [Real.now() + SHIFT]) as [number]));
  }
  static now(): number {
    return Real.now() + SHIFT;
  }
} as DateConstructor;

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const device = (q.get("device") ?? "desktop") as "desktop" | "phone" | "fold" | "foldl";
const room = device === "foldl" ? ROOMS.land : ROOMS[device];
const show = q.get("show");
const junkOn = q.get("sec") === "junk";
const sec =
  q.get("sec") === "screened" || q.get("sec") === "spam" || junkOn ? (junkOn ? "spam" : q.get("sec")) : null;
const state = q.get("state");
const org = q.get("org");
const did = q.get("did") === "1";
const queue = Math.max(0, Math.min(200, Number(q.get("queue") ?? 0) || 0));
const askedOpen = q.get("open");

interface Plain {
  id: string;
  name: string;
  address: string;
  time: string;
  letters: { subject: string; text: string; time?: string }[];
  ai?: { dest: string; confidence: number; rationale: string };
  scope?: "sender" | "domain";
  checked?: ScreenerSenderDTO["checked"];
  segment?: "waiting" | "screened" | "spam";
}
const senderOf = (p: Plain): ScreenerSenderDTO =>
  ({
    id: p.id,
    segment: p.segment ?? "waiting",
    from: { name: p.name, address: p.address },
    initial: p.name[0],
    time: p.time,
    scope: p.scope ?? "sender",
    derived: true,
    checked: p.checked,
    ai: p.ai ?? null,
    held: p.letters.map((l, i) => ({
      id: `${p.id}-${i}`,
      subject: l.subject,
      time: l.time ?? p.time,
      body: "",
      snippet: l.text.slice(0, 120),
      /* Held mail waiting for a decision is mail nobody has read. */
      unread: (p.segment ?? "waiting") === "waiting",
    })),
  }) as ScreenerSenderDTO;

const WAITING: Plain[] = [
  {
    id: "scr-lena",
    name: "Lena Kaufmann",
    address: "lena@atelier-eichspan.example",
    time: "08:40",
    ai: { dest: "ohbox", confidence: 0.92, rationale: "A personal note from a real address" },
    letters: [
      {
        subject: "Visit to the workshop",
        time: "08:12",
        text: "Hello Mila, we spoke briefly at the craft market in Winterthur last month. Would you have time next week to visit the workshop?",
      },
      {
        subject: "One more thing",
        text: "If next week does not work, the Friday after would. And bring a few bowls if you like, I already have a tray in mind.",
      },
    ],
  },
  {
    id: "scr-paperbird",
    name: "Paperbird",
    address: "team@mail.paperbird.example",
    time: "07:26",
    ai: { dest: "reads", confidence: 0.88, rationale: "Bulk mail with an unsubscribe link" },
    letters: [
      {
        subject: "Welcome to Paperbird",
        text: "Your notebook is ready. Here are the three things most new members do in their first week.",
      },
    ],
  },
  {
    id: "scr-jackpot",
    name: "JackpotJodel Promo",
    address: "win@jackpotjodel-alerts.example",
    time: "06:58",
    scope: "domain",
    ai: { dest: "screened", confidence: 0.97, rationale: "A promotion from an unknown domain" },
    letters: [
      {
        subject: "You have won 3 free spins",
        text: "Your address was selected: 3 free spins and a 200% bonus are waiting. Valid for 24 hours only.",
      },
    ],
  },
  {
    id: "scr-toess",
    name: "Töss Energie",
    address: "rechnung@toess-energie.example",
    time: "06:15",
    scope: "domain",
    ai: { dest: "receipts", confidence: 0.94, rationale: "An invoice: an amount and a PDF" },
    letters: [
      {
        subject: "Your October bill is ready",
        text: "Electricity for the studio, 1 to 31 October: CHF 118.40, due 30 November. The bill is attached as a PDF.",
      },
    ],
  },
  {
    id: "scr-cinderl0ck",
    name: "Cinderlock Security",
    address: "support@cinderl0ck-secure.example",
    time: "yesterday",
    scope: "domain",
    checked: {
      reason: "impersonation",
      brand: "Cinderlock",
      domainShared: false,
      domain: "cinderl0ck-secure.example",
    },
    ai: { dest: "spam", confidence: 0.96, rationale: "" },
    letters: [
      {
        subject: "Your account has been restricted",
        text: "Your Cinderlock account was temporarily restricted. Confirm your details to restore access.",
      },
    ],
  },
  {
    id: "scr-marco",
    name: "Marco Bianchi",
    address: "marco@fiera-ceramica.example",
    time: "yesterday",
    letters: [
      {
        subject: "Exhibit at Fiera della Ceramica, Faenza, March 2027",
        text: "We would be glad to have your ceramics at the fair in March.",
      },
    ],
  },
];
const SCREENED: Plain[] = [
  {
    id: "out-fashion",
    name: "fashion-deals.example",
    address: "promo@fashion-deals.example",
    time: "12 Oct",
    scope: "domain",
    segment: "screened",
    /* Eight letters held since the rule, as the reference's row counts them. */
    letters: [
      ...Array.from({ length: 7 }, (_, i) => ({
        subject: `Offer ${i + 1}`,
        text: "This week only.",
        time: "Oct",
      })),
      { subject: "Mid-season sale: up to 70% off", text: "Everything must go." },
    ],
  },
  {
    id: "out-forum",
    name: "old-forum.example",
    address: "notify@old-forum.example",
    time: "3 Sep",
    segment: "screened",
    letters: [
      { subject: "A new reply in “Router configuration”", text: "One person answered.", time: "Aug" },
      { subject: "3 new replies in “Router configuration”", text: "Three people answered." },
    ],
  },
];
const SPAM: Plain[] = [
  {
    id: "spam-0",
    name: "win-invest.example",
    address: "crypto-bonus@win-invest.example",
    time: "Tue 3 Nov",
    segment: "spam",
    letters: [{ subject: "Your Bitcoin prize is waiting", text: "0.75 Bitcoin is waiting in your wallet." }],
  },
];
const FAILED: FailedAtGateDTO[] = [
  {
    id: "mmf-own",
    from: { name: "Mila Brunner", address: "mila@lichtgrat.example" },
    subject: "Payment advice: transfer of CHF 1,480",
    time: "08:12",
    mailboxId: "mb",
    own: true,
  },
  {
    id: "mmf-giulia",
    from: { name: "Giulia Ferrari", address: "giulia@terracotta-milano.example" },
    subject: "New bank details for invoice 2291",
    time: "yesterday",
    mailboxId: "mb",
    own: false,
  },
];
/*
 * THE LONG QUEUE (`queue=60`): the reference's sixty first-time senders, newest first. The six above stand among
 * them where their times put them. The senders the reference's pictures show (the top of the queue, the top of
 * News, the end of the list) are drawn as it draws them; the others, which no picture shows, are this page's own,
 * and hold the counts the pictures read: 60 waiting, 18 suggested for News, 54 with a suggestion.
 */
const WHY: Record<string, string> = {
  ohbox: "A personal note from a real address",
  reads: "Bulk mail with an unsubscribe link",
  screened: "A promotion from an unknown domain",
  receipts: "An invoice: an amount and a PDF",
  spam: "A known spam pattern",
};
type Row = [name: string, address: string, time: string, dest: string | null, subject: string, text: string];
const long = (
  i: number,
  [name, address, time, dest, subject, text]: Row,
  older: { subject: string; text: string; time: string }[] = [],
  confidence = 0.8 + (i % 18) / 100,
): Plain => ({
  id: `scr-q${i}`,
  name,
  address,
  time,
  scope: dest === "receipts" || dest === "screened" || dest === "spam" ? "domain" : "sender",
  ai: dest ? { dest, confidence, rationale: WHY[dest] ?? "" } : undefined,
  letters: [...older, { subject, text, time }],
});
const SIX = new Map(WAITING.map((p) => [p.id, p]));
const LONG: Plain[] = [
  long(
    1,
    [
      "Sandro Keller",
      "sandro@schlosserei-keller.example",
      "08:58",
      "ohbox",
      "Brackets for the kiln shelf",
      "I can weld the four brackets by Friday. Raw steel or powder-coated?",
    ],
    [],
    0.91,
  ),
  SIX.get("scr-lena")!,
  long(3, [
    "Elif Aydin",
    "elif@schulhaus-lindenhof.example",
    "08:21",
    "ohbox",
    "A class visit in January?",
    "I teach art to two classes of sixteen. Could they visit the studio and throw one bowl each?",
  ]),
  long(4, [
    "Henrik Voss",
    "henrik@nordlicht-galerie.example",
    "08:05",
    null,
    "Group show in May",
    "Six makers, four weeks, 35% commission. Applications are open until January.",
  ]),
  long(5, [
    "Noemi Graf",
    "noemi@graf-floristik.example",
    "07:49",
    "ohbox",
    "Vases for the shop window",
    "Twelve small vases for December, if the glaze allows.",
  ]),
  long(6, [
    "Dealwelle",
    "offers@dealwelle.example",
    "07:31",
    "screened",
    "Black week starts now: 60% off",
    "Every offer ends at midnight.",
  ]),
  SIX.get("scr-paperbird")!,
  long(8, [
    "Tonwerk Supply",
    "orders@tonwerk-supply.example",
    "07:15",
    "receipts",
    "Order 88213: 40 kg stoneware",
    "Shipped today. Paid by card.",
  ]),
  long(
    9,
    [
      "Bergwetter",
      "morgen@bergwetter.example",
      "07:00",
      "reads",
      "Föhn on Tuesday",
      "Warm and dry until Wednesday evening, then rain from the west.",
    ],
    [{ subject: "The week ahead", text: "Clear mornings, fog in the valleys.", time: "yesterday" }],
  ),
  SIX.get("scr-jackpot")!,
  long(11, [
    "Paketpunkt",
    "tracking@paketpunkt.example",
    "06:50",
    "receipts",
    "Parcel 99.31.208 delivered",
    "Handed over at the door.",
  ]),
  long(
    12,
    [
      "Tonpost",
      "wochenbrief@tonpost.example",
      "06:40",
      "reads",
      "Issue 212: ash glazes from the garden",
      "What three kinds of wood ash do to one glaze.",
    ],
    [
      { subject: "Issue 210: reclaiming clay", text: "Slaking, drying, wedging.", time: "28 Oct" },
      { subject: "Issue 211: a cheaper firing", text: "Where the energy goes.", time: "4 Nov" },
    ],
  ),
  SIX.get("scr-toess")!,
  long(14, [
    "Flyerwerk",
    "angebote@flyerwerk.example",
    "06:10",
    "screened",
    "Postcards at half price",
    "Until Sunday only.",
  ]),
  long(15, [
    "Werkbank Weekly",
    "hello@werkbankweekly.example",
    "06:02",
    "reads",
    "Five jigs worth building",
    "A centring jig, a handle jig and three you have not thought of.",
  ]),
  long(16, [
    "Zahlstelle",
    "konto@zahlstelle-info.example",
    "05:44",
    "spam",
    "Your payment was declined",
    "Enter your card again to avoid a fee.",
  ]),
  long(17, [
    "Studio Ledger",
    "notes@studioledger.example",
    "05:30",
    "reads",
    "Pricing handmade work in 2027",
    "What an hour of work is worth.",
  ]),
  SIX.get("scr-cinderl0ck")!,
  SIX.get("scr-marco")!,
  long(20, [
    "Rahel Frei",
    "rahel@frei-textil.example",
    "yesterday",
    "ohbox",
    "Linen for the tea towels",
    "I can weave forty by the end of the month.",
  ]),
  long(21, [
    "Jonas Berger",
    "jonas@berger-schreinerei.example",
    "yesterday",
    null,
    "Shelves for the shop",
    "Would oak or ash suit the room better?",
  ]),
  long(22, [
    "Formfrage",
    "brief@formfrage.example",
    "yesterday",
    "reads",
    "Why handles fail",
    "Three joints under a microscope, and the one that held.",
  ]),
  long(23, [
    "Erdwerk",
    "rechnung@erdwerk.example",
    "yesterday",
    "receipts",
    "Invoice 2290: grog, 10 kg",
    "Due in thirty days.",
  ]),
  long(24, [
    "Klickplus",
    "team@klickplus.example",
    "yesterday",
    "screened",
    "Double your visitors",
    "A free check of your site.",
  ]),
  long(25, [
    "Postfach Hilfe",
    "hilfe@postfach-hilfe.example",
    "yesterday",
    "spam",
    "Your mailbox will be closed",
    "Sign in today to keep it.",
  ]),
  long(26, [
    "Nina Wyss",
    "nina@wyss-cafe.example",
    "yesterday",
    "ohbox",
    "Cups for the café",
    "Forty cups in two sizes, for March.",
  ]),
  long(27, [
    "Kiln Notes",
    "letters@kilnnotes.example",
    "yesterday",
    "reads",
    "Cone 6 in an old kiln",
    "A reader fired forty loads in a kiln from 1994. Her schedule is inside.",
  ]),
  long(28, [
    "Strom Ost",
    "abrechnung@strom-ost.example",
    "yesterday",
    "receipts",
    "Your studio's meter reading",
    "The new rate starts in January.",
  ]),
  long(29, [
    "Gewinnbüro",
    "info@gewinnbuero.example",
    "yesterday",
    "spam",
    "Your voucher is ready",
    "Send your address to receive it.",
  ]),
  long(30, [
    "Marktblatt",
    "redaktion@marktblatt.example",
    "yesterday",
    "reads",
    "Advent markets: the full list",
    "Every market of the season, by date.",
  ]),
  long(31, [
    "Kundenstrom",
    "hallo@kundenstrom.example",
    "yesterday",
    "screened",
    "Ten new customers a week",
    "A short call this week?",
  ]),
  long(32, [
    "Pia Roth",
    "pia@roth-design.example",
    "yesterday",
    "ohbox",
    "A logo for the studio?",
    "I have two sketches to show you.",
  ]),
  long(33, [
    "Beat Kunz",
    "beat@kunz-beratung.example",
    "yesterday",
    null,
    "Insurance for workshops",
    "A first talk costs nothing.",
  ]),
  long(34, [
    "Slow Type",
    "letters@slowtype.example",
    "yesterday",
    "reads",
    "A typeface cut in linoleum",
    "Twenty-six letters, one blade, four weekends.",
  ]),
  long(35, [
    "Garage Hügli",
    "service@garage-huegli.example",
    "yesterday",
    "receipts",
    "Van inspection: invoice",
    "Paid on collection.",
  ]),
  long(36, [
    "Vera Ott",
    "vera@ott-lichtbild.example",
    "Sun",
    "ohbox",
    "Photos of the new glazes",
    "Saturday morning, if the light holds.",
  ]),
  long(37, [
    "Lokalzeit",
    "newsletter@lokalzeit.example",
    "Sun",
    "reads",
    "This week in town",
    "The lights go on in the old town on Thursday at 18:00.",
  ]),
  long(38, [
    "Allesrabatt",
    "news@allesrabatt.example",
    "Sun",
    "screened",
    "The winter sale is here",
    "Up to half off.",
  ]),
  long(39, [
    "Marc Egli",
    "marc@egli-events.example",
    "Sun",
    null,
    "A workshop for our team?",
    "Twelve people, one afternoon.",
  ]),
  long(40, [
    "Kistenhaus",
    "versand@kistenhaus.example",
    "Sun",
    "receipts",
    "Order confirmed: 100 boxes",
    "Delivered next week.",
  ]),
  long(41, [
    "Druckfrisch",
    "post@druckfrisch.example",
    "Sun",
    "reads",
    "New: recycled card, 350 g",
    "A grey board that takes letterpress well. Samples on request.",
  ]),
  long(42, [
    "Webkurs24",
    "info@webkurs24.example",
    "Sun",
    "screened",
    "Free course: sell online",
    "Register in one click.",
  ]),
  long(43, [
    "Glücksziehung",
    "ziehung@gluecksziehung.example",
    "Sun",
    "spam",
    "You were drawn",
    "Reply with your bank details.",
  ]),
  long(44, [
    "Ruth Gerber",
    "ruth@quartier-west.example",
    "Sat",
    "ohbox",
    "A stall at the spring fair",
    "Stalls for makers are free this year.",
  ]),
  long(45, [
    "Werkstattbrief",
    "brief@werkstattbrief.example",
    "Sat",
    "reads",
    "Sharpening by hand",
    "Four stones and a strop.",
  ]),
  long(46, [
    "Netzwerk Mitte",
    "rechnung@netzwerk-mitte.example",
    "Sat",
    "receipts",
    "Internet for November",
    "Charged to the card on file.",
  ]),
  long(47, [
    "Sofortkredit",
    "angebot@sofortkredit.example",
    "Sat",
    "screened",
    "A loan by tomorrow",
    "No paperwork needed.",
  ]),
  long(48, [
    "Anna Moser",
    "anna@moser-keramik.example",
    "Sat",
    "ohbox",
    "Could I borrow the extruder?",
    "Only for a weekend in December.",
  ]),
  long(49, [
    "Stadtvelo",
    "tour@stadtvelo.example",
    "Sat",
    "reads",
    "Routes for the cold months",
    "Five loops that stay in the sun.",
  ]),
  long(50, [
    "Galerie am Hang",
    "programm@galerie-am-hang.example",
    "Fri",
    "reads",
    "The December programme",
    "Two shows and a night of readings.",
  ]),
  long(51, [
    "Bahnbillett",
    "tickets@bahnbillett.example",
    "Fri",
    "receipts",
    "Your ticket: Winterthur to Bern, 19 November",
    "Second class, half fare.",
  ]),
  long(52, [
    "Umfragepanel",
    "panel@umfragepanel.example",
    "Fri",
    "screened",
    "Vouchers for your opinion",
    "Ten minutes a survey.",
  ]),
  long(53, [
    "Tom Aebi",
    "tom@lehmbau-aebi.example",
    "Fri",
    null,
    "Leftover clay, free to collect",
    "We have 300 kg of red clay from a building site. Yours if you fetch it.",
  ]),
  long(54, [
    "Lesekreis",
    "post@lesekreis.example",
    "Fri",
    "reads",
    "The January book is chosen",
    "We meet on the 14th.",
  ]),
  long(55, [
    "Hefe & Zeit",
    "brot@hefeundzeit.example",
    "Thu",
    "reads",
    "Sourdough in a cold kitchen",
    "What to change in a cold room.",
  ]),
  long(56, [
    "Ofenbau Marti",
    "buero@ofenbau-marti.example",
    "Thu",
    "receipts",
    "Kiln element: invoice 2026-311",
    "One element and an hour of work.",
  ]),
  long(57, [
    "Reiseschnapper",
    "deals@reiseschnapper.example",
    "Thu",
    "screened",
    "Mallorca from CHF 199",
    "Book by Sunday.",
  ]),
  long(58, [
    "Farbkreis",
    "studio@farbkreis.example",
    "Thu",
    "reads",
    "Sage, moss, lichen: three greens",
    "Mixed from two pigments each.",
  ]),
  long(59, [
    "Markthalle Lind",
    "stand@markthalle-lind.example",
    "5 Nov",
    "receipts",
    "Stand fee for the Advent market",
    "Thank you for booking.",
  ]),
  long(60, [
    "Machergilde",
    "news@machergilde.example",
    "5 Nov",
    "reads",
    "Members’ evening, 3 December",
    "Soup, a short talk and the tool swap.",
  ]),
];
const MANY: Plain[] = queue > 0 ? LONG.slice(0, queue) : [];

const nothing = () => undefined;
const cleared = state === "clear" || state === "importing" || state === "listing";
const waiting = cleared
  ? []
  : queue > 0
    ? MANY.map(senderOf)
    : WAITING.filter((p) => !(did && p.id === "scr-lena")).map(senderOf);
/* With everyone decided, the promotion and the lookalike stand on the shelves they were decided to (3 and 2). */
const CLEARED: Plain[] =
  state === "clear"
    ? [
        { ...SIX.get("scr-jackpot")!, segment: "screened" },
        { ...SIX.get("scr-cinderl0ck")!, segment: "spam" },
      ]
    : [];
const screenedOut = [...SCREENED, ...CLEARED.filter((p) => p.segment === "screened")].map(senderOf);
const spam: SpamRow[] = [...SPAM, ...CLEARED.filter((p) => p.segment === "spam")].map((p) => ({
  sender: senderOf(p),
  pinned: false,
}));
const bodies = new Map<string, unknown>(
  [...WAITING, ...SCREENED, ...SPAM, ...MANY, ...CLEARED].flatMap((p) =>
    p.letters.map((l, i): [string, unknown] => [
      `${p.id}-${i}`,
      { state: "ready", text: l.text, html: null },
    ]),
  ),
);
for (const f of FAILED)
  bodies.set(f.id, { state: "ready", text: "Please find the advice attached.", html: null });

const role: ScreenerState["role"] =
  org === "pending"
    ? { mode: "pending", name: "ohmail Cloud", reason: null, oauthOnly: false }
    : org === "refused"
      ? { mode: "blocked", name: "ohmail on a Mac", reason: "organizer_outdated", oauthOnly: false }
      : org === "nobody"
        ? { mode: "blocked", name: null, reason: "no_organizer", oauthOnly: false }
        : state === "reader"
          ? {
              mode: "blocked",
              name: "ohmail Cloud",
              reason: "organizer_outdated",
              oauthOnly: q.get("oauth") === "1",
            }
          : { mode: "organizer", name: null, reason: null, oauthOnly: false };

const more = state === "more" || state === "more-loading" || state === "more-failed";
const model = {
  waiting,
  waitingCount: state === "listing" ? 4 : waiting.length,
  waitingSource: state === "listing" ? "device" : "store",
  queueAnswered: true,
  copyBehind: false,
  queueSettled: state !== "importing",
  storeSettled: true,
  waitingMore: {
    available: more,
    loading: state === "more-loading",
    failed: state === "more-failed",
    load: nothing,
  },
  rereadWaiting: nothing,
  heldRelease:
    state === "held"
      ? {
          total: 3,
          rulesTotal: 3,
          groups: [],
          senders: [],
          releasing: false,
          release: nothing,
          dismiss: nothing,
        }
      : null,
  impersonationFiled:
    state === "claimed" || state === "claimed-list"
      ? {
          items: [
            {
              messageId: "cl-1",
              from: "billing@hostwerk-rechnung.example",
              subject: "Your domain expires today",
              brand: "Hostwerk",
            },
            {
              messageId: "cl-2",
              from: "team@paperbird-login.example",
              subject: "Sign in to keep your workspace",
              brand: "Paperbird",
            },
          ],
          open: state === "claimed-list",
          toggle: nothing,
          busy: false,
          said:
            q.get("told") === "claimedasked"
              ? "requested"
              : q.get("told") === "claimedfailed"
                ? "failed"
                : null,
          putBack: nothing,
          acknowledge: nothing,
        }
      : null,
  unscreened: null,
  failedAtGate: state === "failed" ? FAILED : [],
  fileFailed: nothing,
  suggestedCount: waiting.filter((w) => w.ai && w.ai.dest !== "screener").length,
  suggestedDests: APPLY_PILE_ORDER.filter((dest) => waiting.some((w) => w.ai?.dest === dest)),
  unsuggestedSenders: [],
  suggestedSenders: [],
  applying: null,
  screenedOut,
  spam,
  isExiting: () => false,
  bodyStall: () => null,
  decide: nothing,
  reachOf: () => ({ others: [], inboxIds: [] }),
  /* A sender suggested for News or Screen out offers an unsubscribe, as the reference's do. */
  unsubClaimOf: (s: ScreenerSenderDTO) =>
    s.ai?.dest === "reads" || s.ai?.dest === "screened" ? "sends" : "none",
  applyAll: nothing,
  markAllSpam: nothing,
  spamAllCount: waiting.length,
  allowScreened: nothing,
  notSpamToWaiting: nothing,
  notSpamToOhbox: nothing,
  deleteSpam: nothing,
  refused: () => false,
  flush: nothing,
  role,
  pending: [],
  decided: [],
  notApplied: [],
} as unknown as ScreenerState;

const engine = {
  read: () => ({ get: (type: string, id: string) => (type === "message_body" ? bodies.get(id) : undefined) }),
  verbRead: () => ({ get: () => undefined }),
  subscribe: () => () => undefined,
  hydrateBodies: async () => undefined,
  hydrateBody: async () => undefined,
} as unknown as OhmailEngine;

const suggest: ScreenerSuggest = {
  priced: true,
  control: {
    available: show === "suggest" ? 1 : waiting.filter((w) => !w.ai).length,
    resuggestable: waiting.filter((w) => w.ai).length,
    pool: 1,
    sizes: [1],
    size: 1,
    phase: show === "suggest" ? "ready" : "closed",
    quote: show === "suggest" ? { senders: 1, credits: 1 } : null,
    notice: null,
    progress: null,
    open: nothing,
    openAgain: nothing,
    choose: nothing,
    confirm: nothing,
    cancel: nothing,
  },
};

/* The mail server's Junk, as the reference's folder holds it while a state of it stands (invented, .example). */
const junkItem = (
  uid: number,
  name: string | null,
  address: string,
  date: string,
  subject: string,
  origin: "verdict" | "provider",
): ScreenerJunkItem => ({
  mailboxId: "mb",
  uidValidity: "1",
  uid,
  subject,
  from: { name, address },
  date,
  messageIdHeader: null,
  seen: false,
  origin,
});
const JUNK: ScreenerJunkItem[] = [
  junkItem(
    5,
    null,
    "service@konto-check.example",
    "2026-11-09T08:12:00Z",
    "Confirm your account within 24 hours",
    "provider",
  ),
  junkItem(
    4,
    null,
    "deals@megarabatt.example",
    "2026-11-08T07:30:00Z",
    "Designer watches, 90% off today",
    "provider",
  ),
  junkItem(
    3,
    null,
    "post@lotto-gewinn.example",
    "2026-11-06T16:05:00Z",
    "You are our winner of the week",
    "verdict",
  ),
  junkItem(
    2,
    null,
    "hinweis@speicher-voll.example",
    "2026-11-05T11:40:00Z",
    "Your mailbox is 99% full",
    "provider",
  ),
  junkItem(
    1,
    null,
    "crypto-bonus@win-invest.example",
    "2026-11-03T08:00:00Z",
    "Your Bitcoin prize is waiting",
    "verdict",
  ),
];
const FOUND: ScreenerJunkItem[] = [
  junkItem(
    91,
    null,
    "prize@sommer-los.example",
    "2026-09-18T10:00:00Z",
    "Claim your prize before Friday",
    "provider",
  ),
  junkItem(
    92,
    null,
    "info@reise-gewinn.example",
    "2026-08-02T10:00:00Z",
    "Prize draw: you were selected",
    "provider",
  ),
];
const JUNK_TEXT: Record<number, string> = {
  5: "Your account will be suspended unless you confirm your details within 24 hours.",
  4: "Only today: every watch in the outlet at 90% off.",
  3: "Your address was drawn in this week’s lottery.",
  2: "Your mailbox has almost reached its limit.",
  1: "0.75 Bitcoin is waiting in your wallet.",
  91: "Your prize is reserved until Friday.",
  92: "You were selected in our travel prize draw.",
};
const FIND: Record<string, string> = {
  "find-more": "prize",
  "find-none": "invoice",
  "find-server": "invoice",
  "find-found": "prize",
  "find-nothing": "invoice",
  "find-cut": "prize",
  "find-away": "prize",
  "find-failed": "invoice",
};
const junkOf = (): ScreenerJunk => {
  const query = (state && FIND[state]) ?? "";
  /* With no state named the folder holds its one letter your verdict put there; a state names the folder's five. */
  const items =
    state === "empty"
      ? []
      : state === null
        ? JUNK.filter((i) => i.origin === "verdict" && i.uid === 1)
        : JUNK.map((i, n) =>
            n === 0 && state === "moving"
              ? { ...i, rescue: "queued" as const }
              : n === 0 && state === "notmoved"
                ? { ...i, rescue: "refused" as const, rescueId: "r-1" }
                : i,
          );
  const kept = query
    ? items.filter((i) => `${i.from.address} ${i.subject}`.toLowerCase().includes(query))
    : items;
  const found = state === "find-found" || state === "find-cut" || state === "find-away" ? FOUND : [];
  const phase = {
    "find-more": "local",
    "find-none": "local",
    "find-server": "searching",
    "find-failed": "failed",
  }[state ?? ""] as ScreenerJunk["search"]["phase"] | undefined;
  return {
    supported: true,
    phase: state === "reading" ? "loading" : state === "unread" ? "failed" : "ready",
    items,
    visible: [...kept, ...found],
    mailboxes: [
      { id: "mb", address: "mila@lichtgrat.example", window: state === "away" ? "unreachable" : "ok" },
    ],
    nextCursor: query ? null : "older",
    olderLoading: state === "older",
    reload: nothing,
    loadOlder: nothing,
    bodyFor: (i) =>
      i.uid === 5 && state === "letter-reading"
        ? { phase: "loading", attempt: 1 }
        : i.uid === 5 && state === "letter-failed"
          ? { phase: "failed" }
          : { phase: "ready", text: JUNK_TEXT[i.uid] ?? "" },
    openBody: nothing,
    rescue: nothing,
    rescuing: () => false,
    dismissRescue: nothing,
    search: {
      query,
      setQuery: nothing,
      phase: query ? (phase ?? "done") : "idle",
      hits: found,
      localCount: kept.length,
      mailboxes:
        state === "find-away" ? [{ id: "mb", address: "mila@lichtgrat.example", window: "unreachable" }] : [],
      truncated: state === "find-cut",
      searchServer: nothing,
    },
  };
};

const beside: ScreenerBeside = {
  letters: NONE,
  junk: junkOn ? junkOf() : NONE,
  unsubscribe: NONE,
  mailboxWord: () => null,
  suggest,
  invitation: NONE,
  facts: {
    settled: state !== "importing",
    owed: state === "importing",
    storeImportOpen: state === "importing",
    notOrganizingYet: null,
  },
  undo: () => false,
};

const words: Messages = fillOver(
  { ...FRAME_WORDS.en, ...(screenerEn as Messages), ...(sharedEn as Messages) },
  lang === "de" ? { ...FRAME_WORDS.de, ...(screenerDe as Messages), ...(sharedDe as Messages) } : {},
);

const entry = (
  id: string,
  label: string,
  icon: RailModel["groups"][number]["entries"][number]["icon"],
  count?: string,
  current?: boolean,
) => ({ id, kind: "place" as const, label, icon, count, current, onPress: nothing });
const RAIL: RailModel = {
  groups: [
    {
      id: "main",
      entries: [
        entry("ohbox", "Ohbox", "ohbox", "5"),
        entry("news", "News", "news", "5"),
        entry("receipts", "Receipts", "receipts", "2"),
      ],
    },
    {
      id: "screener",
      entries: [
        entry("screener", "Screener", "screener", waiting.length ? String(waiting.length) : undefined, true),
      ],
    },
    {
      id: "later",
      entries: [
        entry("later", "Answer Later", "later", "2"),
        entry("parked", "Parked", "parked", "1"),
        entry("resurface", "Resurface", "resurface", "1"),
      ],
    },
    { id: "tags", entries: [{ id: "tags", kind: "fold", label: "Tags", expanded: false, onPress: nothing }] },
    {
      id: "more",
      entries: [
        entry("history", "History", "history"),
        entry("search", "Search", "search"),
        entry("drafts", "Drafts", "drafts", "1"),
        entry("settings", "Settings", "settings"),
      ],
    },
  ],
  write: { label: "Write", onPress: nothing },
  account: {
    name: "Mila Brunner",
    address: "mila@lichtgrat.example",
    note: "2 mailboxes",
    title: "Account",
    onPress: nothing,
  },
  pull: { label: "Pull new mail", busy: false, onPress: nothing },
};

function List(props: PaneProps) {
  useRailModel(RAIL);
  return <ScreenerList {...props} />;
}
const screener: PlaceEntry = {
  ...screenerPlace,
  panes: { ...screenerPlace.panes, List } as PlaceEntry["panes"],
};

const press = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
const byName = (role: string, name: string) =>
  [...document.querySelectorAll<HTMLElement>(role)].find(
    (el) => el.getAttribute("aria-label") === name || el.textContent?.trim() === name,
  );

function Page() {
  useEffect(() => {
    /* Each step waits for the draw the step before it caused: the reading column draws after the list. */
    const steps: (() => void)[] = [];
    /* The reference's open sender: a press on its row, as a person opens it. */
    const open = did ? "scr-paperbird" : askedOpen && askedOpen !== "none" ? askedOpen : null;
    if (open) steps.push(() => document.querySelector<HTMLElement>(`[data-id="${open}"]`)?.click());
    if (show === "slot") steps.push(() => byName("button", "Choose where this sender's mail goes")?.click());
    if (show === "more") steps.push(() => press('[data-more=""]'));
    if (show === "card") steps.push(() => press(".sc-sentence-tools button"));
    if (show === "allspam") {
      steps.push(() => byName("button", "List")?.click());
      steps.push(() => byName('[role="menuitem"]', "Mark all spam")?.click());
    }
    if (show === "filter" || q.get("only") === "news")
      steps.push(() => press(".sc-tools button[aria-haspopup]"));
    if (q.get("only") === "news")
      steps.push(() =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
          .find((el) => el.querySelector(".oh-menu-word")?.textContent === "News")
          ?.click(),
      );
    if (show === "unsub")
      steps.push(() =>
        [...document.querySelectorAll<HTMLElement>('[role="toolbar"] button')]
          .find((b) => b.textContent?.startsWith("Screen out"))
          ?.click(),
      );
    if (show === "menu")
      steps.push(() =>
        document
          .querySelector<HTMLElement>(`[data-id="${askedOpen ?? "scr-lena"}"]`)
          ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 420, clientY: 280 })),
      );
    /* Show more senders stands at the end of the queue: the reference draws the list scrolled to its end there. */
    if (more)
      steps.push(() => {
        const box = document.querySelector<HTMLElement>(".sc-scroll");
        if (box) box.scrollTop = box.scrollHeight;
      });
    const timers = steps.map((step, i) => setTimeout(step, 40 * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <ScreenerAbove model={model} beside={beside}>
      <Frame host={host} />
    </ScreenerAbove>
  );
}

const look = {
  face: q.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
  scheme: q.get("scheme") === "dark" ? "dark" : "light",
} as const;
/* The person's text size, as the web door stamps it on the root: `zoom=1.5` for 150 %. */
const zoom = Number(q.get("zoom") ?? "1");
if (zoom !== 1) {
  document.documentElement.style.setProperty("zoom", String(zoom));
  document.documentElement.style.setProperty("--ui-zoom", String(zoom));
}
document.documentElement.setAttribute("data-face", look.face);
document.documentElement.setAttribute("data-theme", look.scheme);
const { host: made } = fakeHost({
  engine,
  service: "managed",
  scope: "mila",
  places: { screener },
  window: fakeWindow({ ...room, posture: "flat", reducedMotion: true }),
  address: fakeAddress(sec ? `#/screener/${sec}` : "#/screener"),
  appearance: fakeAppearance(look),
});
/* Whose machine sends a one-click unsubscribe: the host's own answer, as the question words it. */
const host = {
  ...made,
  capabilities: {
    ...made.capabilities,
    unsubscribeFrom: q.get("how") === "computer" ? "computer" : "service",
  },
} as typeof made;

createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words} timeZone="Europe/Zurich">
    <Page />
  </TextProvider>,
);
