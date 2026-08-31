/**
 * The ohmail demo world — every string extracted verbatim from the
 * canonical Blanc prototype (design/proposals/blanc/index.html).
 * This dataset powers the component showcase, the webapp's ?demo mode,
 * app-store screenshots and tests. Extract, never invent.
 */
import type {
  AccountFixture,
  ComposeDraftFixture,
  CountsFixture,
  Fixtures,
  MailboxFixture,
  MessageFixture,
  NotificationSettingsFixture,
  ReadsAiChipFixture,
  ReceiptsGroupFixture,
  ScreenedSenderFixture,
  ScreenerEmptyState,
  SearchDemoFixture,
  SpamItemFixture,
  TagFixture,
  TriageFixture,
  WaitingSenderFixture,
  WaterlineFixture,
} from "./types.js";

/* ------------------------------------------------------------ identity */

export const account: AccountFixture = {
  email: "mila@lichtgrat.studio",
  displayName: "Mila",
};

export const mailboxes: MailboxFixture[] = [
  {
    id: "lichtgrat",
    name: "lichtgrat.studio",
    address: "mila@lichtgrat.studio",
    provider: "Work",
    protocol: "IMAP",
    railHint: "IMAP",
    status: "Connected",
  },
  {
    id: "milabrunner",
    name: "milabrunner.ch",
    address: "hello@milabrunner.ch",
    provider: "Personal",
    protocol: "IMAP",
    railHint: "IMAP",
    status: "Connected",
  },
  {
    id: "wolkenmail",
    name: "Wolkenmail",
    address: "mila.demo@wolkenmail.ch",
    provider: "Wolkenmail",
    protocol: "IMAP",
    railHint: "IMAP",
    status: "Connected",
  },
];

/* ---------------------------------------------------------------- tags */

export const tags: TagFixture[] = [
  {
    id: "pottery",
    name: "Pottery Project",
    hue: "moss",
    className: "th-pottery",
    assignedTo: ["giulia", "flurina"],
  },
  {
    id: "buch",
    name: "Paperwork",
    hue: "ochre",
    className: "th-buch",
    assignedTo: ["erdton", "pigment"],
  },
  {
    id: "privat",
    name: "Adventures",
    hue: "rosewood",
    className: "th-privat",
    assignedTo: ["reto", "tim"],
  },
];

/** Tag ids assigned to a message id. */
export function tagsOf(messageId: string): TagFixture[] {
  return tags.filter((t) => t.assignedTo.includes(messageId));
}

/* --------------------------------------------------------------- ohbox */

