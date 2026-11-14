/**
 * THE PLACES' STATES PAGE'S WORLD: plain letters of the reference's people, written for this page (the places' own
 * test data, not the design's), on Tuesday 10 November 2026 at 09:30 (the comparison draws in UTC, and so does this world). Each letter says where it lies, so
 * History and an address can name its place, and which tags it carries.
 */
import type { EngineDraft, EngineMessage, FolderEntity, TagDTO, TrashRowWire } from "@ohmail/client-engine";

export const NOW = new Date("2026-11-10T09:30:00.000Z");
/** An hour of today. */
const today = (h: number, m: number): string => new Date(Date.UTC(2026, 10, 10, h, m)).toISOString();
/** An hour `d` days ago. */
const ago = (d: number, h = 9, m = 0): string => new Date(Date.UTC(2026, 10, 10 - d, h, m)).toISOString();

interface Plain {
  id: string;
  from: string;
  address: string;
  subject: string;
  snippet?: string;
  date: string;
  unread?: boolean;
  file?: boolean;
  code?: boolean;
  labels?: string[];
  folder?: string;
  place?: string;
}

/** Where a letter lies, in the person's words: History and an address say it on each row. */
const PLACE = new Map<string, string>();

function letter(p: Plain): EngineMessage {
  PLACE.set(p.id, p.place ?? "Ohbox");
  return {
    id: p.id,
    accountId: "mila",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: p.subject,
    from: { name: p.from, address: p.address },
    to: [{ name: "Mila Brunner", address: "mila@lichtgrat.example" }],
    cc: [],
    date: p.date,
    folder: p.folder ?? "INBOX",
    snippet: p.snippet ?? "",
    unread: p.unread ?? false,
    hasAttachments: p.file ?? false,
    attachmentCount: p.file ? 1 : 0,
    protected: p.code ? { kind: "code" } : null,
    sensitivity: {
      sensitive: false,
      category: null,
      no_ai: false,
      no_forward: false,
      no_kb: false,
      priority: false,
    },
    triage: null,
    labels: p.labels ?? [],
    remoteContent: "none",
    updatedAt: p.date,
  } as unknown as EngineMessage;
}

export const placeOf = (m: EngineMessage): string => PLACE.get(m.id) ?? "Ohbox";

/* News: five above the line, three under it. */
export const NEWS: readonly EngineMessage[] = [
  letter({
    id: "news-skylark",
    from: "Skylark Notes",
    address: "mara@skylarknotes.example",
    date: today(7, 2),
    unread: true,
    place: "News",
    subject: "#131: the joy of small tools",
    snippet:
      "A letter about tools that do one thing well: a ladle that pours without dripping, a pencil that starts every list.",
  }),
  letter({
    id: "news-blattgang",
    from: "Blattgang",
    address: "post@blattgang.example",
    date: today(6, 31),
    unread: true,
    place: "News",
    subject: "Why paper keeps winning",
    snippet:
      "Three hundred years of interface design, still undefeated. This week: ledgers, index cards and one stubborn stationer.",
  }),
  letter({
    id: "news-makersdozen",
    from: "The Maker's Dozen",
    address: "hello@makersdozen.example",
    date: today(5, 12),
    unread: true,
    place: "News",
    subject: "#47: twelve things makers liked this month",
  }),
  letter({
    id: "news-gratbrief",
    from: "Gratbrief",
    address: "post@gratbrief.example",
    date: today(4, 58),
    unread: true,
    place: "News",
    subject: "This week's walk: the Chäserrugg ridge in first snow",
  }),
  letter({
    id: "news-fruehbrief",
    from: "Frühbrief",
    address: "briefing@fruehbrief.example",
    date: today(4, 30),
    unread: true,
    place: "News",
    subject: "Morning briefing: the Advent market weekend",
  }),
  letter({
    id: "news-pixelthread",
    from: "Pixel & Thread",
    address: "letter@pixelthread.example",
    date: ago(1, 7, 15),
    place: "News",
    subject: "Weaving colour into everything",
    snippet: "A dye garden in its second year, a palette tool worth keeping, and one brave experiment.",
  }),
  letter({
    id: "news-roest",
    from: "Röstsonntag",
    address: "hallo@roestsonntag.example",
    date: ago(2),
    place: "News",
    subject: "November roast: Kenya AA",
    snippet:
      "Blackcurrant, bright, best before noon. Ships Monday to subscribers, a few bags left for everyone else.",
  }),
  letter({
    id: "news-bergbahn",
    from: "Bergbahn Club",
    address: "club@bergbahnclub.example",
    date: ago(2, 8),
    place: "News",
    subject: "Your winter pass is active",
    snippet: "All 23 lifts from 28 November to Easter. This letter also has the opening dates by valley.",
  }),
];
export const NEWS_FRESH = 5;

