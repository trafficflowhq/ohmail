/**
 * PRIVACY INVARIANT (#6): zero real personal data, zero real brands.
 *
 * This file is the single place where the demo world's naming is reviewed —
 * and it is now the ONLY place. A second copy of both lists lived in the
 * native macOS client, which had to be kept in step by hand because the same
 * persona shipped on both surfaces; that client is retired and every surface
 * reads these lists directly, so there is nothing left to drift from.
 *
 * HOW A NAME EARNS ITS PLACE. Every entry carries a `verdict`, not just prose,
 * because a note that merely *sounds* reviewed is worse than no registry at
 * all: a reader trusts it and stops looking. The four verdicts are the only
 * claims this file is willing to make, and each one is falsifiable —
 *
 *   coined           a search for the name turned up no operating entity;
 *   near-collision   real entities DO share the name, they are named in
 *                    `collision`, and the reuse was accepted anyway;
 *   descriptive      ordinary words in ordinary use, no distinctive mark
 *                    claimed and none at risk;
 *   invented-person  a person's name, invented, no public figure.
 *
 * `near-collision` exists so that "reviewed" can never be spelled as silence.
 * A name whose real-world twin was found gets that twin written down, and
 * `test/shape.test.ts` fails if the twin is missing — so the honest and the
 * dishonest way to describe a collision are no longer the same length.
 *
 * WHAT THIS COST TO LEARN. The first pass of this registry certified nine
 * names as coined that were live brands, among them the demo persona's own
 * mail domain (a real studio's registered domain), the security sender the
 * phishing demo impersonates (a real security company), and the flat-pack
 * retailer (a real furniture label). Every one of them read plausibly coined.
 * Hence: no entry without a verdict, and no `near-collision` without a name.
 *
 * The banned terms live here and NOWHERE else in the fixture corpus, so a
 * privacy grep over `packages/fixtures` has exactly one expected hit: this
 * meta-reference. `test/shape.test.ts` walks every renderable string of
 * `getFixtures()` against the list, at every depth (including held mail),
 * audits these review notes as corpus too, and asserts that every display
 * name the UI can render is registered below — so a new sender cannot be
 * added without passing through review.
 */

/** The claim a registry entry is willing to make about its name. */
export type NameVerdict = "coined" | "near-collision" | "descriptive" | "invented-person";

export interface FictionalName {
  name: string;
  /** The reviewed claim. `near-collision` REQUIRES `collision`. */
  verdict: NameVerdict;
  /** Why this name is safe to ship in a public demo. */
  note: string;
  /**
   * For `near-collision` only: the real entity/entities found in review, named
   * explicitly. Required for that verdict so an entry can never imply "nothing
   * matched" when something did.
   */
  collision?: string;
}

/**
 * Every person and brand name the demo can put on screen.
 *
 * Notes deliberately do NOT spell out the real brands that were removed —
 * those strings are in `bannedTerms`, the notes are audited as corpus, and a
 * real brand named in a comment is still a real brand in this repository.
 */
