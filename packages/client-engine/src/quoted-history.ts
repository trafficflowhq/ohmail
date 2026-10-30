/**
 * WHERE A MESSAGE'S QUOTED HISTORY STARTS AND ENDS — one pure reading for every reader (web,
 * desktop, phone), over the plain-text part or the SANITIZED html tree. No DOM global, no React,
 * no network: the html half reads a minimal tree ({@link QuotedTree}) that a DOM node
 * ({@link quotedDomTree}) and the phone's domhandler parse both answer.
 *
 * Both inputs become LINES (text, quote depth, the node a cut there starts at) and one decision
 * runs over the lines. The answer is a RANGE: the history normally runs to the body's end, but
 * stops before a signature or list footer of the new message (mutt, Thunderbird with the
 * signature below). When in doubt the answer is `null` — folding new words is the failure that
 * matters, so every guard (Subject in a header block, the designed-layout gate, an announcement of
 * inline answers, coloured answers inside the history, `>` depth returning to prose) says "do not
 * fold". A forward (its subject's prefix, or its body's own introducer) keeps the message it forwards
 * open and folds only the hops below it. One linear pass, bounded by {@link QUOTED_HISTORY_LIMITS}.
 */

export type QuotedAt = "trailing" | "leading";

/** Lines `[start, end)` of the text part are the history. */
export interface QuotedTextRange { at: QuotedAt; start: number; end: number }

/** The read-only tree the html half walks: only what the sanitizer keeps. */
export interface QuotedTree<N> {
  /** `null` for comments, doctypes and anything that is neither an element nor text. */
  kind(n: N): "element" | "text" | null;
  tag(n: N): string;
  attr(n: N, name: string): string | null;
  children(n: N): readonly N[];
  text(n: N): string;
}

/**
 * The html part's own reading, for its text part (`quotedHistoryOfText`'s `html`): where its history
 * sits, `null` when a guard says the body must not fold, `"unread"` when the html says nothing (past
 * the budget, or no history found): then only `>` runs fold.
 */
export type QuotedVerdict = QuotedAt | null | "unread";

/** `start` and everything after it in document order up to `end` (exclusive; null = the body's end). */
export interface QuotedNodeRange<N> { at: QuotedAt; start: N; end: N | null }

/** What the reader knows beside the body: the message's subject (a forward's prefix). */
export interface QuotedHint { subject?: string | null }

/** Past any of these the body is not read, and nothing folds. */
export const QUOTED_HISTORY_LIMITS = { chars: 524_288, lines: 32_768, nodes: 16_384 } as const;

// ── the vocabulary (de, en, fr, it, es, nl) ───────────────────────────────────────────────

const QUOTE_PREFIX = /^[ \t]{0,3}((?:>[ \t]?)+)/;
/** Lines longer than this are prose, never a label (a To or Cc list excepted), separator or attribution. */
const MAX_LINE = 400;

const SUBJECT_LABEL = /^(?:betreff|subject|objet|oggetto|asunto|onderwerp)\s?:\s*(.*)$/i;
type Label = "from" | "date" | "to" | "cc" | "subject" | "other";
const LABELS: Array<[Label, RegExp]> = [
  ["from", /^(?:von|from|de|da|van)\s?:\s*(.*)$/i],
  ["date", /^(?:gesendet|sent|datum|date|envoy[ée]|inviato|enviado(?: el)?|fecha|verzonden|verstuurd|data)\s?:\s*(.*)$/i],
  ["to", /^(?:an|to|[àa]|para|aan)\s?:\s*(.*)$/i],
  ["cc", /^(?:cc|bcc|kopie|copie|cco)\s?:\s*(.*)$/i],
  ["subject", SUBJECT_LABEL],
  ["other", /^(?:reply-to|antwort an|r[ée]pondre [àa]|rispondi a|responder a|wichtigkeit|importance|priorit[äa]t|anlagen|attachments|pi[èe]ces jointes|allegati|datos adjuntos|bijlagen)\s?:\s*(.*)$/i],
];

const SEPARATOR = /^-{2,}\s*(?:original message|urspr[üu]ngliche nachricht|original-nachricht|message d.origine|messaggio originale|mensaje original|oorspronkelijk bericht|forwarded message|weitergeleitete nachricht|message transf[ée]r[ée]|messaggio inoltrato|mensaje reenviado|doorgestuurd bericht|urspr[üu]ngliche mail)\s*-{2,}$/i;
/** A forward's own introducer (never a reply's "Original Message"): what follows is the forward's content. */
const FORWARD_SEPARATOR = /^-{2,}\s*(?:forwarded message|weitergeleitete nachricht|message transf[ée]r[ée]|messaggio inoltrato|mensaje reenviado|doorgestuurd bericht)\s*-{2,}$/i;
const FORWARD = /^(?:begin forwarded message|anfang der weitergeleiteten nachricht|d[ée]but du message r[ée]exp[ée]di[ée]|inizio messaggio inoltrato|comienzo del mensaje reenviado|begin doorgestuurd bericht)\s?:$/i;
/** A subject's outermost prefix is a forward's (Fwd, FW, WG, TR, I, RV, Doorst), after any bracketed tag. */
const FORWARD_SUBJECT = /^\s*(?:\[[^\]]{0,40}\]\s*)*(?:fwd?|wg|tr|i|rv|doorst)\s?:/i;
const UNDERSCORE_RULE = /^_{10,}$/;
const FOOTER_RULE = /^(?:_{20,}|={20,})$/;
const SIG_DASHES = /^--$/;

/** One anchored line saying who wrote what follows, in its language's own frame. */
const STRONG_ATTRIBUTION: RegExp[] = [
  /^on\b.{4,300}\bwrote\s?:$/i,
  /^am\b.{4,300}\bschrieb\b.{0,200}:$/i,
  /^.{2,200}\bschrieb am\b.{4,200}:$/i,
  /^am\b.{4,300}\bfolgendes geschrieben\s?:$/i,
  /^le\b.{4,300}\ba [ée]crit\s?:$/i,
  /^il\b.{4,300}\bha scritto\s?:$/i,
  /^el\b.{4,300}\bescribi[óo]\s?:$/i,
  /^op\b.{4,300}\b(?:schreef|het volgende geschreven)\b.{0,200}:$/i,
];
/** The reader's older, looser list: it folds only together with a `>` run right below it. */
const WEAK_ATTRIBUTION: RegExp[] = [
  /^on\b.*\bwrote:$/i,
  /^am\b.*\bschrieb.*:$/i,
  /^le\b.*\ba\s+écrit\s*:$/i,
  /^el\b.*\bescribió\s*:$/i,
];

const ANSWER = String.raw`(?:answers?|replies|responses?|comments?|notes|remarks|antworten|anmerkungen|kommentare|bemerkungen|notizen|r[ée]ponses?|commentaires|remarques|risposte|commenti|respuestas|comentarios|notas|antwoorden|opmerkingen|commentaar)`;
const WHERE = String.raw`(?:below|inline|in-line|in the text|at the end|underneath|unten|im text|am ende|darunter|ci-dessous|en dessous|dans le texte|[àa] la fin|sotto|di seguito|nel testo|alla fine|abajo|debajo|a continuaci[óo]n|en el texto|al final|hieronder|in de tekst|aan het eind)`;
const INK = String.raw`\b(?:in|en|in het)\s+(?:blue|red|green|bold|colou?r|blau|rot|gr[üu]n|fett|farbe|bleu|rouge|vert|gras|blu|rosso|verde|grassetto|azul|rojo|negrita|blauw|rood|groen|vetgedrukt)\b`;
/** Inside the text: unlike "below", never the place a forward follows. */
const IN_TEXT = String.raw`(?:inline|in-line|in the text|im text|dans le texte|nel testo|en el texto|in de tekst)`;
const ANSWERED = String.raw`(?:answered|replied|responded|commented|beantwortet|geantwortet|kommentiert|r[ée]pondu|comment[ée]|risposto|commentato|respondido|respond[ií]|beantwoord|geantwoord)`;
/** A colour or weight the answers are said to be in ("meine Antworten sind fett gedruckt"). */
const INK_WORD = String.raw`(?:blue|red|green|bold|colou?red|blau|rot|gr[üu]n|fett|fettgedruckt|farbig|bleu|rouge|vert|gras|blu|rosso|verde|grassetto|azul|rojo|negrita|blauw|rood|groen|vetgedrukt)`;
const SEE = String.raw`(?:see|siehe|voir|vedi|ver|zie)`;
/** Within one clause: "Any comments? The draft is below." names no answers below. */
const CLAUSE = String.raw`[^.?!,;]{0,40}`;
/**
 * The lead says its answers are inside the history: then the history is the letter. Answers and
 * where they are (or their ink) in one clause, or "see inline"; never a word of either alone.
 */