/* Receipts: two above the line, five under it. */
export const RECEIPTS: readonly EngineMessage[] = [
  letter({
    id: "rcpt-brandung",
    from: "Brandung Records",
    address: "tickets@brandung.example",
    date: today(8, 20),
    unread: true,
    file: true,
    place: "Receipts",
    subject: "Your tickets: Winternacht, 21 November",
    snippet: "2 × Winternacht, Saturday 21 November, doors 19:30. Row 8, seats 14 and 15. Tickets attached.",
  }),
  letter({
    id: "rcpt-kino",
    from: "Kino Seeblick",
    address: "tickets@kino-seeblick.example",
    date: today(7, 41),
    unread: true,
    place: "Receipts",
    subject: "Your tickets: film night, Thursday 20:15",
    snippet: "2 × balcony, Thursday 12 November, 20:15. Show this letter at the door.",
  }),
  letter({
    id: "rcpt-erdton",
    from: "Atelier Erdton",
    address: "billing@erdton-atelier.example",
    date: ago(4, 11),
    file: true,
    labels: ["paperwork"],
    place: "Receipts",
    subject: "Invoice #091: Glaze & Fire workshop",
    snippet: "Workshop «Glaze & Fire», 2 places, 24 October. Payable within 30 days. Invoice attached.",
  }),
  letter({
    id: "rcpt-roest",
    from: "Röstsonntag",
    address: "hallo@roestsonntag.example",
    date: ago(4, 8),
    place: "Receipts",
    subject: "Receipt: November roast subscription",
    snippet: "Kenya AA, 500 g, ships Monday. Your subscription renewed for another month.",
  }),
  letter({
    id: "rcpt-speichenhof",
    from: "Speichenhof Velos",
    address: "werkstatt@speichenhof.example",
    date: ago(5, 15),
    place: "Receipts",
    subject: "Bike service: ready to collect",
    snippet: "New chain, fresh brake pads, winter tyres fitted. Collect any day until 18:30.",
  }),
  letter({
    id: "rcpt-alpenbahn",
    from: "Alpenbahn",
    address: "tickets@alpenbahn.example",
    date: ago(5, 9),
    file: true,
    place: "Parked",
    subject: "Your ticket Winterthur–Lugano, 14 November",
  }),
  letter({
    id: "rcpt-pigment",
    from: "Pigment & Papier",
    address: "shop@pigmentpapier.example",
    date: ago(6, 14),
    place: "Receipts",
    subject: "Order #5521 shipped",
    snippet: "Gouache set and two brushes are on the way to the studio. Expected Thursday.",
  }),
];
export const RECEIPTS_FRESH = 2;