export const fictionalNames: FictionalName[] = [
  // People — invented, Swiss/Italian/German-plausible, no public figures.
  { name: "Mila", verdict: "invented-person", note: "the demo persona's given name; invented" },
  { name: "Mila Brunner", verdict: "invented-person", note: "the demo persona; invented" },
  {
    name: "Giulia Ferrari",
    verdict: "invented-person",
    note: "invented; common given + surname, no public figure",
  },
  { name: "Petra Wyss", verdict: "invented-person", note: "invented" },
  { name: "Ben Arnold", verdict: "invented-person", note: "invented" },
  { name: "Anna Odermatt", verdict: "invented-person", note: "invented" },
  { name: "Reto Frei", verdict: "invented-person", note: "invented" },
  { name: "Flurina Caduff", verdict: "invented-person", note: "invented" },
  { name: "Tim Berger", verdict: "invented-person", note: "invented" },
  { name: "Carla Meier", verdict: "invented-person", note: "invented" },
  { name: "Lena Kaufmann", verdict: "invented-person", note: "invented" },
  // The Answer Later pair. Both write from brands ALREADY reviewed below — the pottery studio
  // and Mila's own studio — so the pile cost this registry two person entries and no new brand
  // claim, which is the half of it that has ever been wrong.
  {
    name: "Nadja Lehner",
    verdict: "invented-person",
    note: "invented; the pottery studio's workshop lead",
  },
  {
    name: "Jonas Halter",
    verdict: "invented-person",
    note: "invented; Mila's second studio colleague",
  },
  {
    name: "Mara",
    verdict: "invented-person",
    note: "invented; the Skylark Notes author signature",
  },

  // Brands.
  {
    name: "Lichtgrat Studio",
    verdict: "coined",
    note: "Mila's own studio (Licht + Grat, two words German does not compound); replaces a name whose domain was a real design agency's live domain — and it was the persona's own address, so it was on screen constantly",
  },
  { name: "Wolkenmail", verdict: "coined", note: "mail provider (Wolke = cloud); no operating entity found" },
  {
    name: "Terracotta Milano",
    verdict: "descriptive",
    note: "pottery supplier; two ordinary Italian words (the material + the city), so no distinctive mark is claimed",
    collision: "generic use is everywhere in Italian ceramics (e.g. the CottoMilano tile line, terracottaitalia.com); none is a mark this reuses",
  },
  { name: "Makersfest", verdict: "coined", note: "conference; no operating entity found" },
  {
    name: "Cinderlock",
    verdict: "coined",
    note: "the protected-class verification sender; replaces a name that was a real security company's — which the phishing demo below was busy impersonating",
    collision: "a World of Warcraft player character uses the word; a character handle is not a mark",
  },
  { name: "Gartenlokal Rosa", verdict: "coined", note: "restaurant; no operating entity found" },
  {
    name: "Haldenlicht",
    verdict: "coined",
    note: "workshop host (Halde + Licht); replaces a name registered by several real companies",
  },
  {
    name: "Gassenblatt",
    verdict: "coined",
    note: "neighbourhood paper; replaces a name that was a real Swiss neighbourhood paper — same word, same country, same trade",
  },
  { name: "Sommerfest Lind", verdict: "coined", note: "street party; no operating entity found" },
  { name: "Alpmail", verdict: "coined", note: "mail provider; no operating entity found" },
  { name: "Skylark Notes", verdict: "coined", note: "newsletter; no operating entity found" },
  {
    name: "Blattgang",
    verdict: "coined",
    note: "newsletter (Blatt + Gang); replaces a name carried by a real reading app and a real security newsletter",
  },
  {
    name: "Wohnfalz",
    verdict: "coined",
    note: "furniture retailer, the flat-pack-catalogue stand-in (Wohn + Falz, the woodworking rabbet); replaces a name that was a real furniture design label in exactly this trade",
  },
  {
    name: "KLAPPRI",
    verdict: "coined",
    note: "the folding-table product inside the Wohnfalz issue; replaces a name carried by two real furniture makers",
  },
  { name: "The Maker’s Dozen", verdict: "coined", note: "newsletter; no operating entity found" },
  {
    name: "Gratbrief",
    verdict: "coined",
    note: "hiking newsletter (Grat = ridge); replaces a name that collided with a real product",
  },
  {
    name: "Frühbrief Briefing",
    verdict: "coined",
    note: "morning briefing (früh + Brief); replaces a name that is a real German newspaper masthead in three cities",
  },
  { name: "Brandung Records", verdict: "coined", note: "label; no operating entity found" },
  {
    name: "Nordwind Outdoor",
    verdict: "near-collision",
    note: "outdoor retailer; the qualifier puts it in a different trade from everything found, and Nordwind is an ordinary German word (north wind)",
    collision: "Nordwind Records and the Nordwind Festival (Berlin) both operate under the bare word; neither sells outdoor kit",
  },
  {
    name: "Comet Courier",
    verdict: "near-collision",
    note: "astronomy newsletter; near-collision reviewed and accepted — the twin is a non-commercial school publication with no mark to reuse",
    collision: "the Comet Courier, a US elementary-school newsletter (Horizon Elementary, Loudoun County)",
  },
  { name: "Bergbahn Club", verdict: "coined", note: "mountain-railway club; no operating entity found" },
  { name: "Pixel & Thread", verdict: "coined", note: "textile/design newsletter; no operating entity found" },
  {
    name: "Röstsonntag",
    verdict: "coined",
    note: "coffee roaster; replaces a name that collided with a real roaster",
  },
  { name: "Open-Air Kino Seeblick", verdict: "coined", note: "open-air cinema; no operating entity found" },
  { name: "Atelier Erdton", verdict: "coined", note: "pottery studio (Erdton = earth tone); no operating entity found" },
  {
    name: "Speichenhof Velos",
    verdict: "coined",
    note: "bike shop (Speichen + Hof); replaces a name that was a real Swiss bike shop's — same word, same country, same trade",
  },
  {
    name: "Alpenbahn",
    verdict: "descriptive",
    note: "rail operator; the ordinary German term for an alpine railway, used generically, not as anyone's mark",
    collision: "used descriptively across Swiss and Austrian rail tourism; no single operator owns it",
  },
  { name: "Pigment & Papier", verdict: "coined", note: "art-supply shop; no operating entity found" },
  {
    name: "Atelier Eichspan",
    verdict: "coined",
    note: "woodworking studio (Eiche + Span, fitting Lena's oak furniture); replaces a name that is a real art institution's",
  },
  {
    name: "Paperbird",
    verdict: "near-collision",
    note: "note-taking app; near-collision reviewed and accepted — neither twin is mail- or notes-adjacent, so the coined usage stands",
    collision: "paperbird.us, a Boston paper-goods and invitations business, and a “Paper Bird” Android app",
  },
  { name: "JackpotJodel Promo", verdict: "coined", note: "promo blast (the spam-grade sender); no operating entity found" },
  {
    name: "Fashion Deals",
    verdict: "descriptive",
    note: "retailer, screened out; two generic retail words chosen precisely because they read as bulk filler, not as a brand",
  },
  {
    name: "Old Forum",
    verdict: "descriptive",
    note: "forum, screened out; generic words standing in for any stale mailing list",
  },
  { name: "Win-Invest", verdict: "coined", note: "phishing sender; no operating entity found" },
  {
    name: "Cinderl0ck Secure",
    verdict: "coined",
    note: "the phishing demo — a zero-for-o lookalike of the coined Cinderlock, so the impersonated brand is fictional too",
  },

  // Rail / mailbox shorthands and non-sender labels the UI renders.
  { name: "lichtgrat.studio", verdict: "coined", note: "domain of the coined studio; not a registered domain we could find" },
  {
    name: "milabrunner.ch",
    verdict: "coined",
    note: "personal domain of the invented persona; not a registered domain we could find",
  },
];