const ANNOUNCEMENT = new RegExp(
  String.raw`\b${ANSWER}\b${CLAUSE}\b${WHERE}|\b${WHERE}${CLAUSE}\b${ANSWER}\b|\b${ANSWERED}\b${CLAUSE}\b${WHERE}|\b${WHERE}${CLAUSE}\b${ANSWERED}\b`
    + String.raw`|\b${ANSWER}\b${CLAUSE}(?:${INK}|\b(?:are|is|sind|ist|sont|est|sono|son|zijn)\s+${INK_WORD}\b)|\b${SEE}\b[^.?!,;]{0,20}(?:\b${IN_TEXT}\b|${INK})`
    + String.raw`|\b(?:pasted|eingef[üu]gt|coll[ée]|incollat[oa]|pegad[oa]|geplakt)\b.{0,30}\b(?:below|unten|ci-dessous|sotto|abajo|hieronder)\b`,
  "i",
);
/** A client's own line under what was typed ("Sent from my iPhone"): never the writer's words. */
const CLIENT_SIGNATURE = /^(?:sent from my\b.{1,60}|sent from (?:mail|outlook) for (?:windows|ios|android)|von meinem\b.{1,60}\bgesendet\.?|envoy[ée] (?:de|depuis) mon\b.{1,60}|inviato da(?:l mio)?\b.{1,60}|enviado desde mi\b.{1,60}|verzonden (?:vanaf|met) mijn\b.{1,60}|get outlook for (?:ios|android)|outlook f[üu]r (?:ios|android) beziehen|obtenir outlook pour (?:ios|android)|scarica outlook per (?:ios|android)|obtener outlook para (?:ios|android)|outlook voor (?:ios|android) downloaden|sent with proton mail secure email\.?)$/i;
/** The writer's heading over comments below a pasted message ("Comments:", "Meine Anmerkungen:"). */
const COMMENT_HEAD = /\b(?:comments?|anmerkungen|kommentare?|bemerkungen|remarques|commentaires|commenti|comentarios|opmerkingen|commentaar|(?:my|meine|mes|le mie|mis|mijn)\s+(?:notes|notizen|note|notas|notities))\s?:$/i;
/** A footer the sender's server appends below everything. */
const DISCLAIMER = /\b(?:confidential(?:ity)?|vertraulich\w*|confidentiel\w*|riservat[aoie]|confidencial\w*|vertrouwelijk\w*|disclaimer|haftungsausschluss|handelsregister|registered office|registered in)\b/i;
/** A line ending a sentence, not an abbreviation ("Oct.", "10."). */
const SENTENCE_END = /[.!?]$/;
const ABBREVIATION_END = /(?:^|\s)(?:\p{Lu}\p{Ll}{0,3}|\d{1,2})\.$/u;
const MONTH = String.raw`(?:jan|feb|m[äa]r|apr|ma[iy]|jun|jul|aug|sep|o[ck]t|nov|d[ée][cz])`;
/** What the first line of a wrapped attribution carries: its date, time or address. */
const DATED = new RegExp(String.raw`\b(?:19|20)\d\d\b|\b\d{1,2}:\d\d\b|@|\b\d{1,2}[./]\d{1,2}[./]|\b${MONTH}[\p{L}]*\.?\s+\d|\d\.?\s+${MONTH}`, "iu");
const ANSWER_PREFIX = /^(?:\[[A-Z]{1,4}\]|->|=>|A:|Antwort:)/;
/** Outlook's inline-answer mark, the writer's initials or name ("[Ana Example] "): an answer when a hop repeats it. */
const ANSWER_MARK = /^\[(\p{L}[\p{L} .'-]{0,40})\]\s/u;
/** What a picture contributes to its line: content, matched by no rule. */
const PICTURE = "￼";

// ── the line model ─────────────────────────────────────────────────────────────────────────

interface Line {
  text: string;
  depth: number;
  blank: boolean;
  /** Plain text only: the raw line, whose indentation is a signal (Yahoo). */
  raw: string;
  /** Html only: the node a cut at this line starts at, or -1 when it starts inside a text node. */
  at: number;
  hr: boolean;
  cell: boolean;
  /** Inside an element that declares a mail canvas (a 520–1000 px width). */
  canvas: boolean;
  /** Inside a quote container element (gmail_quote, moz-forward-container, …). */
  boxed: boolean;
  /** Quote boxes around the line: `>` depth, a blockquote, an element drawn with a solid left rule. */
  nest: number;
  /** Inside a `.moz-cite-prefix` / `#reply-intro` introducer. */
  intro: boolean;
  /** The first line of a `.moz-signature` / `.gmail_signature`. */
  sig: boolean;
  /** Non-link characters; how many are bold, highlighted, or small print or grey. */
  chars: number;
  bold: number;
  mark: number;
  quiet: number;
  /** The line's most used ink ("" = the body's default or a grey) and its share of `chars`. */
  ink: string;
  inkShare: number;
  inks: Map<string, number> | null;
}

function newLine(text: string, depth: number, raw = ""): Line {
  return {
    text, depth, blank: text === "", raw, at: -1, hr: false, cell: false, canvas: false, boxed: false, nest: depth, intro: false, sig: false,
    chars: 0, bold: 0, mark: 0, quiet: 0, ink: "", inkShare: 0, inks: null,
  };
}

function normalize(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function labelOf(text: string): Label | null {
  // A To or Cc list may run past MAX_LINE (a group's recipients); no other label line does.
  if (text.length > MAX_LINE) {
    const k = labelOf(text.slice(0, MAX_LINE));
    return k === "to" || k === "cc" ? k : null;
  }
  if (text.indexOf(":") < 0) return null;
  for (const [label, re] of LABELS) {
    const m = re.exec(text);
    if (!m) continue;
    if (label === "from" && !/[\p{L}@]/u.test(m[1] ?? "")) return null;
    return label;
  }
  return null;
}

function strongAttribution(text: string): boolean {
  if (text.length > MAX_LINE || !text.endsWith(":") || !/\d/.test(text)) return false;
  return STRONG_ATTRIBUTION.some((re) => re.test(text));
}

function weakAttribution(text: string): boolean {
  if (text.length > MAX_LINE || !text.endsWith(":")) return false;
  return WEAK_ATTRIBUTION.some((re) => re.test(text));
}

function separatorLine(text: string): boolean {
  return text.length <= MAX_LINE && (SEPARATOR.test(text) || FORWARD.test(text));
}

/** The history from line `s` opens with a forward's introducer: the forwarded message is the content. */
function forwardAt(L: Line[], s: number): boolean {
  let k = s;
  while (k < L.length && (L[k]!.blank || UNDERSCORE_RULE.test(L[k]!.text))) k++;
  const t = k < L.length ? L[k]!.text : "";
  return t.length <= MAX_LINE && (FORWARD_SEPARATOR.test(t) || FORWARD.test(t));
}

const NAMED: Record<string, string> = {
  blue: "0000ff", red: "ff0000", green: "008000", navy: "000080", purple: "800080", teal: "008080", maroon: "800000",
  darkblue: "00008b", darkred: "8b0000", darkgreen: "006400", olive: "808000", fuchsia: "ff00ff", orange: "ffa500",
  yellow: "ffff00", lime: "00ff00", aqua: "00ffff", cyan: "00ffff", magenta: "ff00ff", gray: "808080", grey: "808080",
  silver: "c0c0c0", darkgray: "a9a9a9", darkgrey: "a9a9a9", black: "000000", white: "ffffff",
};

/** A css colour as `rrggbb`, or null. */
function rgbOf(css: string): [number, number, number] | null {
  const c = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  const h = hex ? (hex[1]!.length === 3 ? [...hex[1]!].map((x) => x + x).join("") : hex[1]!) : NAMED[c];
  if (h) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(c);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** Saturated: a colour, not a grey (`#595959` is a grey). */
function saturated(rgb: readonly number[]): boolean {
  return Math.max(...rgb) - Math.min(...rgb) >= 64;
}

/** An ink: a saturated colour by its value, every grey and black as one (""). */
function inkOf(css: string): string {
  const rgb = rgbOf(css);
  return rgb !== null && saturated(rgb) ? rgb.map((x) => x.toString(16).padStart(2, "0")).join("") : "";
}

/** A light grey, the colour of a footer (`#595959` is still body ink). */
function greyInk(css: string): boolean {
  const rgb = rgbOf(css);
  return rgb !== null && !saturated(rgb) && Math.min(...rgb) >= 96 && Math.max(...rgb) <= 224;
}

// ── the decision ───────────────────────────────────────────────────────────────────────────

interface Marker { kind: "container" | "header" | "border"; line: number; node: number }
interface Decision { at: QuotedAt; start: number; end: number; node: number }

/** Everything the rules read, precomputed once so no rule rescans the body. */
interface Facts {
  label: (Label | null)[];
  /** A header block starts at line i: a from line, a Subject, and a date or To within 12 label lines. */
  header: boolean[];
  /** The same at any quote depth: where the next hop of a history starts. */
  hop: boolean[];
  /** Line i is one of a header block's lines (any depth). A lone label line ("A: Yes.") is the writer's. */
  inHeader: boolean[];
  /** Line i is in a run of two or more label lines; `headerish`: one that names a From. */
  labelRun: boolean[];
  headerish: boolean[];
  /** A comment heading of the writer's ("Comments:") is on line i or below it. */
  commentFrom: boolean[];
  /** The writer's own words are on line i. */
  words: boolean[];
  wordsBefore: boolean[];
  wordsFrom: boolean[];
  quoteFrom: boolean[];
  /** Every non-blank line from i on is indented (plain text). */
  indentedFrom: boolean[];
}

const HEADER_SPAN = 12;

function factsOf(L: Line[], plain: boolean): Facts {
  const n = L.length;
  const any = L.map((l) => (l.blank ? null : labelOf(l.text)));
  const label = any.map((k, i) => (L[i]!.depth === 0 ? k : null));
  const hop = new Array<boolean>(n).fill(false);
  const inHeader = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (any[i] !== "from" && any[i] !== "subject") continue;
    const depth = L[i]!.depth;
    const seen = new Set<Label>();
    let wrapped = false;
    let last = i;
    for (let j = i; j < n && j < i + HEADER_SPAN; j++) {
      const l = L[j]!;
      if (l.blank) { if (plain) break; continue; }
      if (l.depth !== depth) break;
      const k = any[j];
      if (k === null) {
        // One wrapped continuation line after a To or Cc list.
        if (!wrapped && (any[j - 1] === "to" || any[j - 1] === "cc")) { wrapped = true; last = j; continue; }
        break;
      }
      seen.add(k);
      last = j;
    }
    hop[i] = seen.has("from") && seen.has("subject") && (seen.has("date") || seen.has("to"));
    if (!hop[i]) continue;
    for (let j = i; j <= last; j++) inHeader[j] = true;
    // The block starts at its first label line (GMX: "Gesendet:" above "Von:").
    for (let j = i - 1; j >= 0 && any[j] === "date" && L[j]!.depth === depth && !hop[j]; j--) hop[j] = inHeader[j] = true;
  }
  const header = hop.map((h, i) => h && L[i]!.depth === 0);
  const labelRun = new Array<boolean>(n).fill(false);
  const headerish = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n;) {
    if (label[i] === null) { i++; continue; }
    let j = i;
    let from = false;
    while (j < n && label[j] !== null) { if (label[j] === "from") from = true; j++; }
    if (j - i >= 2) for (let k = i; k < j; k++) { labelRun[k] = true; headerish[k] = from; }
    i = j;
  }
  const words = L.map((l, i) =>
    l.depth === 0 && !l.blank && !l.hr && !inHeader[i] && !labelRun[i] && !weakAttribution(l.text) && !strongAttribution(l.text) &&
    !separatorLine(l.text) && !UNDERSCORE_RULE.test(l.text) && !FOOTER_RULE.test(l.text) && !SIG_DASHES.test(l.text) &&
    !(l.text.length <= 100 && CLIENT_SIGNATURE.test(l.text)));
  const wordsBefore = new Array<boolean>(n + 1).fill(false);
  for (let i = 1; i <= n; i++) wordsBefore[i] = wordsBefore[i - 1]! || words[i - 1]!;
  const wordsFrom = new Array<boolean>(n + 1).fill(false);
  const quoteFrom = new Array<boolean>(n + 1).fill(false);
  const indentedFrom = new Array<boolean>(n + 1).fill(true);
  const commentFrom = new Array<boolean>(n + 1).fill(false);
  for (let i = n - 1; i >= 0; i--) {
    const l = L[i]!;
    wordsFrom[i] = wordsFrom[i + 1]! || words[i]!;
    quoteFrom[i] = quoteFrom[i + 1]! || l.depth > 0;
    indentedFrom[i] = indentedFrom[i + 1]! && (l.blank || /^[ \t]/.test(l.raw));
    commentFrom[i] = commentFrom[i + 1]! || (l.depth === 0 && !inHeader[i] && l.text.length <= 160 && COMMENT_HEAD.test(l.text));
  }
  return { label, header, hop, inHeader, labelRun, headerish, commentFrom, words, wordsBefore, wordsFrom, quoteFrom, indentedFrom };
}

function nextFilled(L: Line[], i: number): number {
  let k = i;
  while (k < L.length && L[k]!.blank) k++;
  return k;
}

/**
 * A footer appended below everything (a server's disclaimer, small print or grey) starts at line k:
 * a short block, nothing quoted after it. It ends the history and stays visible.
 */
function footerAt(L: Line[], f: Facts, k: number, html: boolean): boolean {
  if (k >= L.length || f.quoteFrom[k]) return false;
  let filled = 0;
  let inked = 0;
  let vocab = false;
  let quiet = true;
  for (let j = k; j < L.length; j++) {
    const l = L[j]!;
    if (l.blank || l.hr) continue;
    if (++filled > 8 || l.text.length > MAX_LINE) return false;
    // It starts with the footer itself, never with the writer's words above it.
    if (filled === 1 && !DISCLAIMER.test(l.text) && !(html && (l.chars === 0 || l.quiet * 10 >= l.chars * 6))) return false;
    if (DISCLAIMER.test(l.text)) vocab = true;
    if (l.chars > 0) {
      inked++;
      if (l.quiet * 10 < l.chars * 6) quiet = false;
    }
  }
  return vocab || (html && inked > 0 && quiet);
}

/** A signature or list footer of the NEW message starts at line k, with nothing quoted after it. */
function signatureAt(L: Line[], f: Facts, k: number): boolean {
  if (k >= L.length || f.quoteFrom[k]) return false;
  const l = L[k]!;
  if (l.sig || SIG_DASHES.test(l.text)) return true;
  if (!FOOTER_RULE.test(l.text)) return false;
  let filled = 0;
  for (let j = k + 1; j < L.length; j++) {
    if (L[j]!.blank) continue;
    if (++filled > 8 || L[j]!.text.length > 200) return false;
  }
  return true;
}

/**
 * The introducer directly above line `s`: blank lines, an `<hr>` or a `____` rule, an introducer
 * element, a strong attribution (wrapped over up to three lines), and — above a `>` run only — the
 * weak attributions and header lines the reader already sets apart.
 */
function introAbove(L: Line[], f: Facts, s: number, run: boolean): number {
  let top = s;
  for (;;) {
    let k = top - 1;
    while (k >= 0 && L[k]!.blank) k--;
    if (k < 0) return top;
    const l = L[k]!;
    // An earlier run ends the walk: each gap between runs is walked once.
    if (l.depth !== 0 || l.boxed) return top;
    if (l.intro || UNDERSCORE_RULE.test(l.text)) { top = k; continue; }
    // One attribution wrapped over up to three lines: never across a sentence's end, and its first
    // line carries the date, time or address.
    let wrapped = -1;
    let joined = "";
    for (let w = 1; w <= 3 && k - w + 1 >= 0; w++) {
      const from = k - w + 1;
      const add = L[from]!;
      if (add.blank || add.depth !== 0) break;
      if (w > 1 && SENTENCE_END.test(add.text) && !ABBREVIATION_END.test(add.text)) break;
      joined = w === 1 ? add.text : add.text + (add.text.endsWith("<") ? "" : " ") + joined;
      if (joined.length > MAX_LINE) break;
      if (strongAttribution(joined) && (w === 1 || DATED.test(add.text))) { wrapped = from; break; }
    }
    if (wrapped >= 0) { top = wrapped; continue; }
    if (run && (weakAttribution(l.text) || f.inHeader[k] || f.headerish[k])) { top = k; continue; }
    return top;
  }
}

/** An explicit answer mark: bracketed initials ("[AE] ") or a mark the hop repeats (`marks`). */
function bracketed(l: Line, marks: ReadonlySet<string>): boolean {
  return /^\[[A-Z]{1,4}\]/.test(l.text) || marks.has(ANSWER_MARK.exec(l.text)?.[1] ?? "");
}

/**
 * A line in another hand than its hop's body: mostly highlighted, mostly in another ink than the
 * hop's own, opening with an answer mark at any weight, or bold with an answer prefix ("->", "A:").
 * In plain text: an answer mark or prefix.
 */
function foreign(l: Line, hopInk: string, html: boolean, marks: ReadonlySet<string>): boolean {
  const bracket = bracketed(l, marks);
  if (!html) return bracket || ANSWER_PREFIX.test(l.text);
  if (l.chars === 0) return false;
  if (l.mark * 10 >= l.chars * 6) return true;
  if (l.ink !== hopInk && l.inkShare >= 0.6) return true;
  return bracket || (l.bold === l.chars && ANSWER_PREFIX.test(l.text));
}

/** The answer marks two or more body lines of the hop `a..b` open with (one "[EXTERNAL]" banner is none). */
function marksOf(L: Line[], f: Facts, a: number, b: number, html: boolean): Set<string> {
  const seen = new Set<string>();
  const marks = new Set<string>();
  for (let i = a; i < b; i++) {
    const m = bodyLine(L, f, i, html) ? ANSWER_MARK.exec(L[i]!.text)?.[1] : undefined;
    if (m === undefined) continue;
    if (seen.has(m)) marks.add(m);
    seen.add(m);
  }
  return marks;
}

/** A line of the history's own body (not a header block's, not empty). */
function bodyLine(L: Line[], f: Facts, i: number, html: boolean): boolean {
  const l = L[i]!;
  return !l.blank && !l.hr && !f.inHeader[i] && (html ? l.chars > 0 : f.words[i]!);
}

/** Prose in the hop's own hand: a sentence of several words, not small print, grey or a disclaimer. */
function prose(l: Line): boolean {
  return l.quiet * 10 < l.chars * 6 && SENTENCE_END.test(l.text) && !DISCLAIMER.test(l.text) && l.text.split(" ").length >= 4;
}

/**
 * Answers written inside a history: a foreign line with body lines of the hop's own ink before it
 * and the hop's prose after it (not its closing block: a coloured company name is no answer), in one
 * hop (a header block or a separator starts the next), up to `end`.
 */
function answersInside(L: Line[], f: Facts, s: number, html: boolean, end = L.length): boolean {
  const n = end;
  for (let a = s; a < n;) {
    let b = a + 1;
    while (b < n && !f.hop[b] && !separatorLine(L[b]!.text)) b++;
    // The hop's own ink: the one most of its body is written in.
    const weight = new Map<string, number>();
    if (html) {
      for (let i = a; i < b; i++) {
        const l = L[i]!;
        if (bodyLine(L, f, i, html) && l.mark * 10 < l.chars * 6) weight.set(l.ink, (weight.get(l.ink) ?? 0) + l.chars);
      }
    }
    let hopInk = "";
    let most = -1;
    for (const [ink, w] of weight) if (w > most) { most = w; hopInk = ink; }
    const marks = marksOf(L, f, a, b, html);
    // A heading ("URGENT", "Bitte beachten:") is the hop's own emphasis: its one foreign line with no
    // lowercase letter or ending in ':', not under a question. Several, or one under a question, answer.
    let heading = -1;
    if (html) {
      let shaped = 0;
      let above = "";
      for (let i = a; i < b; i++) {
        if (!bodyLine(L, f, i, html)) continue;
        const t = L[i]!.text;
        if ((t.endsWith(":") || !/\p{Ll}/u.test(t)) && foreign(L[i]!, hopInk, html, marks)) {
          shaped++;
          heading = shaped === 1 && !above.endsWith("?") ? i : -1;
        }
        above = t;
      }
      if (shaped !== 1) heading = -1;
    }
    let before = false;
    let pending = false;
    for (let i = a; i < b; i++) {
      if (!bodyLine(L, f, i, html) || i === heading) continue;
      const l = L[i]!;
      if (foreign(l, hopInk, html, marks)) {
        // A marked answer needs no prose after it: it may answer the last question.
        if (before && bracketed(l, marks)) return true;
        if (before) pending = true;
        continue;
      }
      if (html && l.ink !== hopInk) continue;
      if (pending && (!html || prose(l))) return true;
      before = true;
    }
    a = b;
  }
  return false;
}

/** What a writer opens an inline answer with: initials, a name mark, an answer prefix. */
function opensAnswer(t: string): boolean {
  return /^\[[A-Z]{1,4}\]/.test(t) || ANSWER_MARK.test(t) || ANSWER_PREFIX.test(t);
}

/**
 * THE EARLIER MESSAGES' OWN QUOTES, AND NOTHING ELSE (html): from the header block at `from` to `to`,
 * each hop opens with its header block and its first body line at the header's level; every body line
 * is one ink, unhighlighted, with no answer opener; the level's lines share one ink; each run of
 * deeper lines (a quote box) shares one ink, is not right below the message's own question, holds only
 * questions below a question and is followed by a sentence of the message, not a word or two. A box in
 * another ink than the message's ends with the question the message answers; all such boxes of a hop
 * share one ink, and the first sits below a greeting or a lead-in, not below a sentence.
 */
function ownQuotesOnly(L: Line[], f: Facts, from: number, to: number): boolean {
  for (let a = from; a < to;) {
    let b = a + 1;
    while (b < to && !f.hop[b] && !separatorLine(L[b]!.text)) b++;
    // Every hop opens with its header block (the first at `from`): never a separator or a bare quote.
    if (!f.hop[a]) return false;
    const lv = L[a]!.nest;
    let levelInk: string | null = null;
    let boxInk: string | null = null;
    let quoteInk: string | null = null;
    let above: Line | null = null;
    for (let i = a; i <= b; i++) {
      const l = i < b && bodyLine(L, f, i, true) ? L[i]! : null;
      if (i < b && l === null) continue;
      if (boxInk !== null && (l === null || l.nest <= lv)) {
        if (boxInk !== levelInk && !above!.text.endsWith("?")) return false;
        if (l !== null && l.text.split(" ").length < 4) return false;
        boxInk = null;
      }
      if (l === null) break;
      if (l.nest < lv || l.mark > 0 || l.inkShare < 1 || opensAnswer(l.text)) return false;
      if (l.nest === lv) {
        if (levelInk === null) levelInk = l.ink;
        else if (l.ink !== levelInk) return false;
      } else if (boxInk === null) {
        // A box opens: never right below the message's own question; in another ink, below a
        // greeting or lead-in the first time, and in that one ink every time.
        if (above === null || levelInk === null || above.text.endsWith("?")) return false;
        if (l.ink !== levelInk) {
          if (quoteInk === null ? SENTENCE_END.test(above.text) : l.ink !== quoteInk) return false;
          quoteInk = l.ink;
        }
        boxInk = l.ink;
      } else if (l.ink !== boxInk || (above!.text.endsWith("?") && !l.text.endsWith("?"))) {
        return false;
      }
      above = l;
    }
    a = b;
  }
  return true;
}

/**
 * The header path's answer read from the header block at `h` to `end`: 0.30.16's read, and the message
 * under each header block of this level read on its own up to an attribution (a long older quote in
 * another ink then sets no hop ink), unless the earlier messages hold only their own quotes.
 */
function answersBelowHeader(L: Line[], f: Facts, h: number, end: number, html: boolean): boolean {
  if (html && ownQuotesOnly(L, f, h, end)) return false;
  if (answersInside(L, f, h, html, end)) return true;
  if (!html) return false;
  for (let i = h; i < end; i++) {
    if (!f.header[i]) continue;
    const e = firstHopEnd(L, f, i, end);
    if (answersInside(L, f, i, html, e)) return true;
    // Header lines before e come before this message's first line: their reads end at e, over hops read here.
    i = Math.max(i, e - 1);
  }
  return false;
}

interface Cand { kind: "run" | "header"; line: number; end: number; node: number }

/**
 * A bare header block (no client marker, no separator) reads as a paste or a memo: its lead
 * introduces it (a colon, or a sentence: a reply's lead ends in a sign-off), or its labels open
 * with To or Cc (a memo; a date first is GMX's and WEB.DE's reply header).
 */
function pastedBlock(L: Line[], f: Facts, s: number, line: number): boolean {
  let first = line;
  while (first > 0 && !L[first - 1]!.blank && L[first - 1]!.depth === 0 && f.label[first - 1] !== null) first--;
  let k = s - 1;
  while (k >= 0 && L[k]!.blank) k--;
  if (k >= 0) {
    const t = L[k]!.text;
    if (t.endsWith(":")) return true;
    if (SENTENCE_END.test(t) && !ABBREVIATION_END.test(t) && !DISCLAIMER.test(t) && t.split(" ").length >= 5) return true;
  }
  return f.label[first] === "to" || f.label[first] === "cc";
}

/** The first hop of a quote run: up to the first attribution, header block or separator after its own text. */
function firstHopEnd(L: Line[], f: Facts, from: number, to: number): number {
  let body = false;
  for (let i = from; i < to; i++) {
    const l = L[i]!;
    if (l.blank) continue;
    if (strongAttribution(l.text) || weakAttribution(l.text) || separatorLine(l.text) || f.hop[i] || l.intro) {
      if (body) return i;
    } else {
      body = true;
    }
  }
  return to;
}

function leadOf(L: Line[], s: number): string {
  let lead = "";
  for (let i = 0; i < s; i++) if (!L[i]!.blank) lead += `${L[i]!.text}\n`;
  return lead;
}

/** The message is a forward by its subject: what its history opens with is the content it delivers. */
export function isForwardSubject(subject: string | null | undefined): boolean {
  return typeof subject === "string" && FORWARD_SUBJECT.test(subject.slice(0, MAX_LINE));
}

/** The Subject value of the header block starting at line `h`, or null. */
function hopSubject(L: Line[], f: Facts, h: number): string | null {
  for (let j = h; j < L.length && j < h + HEADER_SPAN && f.inHeader[j]; j++) {
    const m = L[j]!.text.length <= MAX_LINE ? SUBJECT_LABEL.exec(L[j]!.text) : null;
    if (m) return m[1] ?? "";
  }
  return null;
}

/**
 * A forward's history from line `s` to `end`: its first forwarded message is the content, so the fold
 * starts at the hop below that message (a header block, separator, attribution, or a deeper quote that
 * runs to `end`). A forwarded message that is itself a forward (its header's subject, or the hop's own
 * introducer) delivers the hop below it too. No such hop, or answers in what would fold: nothing folds.
 */
function belowForward(L: Line[], f: Facts, s: number, end: number, html: boolean): Decision | typeof NO {
  let base = -1;
  // The header block of the message kept open.
  let head = -1;
  for (let i = s; i < end; i++) {
    const l = L[i]!;
    if (l.blank) continue;
    const rule = UNDERSCORE_RULE.test(l.text);
    let opens = f.hop[i] || separatorLine(l.text) || strongAttribution(l.text) || l.intro || (rule && f.hop[nextFilled(L, i + 1)] === true);
    if (base < 0) {
      if (f.hop[i]) head = i;
      if (!opens && !rule && !f.inHeader[i]) base = l.depth;
      continue;
    }
    if (opens && (forwardAt(L, i) || (head >= 0 && isForwardSubject(hopSubject(L, f, head))))) {
      base = -1;
      head = f.hop[i] ? i : -1;
      continue;
    }
    if (!opens && l.depth > base) {
      let j = i;
      while (j < end && (L[j]!.blank || L[j]!.depth > base)) j++;
      if (j < end) { i = j - 1; continue; }
      opens = true;
    }
    if (!opens) continue;
    let h = introAbove(L, f, i, true);
    while (h - 1 > s && L[h - 1]!.hr) h--;
    if (h <= s) return NO;
    let deeper = false;
    for (let j = h; j < end; j++) {
      const k = L[j]!;
      if (k.depth > base) deeper = true;
      else if (deeper && !k.blank && (k.depth > 0 || f.words[j])) return NO;
    }
    if (answersInside(L, f, h, html, end)) return NO;
    return { at: "trailing", start: h, end, node: L[h]!.at };
  }
  return NO;
}

/** A guard's no (`decide`): unlike finding nothing, it holds the text part too. */
const NO = "no" as const;

/**
 * `null`: no history found; {@link NO}: a guard says this body must not fold.
 * `quotesOnly`: the html part was not read, so only `>` runs may fold (no depth-0 history).
 * `vouched`: the html part folds as trailing; a bare block in the text is then no paste.
 * `forward`: the subject says the message is a forward ({@link belowForward}).
 */
function decide(
  L: Line[], markers: Marker[], designed: boolean, html: boolean, quotesOnly = false, vouched = false, forward = false,
): Decision | typeof NO | null {
  const n = L.length;
  if (n === 0) return null;
  const f = factsOf(L, !html);
  const cands: Cand[] = [];
  // Quote runs: `>` depth or a container element, merged across blank lines.
  const quoted = (l: Line): boolean => l.depth > 0 || l.boxed;
  const inRun = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n;) {
    if (!quoted(L[i]!)) { i++; continue; }
    let j = i;
    while (j < n) {
      if (quoted(L[j]!)) { j++; continue; }
      const k = nextFilled(L, j);
      if (k > j && k < n && quoted(L[k]!)) { j = k; continue; }
      break;
    }
    cands.push({ kind: "run", line: i, end: j, node: -1 });
    for (let k = i; k < j; k++) inRun[k] = true;
    i = j;
  }
  // Header markers (`#divRplyFwdMsg`, `hr#zwchr`; an Outlook border-top div only over a header block).
  for (const m of quotesOnly ? [] : markers) {
    if (m.kind === "container" || m.line >= n || inRun[m.line]) continue;
    if (m.kind === "border" && ((designed && L[m.line]!.canvas) || L[m.line]!.cell || !f.header[m.line])) continue;
    cands.push({ kind: "header", line: m.line, end: n, node: m.node });
  }
  // Signals in unquoted text. A designed layout needs a marker; a table cell needs one too.
  if (!designed && !quotesOnly) {
    for (let i = 0; i < n; i++) {
      const l = L[i]!;
      if (l.blank || l.depth !== 0 || inRun[i] || l.cell) continue;
      let hit = separatorLine(l.text) || f.header[i]!;
      if (!hit && UNDERSCORE_RULE.test(l.text)) hit = f.header[nextFilled(L, i + 1)] === true;
      // Yahoo: an attribution over history that is only indented, never `>`-quoted.
      if (!hit && !html && strongAttribution(l.text) && !f.quoteFrom[i + 1] && f.indentedFrom[i + 1] && f.wordsFrom[i + 1]) hit = true;
      if (hit) cands.push({ kind: "header", line: i, end: n, node: -1 });
    }
  }
  cands.sort((a, b) => a.line - b.line || (a.kind === b.kind ? 0 : a.kind === "run" ? -1 : 1));

  let runs = 0;
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci]!;
    if (c.kind === "header") {
      // Unquoted history runs to the body's end, and only behind guards.
      const s = introAbove(L, f, c.line, false);
      const fwd = forward || forwardAt(L, s);
      if (!f.wordsBefore[s] && !fwd) return NO;
      if (ANNOUNCEMENT.test(leadOf(L, s))) return NO;
      if (f.commentFrom[c.line]) return NO;
      if (fwd) return belowForward(L, f, s, n, html);
      const bare = c.node < 0 && s === c.line && f.header[c.line] && !separatorLine(L[c.line]!.text);
      if (bare && !vouched && pastedBlock(L, f, s, c.line)) return NO;
      if (answersBelowHeader(L, f, c.line, n, html)) return NO;
      return { at: "trailing", start: s, end: n, node: s === c.line && c.node >= 0 ? c.node : L[s]!.at };
    }
    const firstRun = runs++ === 0;
    // A container that opens with a header block (new Outlook's) and holds only the earlier messages'
    // own quotes: the fold the code below makes when its two answer guards are silent. Else unchanged.
    if (html && !forward && L[c.line]!.boxed && f.header[c.line]) {
      const s = introAbove(L, f, c.line, true);
      const head = L[c.line]!;
      const introduced = s < c.line || head.intro || strongAttribution(head.text) || weakAttribution(head.text) || separatorLine(head.text);
      const k = nextFilled(L, c.end);
      if (f.wordsBefore[s] && !forwardAt(L, s) && (k >= n || signatureAt(L, f, k) || footerAt(L, f, k, html)) && (k >= n || introduced)
        && !ANNOUNCEMENT.test(leadOf(L, s)) && !f.commentFrom[c.line] && ownQuotesOnly(L, f, c.line, c.end)) {
        return { at: "trailing", start: s, end: k, node: L[s]!.at };
      }
    }
    // Answers between the quotes of one container: the container is the letter.
    let quote = false;
    for (let i = c.line; i < c.end; i++) {
      if (L[i]!.depth > 0) quote = true;
      else if (quote && f.words[i]) return NO;
    }
    const s = introAbove(L, f, c.line, true);
    const head = L[c.line]!;
    const introduced = s < c.line || head.intro || strongAttribution(head.text) || weakAttribution(head.text) || separatorLine(head.text);
    // A laid-out mail's own quote (a pull quote) needs an introducer or a client's container.
    if ((designed || head.cell) && !introduced && !head.boxed) continue;
    const k = nextFilled(L, c.end);
    if (k >= n || signatureAt(L, f, k) || (f.wordsBefore[s] && footerAt(L, f, k, html))) {
      const fwd = forward || forwardAt(L, s);
      if (!f.wordsBefore[s] && !fwd) return NO;
      // Above the new message's signature or footer, an unintroduced quote is the writer's own passage.
      if (k < n && !introduced) continue;
      // Answers typed inside the first quote: the lead says so, or they are in another hand.
      if ((firstRun || f.header[c.line]) && ANNOUNCEMENT.test(leadOf(L, s))) return NO;
      if (f.header[c.line] && f.commentFrom[c.line]) return NO;
      if (fwd) return belowForward(L, f, s, k, html);
      // From the container's first header block of its own level (new Outlook's, or an Outlook hop under
      // Yahoo's attribution) to its end, as the header path reads the body.
      let h = c.line;
      while (h < c.end && !f.header[h]) h++;
      if ((firstRun && answersInside(L, f, c.line, html, firstHopEnd(L, f, c.line, c.end)))
        || (h < c.end && answersBelowHeader(L, f, h, c.end, html))) return NO;
      return { at: "trailing", start: s, end: k, node: L[s]!.at };
    }
    // Bottom-posted: an introducer and its quote come first, the reply below, nothing quoted after.
    if (!forward && ci === 0 && cands.length === 1 && introduced && !f.wordsBefore[s] && f.wordsFrom[c.end] && !f.quoteFrom[c.end]) {
      return { at: "leading", start: s, end: k, node: L[s]!.at };
    }
  }
  return null;
}