/* The Ohbox's letters History, Tags and an address read. */
const giulia = letter({
  id: "giulia-glaze",
  from: "Giulia Ferrari",
  address: "giulia@terra-cotta.example",
  date: today(9, 12),
  unread: true,
  file: true,
  labels: ["pottery"],
  subject: "Re: Glaze order #2291",
  snippet: "Both glazes leave Milan today and reach the studio on Thursday.",
});
const petraTalk = letter({
  id: "petra-talk",
  from: "Petra Wyss",
  address: "petra@makersfest.example",
  date: today(8, 47),
  unread: true,
  file: true,
  subject: "Your talk is on the programme",
  snippet: "“Wabi-sabi for web people” made the final programme: Saturday at 11:00 in the main hall.",
});
const petraInvite = letter({
  id: "petra-invite",
  from: "Petra Wyss",
  address: "petra@makersfest.example",
  date: today(8, 39),
  subject: "Invitation: Tech check, main hall",
  snippet: "Petra Wyss invited you: Friday 20 November, 16:00, main hall. Fifteen minutes on stage.",
});
const nadjaTime = letter({
  id: "nadja-time",
  from: "Nadja Lehner",
  address: "nadja@erdton-atelier.example",
  date: today(8, 35),
  subject: "New time proposed: glaze evening planning call",
});
const cinderlock = letter({
  id: "cinderlock-code",
  from: "Cinderlock",
  address: "no-reply@cinderlock.example",
  date: today(8, 31),
  code: true,
  subject: "Your verification code",
});
const benKiln = letter({
  id: "ben-kiln",
  from: "Ben Arnold",
  address: "ben@kiln.example",
  date: today(7, 58),
  unread: true,
  labels: ["pottery"],
  subject: "Kiln is fixed, and Friday pizza",
  snippet: "The new element arrived early and the kiln heats evenly again.",
});
const flurinaFull = letter({
  id: "flurina-full",
  from: "Flurina Caduff",
  address: "flurina@haldenlicht.example",
  date: ago(1, 16),
  labels: ["pottery"],
  subject: "Saturday's workshop is full",
  snippet: "All twelve places are booked, and two people already asked about a second date.",
});
const retoPhotos = letter({
  id: "reto-photos",
  from: "Reto Frei",
  address: "reto@frei.example",
  date: ago(1, 11),
  file: true,
  labels: ["adventures"],
  subject: "Photos from the ridge",
  snippet: "The promised photos from the ridge. The sunrise was worth the four o'clock start.",
});
const timTickets = letter({
  id: "tim-tickets",
  from: "Tim Berger",
  address: "tim@gassenblatt.example",
  date: ago(3, 18),
  labels: ["adventures"],
  subject: "Got us tickets for the 21st",
  snippet: "Row 8, right side, close enough to see the drummer. I will forward the details.",
});
const carlaPosters = letter({
  id: "carla-posters",
  from: "Carla Meier",
  address: "carla@wintermarkt-lind.example",
  date: ago(3, 10),
  subject: "The posters went up on Friday",
  snippet: "Half the neighbourhood asked who made them. See you at the market on Saturday.",
});
const nadjaGlaze = letter({
  id: "nadja-glaze",
  from: "Nadja Lehner",
  address: "nadja@erdton-atelier.example",
  date: ago(4, 17),
  labels: ["pottery"],
  place: "Answer Later",
  subject: "Would you teach the December glaze evening?",
});
const jonasStudio = letter({
  id: "jonas-openstudio",
  from: "Jonas Halter",
  address: "jonas@halter.example",
  date: ago(4, 9),
  place: "Answer Later",
  subject: "Open studio in December: which weekend?",
});
const rahelInvoice = letter({
  id: "rahel-invoice",
  from: "Rahel Beck",
  address: "rahel@lichtgrat.example",
  date: ago(5, 17),
  file: true,
  labels: ["paperwork"],
  subject: "Invoice template, final",
  snippet: "Final version attached, with the new bank details and the VAT line moved under the total.",
});
const hostwerk = letter({
  id: "hostwerk-renewal",
  from: "Hostwerk",
  address: "support@hostwerk.example",
  date: ago(7),
  labels: ["paperwork"],
  subject: "Domain renewal: lichtgrat.example expires 30 November",
});
const petraSlides = letter({
  id: "petra-slides",
  from: "Petra Wyss",
  address: "petra@makersfest.example",
  date: ago(6, 10),
  place: "Resurface",
  subject: "Makersfest: slides due",
});
const flurinaSoon = letter({
  id: "flurina-soon",
  from: "Flurina Caduff",
  address: "flurina@haldenlicht.example",
  date: ago(2, 12),
  place: "Resurface",
  subject: "Saturday's workshop is full",
});

/* History: every letter, newest first. */
export const HISTORY: readonly EngineMessage[] = [
  giulia,
  petraTalk,
  petraInvite,
  nadjaTime,
  cinderlock,
  RECEIPTS[0]!,
  benKiln,
  RECEIPTS[1]!,
  ...NEWS,
  flurinaFull,
  retoPhotos,
  timTickets,
  carlaPosters,
  nadjaGlaze,
  jonasStudio,
  RECEIPTS[2]!,
  RECEIPTS[3]!,
  rahelInvoice,
  RECEIPTS[4]!,
  RECEIPTS[5]!,
  RECEIPTS[6]!,
  hostwerk,
];

/* Tags. */
export const TAGS: readonly TagDTO[] = [
  { id: "pottery", name: "Pottery Project", hue: "30", createdAt: ago(60), updatedAt: ago(60) },
  { id: "paperwork", name: "Paperwork", hue: "45", createdAt: ago(60), updatedAt: ago(60) },
  { id: "adventures", name: "Adventures", hue: "10", createdAt: ago(60), updatedAt: ago(60) },
] as unknown as TagDTO[];
export const TAGGED: readonly EngineMessage[] = [
  giulia,
  benKiln,
  flurinaFull,
  nadjaGlaze,
  hostwerk,
  rahelInvoice,
  RECEIPTS[2]!,
  retoPhotos,
  timTickets,
];

/* The piles. */
export const LATER: readonly EngineMessage[] = [nadjaGlaze, jonasStudio];
export const PARKED: readonly EngineMessage[] = [RECEIPTS[5]!];
export const RESURFACE: readonly { message: EngineMessage; at: string }[] = [
  { message: flurinaSoon, at: new Date(Date.UTC(2026, 10, 11, 8)).toISOString() },
  { message: petraSlides, at: new Date(Date.UTC(2026, 10, 16, 8)).toISOString() },
];