/**
 * Substrings that must never appear anywhere in the FIXTURE CORPUS: the real
 * identity of the person behind this project, the real company, and every real
 * brand identified in review — including the nine this registry once certified
 * as coined.
 *
 * SCOPE — stated precisely, because an overstated scope is how the last grep
 * got waved through. This list governs the DEMO WORLD and nothing else:
 * `getFixtures()` at every depth, and the review notes above (audited as
 * corpus, so a note may never name a brand it bans). It is deliberately not a
 * repo-wide grep, and there are two reasons a wider one would not come back
 * clean:
 *
 *  1. `NAMESPACE_EXEMPTION` below — the product's IMAP folder namespace still
 *     carries the pre-rebrand company name. Documented, with a tracked fix.
 *  2. Product code outside the fixtures names real vendors on purpose: the
 *     marketing copy has to name the mail providers ohmail works with, and the
 *     tracker blocklist has to name the trackers it blocks. That is nominative
 *     use, not a leak, and both would be nonsense anonymised.
 *
 * So read a green run of this guard as what it is — a certified demo world —
 * and not as a claim about every file that happens to sit next to it.
 */
export const bannedTerms: string[] = [
  // real personal / company identity
  "gilles",
  "goetsch",
  "trafficflow",
  "steiner",
  // real brands previously present or adjacent enough to guard
  "alpenglow",
  "trailhead",
  "ikea",
  "swisscom",
  "sbb",
  "migros",
  "coop",
  "nespresso",
  "starbucks",
  "salesforce",
  "hetzner",
  "github",
  "notion",
  "icloud",
  "gmail",
  "outlook",
  "protonmail",
  "fastmail",
  "superhuman",
  "hey.com",
  // real brands this registry itself once shipped as "coined" — banned so the
  // same nine names cannot walk back in behind a plausible-looking note
  "hejmo",
  "falto",
  "northlight",
  "skyfort",
  "skyf0rt",
  "atelier nord",
  "atelier-nord",
  "morgenpost",
  "looseleaf",
  "velowerk",
  "bergwind",
  "quartierpost",
];

/**
 * The one documented contradiction of `bannedTerms`, kept honest on purpose.
 *
 * The IMAP folder namespace used to be the contradiction: the product created
 * `TrafficFlow/…` folders inside real customer mailboxes. That is **fixed** —
 * on 2026-07-31, while zero real mailboxes were connected, the five strings
 * became `ohmail/Screener`, `ohmail/Reads`, `ohmail/Receipts`,
 * `ohmail/Screened`, `ohmail/Quarantine`. Nothing a user can see carries the
 * pre-rebrand name any more.
 *
 * What survives is the backend workspace scope — `@trafficflow/{api,core,db,
 * services}` and `@trafficflow/worker`. Nothing is published to npm and the
 * specifiers are resolved away at build time, so the term appears in no
 * shipped bundle, no HTTP payload and no mailbox: it is cosmetic
 * inconsistency inside the repository, not a leak. It stays on the ban list so
 * fixture copy can never reintroduce it, and it stays exempt here so the list
 * is not silently self-contradicting.
 *
 * The UI rule that guarded the old namespace is kept because it is good
 * regardless: never render a raw folder string. Map it through
 * `VIEW_OF_FOLDER`, and fall back to the leaf segment (`folderLeaf()`), never
 * the namespaced path.
 */
export const NAMESPACE_EXEMPTION = {
  term: "trafficflow",
  where: "backend workspace package scope @trafficflow/{api,core,db,services,worker}",
  why: "never published, resolved away at build time — absent from every bundle, payload and mailbox",
  until: "folded into a future workspace-scope rename; the user-visible folder namespace is already ohmail/…",
  uiRule: "never render a raw folder string; map via VIEW_OF_FOLDER, fall back to folderLeaf()",
} as const;