// ── plain text ─────────────────────────────────────────────────────────────────────────────

/**
 * The history in a text part's lines, or `null`. `html`: the message's html part's own reading
 * ({@link quotedHistoryVerdictOfHtml}) — the text folds only where the html folds, at the same kind,
 * and only `>` runs when the html could not be read. Absent when the message has no html part.
 */
export function quotedHistoryOfText(lines: readonly string[], opts: { html?: QuotedVerdict } & QuotedHint = {}): QuotedTextRange | null {
  if (opts.html === null) return null;
  if (lines.length > QUOTED_HISTORY_LIMITS.lines) return null;
  let chars = 0;
  const L: Line[] = [];
  for (const raw0 of lines) {
    const raw = raw0.endsWith("\r") ? raw0.slice(0, -1) : raw0;
    chars += raw.length;
    if (chars > QUOTED_HISTORY_LIMITS.chars) return null;
    const m = QUOTE_PREFIX.exec(raw);
    const depth = m ? (m[1]!.match(/>/g) ?? []).length : 0;
    L.push(newLine(normalize(m ? raw.slice(m[0].length) : raw), depth, raw));
  }
  const d = decide(L, [], false, false, opts.html === "unread", opts.html === "trailing", isForwardSubject(opts.subject));
  if (d === null || d === NO || (opts.html !== undefined && opts.html !== "unread" && d.at !== opts.html)) return null;
  return { at: d.at, start: d.start, end: d.end };
}