/* Folders. */
export const FOLDERS: readonly FolderEntity[] = [
  { id: "f-workshops", name: "Workshops", mailboxId: "mb", mailbox: "mila@lichtgrat.example" },
  { id: "f-rosa", name: "Clients/Gartenlokal Rosa", mailboxId: "mb", mailbox: "mila@lichtgrat.example" },
  { id: "f-clients", name: "Clients", mailboxId: "mb", mailbox: "mila@lichtgrat.example" },
];
export const IN_FOLDER: Readonly<Record<string, readonly EngineMessage[]>> = {
  "f-workshops": [
    letter({
      id: "fld-flurina-dates",
      from: "Flurina Caduff",
      address: "flurina@haldenlicht.example",
      date: ago(12, 10),
      folder: "Workshops",
      place: "Workshops",
      subject: "Workshop dates until March",
      snippet: "Every second Saturday, starting 14 November. Twelve places each.",
    }),
    letter({
      id: "fld-nadja-bring",
      from: "Nadja Lehner",
      address: "nadja@erdton-atelier.example",
      date: ago(21, 15),
      folder: "Workshops",
      place: "Workshops",
      subject: "Glaze evening: what to bring",
      snippet: "Aprons and two bisque pieces each. I bring the test tiles.",
    }),
  ],
  "f-rosa": [
    letter({
      id: "fld-anna-brunch",
      from: "Anna Odermatt",
      address: "anna@gartenlokal-rosa.example",
      date: ago(15, 11),
      folder: "Clients/Gartenlokal Rosa",
      place: "Gartenlokal Rosa",
      subject: "Sunday brunch cards",
      snippet: "Ten cards without prices would be perfect for the brunch. Same paper as the others.",
    }),
    letter({
      id: "fld-anna-rose",
      from: "Anna Odermatt",
      address: "anna@gartenlokal-rosa.example",
      date: ago(32, 14),
      folder: "Clients/Gartenlokal Rosa",
      place: "Gartenlokal Rosa",
      subject: "The rose, a little smaller",
      snippet: "Could the rose in the corner be a little smaller? It fights with the prices.",
    }),
  ],
};

/* An address: Petra's letters. */
export const PETRA = "petra@makersfest.example";
export const BY_ADDRESS: readonly EngineMessage[] = [petraTalk, petraInvite];

/* Drafts: one reply set to go tomorrow morning. */
export function scheduledDraft(held: boolean): EngineDraft {
  return {
    id: "draft-nadja",
    mailboxId: "mb",
    threadId: null,
    inReplyToMessageId: nadjaGlaze.id,
    subject: "Re: Would you teach the December glaze evening?",
    body: "Gladly. The second Saturday works best for me.",
    to: [{ name: "Nadja Lehner", address: "nadja@erdton-atelier.example" }],
    cc: [],
    bcc: [],
    rationale: null,
    status: held ? "unverified" : "scheduled",
    sendAt: new Date(Date.UTC(2026, 10, 11, 8)).toISOString(),
    createdAt: ago(1),
    updatedAt: ago(1),
  } as EngineDraft;
}

/* Trash: one deleted letter, from the Ohbox, deleted at 09:24. */
export const TRASHED: readonly TrashRowWire[] = [
  { ...cinderlock, id: "trash-cinderlock", trashedAt: today(9, 24), restoreTo: "INBOX" } as TrashRowWire,
];

/** An instant as a row prints it: the hour today, `yesterday`, the weekday this week, else the day and month. */
export function stampOf(lang: "en" | "de"): (iso: string) => string {
  const locale = lang === "de" ? "de-CH" : "en-GB";
  return (iso) => {
    const d = new Date(iso);
    const days = Math.round(
      (Date.UTC(2026, 10, 10) - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86_400_000,
    );
    if (days <= 0)
      return d.toLocaleTimeString(locale, { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
    if (days === 1) return lang === "de" ? "gestern" : "yesterday";
    if (days < 7) return d.toLocaleDateString(locale, { timeZone: "UTC", weekday: "short" });
    return d.toLocaleDateString(locale, { timeZone: "UTC", day: "numeric", month: "short" });
  };
}

/** A time to come as the reference prints a send's appointment, "Wed 11 Nov, 08:00"; a seat hands its `scheduleLabel`. */
export function appointmentOf(lang: "en" | "de"): (iso: string) => string {
  const locale = lang === "de" ? "de-CH" : "en-GB";
  return (iso) => {
    const d = new Date(iso);
    const day = d.toLocaleDateString(locale, {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    const hour = d.toLocaleTimeString(locale, { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
    return `${day.replace(",", "")}, ${hour}`;
  };
}

/** A few paragraphs a stream item shows while the reader's own letter is not handed. */
export function textOf(id: string): string {
  const m = [...NEWS, ...RECEIPTS].find((x) => x.id === id);
  if (!m) return "";
  const head = m.snippet || m.subject;
  return `${head}\n\nThis issue has more inside: a short note from the workshop, two links worth keeping and a reply from last week.\n\nUntil next time.`;
}