export const ohbox: MessageFixture[] = [
  {
    id: "giulia",
    folder: "ohbox",
    from: { name: "Giulia Ferrari", address: "giulia@terracotta-milano.it" },
    subject: "Re: Glaze order #2214 🎉",
    time: "09:12",
    threadCount: 4,
    unread: true,
    snippet:
      "Buongiorno Mila, buone notizie — la spedizione arriva già il 4 agosto…",
    body: "Buongiorno Mila,\n\nbuone notizie — la vostra spedizione di smalti arriva già il 4 agosto, dieci giorni prima del previsto! Verde salvia e bianco opaco sono entrambi in cartone.\n\nMi confermate che la consegna resta all’atelier?\n\nA presto,\nGiulia Ferrari\nTerracotta Milano",
    rationale:
      "Ohbox — rule: sender giulia@terracotta-milano.it → Ohbox (learned from you · 14×)",
    trackerNote: "1 spy pixel blocked (open-tracker)",
  },
  {
    id: "petra",
    folder: "ohbox",
    from: { name: "Petra Wyss", address: "petra@makersfest.ch" },
    subject: "Your talk is in! 🎈",
    time: "08:47",
    unread: true,
    attachment: { filename: "Speaker_Info.pdf", size: "1.2 MB" },
    snippet: "Great news — “Wabi-sabi for web people” made the final program…",
    body: "Hi Mila\n\nGreat news — “Wabi-sabi for web people” made the final program! You’re on Saturday at 11:00 in the main hall; yours was one of the most requested sessions.\n\nSpeaker details attached — and yes, there is a speaker dinner on Friday.\n\nSee you in September!\nPetra",
    rationale: "Ohbox — rule: domain makersfest.ch → Ohbox",
  },
  {
    id: "techcheck",
    folder: "ohbox",
    from: { name: "Petra Wyss", address: "petra@makersfest.ch" },
    subject: "Invitation: Tech check — main hall",
    time: "08:39",
    /* READ, deliberately: the demo's Ohbox opens with exactly THREE unread rows — giulia
       (the threaded conversation), petra and ben — so the "Earlier" group stands above the
       fold. The landing demo's callouts point at the two group labels, and a fold that hides
       "Earlier" would leave the second one pointing at nothing. This invite, the
       counter-proposal and the verification code read as this morning's already-handled mail
       at the top of Earlier. */
    unread: false,
    /* A NAMELESS text/calendar part — the wire shape Google and Outlook actually send — so the
       demo shows the invite exactly as a live mailbox would: an event card, downloadable as
       invite.ics. The content is served by the fixtures adapter with zero network. */
    attachment: {
      filename: "",
      size: "1 KB",
      contentType: "text/calendar; charset=utf-8; method=REQUEST",
      content: [
        "BEGIN:VCALENDAR",
        "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "DTSTART;TZID=Europe/Zurich:20260911T160000",
        "DTEND;TZID=Europe/Zurich:20260911T163000",
        "ORGANIZER;CN=Petra Wyss:mailto:petra@makersfest.ch",
        "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Mila Brunner:mailto:mila@lichtgrat.studio",
        "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Petra Wyss:mailto:petra@makersfest.ch",
        "SUMMARY:Tech check — main hall",
        "LOCATION:Makersfest\\, Halle 2\\, Zürich",
        "UID:techcheck-2026@makersfest.ch",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    },
    snippet: "Petra Wyss invited you: Friday, September 11 · 16:00, main hall.",
    body: "Hi Mila\n\nQuick tech check before your talk — mics, slides, the clicker. Fifteen minutes on stage, the Friday before the weekend.\n\nThe invite is attached; just accept if the slot works.\n\nPetra",
    rationale: "Ohbox — rule: domain makersfest.ch → Ohbox",
  },
  {
    id: "glazecall",
    folder: "ohbox",
    from: { name: "Nadja Lehner", address: "nadja@erdton-atelier.ch" },
    subject: "New time proposed: Glaze evening — planning call",
    time: "08:35",
    /* read — see techcheck's note: the demo keeps three unread rows */
    unread: false,
    /* An Outlook counter-proposal: METHOD:COUNTER with the original time in X-MS-OLDSTART/END
       and a WINDOWS zone name — the Exchange dialect, VTIMEZONE trap lines included. */
    attachment: {
      filename: "",
      size: "1 KB",
      contentType: "text/calendar; charset=utf-8; method=COUNTER",
      content: [
        "BEGIN:VCALENDAR",
        "METHOD:COUNTER",
        "PRODID:Microsoft Exchange Server 2010",
        "VERSION:2.0",
        "BEGIN:VTIMEZONE",
        "TZID:W. Europe Standard Time",
        "BEGIN:STANDARD",
        "DTSTART:16010101T030000",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0100",
        "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
        "END:STANDARD",
        "BEGIN:DAYLIGHT",
        "DTSTART:16010101T020000",
        "TZOFFSETFROM:+0100",
        "TZOFFSETTO:+0200",
        "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
        "END:DAYLIGHT",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "ORGANIZER;CN=Mila Brunner:mailto:mila@lichtgrat.studio",
        "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Nadja Lehner:mailto:nadja@erdton-atelier.ch",
        "SUMMARY:Glaze evening — planning call",
        "DTSTART;TZID=W. Europe Standard Time:20260730T150000",
        "DTEND;TZID=W. Europe Standard Time:20260730T153000",
        "X-MS-OLDSTART:20260730T080000Z",
        "X-MS-OLDEND:20260730T083000Z",
        "LOCATION:Phone",
        "UID:planning-call-2026@erdton-atelier.ch",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    },
    snippet: "Nadja proposed a new time: Thursday 15:00 instead of 10:00.",
    body: "Hi Mila\n\nTomorrow morning is suddenly full here — could we do the planning call at 15:00 instead of 10:00? Same half hour, I'll call you.\n\nNadja\nAtelier Erdton",
    rationale: "Ohbox — you said Yes to this sender",
  },
  {
    id: "cinderlock",
    folder: "ohbox",
    from: { name: "Cinderlock", address: "no-reply@cinderlock.app" },
    subject: "Your verification code",
    time: "08:31",
    /* read — see techcheck's note; a code already used is the natural read state anyway */
    unread: false,
    snippet: "Your Cinderlock verification code is 481 920. It expires in 10 minutes.",
    body: "Your Cinderlock verification code is 481 920. It expires in 10 minutes.\n\nIf you didn't ask to sign in, you can ignore this message.\n\n— Cinderlock",
    protected: {
      kind: "verification",
      label: "Verification code",
      redactedNote: "kept out of AI",
      policy:
        "You see it in full — it's your own code. It's kept out of AI and never forwarded; only what a model would read is stripped.",
    },
    rationale: "Sensitive class: verification — labelled and kept out of AI; the body is shown in full",
  },
  {
    id: "ben",
    folder: "ohbox",
    from: { name: "Ben Arnold", address: "ben@lichtgrat.studio" },
    subject: "Kiln’s fixed + Friday pizza 🍕",
    time: "07:58",
    unread: true,
    snippet:
      "Good news twice: the kiln heats evenly again, and Friday we fire the wood oven…",
    body: "Good news twice: the kiln heats evenly again — the new element arrived early — and Friday we fire the wood oven after work. Bring nothing but appetite.\n\n— Ben",
    rationale: "Ohbox — rule: teammate @lichtgrat.studio → Ohbox",
  },
  {
    id: "anna",
    folder: "ohbox",
    from: { name: "Anna Odermatt", address: "anna@gartenlokal-rosa.ch" },
    subject: "Re: the new menu cards — wow!",
    time: "yesterday",
    unread: false,
    body: "The cards arrived and they’re even lovelier in person — guests keep picking them up and turning them over. Thank you for making us look this good!\n\nWarmly,\nAnna",
    rationale: "Ohbox — you said Yes to this sender",
  },
  {
    id: "reto",
    folder: "ohbox",
    from: { name: "Reto Frei", address: "reto@alpmail.ch" },
    subject: "Fotos vom Grat 🏔",
    time: "yesterday",
    unread: false,
    body: "Hoi Mila — die versprochenen Fotos vom Grat. Der Sonnenaufgang war jede Minute um 4 Uhr wert. Nächstes Mal kommst du mit!\n\nReto",
    rationale: "Ohbox — you said Yes to this sender",
  },
  {
    id: "flurina",
    folder: "ohbox",
    from: { name: "Flurina Caduff", address: "flurina@haldenlicht.ch" },
    subject: "Saturday’s workshop is full! 🙌",
    time: "yesterday",
    unread: false,
    body: "All twelve spots are booked — and two people already asked about a second date. Shall we plan an autumn edition?\n\nFlurina",
    rationale: "Ohbox — you said Yes to this sender",
  },
  {
    id: "tim",
    folder: "ohbox",
    from: { name: "Tim Berger", address: "tim@gassenblatt.ch" },
    subject: "Got us tickets for the 22nd! 🎶",
    time: "Mon",
    unread: false,
    body: "Row 8, right side — close enough to see the drummer sweat. I’ll forward the details; you owe me a beer.\n\nTim",
    rationale: "Ohbox — you said Yes to this sender",
  },
  {
    id: "carla",
    folder: "ohbox",
    from: { name: "Carla Meier", address: "carla@sommerfest-lind.ch" },
    subject: "The posters were a hit — danke!",
    time: "Mon",
    unread: false,
    body: "Half the neighbourhood asked who made them. See you at the fest on Saturday — we saved you a raclette.\n\nCarla",
    rationale: "Ohbox — you said Yes to this sender",
  },
  /*
   * THE ANSWER LATER PAIR — the last two rows, and the only two the Ohbox does not show.
   *
   * `triage.replyLater` parks both, and a parked message is in its pile and nowhere else
   * (`client-engine/selectors.ts#ohboxView`), so these two are absent from the Ohbox screen by
   * construction. That rule is the reason they exist: the pile used to be spelled with `giulia`
   * and `petra`, which meant the demo's two best messages vanished from the Ohbox the moment
   * one-pile shipped. The Ohbox keeps its nine; the pile gets two mails written for it.
   *
   * WHAT THEY HAVE TO BE, since a pile of two is the whole feature on screen: mail that plainly
   * owes a considered reply — a decision, a date, a number — from senders who appear nowhere
   * else. A second message from a sender already in the Ohbox would read as the same mail listed
   * twice, which is precisely the confusion one-pile exists to end.
   *
   * APPENDED, NOT INSERTED, and that is a constraint rather than a convenience: several callers
   * address rows of this array by index rather than by id, so a message inserted anywhere but the
   * tail silently re-points every one of them at a different mail. Both are read and dated before
   * the weekend — Answer Later is where mail goes once you have seen it and owe more than a line.
   */
  {
    id: "nadja",
    folder: "ohbox",
    from: { name: "Nadja Lehner", address: "nadja@erdton-atelier.ch" },
    subject: "Would you teach the September glaze evening?",
    time: "Mon",
    unread: false,
    snippet: "Two hours, twelve people — and your matte white is why they're asking.",
    body: "Hi Mila\n\nYou were at «Glaze & Fire» in August, and three people have since asked us who made the matte white bowls on your table. So — would you teach the September glaze evening?\n\nTwo hours, twelve people, Thursday the 18th or the 25th, whichever suits you. Materials and firing are ours; tell me what you'd want for the evening itself.\n\nNo rush, but I'd like the programme at the printer by the end of next week.\n\nNadja\nAtelier Erdton",
    rationale: "Ohbox — you said Yes to this sender",
  },
  {
    id: "jonas",
    folder: "ohbox",
    from: { name: "Jonas Halter", address: "jonas@lichtgrat.studio" },
    subject: "Open studio in October — which weekend?",
    time: "Fri",
    unread: false,
    snippet: "The 11th or the 18th. I'll do the rest, I just need the date.",
    body: "Mila — the open studio. If it's happening in October it's the 11th or the 18th, and the printer wants the date on Wednesday.\n\nThe 11th is quieter in town. The 18th shares the weekend with the market, so more people walk past and all of them are slower. I lean 18th.\n\nAlso: seconds table again? It outsold the good shelf last year, which I have decided not to take personally.\n\nJonas",
    rationale: "Ohbox — rule: teammate @lichtgrat.studio → Ohbox",
  },
];

/* --------------------------------------------------------------- reads */

export const reads: MessageFixture[] = [
  {
    id: "f1",
    folder: "reads",
    from: { name: "Skylark Notes", address: "mara@skylarknotes.com" },
    subject: "#118 — the joy of small tools",
    snippet: "Plus: a lamp, a ladle, and one very good pencil.",
    time: "07:02",
    unread: true,
    body: "Hi there — this issue is a love letter to tools that do one thing kindly.\n\nSmall tools are not lesser tools. They are the ones that fit your hand on the first try: the ladle that pours without dripping, the pencil that starts every list, the app with exactly one screen. This week’s essay visits three workshops and asks each maker which object they’d save from a fire. Nobody picked the expensive one.\n\nWorthy five: a lamp that ages like furniture, a wooden ladle from a two-person workshop, a pencil with honest graphite, a pocket notebook system, and one very good broom.\n\nAlso in this issue: an interview with a bookbinder on the pleasure of doing the same thing ten thousand times, and a reader thread about the tool you’ve owned longest.\n\nThe archive, as always, is open — issues #1 through #117, no paywall, no tracking.\n\n— Mara",
  },
  {
    id: "f2",
    folder: "reads",
    from: { name: "Blattgang", address: "post@blattgang.press" },
    subject: "Why paper keeps winning",
    snippet: "Three hundred years of interface design, still undefeated.",
    time: "06:31",
    unread: true,
    body: "Three hundred years after the broadsheet, paper is still the best interface anyone has shipped: instant on, folds to pocket size, survives coffee, works in sunlight.\n\nThis week’s essay is about why the good digital tools all quietly imitate it — margins, pages, bookmarks, the satisfying flip — and what they still haven’t managed to copy. (Hint: it’s the smell, but it’s also the permission to scribble.)\n\nFrom the mailbag: a dozen of you sent photos of your reading chairs. They are all magnificent. The armchair-with-lamp configuration leads by a wide margin.\n\nNext week: a visit to a paper mill that has been run by the same family since 1874, and what their apprentice learned in year one. (Everything. She learned everything.)",
  },
  {
    id: "f3",
    folder: "reads",
    from: { name: "Wohnfalz", address: "news@wohnfalz.ch" },
    subject: "Ideen für kleine Räume",
    snippet: "Neu diese Woche: Klappbares für Balkon und Flur.",
    time: "05:44",
    unread: true,
    body: "Kleine Räume, grosse Wirkung: Diese Woche zeigen wir Neuheiten, die sich zusammenklappen, stapeln oder ganz verschwinden, wenn der Tag sie nicht braucht.\n[[img]]\nDer Klapptisch KLAPPRI trägt vier Teller und einen Laptop — und hängt danach flach an der Wand. Dazu: ein Hocker, der Stauraum versteckt, und Haken, die keine Löcher hinterlassen.\n\nFür Wohnfalz Mitglieder diese Woche: 15% auf alle Aufbewahrungsserien — im Showroom und online.",
    art: {
      ariaLabel: "Produktbild: Klapptisch, an der Wand montiert",
      caption: "KLAPPRI — klappbar, wandmontiert",
    },
  },
  {
    id: "f4",
    folder: "reads",
    from: { name: "The Maker’s Dozen", address: "hello@makersdozen.studio" },
    subject: "#41 — twelve things makers loved",
    snippet: "A kiln timer, a broom, and a very honest pricing essay.",
    time: "05:12",
    unread: true,
    body: "Twelve things makers loved this month, and this one is a good batch.\n\nThe kiln timer that finally does ramps properly. A broom (yes, a second good broom this year — it’s a golden age). A price-your-work essay written by a potter who doubled her prices and lost exactly zero customers — required reading before your next market.\n\nAlso in the dozen: linen aprons that survive the wheel, a glaze-test tile system that ends the guessing, and a folding market table that one person can carry uphill.\n\nThe community thread this month: what did you make for yourself, not for sale? The answers are wonderful. A gate hinge. A soup bowl. A banjo.\n\nFull list with photos and links below.",
  },
  {
    id: "f5",
    folder: "reads",
    from: { name: "Gratbrief", address: "post@gratbrief.ch" },
    subject: "This week’s hike: the Chäserrugg ridge",
    snippet: "Four hours, one ridge, zero regrets.",
    time: "04:58",
    unread: true,
    body: "This week’s hike: the Chäserrugg ridge. Four hours, one ridge line, and the kind of views that make you forgive the first forty minutes of forest switchbacks.\n\nGo early — the light on the Churfirsten before nine is the whole point. Coffee at the top station is honest; the rösti is better. Boots over trail runners: the ridge path has opinions.\n\nNext week: a lake-to-lake traverse with a swim in the middle.",
  },
  {
    id: "f6",
    folder: "reads",
    from: { name: "Frühbrief Briefing", address: "briefing@fruehbrief.ch" },
    subject: "Morgen-Briefing: Sommerfest-Wochenende",
    snippet: "Was heute schön wird — in fünf Minuten.",
    time: "04:30",
    unread: true,
    body: "Guten Morgen. Das Sommerfest-Wochenende steht vor der Tür — in Winterthur werden über vierzig Quartierfeste erwartet, und die Wetterprognose spielt mit.\n\nAusserdem: Die Nachtzug-Teststrecke nach Barcelona ist auf den Herbst bestätigt, die Badis melden die wärmsten Wassertemperaturen seit fünf Jahren, und im Wallis beginnt die Aprikosenernte — süsser als letztes Jahr, sagen die Bauern.\n\nDas Wetter: sonnig, am Nachmittag Quellwolken, 27 Grad. Perfektes Fest-Wetter.",
  },
  {
    id: "f7",
    folder: "reads",
    from: { name: "Brandung Records", address: "post@brandung-records.de" },
    subject: "New signings + Sommernacht lineup 🎶",
    snippet: "Two new bands, one lake stage, all summer.",
    time: "Mon",
    unread: true,
    body: "Two new signings, and we could not be happier: a four-piece surf band from Kiel and a singer-songwriter who records in her grandmother’s barn. First singles drop this month.\n\nSommernacht Open Air is filling up nicely — the lake stage lineup is now complete, gates at 18:00, and yes, the boat shuttle is back by popular demand.\n\nFrom the crate: our sleeve designer picks five covers that made him take up printmaking. Number three is the reason this label has a heron on it.\n\nSee you at the lake.",
  },
  {
    id: "f8",
    folder: "reads",
    from: { name: "Nordwind Outdoor", address: "news@nordwind-outdoor.ch" },
    subject: "Fünf Zelte im Test",
    snippet: "Fünf Modelle, ein klarer Favorit.",
    time: "Mon",
    unread: true,
    body: "Fünf Zelte, vier Wochenenden, ein klarer Favorit: Das leichteste Zelt im Feld gewinnt — nicht wegen des Gewichts, sondern wegen des Aufbaus. Drei Minuten, allein, im Wind.\n\nÜberzeugt hat auch der günstigste Kandidat: solide Nähte, ehrliche 2.1 kg, Schwächen nur bei den Heringen. Das teuerste Modell? Brillant — aber der Aufpreis kauft Farbe, keine Trockenheit.\n\nAlle fünf Testberichte, Messwerte und das Fazit im Vergleich findest du online.\n\nAusserdem im Update: Der Schlafsack-Vergleich startet im September, und das Community-Voting für die Tour des Jahres ist offen — 12'000 Stimmen sind schon drin.",
  },
  {
    id: "f9",
    folder: "reads",
    from: { name: "Comet Courier", address: "mail@cometcourier.space" },
    subject: "A very good week above the clouds",
    snippet: "Meteor showers, a comet with a schedule, and one happy telescope.",
    time: "Mon",
    unread: true,
    body: "Welcome back to the Comet Courier! A very good week above the clouds — which in August means warm nights, no moon to speak of, and a meteor shower warming up for its big weekend.\n\nThe headliner: comet Ashida-Lange is running precisely on schedule, brightening on cue, and should be a binocular object by the end of the month. Astronomers are delighted and slightly suspicious — comets are rarely this punctual.\n\nCloser to the ground: the alpine observatory finished its mirror re-coating early, the community telescope night in Winterthur sold out in a day (a second date is coming), and a reader in Ticino photographed the space station crossing the face of the moon on her first try.\n\nNext week: where to stand, when to look, and how to keep your phone from ruining your night vision. Clear skies!",
  },
  {
    id: "f10",
    folder: "reads",
    from: { name: "Bergbahn Club", address: "club@bergbahnclub.ch" },
    subject: "Dein Sommerpass ist aktiv 🚠",
    snippet: "Alle 23 Bahnen, den ganzen August — los geht’s.",
    time: "Mon",
    unread: true,
    body: "Hallo Mila\n\nDein Sommerpass ist aktiv! Alle 23 Bergbahnen, den ganzen August — einsteigen, hochfahren, staunen.\n\nUnser Tipp zum Start: die Frühfahrt am Samstag, mit Zopf und Kaffee auf der Terrasse, bevor die Wanderwege aufwachen.\n\nDein Bergbahn Club",
  },
  {
    id: "f11",
    folder: "reads",
    from: { name: "Pixel & Thread", address: "letter@pixelthread.studio" },
    subject: "Weaving color into everything",
    snippet: "A dye garden, a palette tool, and one brave kitchen.",
    time: "Sun",
    unread: true,
    body: "This issue is about color that lives somewhere: a dye garden on a rooftop in Basel, where the indigo does not care about your deadlines.\n\nWe walk through a season of growing color — what the madder root did after two years of patience, why the marigold row earns its keep, and the small chaos of a first indigo vat. The palette that came out of it is now a set of swatches you can actually download.\n\nAlso inside: a palette tool that starts from a photograph of your own shelf, and one brave kitchen painted the green of week-three fennel.\n\nAs always, the printer-friendly version is one click, and the swatch files are free.\n\nComing next issue: the weaving workshop that dyes with onion skins from the restaurant next door.",
  },
  {
    id: "f12",
    folder: "reads",
    from: { name: "Röstsonntag", address: "hallo@roestsonntag.ch" },
    subject: "August roast: Kenya AA",
    snippet: "Blackcurrant, bright, dangerous before noon.",
    time: "Sun",
    unread: true,
    body: "August roast: Kenya AA, Nyeri County. Blackcurrant up front, a bright citrus acidity, and a finish that has no business being this long at this price.\n\nWe brew it at 15 g on 250 g water, 94° — and honestly, not after 15:00. It has opinions.\n\nYour bag ships Monday.",
  },
  {
    id: "f13",
    folder: "reads",
    from: { name: "Skylark Notes", address: "mara@skylarknotes.com" },
    subject: "#117 — the tools we keep",
    snippet: "On objects that age well.",
    time: "Thu",
    unread: false,
    body: "On objects that age well: this issue collects tools that survived a decade of daily use without asking for attention — and asks what they know that the rest of the shelf keeps forgetting.\n\nPlus the usual worthy five, including a chair, a font, and a very good pencil sharpener.",
  },
  {
    id: "f14",
    folder: "reads",
    from: { name: "Blattgang", address: "post@blattgang.press" },
    subject: "Weekly wrap — the week in one read",
    snippet: "Everything lovely, compressed.",
    time: "Thu",
    unread: false,
    body: "The week in one read: the paper-mill visit, the interview on margins as kindness, and Friday’s note on why the best bookmarks are borrowed.\n\nIf you read one thing, read Tuesday’s. If you read two, add the interview.",
  },
  {
    id: "f15",
    folder: "reads",
    from: { name: "Wohnfalz", address: "news@wohnfalz.ch" },
    subject: "Sommer-Sale endet Sonntag",
    snippet: "Letzte Chance auf Balkon-Lieblinge.",
    time: "Wed",
    unread: false,
    body: "Der Sommer-Sale endet Sonntag: letzte Balkon-Lieblinge für Garten und Loggia, bis zu 50% reduziert.\n\nSolange der Vorrat reicht — online reservieren, im Showroom abholen.",
  },
];

export const readsWaterline: WaterlineFixture = {
  // f13 is the newest of the three issues Mila had already seen on her Monday visit,
  // so the line draws above it: f1–f12 arrived since, f13–f15 sit below the line.
  newestSeenId: "f13",
  label: "Seen up to here",
  meta: "last visit · Mon 18:40",
};

export const readsAiChip: ReadsAiChipFixture = {
  afterId: "f1",
  label: "Reads — AI 0.87: newsletter fingerprint",
  confidence: 0.87,
  reason: "newsletter fingerprint",
  approvedLabel: "Approved — saved as a rule",
  correctedLabel: "Corrected — goes to Ohbox next time",
};

/* ------------------------------------------------------------ receipts */

export const receipts: MessageFixture[] = [
  {
    id: "brandung",
    folder: "receipts",
    from: { name: "Brandung Records", address: "tickets@brandung-records.de" },
    subject: "Your tickets — Sommernacht Open Air 🎫",
    amount: "CHF 96.00",
    snippet: "2 × Sommernacht Open Air, 22 Aug — see you at the lake stage.",
    time: "08:20",
    unread: true,
    body: "Sommernacht Open Air — Seebühne\nSa 22. August · Doors 18:00\n\n2 × Stehplatz — CHF 96.00\nPaid with the card on file.\n\nYour tickets are attached and in your wallet — the QR codes scan at any gate. Rain or shine; the lake stage has never cancelled.",
  },
  {
    id: "kino",
    folder: "receipts",
    from: { name: "Open-Air Kino Seeblick", address: "tickets@kino-seeblick.ch" },
    subject: "Deine Tickets — Filmnacht am See",
    amount: "CHF 36.00",
    snippet: "2 × Liegestuhl, Do 21:15 — Decken gibt’s am Eingang.",
    time: "07:41",
    unread: true,
    body: "Filmnacht am See — Do 31. Juli, 21:15\n\n2 × Liegestuhl-Platz — CHF 36.00\nBezahlt mit der hinterlegten Karte.\n\nBei Regen wandert die Vorstellung auf Freitag — dein Ticket bleibt gültig. Decken und Popcorn gibt es am Eingang.",
  },
  {
    id: "erdton",
    folder: "receipts",
    from: { name: "Atelier Erdton", address: "billing@erdton-atelier.ch" },
    subject: "Invoice #078 — Pottery Workshop",
    amount: "CHF 240.00",
    snippet: "Workshop «Glaze & Fire», 2 seats — thanks for booking with us!",
    time: "Tue",
    unread: true,
    body: "Invoice #078 — July 2026\n\nWorkshop «Glaze & Fire», Sa 9. August, 2 seats — CHF 220.00\nMaterial & firing — CHF 20.00\n\nTotal CHF 240.00 (incl. VAT)\n\nPaid — this is your receipt. Aprons, clay and coffee are on us; bring ideas.",
  },
  {
    id: "roestsonntag",
    folder: "receipts",
    from: { name: "Röstsonntag", address: "hallo@roestsonntag.ch" },
    subject: "Receipt — August roast subscription",
    amount: "CHF 24.00",
    snippet: "Kenya AA ships Monday — your subscription rolled over.",
    time: "Tue",
    unread: true,
    body: "August subscription — Kenya AA, 500 g\n\n1 × monthly roast — CHF 24.00\nCharged to the card on file.\n\nYour bag ships Monday with the tasting card. Skip or pause any month with one click.",
  },
  {
    id: "speichenhof",
    folder: "receipts",
    from: { name: "Speichenhof Velos", address: "service@speichenhof-velos.ch" },
    subject: "Bike service — ready to ride 🚲",
    amount: "CHF 89.00",
    snippet: "New chain, fresh brakes — she runs like spring again.",
    time: "Mon",
    unread: true,
    body: "Service summary — city bike\n\nNew chain + cassette — CHF 62.00\nBrake pads, front — CHF 18.00\nLabour flat rate — CHF 9.00\n\nTotal CHF 89.00, paid in store.\n\nShe runs like spring again — next check-up is on us.",
  },
  {
    id: "alpenbahn",
    folder: "receipts",
    from: { name: "Alpenbahn", address: "tickets@alpenbahn.ch" },
    subject: "Dein Billett Winterthur–Lugano",
    amount: "CHF 52.00",
    snippet: "Winterthur ab 08:02 — Sitzplatz am Fenster, Seeseite.",
    time: "Mon",
    unread: true,
    body: "Winterthur → Lugano\nDi 12. August · Abfahrt 08:02 · Ankunft 11:24\n\n1 × 2. Klasse — CHF 52.00\nBezahlt mit der hinterlegten Karte.\n\nSitzplatz 44, Fenster, Seeseite — die schöne Hälfte der Strecke gehört dir.",
  },
  {
    id: "pigment",
    folder: "receipts",
    from: { name: "Pigment & Papier", address: "shop@pigmentpapier.de" },
    subject: "Order #5521 shipped 📦",
    amount: "€31.40",
    snippet: "Gouache set + two brushes — on the way to the studio.",
    time: "Mon",
    unread: true,
    body: "Order #5521 — shipped today\n\nGouache set, 12 colours — €24.90\nBrush, round no. 6 — €3.80\nBrush, flat no. 10 — €2.70\n\nTotal €31.40 (incl. VAT), paid by card.\n\nTracking is in your account — expected Thursday.",
  },
];

export const receiptsGroups: ReceiptsGroupFixture[] = [
  { label: "Today", items: ["brandung", "kino"] },
  { label: "Tuesday", items: ["erdton", "roestsonntag"] },
  { label: "Monday", items: ["speichenhof", "alpenbahn", "pigment"] },
];

/* ------------------------------------------------------------ screener */

export const waiting: WaitingSenderFixture[] = [
  {
    id: "lena",
    from: { name: "Lena Kaufmann", address: "lena@atelier-eichspan.ch" },
    initial: "L",
    time: "08:40",
    scope: "sender",
    ai: {
      dest: "ohbox",
      confidence: 0.92,
      rationale: "personal message, real sender, no bulk fingerprint",
    },
    held: [
      {
        id: "lena-1",
        subject: "Werkstatt-Besuch nächste Woche?",
        time: "08:12",
        body: "Hallo Mila\n\nWir haben uns letzten Monat am Handwerksmarkt in Winterthur kurz unterhalten — ich hatte den Stand mit den Eichenmöbeln, gleich neben Ihrer Keramik. Ihre Karte liegt seither auf meiner Werkbank, und jetzt melde ich mich endlich.\n\nHätten Sie nächste Woche Zeit für einen Besuch in der Werkstatt? Ich hätte da eine Idee: Ihre Schalen, meine Tabletts — eine kleine gemeinsame Serie für den Herbstmarkt. Dienstag oder Donnerstag Nachmittag wäre ich frei.\n\nHerzliche Grüsse aus Winterthur\nLena Kaufmann\nAtelier Eichspan",
      },
      {
        id: "lena-2",
        subject: "Kleine Ergänzung",
        time: "08:40",
        body: "Nochmals kurz: Falls es nächste Woche nicht klappt, ginge auch der Freitag darauf. Und bringen Sie gerne ein paar Schalen mit — ich habe schon ein Tablett im Kopf.\n\nLena",
      },
    ],
  },
  {
    id: "paperbird",
    from: { name: "Paperbird", address: "team@mail.paperbird.app" },
    initial: "P",
    time: "07:26",
    scope: "sender",
    ai: {
      dest: "reads",
      confidence: 0.88,
      rationale: "newsletter fingerprint: List-Unsubscribe, bulk precedence",
    },
    held: [
      {
        id: "paperbird-1",
        subject: "Welcome to Paperbird ✏️",
        time: "07:26",
        body: "Hi Mila,\n\nYour notebook is ready. Here are the three things most new members do in their first week:\n\n1. Clip something — articles land clean, without the pop-ups.\n2. Make a collection — drag three clips together and give it a name.\n3. Try the Sunday digest — your clips come back to you once a week, tidy and readable.\n\nA quiet tip: press Cmd+K anywhere. Nearly everything in Paperbird is one box away.\n\nWe send one onboarding mail per week for the next three weeks — you can end the series with one click below.\n\n— The Paperbird team",
      },
    ],
  },
  {
    id: "jackpot",
    from: { name: "JackpotJodel Promo", address: "win@jackpotjodel-alerts.info" },
    initial: "J",
    time: "06:58",
    scope: "domain",
    dull: true,
    ai: {
      dest: "screened",
      confidence: 0.97,
      rationale: "promo blast, link-tracker dense, unknown domain",
    },
    held: [
      {
        id: "jackpot-1",
        subject: "🎰 Sie haben 3 Freispiele gewonnen!",
        time: "06:58",
        trackerNote: "31 tracking links · 2 spy pixels blocked",
        body: "GLÜCKWUNSCH!!! Ihre E-Mail wurde ausgewählt: 3 FREISPIELE + 200% JODEL-BONUS warten auf Sie.\n\n>> JETZT EINLÖSEN — nur 24 Stunden gültig <<\n\nÜber 9'000 Gewinner diese Woche. Verpassen Sie nicht Ihre Chance auf den Jackpot von CHF 1'750'000.\n\nKlicken Sie hier • Bonus aktivieren • Jetzt jodeln\n\nSie erhalten diese Mail, weil Sie sich für Partnerangebote registriert haben. Abmelden.",
      },
    ],
  },
];

/**
 * Screened-out senders hold **all** their mail, in full. The list says
 * "8 held" only because eight rendered messages are behind it.
 */
export const screenedOut: ScreenedSenderFixture[] = [
  {
    address: "promo@fashion-deals.ch",
    screenedOn: "12 Jul",
    held: [
      {
        id: "fd-1",
        subject: "Willkommen — 10% auf die erste Bestellung",
        time: "2 Mai",
        body: "Schön, dass du da bist. Dein Willkommens-Code: HALLO10 — gültig auf alles, 30 Tage.\n\nUnd damit du nichts verpasst: neue Kollektionen landen jeden Donnerstag.",
      },
      {
        id: "fd-2",
        subject: "Neu eingetroffen: Leinen für den Sommer",
        time: "16 Mai",
        body: "Leinen in neun Farben, Hosen mit echten Taschen, und ein Hemd, das auch nach dem Waschen noch aussieht wie am Anfang.\n\nAb CHF 39.90 — solange der Vorrat reicht.",
      },
      {
        id: "fd-3",
        subject: "Nur heute: Gratisversand",
        time: "29 Mai",
        body: "Heute versenden wir gratis, ohne Mindestbestellwert. Code: FREITAG.\n\nGilt bis Mitternacht, auch auf reduzierte Artikel.",
      },
      {
        id: "fd-4",
        subject: "Du hast etwas im Warenkorb liegen lassen",
        time: "3 Jun",
        body: "Der Korb wartet noch: 1 × Leinenhemd, Grösse M, salbeigrün.\n\nWir halten ihn zwei Tage — danach geben wir die Grösse wieder frei.",
      },
      {
        id: "fd-5",
        subject: "Sommer-Sale startet: bis 50%",
        time: "14 Jun",
        body: "Der Sommer-Sale ist offen: über 2'000 Artikel reduziert, Sneaker ab CHF 29.90.\n\nMitglieder haben 24 Stunden Vorsprung — du bist Mitglied.",
      },
      {
        id: "fd-6",
        subject: "Deine Grösse ist wieder da",
        time: "27 Jun",
        body: "Das Leinenhemd in Salbeigrün, Grösse M, ist nachgeliefert.\n\nDiesmal in kleiner Stückzahl — wir sagen es dir zuerst.",
      },
      {
        id: "fd-7",
        subject: "Letzte Chance: Sale endet Sonntag",
        time: "5 Jul",
        body: "Am Sonntag um 23:59 ist der Sale vorbei. Was dann noch hängt, geht zurück ins Lager.\n\nVersand gratis ab CHF 50.",
      },
      {
        id: "fd-8",
        subject: "Mid-Season Sale: bis 70% auf alles",
        time: "12 Jul",
        body: "Nur dieses Wochenende: bis 70% auf über 4'000 Artikel.\n\nSneaker ab CHF 29.90 • Jacken ab CHF 49.90 • Accessoires ab CHF 9.90\n\nGratisversand ab CHF 50 — Code WEEKEND70 an der Kasse.",
      },
    ],
  },
  {
    address: "notifications@old-forum.net",
    screenedOn: "3 Jun",
    held: [
      {
        id: "of-1",
        subject: "1 neue Antwort in „Router-Konfiguration“",
        time: "21 Mai",
        body: "Es gibt 1 neue Antwort in einem Thema, dem du folgst: „Router-Konfiguration VDSL“.\n\n> Bei mir lief es erst, nachdem ich den VLAN-Tag auf 10 gesetzt hatte.\n\nDu erhältst diese Benachrichtigung, weil du das Thema 2019 abonniert hast.",
      },
      {
        id: "of-2",
        subject: "3 neue Antworten in „Router-Konfiguration“",
        time: "3 Jun",
        body: "Es gibt 3 neue Antworten in einem Thema, dem du folgst: „Router-Konfiguration VDSL“.\n\nDu erhältst diese Benachrichtigung, weil du das Thema 2019 abonniert hast. Benachrichtigungen lassen sich im Profil verwalten.",
      },
    ],
  },
];

export const spam: SpamItemFixture[] = [
  {
    from: "crypto-bonus@win-invest.biz",
    detection: {
      source: "auto-detected",
      confidence: 0.98,
      reason: "phishing fingerprint",
      label: "auto-detected · 0.98 · phishing fingerprint",
    },
    held: [
      {
        id: "wi-1",
        subject: "Ihr Bitcoin Gewinn wartet 🎁",
        time: "Tue",
        trackerNote: "12 tracking links blocked",
        body: "Sehr geehrter Kunde,\n\nIhr Konto zeigt einen nicht abgeholten Gewinn von 0.4 BTC. Bestätigen Sie Ihre Wallet-Adresse innert 48 Stunden, sonst verfällt der Betrag.\n\nJetzt bestätigen → wallet-verify-ch.win-invest.biz\n\nSupport Team",
      },
    ],
  },
  {
    from: "support@cinderl0ck-secure.info",
    detection: {
      source: "auto-detected",
      confidence: 0.96,
      reason: "lookalike domain (cinderl0ck)",
      label: "auto-detected · 0.96 · lookalike domain (cinderl0ck)",
    },
    held: [
      {
        id: "sk-1",
        subject: "Ihr Konto wurde eingeschränkt",
        time: "Mon",
        trackerNote: "lookalike link flagged: cinderl0ck-secure.info",
        body: "Ihr Cinderlock-Konto wurde vorübergehend eingeschränkt. Um die Einschränkung aufzuheben, bestätigen Sie Ihre Daten über den folgenden Link.\n\nKonto bestätigen → secure.cinderl0ck-secure.info/login\n\nDieser Vorgang dauert nur 2 Minuten.",
      },
    ],
  },
];

export const screenerEmptyStates: Record<
  "waiting" | "screened" | "spam",
  ScreenerEmptyState
> = {
  waiting: {
    glyph: "🕊",
    title: "No one’s waiting.",
    hint: "First-time senders appear here before anything reaches the Ohbox.",
  },
  screened: {
    glyph: "🚪",
    title: "No senders screened out.",
    hint: "Screening out a waiting sender lists them here — reversible any time.",
  },
  spam: {
    glyph: "🕳",
    title: "No spam held.",
    hint: "Auto-detected spam lands here for review — nothing is deleted unseen.",
  },
};

/* -------------------------------------------------------------- triage */

export const triage: TriageFixture = {
  /*
   * PARKING A MESSAGE TAKES IT OUT OF THE OHBOX, so what is listed here is what the Ohbox does
   * NOT show. `giulia` and `petra` used to be these two entries, and the cost only became
   * visible when the one-pile rule shipped and honoured them: the demo Ohbox dropped to seven
   * rows, without its opening message or its attachment row. The pile now names the two mails
   * written for it (`ohbox`'s last two), and the nine the Ohbox is meant to show all render.
   *
   * The title/subtitle/preview beside each `messageId` are for surfaces that read this fixture
   * directly, without an engine under them. The engine ignores all three and derives them from
   * the message instead — see `selectors.ts#triagePiles` — so they are a copy that has to be kept
   * true, never a second source of the answer.
   */
  replyLater: [
    {
      messageId: "nadja",
      title: "Nadja Lehner",
      subtitle: "Would you teach the September glaze evening?",
      preview: "Two hours, twelve people — and your matte white is why they're asking.",
    },
    {
      messageId: "jonas",
      title: "Jonas Halter",
      subtitle: "Open studio in October — which weekend?",
      preview: "The 11th or the 18th. I'll do the rest, I just need the date.",
    },
  ],
  setAside: [{ title: "Alpenbahn", subtitle: "Itinerary Winterthur→Lugano, 12 Aug" }],
  resurface: [
    { title: "Domain renewal lichtgrat.studio", resurfaceAt: "Fri 09:00" },
  ],
};

/* -------------------------------------------------------------- search */

export const search: SearchDemoFixture = {
  query: "invoce",
  resultCount: 2,
  tookMs: 11,
  source: "local index",
  hits: [
    {
      who: "Giulia Ferrari",
      where: "Ohbox · 09:12",
      subject: "Re: Glaze order #2214 🎉",
      fuzzyNote: "fuzzy match — “invoice”",
    },
    {
      who: "Atelier Erdton",
      where: "Receipts · Tue",
      subject: "Invoice #078 — Pottery Workshop — CHF 240.00",
      highlight: "Invoice",
    },
  ],
  facets: [
    {
      title: "From",
      items: [
        { label: "Giulia", count: 3 },
        { label: "Erdton", count: 2 },
      ],
    },
    { title: "Folder", items: [{ label: "Ohbox" }, { label: "Receipts" }] },
    { title: "Refine", items: [{ label: "Has attachment" }] },
    { title: "Date", items: [{ label: "This week" }, { label: "July" }] },
  ],
  emptyTitle: "No local results.",
  emptyHint: "Press ↵ to search the server archive.",
};

/* ------------------------------------------------------------- compose */

export const composeDraft: ComposeDraftFixture = {
  to: { name: "Giulia Ferrari", address: "giulia@terracotta-milano.it" },
  subject: "Re: Glaze order #2214 🎉",
  tagLabel: "AI draft — not sent",
  body: "Buongiorno Giulia, che bella notizia — il 4 agosto va benissimo! La consegna resta all’atelier, come sempre. Verde salvia e bianco opaco: confermati. A presto, Mila",
  grounding:
    "Drafted from your 14 previous replies to Giulia + KB: “Delivery replies — standard note”",
  editorPlaceholder: "Write your message, or take the draft above.",
  sendNote: "Draft — not sent",
};

/* ------------------------------------------------------------ settings */

export const notificationSettings: NotificationSettingsFixture = {
  channels: [
    {
      id: "people",
      label: "People in Ohbox",
      description: "Mail from people you said Yes to",
      enabled: true,
    },
    {
      id: "known",
      label: "Known senders",
      description: "Anyone your rules already file",
      enabled: true,
    },
    { id: "reads", label: "Reads", description: "New newsletter issues", enabled: false },
    {
      id: "receipts",
      label: "Receipts",
      description: "Orders, invoices, tickets",
      enabled: false,
    },
    {
      id: "screener",
      label: "Screener holds",
      description: "Weekly digest instead of alerts",
      enabled: false,
    },
  ],
  vipLabel: "VIP — always notifies",
  vips: ["Petra Wyss", "Giulia Ferrari"],
  learnedSuggestion: {
    text: "You usually open Petra’s mail within 5 minutes — add to VIP?",
    target: "Petra Wyss",
    acceptedToast: "Petra Wyss added to VIP.",
    dismissedToast: "Dismissed — no more suggestions for Petra.",
  },
  privacyNote: "Notifications carry no mail content — your device fetches privately.",
};

/* -------------------------------------------------------------- counts */

export const counts: CountsFixture = {
  /* three, not six — see the techcheck fixture's note: the demo's Ohbox shows "Earlier"
     above the fold, under exactly three unread rows */
  ohboxUnread: 3,
  /*
   * MAIL FILED IN THE OHBOX FOLDER — thirteen — which is NOT the eleven rows the Ohbox screen
   * shows. The two are different questions and the demo answers both: parking moves nothing on
   * the mail server, so `nadja` and `jonas` are still Ohbox mail while Answer Later is the only
   * place they are listed. Surfaces that apply the one-pile rule derive their own total from
   * what they render (`AppShell` passes `allOhbox.length`, which is eleven); this field is the
   * folder, and `unreadCounts()` is what it is checked against.
   */
  ohboxTotal: 13,
  reads: 12,
  receipts: 7,
  screenerWaiting: 3,
  replyLater: 2,
  setAside: 1,
  resurface: 1,
};

/* ----------------------------------------------------------- the world */

export function getFixtures(): Fixtures {
  return {
    account,
    mailboxes,
    tags,
    ohbox,
    reads,
    readsWaterline,
    readsAiChip,
    receipts,
    receiptsGroups,
    screener: {
      waiting,
      screenedOut,
      spam,
      emptyStates: screenerEmptyStates,
    },
    triage,
    search,
    composeDraft,
    notificationSettings,
    counts,
  };
}