// ── html ───────────────────────────────────────────────────────────────────────────────────

const BLOCK = new Set([
  "p", "div", "blockquote", "li", "ul", "ol", "dl", "dt", "dd", "tr", "table", "tbody", "thead", "tfoot", "caption",
  "h1", "h2", "h3", "h4", "h5", "h6", "pre", "hr", "center", "section", "article", "header", "footer", "address",
  "figure", "figcaption", "main", "nav", "aside", "details", "summary",
]);
const SKIP = new Set(["style", "script", "head", "title", "template", "noscript", "svg", "math", "xml"]);
const COLOR_DECL = /(?:^|;)\s*color\s*:\s*([^;!]+)/i;
const BOLD_DECL = /font-weight\s*:\s*(?:bold|bolder|[6-9]00)/i;
const BACKGROUND_DECL = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/i;
const HIGHLIGHT_DECL = /(?:^|;)\s*mso-highlight\s*:\s*([^;!]+)/i;
const SMALL_DECL = /(?:^|;)\s*font-size\s*:\s*(\d+(?:\.\d+)?)\s*(pt|px)/i;
/** Where a highlight is the writer's marking, not a layout's fill. */
const INLINE = new Set(["span", "font", "b", "strong", "i", "em", "u", "mark", "a", "small"]);
/** A declared mail canvas, fixed or responsive: a width in the 520–1000 px band (the reader's own `isDesignedLayout`). */
const CANVAS = new Set(["table", "tr", "td", "th", "col", "colgroup", "div", "center"]);
const CANVAS_DECL = /(?:^|[;{])\s*(?:max-)?width\s*:\s*(\d+(?:\.\d+)?)\s*px/gi;
const canvasPx = (v: number): boolean => v >= 520 && v <= 1000;

function declaresCanvas(css: string): boolean {
  CANVAS_DECL.lastIndex = 0;
  for (let m = CANVAS_DECL.exec(css); m; m = CANVAS_DECL.exec(css)) if (canvasPx(Number(m[1]))) return true;
  return false;
}

const tiny = (v: string | null): boolean => v !== null && /^\s*0*[01](?:\.0*)?\s*(?:px)?\s*$/i.test(v);

/** A tracking pixel or a hidden picture: nothing a reader sees. */
function pixelImage<N>(n: N, tree: QuotedTree<N>): boolean {
  if (tree.attr(n, "data-ohmail-pixel") !== null || tiny(tree.attr(n, "width")) || tiny(tree.attr(n, "height"))) return true;
  const style = tree.attr(n, "style") ?? "";
  if (/(?:^|;)\s*display\s*:\s*none/i.test(style)) return true;
  return tiny(/(?:^|;)\s*width\s*:\s*([^;!]+)/i.exec(style)?.[1] ?? null) || tiny(/(?:^|;)\s*height\s*:\s*([^;!]+)/i.exec(style)?.[1] ?? null);
}

function textOfTree<N>(n: N, tree: QuotedTree<N>): string {
  let out = "";
  for (const c of tree.children(n)) if (tree.kind(c) === "text") out += tree.text(c);
  return out;
}
/** Yahoo prefixes its own ids and classes (`ydp1a2b3c4dyahoo_quoted_1`). */
const CONTAINER_CLASS = /^(?:x_)*(?:gmail_quote|protonmail_quote|(?:ydp[0-9a-f]*)?yahoo_quoted|moz-forward-container)$/;
const CONTAINER_ID = /^(?:x_)*(?:(?:ydp[0-9a-f]*)?yahoo_quoted\w*|mail-editor-reference-message-container)$/;
const INTRO_CLASS = /^(?:x_)*moz-cite-prefix$/;
const INTRO_ID = /^(?:x_)*reply-intro$/;
const SIG_CLASS = /^(?:x_)*(?:moz-signature|gmail_signature)$/;
const HEADER_ID = /^(?:x_)*divRplyFwdMsg$/;
const ZIMBRA_ID = /^(?:x_)*zwchr$/;

function hasToken(value: string | null, name: RegExp): boolean {
  if (!value) return false;
  for (const t of value.split(/\s+/)) if (name.test(t)) return true;
  return false;
}

interface Frame<N> {
  kids: readonly N[];
  next: number;
  /** This element's node index (-1 for the root). */
  at: number;
  block: boolean;
  /** Text or a picture was seen inside this element. */
  content: boolean;
  depth: number;
  boxed: boolean;
  nest: number;
  intro: boolean;
  cell: boolean;
  canvas: boolean;
  /** The ink its text is in ("" = default or grey), and whether it is highlighted or small print or grey. */
  ink: string;
  mark: boolean;
  quiet: boolean;
  bold: boolean;
  link: boolean;
  pre: boolean;
  /** The signature element this frame sits in, until its first line is drawn. */
  sig: { drawn: boolean } | null;
}

interface Linear<N> { lines: Line[]; markers: Marker[]; nodes: N[]; designed: boolean }

/** One iterative pass: the tree as lines, each knowing the node a cut there starts at. */
function linearize<N>(root: N, tree: QuotedTree<N>, sheets: readonly string[] = []): Linear<N> | null {
  const lines: Line[] = [];
  const markers: Marker[] = [];
  const nodes: N[] = [];
  /** A style sheet declares the canvas (the tree's own, or one outside it): every line sits in it. */
  let sheet = sheets.some(declaresCanvas);
  let designed = sheet;
  let budget = QUOTED_HISTORY_LIMITS.nodes;
  let chars = 0;
  let cur: Line | null = null;
  /** The node the next line starts at; set by the first node met after a break. */
  let start = -1;
  let fresh = true;
  const stack: Array<Frame<N>> = [{
    kids: tree.children(root), next: 0, at: -1, block: true, content: false, depth: 0, boxed: false, nest: 0, intro: false,
    cell: false, canvas: false, ink: "", mark: false, quiet: false, bold: false, link: false, pre: false, sig: null,
  }];

  const flush = (): void => {
    if (cur !== null) {
      cur.text = normalize(cur.text);
      if (cur.inks !== null) {
        for (const [ink, c] of cur.inks) if (c > cur.inkShare) { cur.inkShare = c; cur.ink = ink; }
        cur.inkShare = cur.chars > 0 ? cur.inkShare / cur.chars : 0;
        cur.inks = null;
      }
      if (cur.text !== "") {
        cur.blank = false;
        cur.at = start;
        lines.push(cur);
        fresh = true;
        start = -1;
      }
    }
    cur = null;
  };
  /** A cut at node `index` may start at the highest ancestor nothing has been seen in yet. */
  const begin = (index: number): void => {
    if (!fresh || start >= 0) return;
    let at = index;
    for (let k = stack.length - 1, hops = 0; k >= 1 && hops < 64 && !stack[k]!.content; k--, hops++) at = stack[k]!.at;
    start = at;
  };
  const lineIn = (fr: Frame<N>): Line => {
    if (cur === null) {
      cur = newLine("", fr.depth);
      cur.boxed = fr.boxed;
      cur.nest = fr.nest;
      cur.intro = fr.intro;
      cur.cell = fr.cell;
      cur.canvas = fr.canvas;
      if (fr.sig && !fr.sig.drawn) { fr.sig.drawn = true; cur.sig = true; }
    }
    return cur;
  };
  const sawContent = (): void => {
    for (let k = stack.length - 1; k >= 0 && !stack[k]!.content; k--) stack[k]!.content = true;
  };

  while (stack.length > 0) {
    const fr = stack[stack.length - 1]!;
    if (fr.next >= fr.kids.length) {
      if (fr.block) flush();
      stack.pop();
      continue;
    }
    const n = fr.kids[fr.next++]!;
    if (--budget < 0) return null;
    const kind = tree.kind(n);
    if (kind === "text") {
      const raw = tree.text(n);
      chars += raw.length;
      if (chars > QUOTED_HISTORY_LIMITS.chars) return null;
      const index = nodes.push(n) - 1;
      const parts = fr.pre ? raw.split("\n") : [raw];
      for (let p = 0; p < parts.length; p++) {
        if (p > 0) {
          // A line that starts inside this text node cannot be cut at.
          flush();
          fresh = false;
          start = -1;
        } else {
          begin(index);
        }
        const piece = parts[p]!;
        const l = lineIn(fr);
        l.text += piece;
        const visible = piece.replace(/[\s ]+/g, "").length;
        if (visible === 0) continue;
        sawContent();
        if (fr.link) continue;
        l.chars += visible;
        (l.inks ??= new Map()).set(fr.ink, (l.inks.get(fr.ink) ?? 0) + visible);
        if (fr.mark) l.mark += visible;
        if (fr.quiet) l.quiet += visible;
        if (fr.bold) l.bold += visible;
      }
      continue;
    }
    if (kind !== "element") continue;
    const tag = tree.tag(n).toLowerCase();
    if (tag === "style" && !sheet && declaresCanvas(textOfTree(n, tree))) designed = sheet = true;
    if (SKIP.has(tag)) continue;
    const index = nodes.push(n) - 1;
    if (tag === "br") {
      begin(index);
      flush();
      fresh = true;
      continue;
    }
    if (tag === "img") {
      if (pixelImage(n, tree)) continue;
      begin(index);
      lineIn(fr).text += ` ${PICTURE} `;
      sawContent();
      continue;
    }
    const block = BLOCK.has(tag);
    if (block) flush();
    begin(index);
    if (tag === "hr") {
      const l = newLine("", fr.depth);
      l.hr = true;
      l.at = start;
      l.boxed = fr.boxed;
      l.nest = fr.nest;
      l.canvas = fr.canvas;
      lines.push(l);
      start = -1;
      fresh = true;
      if (hasToken(tree.attr(n, "id"), ZIMBRA_ID) && fr.depth === 0 && !fr.boxed) {
        markers.push({ kind: "header", line: lines.length - 1, node: index });
      }
      continue;
    }
    const cls = tree.attr(n, "class");
    const id = tree.attr(n, "id");
    const style = tree.attr(n, "style") ?? "";
    // An indent (`border:none`, no cite, no quote class) is the writer's own layout, not a quote.
    const indent = /border\s*:\s*none/i.test(style) && tree.attr(n, "type") === null && !/quote/i.test(cls ?? "");
    const depth = fr.depth + (tag === "blockquote" && !indent ? 1 : 0);
    const container = hasToken(cls, CONTAINER_CLASS) || hasToken(id, CONTAINER_ID);
    const quiet = fr.depth === 0 && !fr.boxed;
    if (container) markers.push({ kind: "container", line: lines.length, node: index });
    else if (quiet && hasToken(id, HEADER_ID)) markers.push({ kind: "header", line: lines.length, node: index });
    // Outlook's border-top div; GMX's, WEB.DE's and mail.com's border-left quote box.
    else if (quiet && tag === "div" && /border-top\s*:\s*solid|border-left\s*:[^;]*\bsolid/i.test(style)) markers.push({ kind: "border", line: lines.length, node: index });
    const w = CANVAS.has(tag) ? tree.attr(n, "width") : null;
    const canvas = CANVAS.has(tag) && ((w !== null && /^\s*\d+\s*$/.test(w) && canvasPx(Number(w))) || declaresCanvas(style));
    if (canvas) designed = true;
    const colour = COLOR_DECL.exec(style)?.[1] ?? (tag === "font" ? tree.attr(n, "color") : null);
    let mark = fr.mark || tag === "mark";
    if (INLINE.has(tag)) {
      const bg = BACKGROUND_DECL.exec(style)?.[1]?.trim().split(/\s+/)[0];
      const rgb = bg ? rgbOf(bg) : null;
      const hl = HIGHLIGHT_DECL.exec(style)?.[1]?.trim().toLowerCase();
      if ((rgb !== null && saturated(rgb)) || (hl !== undefined && hl !== "none" && hl !== "auto")) mark = true;
    }
    const size = SMALL_DECL.exec(style);
    const small = tag === "small" || (tag === "font" && /^\s*[12]\s*$/.test(tree.attr(n, "size") ?? ""))
      || (size !== null && Number(size[1]) <= (size[2]!.toLowerCase() === "pt" ? 9 : 12));
    const quoteBox = (tag === "blockquote" && !indent) || /border-left\s*:[^;]*\bsolid|border-left-style\s*:\s*solid/i.test(style);
    const child: Frame<N> = {
      kids: tree.children(n), next: 0, at: index, block, content: false, depth,
      boxed: fr.boxed || container, nest: fr.nest + (quoteBox ? 1 : 0), intro: fr.intro || hasToken(cls, INTRO_CLASS) || hasToken(id, INTRO_ID),
      cell: fr.cell || tag === "td" || tag === "th", canvas: fr.canvas || canvas,
      ink: colour != null ? inkOf(colour) : fr.ink,
      mark,
      quiet: small || (colour != null ? greyInk(colour) : fr.quiet),
      bold: fr.bold || tag === "b" || tag === "strong" || BOLD_DECL.test(style),
      link: fr.link || tag === "a", pre: fr.pre || tag === "pre",
      sig: hasToken(cls, SIG_CLASS) ? { drawn: false } : fr.sig,
    };
    stack.push(child);
    if (tag === "td" || tag === "th") lineIn(child).text += " ";
  }
  flush();
  if (sheet) for (const l of lines) l.canvas = true;
  return { lines, markers, nodes, designed };
}

/** The path from `root` to `target` (both included), or null. Iterative and bounded. */
function pathTo<N>(root: N, tree: QuotedTree<N>, target: N): N[] | null {
  if (root === target) return [root];
  const path: N[] = [root];
  const kids: Array<readonly N[]> = [tree.children(root)];
  const at: number[] = [0];
  let budget = QUOTED_HISTORY_LIMITS.nodes * 2;
  while (path.length > 0) {
    const d = path.length - 1;
    if (at[d]! >= kids[d]!.length) {
      path.pop();
      kids.pop();
      at.pop();
      continue;
    }
    const n = kids[d]![at[d]!++]!;
    if (--budget < 0) return null;
    if (n === target) return [...path, n];
    if (tree.kind(n) === "element") {
      path.push(n);
      kids.push(tree.children(n));
      at.push(0);
    }
  }
  return null;
}

/** Nothing a reader would see: whitespace, a comment, a line break, a rule, an empty element. */
function empty<N>(n: N, tree: QuotedTree<N>, budget: { left: number }): boolean {
  if (--budget.left < 0) return false;
  const kind = tree.kind(n);
  if (kind === null) return true;
  if (kind === "text") return tree.text(n).replace(/[\s ]+/g, "") === "";
  const tag = tree.tag(n).toLowerCase();
  if (tag === "br" || tag === "hr") return true;
  if (tag === "img") return pixelImage(n, tree);
  if (SKIP.has(tag)) return false;
  for (const c of tree.children(n)) if (!empty(c, tree, budget)) return false;
  return true;
}

/**
 * The html part's whole reading: its history as a node range (or `null`), and the verdict its text
 * part follows — where the history sits, `null` when a guard says no, `"unread"` when the tree was
 * past the budget or the html found no history (its text may still fold its `>` runs). A laid-out
 * mail (a 520–1000 px canvas) lets only client markers start a history. `sheets`: style sheets
 * outside the tree (the head's), read for that canvas only.
 */
export function quotedHistoryReadingOfHtml<N>(root: N, tree: QuotedTree<N>, opts: { sheets?: readonly string[] } & QuotedHint = {}): {
  range: QuotedNodeRange<N> | null;
  verdict: QuotedVerdict;
} {
  const lin = linearize(root, tree, opts.sheets);
  if (lin === null) return { range: null, verdict: "unread" };
  const d = decide(lin.lines, lin.markers, lin.designed, true, false, false, isForwardSubject(opts.subject));
  if (d === null) return { range: null, verdict: "unread" };
  if (d === NO) return { range: null, verdict: null };
  return { range: rangeOf(root, tree, lin, d), verdict: d.at };
}

/** The history in a sanitized html tree, as a node range, or `null`. */
export function quotedHistoryOfHtml<N>(root: N, tree: QuotedTree<N>, opts: { sheets?: readonly string[] } & QuotedHint = {}): QuotedNodeRange<N> | null {
  return quotedHistoryReadingOfHtml(root, tree, opts).range;
}

/** The html part's verdict for its text part ({@link quotedHistoryReadingOfHtml}). */
export function quotedHistoryVerdictOfHtml<N>(root: N, tree: QuotedTree<N>, opts: { sheets?: readonly string[] } & QuotedHint = {}): QuotedVerdict {
  return quotedHistoryReadingOfHtml(root, tree, opts).verdict;
}

function rangeOf<N>(root: N, tree: QuotedTree<N>, lin: Linear<N>, d: Decision): QuotedNodeRange<N> | null {
  if (d.node < 0) return null;
  let end: N | null = null;
  if (d.end < lin.lines.length) {
    const e = lin.lines[d.end]!.at;
    if (e < 0) return null;
    end = lin.nodes[e]!;
  }
  // Empty nodes right above the start join the history: no gap above the toggle.
  const path = pathTo(root, tree, lin.nodes[d.node]!);
  if (path === null || path.length < 2) return null;
  const endPath = end === null ? null : pathTo(root, tree, end);
  if (end !== null && endPath === null) return null;
  const holdsEnd = new Set(endPath ?? []);
  const budget = { left: QUOTED_HISTORY_LIMITS.nodes };
  let start = path[path.length - 1]!;
  for (let depth = path.length - 1; depth >= 1; depth--) {
    const kids = tree.children(path[depth - 1]!);
    let i = kids.indexOf(start);
    while (i > 0 && empty(kids[i - 1]!, tree, budget)) i--;
    start = kids[i]!;
    const parent = path[depth - 1]!;
    if (i > 0 || depth === 1 || holdsEnd.has(parent)) break;
    start = parent;
  }
  return { at: d.at, start, end };
}

/**
 * Split the tree at a range: `history` is the start node and its following siblings, then each
 * ancestor's following siblings, up to the end node's ancestors; `after` is the end node and
 * everything following it. A text node is never split, and an ancestor of the end never moves.
 */
export function quotedHistoryCut<N>(root: N, tree: QuotedTree<N>, r: QuotedNodeRange<N>): { history: N[]; after: N[] } {
  const history: N[] = [];
  const after: N[] = [];
  const sp = pathTo(root, tree, r.start);
  if (sp === null || sp.length < 2) return { history, after };
  const ep = r.end === null ? null : pathTo(root, tree, r.end);
  const holdsEnd = new Set(ep ?? []);
  let done = false;
  for (let d = sp.length - 1; d >= 1 && !done; d--) {
    const kids = tree.children(sp[d - 1]!);
    for (let i = kids.indexOf(sp[d]!) + (d === sp.length - 1 ? 0 : 1); i < kids.length; i++) {
      let k = kids[i]!;
      if (!holdsEnd.has(k)) { history.push(k); continue; }
      // The end is inside k: take k's children up to the branch that holds it, and descend.
      while (k !== r.end) {
        const kids2 = tree.children(k);
        let into = -1;
        for (let j = 0; j < kids2.length; j++) {
          if (holdsEnd.has(kids2[j]!)) { into = j; break; }
          history.push(kids2[j]!);
        }
        if (into < 0) break;
        k = kids2[into]!;
      }
      done = true;
      break;
    }
  }
  if (ep !== null) {
    for (let d = ep.length - 1; d >= 1; d--) {
      const kids = tree.children(ep[d - 1]!);
      for (let i = kids.indexOf(ep[d]!) + (d === ep.length - 1 ? 0 : 1); i < kids.length; i++) after.push(kids[i]!);
    }
  }
  return { history, after };
}

/** The DOM's shape, structurally: no DOM global is read. */
export interface QuotedDomNode {
  nodeType: number;
  nodeValue: string | null;
  localName?: string | null;
  childNodes: ArrayLike<QuotedDomNode>;
  getAttribute?(name: string): string | null;
}

/** A DOM node as a {@link QuotedTree} — the web and desktop readers' adapter. */
export const quotedDomTree: QuotedTree<QuotedDomNode> = {
  kind: (n) => (n.nodeType === 1 ? "element" : n.nodeType === 3 ? "text" : null),
  tag: (n) => n.localName ?? "",
  attr: (n, name) => (n.getAttribute ? n.getAttribute(name) : null),
  children: (n) => Array.from(n.childNodes),
  text: (n) => n.nodeValue ?? "",
};
