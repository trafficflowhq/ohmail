/**
 * THE PROBE MATRIX of the quoted-history differential (`quoted-history-monotone.test.ts`) and of the
 * phone's parity test. Every case is labelled by what its family builds: `owner`, an earlier message
 * holding its own quotes and nothing else, which folds at its header; `cost`, the writer's same-ink,
 * unmarked words under a quote in a new-Outlook history or under a coloured quote, which fold with it
 * (the class's named cost); `open`, a new-Outlook history read to its end, as its Windows twin is read;
 * `same`, everything else, which reads as 0.30.16 reads it. Synthetic names, example.* addresses only.
 */
import { qhFixtures, qhTypedAnswers, type QhFixture } from "./quoted-history-fixtures.js";

export type QhProbeLabel = "owner" | "cost" | "open" | "same";

export interface QhProbe {
  family: string;
  name: string;
  label: QhProbeLabel;
  html: string | null;
  /** The text part, where the case carries one. */
  text?: string;
  subject?: string;
  /** The writer's answer the case types into the history. */
  answer?: string;
}

type Wrap = (x: string) => string;
type More = Pick<QhProbe, "text" | "subject" | "answer">;
type Add = (family: string, label: QhProbeLabel, name: string, html: string | null, more?: More) => void;

// ── markup ───────────────────────────────────────────────────────────────────────────────

const P = (t: string): string => `<p class="MsoNormal">${t}<o:p></o:p></p>`;
const BL = '<p class="MsoNormal"><o:p>&nbsp;</o:p></p>';
const inked = (c: string): Wrap => (t) => `<span style="color:${c}">${t}</span>`;
const red = inked("#C00000");
const blue = inked("#0070C0");
const obl = inked("#1F497D");
const purple = inked("#500050");
const black: Wrap = (t) => t;
const hl: Wrap = (t) => `<span style="background:yellow;mso-highlight:yellow">${t}</span>`;
const nm: Wrap = (t) => `<b><i>[Clara Muster] </i></b>${t}`;
const cm: Wrap = (t) => `<b><i>[CM] </i></b>${t}`;
const li: Wrap = (t) => `<ul style="margin-top:0cm" type="disc"><li class="MsoNormal">${t}<o:p></o:p></li></ul>`;

const box: Wrap = (x) => `<blockquote style="margin:0cm 0cm 0cm 4.8pt;border-left:solid #CCCCCC 1.0pt;padding:0cm 0cm 0cm 6.0pt">${x}</blockquote>`;
const wordBox: Wrap = (x) => `<div style="border:none;border-left:solid #CCCCCC 1.0pt;padding:0cm 0cm 0cm 6.0pt">${x}</div>`;
const wbox: Wrap = (x) => `<div style="border:none;border-left:solid #CCCCCC 1.0pt;padding:0cm 0cm 0cm 6.0pt;margin-left:4.8pt;margin-right:0cm">${x}</div>`;
const wordBq: Wrap = (x) => `<blockquote style="border:none;border-left:solid #CCCCCC 1.0pt;padding:0cm 0cm 0cm 6.0pt;margin-left:4.8pt;margin-right:0cm">${x}</blockquote>`;
const gmxBox: Wrap = (x) => `<div style="margin: 10px 5px 5px 10px; padding: 10px 0 10px 10px; border-left:2px solid #C3D9E5; word-wrap: break-word;">${x}</div>`;
const cite: Wrap = (x) => `<blockquote type="cite">${x}</blockquote>`;
const gmail: Wrap = (x) => `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${x}</blockquote>`;
const plain: Wrap = (x) => `<blockquote>${x}</blockquote>`;
const indentBq: Wrap = (x) => `<blockquote style="margin-top:0px;margin-bottom:0px">${x}</blockquote>`;
const marginBq: Wrap = (x) => `<blockquote style="margin-left:30.0pt;margin-right:0cm">${x}</blockquote>`;
const rooster: Wrap = (x) => `<blockquote style="border-left: 3px solid rgb(200, 200, 200); padding-left: 1ex; margin-left: 0.8ex; color: rgb(102, 102, 102);">${x}</blockquote>`;

// ── the words ────────────────────────────────────────────────────────────────────────────

const IDS = ["132", "133", "135"];
/** New Outlook (132) where its Windows twins read the whole history and keep it open. */
const opens = (id: string, when = true): QhProbeLabel => (id === "132" && when ? "open" : "same");
const Q_WHEN = "Wann kommt der Techniker morgen genau?";
const Q_KEY = "Wer hat den Schlüssel für den Technikraum?";
const QF = "Ist die Filterreinigung im Angebot enthalten?";
const QMOVE = "Können wir die Begehung auf Donnerstag verschieben?";
const AT_TEN = "Um 10 Uhr, er meldet sich am Empfang.";
const AT_DESK = "Der Hauswart hat ihn, bitte am Empfang fragen.";
const PLAN_T = "Bitte gib mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.";
const PLAN = P(PLAN_T) + P("Gruss") + P("Ben");
const BY_T = "Am 27.10.2026 um 17:40 schrieb Dana Example &lt;dana.example@example.net&gt;:";
const BY = P(BY_T);
const ASK = P("Dana fragt noch:");
const SIGNED = P("Hallo Clara,") + P("Dana hat Fragen, siehe unten.") + P("Gruss") + P("Ben") + BY;
const PLAIN_BEN = P("Hallo Clara,") + P("Dana hat Fragen, siehe unten.") + P("Gruss") + P("Ben");
const SIG = P(`<b>${obl("Ben Sample")}</b>`) + P(obl("Projektleiter Haustechnik | Beispiel AG"));
const REPLY = P("Hallo Clara,") + P("Ja, Donnerstag um 10 Uhr passt uns.") + P("Gruss") + P("Ben");
const DANA = P("Hallo Ben,") + P("Können wir die Begehung des Technikraums auf Donnerstag verschieben? Am Dienstag bin ich leider nicht im Haus.") + P("Viele Grüsse") + P("Dana");
const DANA_QA = P("Hallo Ben,") + P("1. Wann kommt der Techniker genau?") + P(red("Am Dienstag um 10 Uhr.")) + P(`2. ${Q_KEY}`) + P(red("Der Hauswart hat ihn."))
  + P("Bitte gebt mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.") + P("Gruss") + P("Dana");
const OLDER_BY = P("Am 26.10.2026 um 09:00 schrieb Ben Sample:");
const BEN_OLD = P("Hallo Dana,") + P("wann passt dir die Begehung des Technikraums am besten?") + P("Gruss") + P("Ben");
const LONG = ["Am Dienstag um 10 Uhr, er meldet sich vorher telefonisch bei Frau Muster am Empfang.",
  "Der Hauswart hat ihn, bitte vorher beim Empfang im Erdgeschoss nachfragen und unterschreiben.",
  "Ja, die Filterreinigung ist Position 3 im Angebot und wird beim gleichen Termin erledigt."];
const ASKED = ["1. Wann kommt der Techniker morgen genau? Wir müssen den Raum vorher aufschliessen und lüften.",
  "2. Wer hat den Schlüssel für den Technikraum? Letztes Mal hat das eine Stunde gedauert.", "3. Ist die Filterreinigung im Angebot enthalten? Im letzten Jahr wurde sie extra verrechnet."];
/** Dana's questions quoted in parts, an answer typed below each, her closing quoted last. */
const parts = (q: Wrap, n: number, ink: Wrap = black, ans: Wrap = red): string =>
  ASKED.slice(0, n).map((x, k) => q(P(ink(x))) + P(ans(LONG[k]!))).join("") + q(P(ink("Danke und Gruss")) + P(ink("Dana")));
const QUOTE_BOXES: Array<[string, Wrap]> = [["blockquote", box], ["cite", cite], ["Word box", wordBox], ["gmail", gmail]];

// ── the corpus around a case ─────────────────────────────────────────────────────────────

let corpus: QhFixture[] | null = null;
const fixture = (id: string): QhFixture => (corpus ??= qhFixtures()).find((f) => f.id === id)!;
/** Ben's earlier message under the fixture's header, replaced whole. */
const EARLIER = /<p class="MsoNormal">Hallo Clara,[^]*Ben<o:p><\/o:p><\/p>/;
const earlier = (id: string, body: string): string => {
  const h = fixture(id).html!;
  const out = h.replace(EARLIER, body);
  if (out === h) throw new Error(`no earlier message in ${id}`);
  return out;
};
const winHop = (body: string): string => '<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>Von:</b> '
  + "Dana Example &lt;dana.example@example.net&gt;<br><b>Gesendet:</b> Dienstag, 27. Oktober 2026 17:40<br><b>An:</b> Ben Sample &lt;ben.sample@example.org&gt;<br>"
  + `<b>Betreff:</b> Begehung Technikraum</p></div></div>${body}`;
/** An older message of Dana's under its own Outlook header, below Ben's. */
const below = (id: string, body: string): string => fixture(id).html!.replace(/(<p class="MsoNormal">Ben<o:p><\/o:p><\/p>)/, `$1${winHop(body)}`);
/** 134's second hop (Dana's, under its own header), replaced whole. */
const danaHop = (body: string): string => {
  const h = fixture("134").html!;
  const i = h.lastIndexOf('<p class="MsoNormal">Hallo Ben,<o:p></o:p></p>');
  const j = h.indexOf("Dana<o:p></o:p></p>", i) + "Dana<o:p></o:p></p>".length;
  return h.slice(0, i) + body + h.slice(j);
};

// ── the quote-and-answer shape under four headers, six quote boxes, one to three hops ──────

const DATE_MAC = "Datum: </b>Mittwoch, 28. Oktober 2026 um 14:12";
const DATE_WIN = "Gesendet: </b>Mittwoch, 28. Oktober 2026 14:12";
const hdr = (date: string, subject: string): string => `<b>Von: </b>Ben Sample &lt;ben.sample@example.org&gt;<br><b>${date}<br><b>An: </b>Clara Muster &lt;clara.muster@example.org&gt;, `
  + `Dana Example &lt;dana@example.net&gt;<br><b>Cc: </b>Finn Beispiel &lt;finn@example.com&gt;<br><b>Betreff: </b>${subject}`;
const HEADERS: Record<string, Wrap> = {
  macNew: (h) => '<div id="mail-editor-reference-message-container"><div class="ms-outlook-mobile-reference-message skipProofing"><p class="MsoNormal" style="margin-bottom:12.0pt">'
    + `${hdr(DATE_MAC, "Re: Begehung Technikraum")}<o:p></o:p></p></div>${h}</div>`,
  macClassic: (h) => '<div style="border:none;border-top:solid #B5C4DF 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal" style="margin-bottom:12.0pt">'
    + `${hdr(DATE_MAC, "Re: Begehung Technikraum")}<o:p></o:p></p></div>${h}`,
  winDe: (h) => `<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal">${hdr(DATE_WIN, "AW: Begehung Technikraum")}<o:p></o:p></p></div></div>${BL}${h}`,
  owa: (h) => '<hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000">'
    + `${hdr(DATE_WIN, "AW: Begehung Technikraum")}</font><div>&nbsp;</div></div><div>${h}</div>`,
};
const QUOTES: Record<string, Wrap> = { gmail, apple: cite, plainbq: plain, wordbq: wordBq, worddiv: wordBox, gmxdiv: gmxBox };
const LEAD = P("Hallo Ben,") + BL + P("danke, so machen wir es. Ich reserviere den Raum für Donnerstag.") + BL + P("Gruss") + P("Clara") + BL;
const BULLET = "<ul><li>Können wir die Begehung des Technikraums auf Donnerstag verschieben?</li></ul>";
const ownMessage = (q: Wrap): string => P("Hallo Clara,") + BL + q(BULLET)
  + P('Ja, Donnerstag um 10 Uhr passt uns. Den Plan des Technikraums findest du hier: <a href="https://example.com/plan">Plan Technikraum</a>') + BL + P("Gruss") + P("Ben");
const OLDER = '<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">'
  + P("<b>Von:</b> Clara Muster &lt;clara.muster@example.org&gt;<br><b>Gesendet:</b> Dienstag, 27. Oktober 2026 09:30<br><b>An:</b> Ben Sample &lt;ben.sample@example.org&gt;<br><b>Betreff:</b> Begehung Technikraum")
  + "</div></div>" + P("Hallo Ben,") + P("Können wir die Begehung des Technikraums auf Donnerstag verschieben?") + P("Gruss") + P("Clara");
const word = (body: string): string => `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body lang="DE-CH"><div class="WordSection1">${body}</div></body></html>`;
const ownerShape = (header: string, quote: string, older = false, twoDeep = false): string => {
  const h = HEADERS[header]!;
  const q = QUOTES[quote]!;
  let hist = ownMessage(q) + (older ? OLDER : "");
  if (twoDeep) hist += h(ownMessage(q).replace(/Ben/g, "Dana") + OLDER).replace("Ben Sample &lt;ben.sample@example.org&gt;", "Dana Example &lt;dana@example.net&gt;");
  return word(LEAD + h(hist));
};
const ownerText = (mac: boolean, older: boolean): string => [
  "Hallo Ben,", "", "danke, so machen wir es. Ich reserviere den Raum für Donnerstag.", "", "Gruss", "Clara", "", "Von: Ben Sample <ben.sample@example.org>",
  mac ? "Datum: Mittwoch, 28. Oktober 2026 um 14:12" : "Gesendet: Mittwoch, 28. Oktober 2026 14:12",
  "An: Clara Muster <clara.muster@example.org>, Dana Example <dana@example.net>", "Cc: Finn Beispiel <finn@example.com>",
  mac ? "Betreff: Re: Begehung Technikraum" : "Betreff: AW: Begehung Technikraum", "", "Hallo Clara,", "", "> • Können wir die Begehung des Technikraums auf Donnerstag verschieben?", "",
  "Ja, Donnerstag um 10 Uhr passt uns. Den Plan des Technikraums findest du hier: Plan Technikraum<https://example.com/plan>", "", "Gruss", "Ben",
  ...(older ? ["", "Von: Clara Muster <clara.muster@example.org>", "Gesendet: Dienstag, 27. Oktober 2026 09:30", "An: Ben Sample <ben.sample@example.org>",
    "Betreff: Begehung Technikraum", "", "Hallo Ben,", "Können wir die Begehung des Technikraums auf Donnerstag verschieben?", "Gruss", "Clara"] : []),
].join("\n");

function ownerMatrices(add: Add): void {
  const headers = Object.keys(HEADERS);
  for (const header of headers) for (const quote of Object.keys(QUOTES)) for (const [older, two] of [[false, false], [true, false], [true, true]] as const) {
    add("shape", "owner", `${header} ${quote} older=${older ? 1 : 0} two=${two ? 1 : 0}`, ownerShape(header, quote, older, two), { text: ownerText(header.startsWith("mac"), older) });
  }
  // The quoted bullet in another ink, a link or a sentence closing the answer.
  for (const header of headers) for (const quote of ["gmail", "apple", "wordbq", "worddiv", "gmxdiv"]) for (const ink of ["#1F497D", "#500050", "#0070C0", "#888888"]) {
    for (const tail of ["link", "sentence"]) {
      let html = ownerShape(header, quote, true).replace(BULLET, `<ul><li>${inked(ink)("Können wir die Begehung des Technikraums auf Donnerstag verschieben?")}</li></ul>`);
      if (tail === "sentence") html = html.replace("Plan Technikraum</a>", "Plan Technikraum</a>. Bitte bringt die Schlüssel mit.");
      add("shape-inked", "owner", `${header} ${quote} ${ink} ${tail}`, html, { text: ownerText(header.startsWith("mac"), true) });
    }
  }
  for (const header of headers) for (const quote of ["gmail", "apple", "wordbq", "worddiv"]) {
    const html = ownerShape(header, quote, true, true).split(BULLET).join(`<ul><li>${purple("Können wir die Begehung des Technikraums auf Donnerstag verschieben?")}</li></ul>`)
      .replace(/Plan Technikraum<\/a>/g, "Plan Technikraum</a>. Bitte bringt die Schlüssel mit.");
    add("shape-two-deep", "owner", `${header} ${quote}`, html, { text: ownerText(header.startsWith("mac"), true) });
  }
  // A coloured signature or greeting in the earlier message keeps 0.30.16's reading; two bullets are the shape.
  const variants: Array<[string, QhProbeLabel, Wrap]> = [
    ["sig", "same", (h) => h.replace(P("Ben"), SIG)],
    ["sig+older", "same", (h) => h.replace(P("Ben"), SIG)],
    ["greet-in-box", "same", (h) => h.replace(BULLET, `<p class="MsoNormal">${obl("Hallo Ben,")}</p>${BULLET}`)],
    ["two-bullets", "owner", (h) => h.replace(BULLET, "<ul><li>Können wir die Begehung des Technikraums auf Donnerstag verschieben?</li><li>Bringt ihr die Pläne der Lüftung mit?</li></ul>")],
  ];
  for (const header of headers) for (const quote of ["gmail", "apple", "wordbq", "worddiv", "gmxdiv", "plainbq"]) for (const [v, label, edit] of variants) {
    add("shape-variant", label, `${header} ${quote} ${v}`, edit(ownerShape(header, quote, v.includes("older"))));
  }
}

// ── answers typed into the history keep 0.30.16's reading; the controls without them fold ──

function typedAnswers(add: Add): void {
  for (const id of IDS) for (const [k, q] of QUOTE_BOXES) {
    const a = { answer: LONG[0] };
    add("parts", "same", `${id} ${k} greeting+siehe unten, 3 parts`, earlier(id, P("Hallo Clara,") + P("siehe unten.") + parts(q, 3)), a);
    const wb = k === "Word box";
    add("parts", opens(id, wb), `${id} ${k} signed, 3 parts`, earlier(id, SIGNED + parts(q, 3)), a);
    add("parts", opens(id, wb), `${id} ${k} signed, 2 parts`, earlier(id, SIGNED + parts(q, 2)), a);
    add("parts-variant", opens(id, wb), `${id} ${k} signed, 3 parts, quote in #500050`, earlier(id, SIGNED + parts(q, 3, purple)), a);
    add("parts-variant", "same", `${id} ${k} greeting, 3 parts, quote in #500050`, earlier(id, P("Hallo Clara,") + P("siehe unten.") + parts(q, 3, purple)), a);
    const blueBen = P(obl("Hallo Clara,")) + P(obl("Dana hat Fragen, siehe unten.")) + P(obl("Gruss")) + P(obl("Ben")) + BY;
    add("parts-variant", opens(id, wb), `${id} ${k} own words in Outlook blue, 3 parts`, earlier(id, blueBen + parts(q, 3)), a);
    add("parts-variant", opens(id, wb), `${id} ${k} own words in Outlook blue, 2 parts`, earlier(id, blueBen + parts(q, 2)), a);
    add("parts-variant", "same", `${id} ${k} parts only, no greeting`, earlier(id, parts(q, 3)), a);
    add("parts-variant", opens(id, wb), `${id} ${k} blue answers, 3 parts`, earlier(id, SIGNED + parts(q, 3, black, blue)), a);
    add("parts-variant", opens(id, wb), `${id} ${k} highlighted answers, 3 parts`, earlier(id, SIGNED + parts(q, 3, black, hl)), a);
  }
  const qq = P(QF);
  for (const id of IDS) for (const [k, q] of QUOTE_BOXES) for (const [n, a] of [["JA", red("JA")], ["NEIN", red("NEIN")], ["OK", red("OK")], ["14:00", red("14:00")], ["hl JA", hl("JA")]] as const) {
    add("lone-answer", "same", `${id} ${k} ${n}`, earlier(id, P("Hallo Clara,") + ASK + q(qq) + P(a) + PLAN), { answer: n.replace("hl ", "") });
  }
  for (const id of IDS) for (const [k, q] of QUOTE_BOXES) {
    add("lone-answer-variant", "same", `${id} ${k} JA last, sign-off above`, earlier(id, P("Hallo Clara,") + ASK + q(qq) + P(red("JA"))), { answer: "JA" });
    add("lone-answer-variant", "same", `${id} ${k} JA then sign-off only`, earlier(id, P("Hallo Clara,") + ASK + q(qq) + P(red("JA")) + P("Gruss") + P("Ben")), { answer: "JA" });
    add("lone-answer-variant", "same", `${id} ${k} 'JA:' with colon`, earlier(id, P("Hallo Clara,") + ASK + q(qq) + P(red("JA:")) + PLAN), { answer: "JA:" });
    add("lone-answer-variant", "same", `${id} ${k} question box with two lines`, earlier(id, P("Hallo Clara,") + ASK + q(P("Dana schreibt:") + qq) + P(red("JA")) + PLAN), { answer: "JA" });
    add("lone-answer-variant", "same", `${id} ${k} question then quoted closing line`, earlier(id, P("Hallo Clara,") + ASK + q(qq + P("Danke!")) + P(red("JA")) + PLAN), { answer: "JA" });
  }
  // Ben's reply over an attribution and Dana's quoted message: the plain one is the shape.
  const own = P("Hallo Clara,") + box(P("Können wir die Begehung des Technikraums auf Donnerstag verschieben?")) + P("Ja, Donnerstag um 10 Uhr passt uns.") + P("Gruss");
  for (const id of IDS) for (const [k, q] of [["Gmail", gmail], ["Apple", cite], ["blockquote", box], ["Word box", wordBox]] as const) {
    add("reply-quote", opens(id), `${id} ${k} signature`, earlier(id, REPLY + SIG + BY + q(DANA)));
    add("reply-quote", "owner", `${id} ${k} plain`, earlier(id, REPLY + BY + q(DANA)));
    add("reply-quote", "same", `${id} ${k} own quote + signature`, earlier(id, own + SIG + BY + q(DANA)));
    add("reply-quote-signature", opens(id), `${id} ${k} signature, quote with coloured signature and older quote`, earlier(id, REPLY + SIG + BY
      + q(DANA + P(obl("Dana Example")) + P(obl("Leiterin Facility Management")) + OLDER_BY + q(BEN_OLD))));
    add("reply-quote-signature", opens(id), `${id} ${k} signature in red`, earlier(id, REPLY + P(red("Ben Sample")) + P(red("Projektleiter Haustechnik | Beispiel AG")) + BY + q(DANA)));
    add("reply-quote-signature", opens(id), `${id} ${k} signature one line, sentence`, earlier(id, REPLY + P(obl("Beispiel AG, Musterstrasse 1, 8000 Zürich.")) + BY + q(DANA)));
  }
  const POSITION = "Ja, sie ist Position 3 im Angebot.";
  for (const id of IDS) for (const [k, q] of QUOTE_BOXES) for (const [n, a] of [["red sentence", red(POSITION)], ["red JA", red("JA")], ["blue sentence", blue(POSITION)], ["highlight", hl(POSITION)]] as const) {
    const typed = n === "red JA" ? "JA" : POSITION;
    add("level-answer", opens(id), `${id} ${k} ${n}: own question, sign-off, attribution + quote`, earlier(id, P("Hallo Clara,") + qq + P(a) + P("Gruss") + P("Ben") + BY + q(DANA)), { answer: typed });
    add("level-answer", "same", `${id} ${k} ${n}: two own questions, sign-off, attribution + quote`, earlier(id, P("Hallo Clara,") + P(`1. ${QF}`) + P(a)
      + P("2. Brauchen Ihre Techniker einen Schlüssel für den Technikraum?") + P(red("Ja, bitte am Empfang hinterlegen.")) + P("Gruss") + P("Ben") + BY + q(DANA)), { answer: "Ja, bitte am Empfang hinterlegen." });
    add("level-answer", opens(id), `${id} ${k} ${n}: own question, attribution + quote, no sign-off`, earlier(id, P("Hallo Clara,") + qq + P(a) + BY + q(DANA)), { answer: typed });
  }
  for (const id of IDS) for (const [k, q] of QUOTE_BOXES) {
    add("reply-quote-control", "owner", `${id} ${k} reply + attribution + quote`, earlier(id, REPLY + BY + q(DANA)));
    add("reply-quote-control", "owner", `${id} ${k} own question + sign-off + attribution + quote`, earlier(id, P("Hallo Clara,") + qq + P("Gruss") + P("Ben") + BY + q(DANA)));
  }
  const KOMMT = "Am Dienstag um 10 Uhr kommt er.";
  for (const id of IDS) for (const [k, q] of QUOTE_BOXES) {
    const a = { answer: KOMMT };
    add("parts-inked", "same", `${id} ${k} short answers, purple parts`, earlier(id, SIGNED + q(P(purple(`1. ${Q_WHEN}`))) + P(red(KOMMT)) + q(P(purple(`2. ${Q_KEY}`)) + P(purple("Gruss Dana")))
      + P(red(AT_DESK))), a);
    add("parts-inked", opens(id, k === "Word box"), `${id} ${k} short answers, black parts (control)`, earlier(id, SIGNED + q(P(`1. ${Q_WHEN}`)) + P(red(KOMMT)) + q(P(`2. ${Q_KEY}`) + P("Gruss Dana")) + P(red(AT_DESK))), a);
    add("parts-inked", "same", `${id} ${k} one answer between two purple parts, message words long`, earlier(id, P("Hallo Clara,")
      + P("Dana hat Fragen zur Begehung, siehe unten. Ich bin bis Montag im Urlaub und kann ihr leider nicht selbst antworten.") + P("Gruss") + P("Ben") + BY
      + q(P(purple(`1. ${Q_WHEN}`))) + P(red(KOMMT)) + q(P(purple(`2. ${Q_KEY}`)) + P(purple("Danke und Gruss")) + P(purple("Dana")))), a);
    add("parts-inked", "same", `${id} ${k} one answer between two blue (#0070C0) parts`, earlier(id, SIGNED + q(P(blue(`1. ${Q_WHEN}`))) + P(red(KOMMT))
      + q(P(blue(`2. ${Q_KEY}`)) + P(blue("Danke und Gruss")) + P(blue("Dana")))), a);
    add("parts-inked", opens(id, k === "Word box"), `${id} ${k} one answer between two black parts (control)`, earlier(id, SIGNED + q(P(`1. ${Q_WHEN}`)) + P(red(KOMMT)) + q(P(`2. ${Q_KEY}`) + P("Danke und Gruss") + P("Dana"))), a);
  }
  // Dana's quoted message with her signature and her own older quote: a black signature is the shape.
  for (const id of IDS) for (const [k, q] of [["Gmail", gmail], ["Apple", cite], ["blockquote", box]] as const) {
    add("quoted-signature", opens(id), `${id} ${k} plain reply; quoted message has coloured signature + older quote`, earlier(id, REPLY + BY
      + q(DANA + P(obl("Dana Example")) + P(obl("Leiterin Facility Management")) + OLDER_BY + q(BEN_OLD))));
    add("quoted-signature", "owner", `${id} ${k} plain reply; quoted message has black signature + older quote (control)`, earlier(id, REPLY + BY
      + q(DANA + P("Dana Example") + P("Leiterin Facility Management") + OLDER_BY + q(BEN_OLD))));
    add("quoted-signature", "same", `${id} ${k} quoted msg: coloured sig, nothing after`, earlier(id, REPLY + BY + q(DANA + P(obl("Dana Example")) + P(obl("Leiterin Facility Management")))));
  }
  // Both parts: the text part follows its html.
  const shape = (id: string, ps: Array<[string, string]>): { html: string; text: string } => ({
    html: fixture(id).html!.replace(EARLIER, ps.map(([h]) => h).join("")),
    text: fixture(id).text.replace(/\nHallo Clara,[^]*$/, `\n${ps.map(([, t]) => t).join("\n")}`),
  });
  const p = (...ts: string[]): [string, string] => [ts.map(P).join(""), ts.join("\n")];
  const byText = "Am 27.10.2026 um 17:40 schrieb Dana Example <dana.example@example.net>:";
  const attribution: [string, string] = [P(byText.replace(/</g, "&lt;").replace(/>/g, "&gt;")), byText];
  const danaLines = ["Hallo Ben,", "Können wir die Begehung des Technikraums auf Donnerstag verschieben? Am Dienstag bin ich leider nicht im Haus.", "Viele Grüsse", "Dana"];
  const quoted = (q: Wrap): [string, string] => [q(danaLines.map(P).join("")), danaLines.map((l) => `> ${l}`).join("\n")];
  for (const id of IDS) for (const [qk, q] of [["Apple cite", cite], ["Gmail quote", gmail]] as const) for (const [ak, a, typed] of [["red", red(POSITION), POSITION], ["highlight", hl("JA"), "JA"]] as const) {
    const s1 = shape(id, [p("Hallo Clara,", "kannst du mir bis Freitag sagen, ob die Filterreinigung im Angebot enthalten ist?"), [P(a), typed], p("Gruss", "Ben"), attribution, quoted(q)]);
    add("both-parts", opens(id), `${id} ${qk} ${ak}: one own question, answer, sign-off, attribution + quote`, s1.html, { answer: typed, text: s1.text });
    const s2 = shape(id, [p("Hallo Clara,", "Dana fragt, ob die Filterreinigung im Angebot enthalten ist. Weisst du das?"), [P(a), typed], p("Danke dir", "Gruss", "Ben"), attribution, quoted(q)]);
    add("both-parts", opens(id), `${id} ${qk} ${ak}: question, answer, 'Danke dir', sign-off, attribution + quote`, s2.html, { answer: typed, text: s2.text });
  }
  for (const id of IDS) for (const [k, q] of QUOTE_BOXES) for (const [cn, ink] of [["#500050", purple], ["#0070C0", blue], ["#1F497D", obl], ["black", black]] as const) {
    for (const n of [2, 3]) {
      add("parts-long", opens(id, k === "Word box"), `${id} ${k} quote ${cn}, signed, ${n} long parts`, earlier(id, SIGNED + parts(q, n, ink)), { answer: LONG[0] });
      add("parts-long", "same", `${id} ${k} quote ${cn}, greeting, ${n} long parts`, earlier(id, P("Hallo Clara,") + P("siehe unten.") + parts(q, n, ink)), { answer: LONG[0] });
    }
  }
  const yahooQuote = (inner: string): string => '<div class="ydp1 yahoo-style-wrap"><div>Hallo Ben, danke, passt so.</div><div>Gruss Clara</div></div>'
    + '<div id="ydp2yahoo_quoted_1" class="ydp2yahoo_quoted"><div><div>On Wednesday, 28 October 2026 at 14:12:00 CET, Ben Sample &lt;ben.sample@example.org&gt; wrote:</div>'
    + `<div><br></div><div dir="ltr">${P("Hallo Clara,") + P("anbei der Stand von Dana, bitte kurz prüfen.") + P("Gruss") + P("Ben") + winHop(inner)}</div></div></div>`;
  const danaPlan = PLAN.replace("Ben", "Dana");
  add("yahoo-older-hop", "same", "older hop with red inline answers (by Ben, earlier)", yahooQuote(P("Hallo Ben,") + P(`1. ${Q_WHEN}`) + P(red(AT_TEN)) + P(`2. ${Q_KEY}`)
    + P(red("Der Hauswart hat ihn.")) + danaPlan));
  add("yahoo-older-hop", "same", "older hop, no answers (control)", yahooQuote(P("Hallo Ben,") + P(`1. ${Q_WHEN}`) + P(`2. ${Q_KEY}`) + danaPlan));
  for (const id of IDS) for (const [k, q] of [["blockquote", box], ["cite", cite]] as const) {
    add("remark-box", "same", `${id} ${k} own question, then a quoted remark box, then red JA`, earlier(id, P("Hallo Clara,") + P("Kommt der Techniker morgen?")
      + q(P("Dana schreibt: Er braucht den Schlüssel vom Hauswart.")) + P(red("JA")) + PLAN), { answer: "JA" });
  }
}

// ── answers inside boxes, between parts, in older hops; the class's own controls ───────────

function answersEverywhere(add: Add): void {
  const ANSWER = "Ja, Dienstag um 10 Uhr passt mir.";
  const single = (bx: Wrap, ink: Wrap): string => P("Hallo Clara,") + P("Dana fragt wegen der Begehung:")
    + bx(P("Kannst du am Dienstag um 10 Uhr zur Begehung des Technikraums kommen?") + P(ink(ANSWER))) + PLAN;
  const bullets = (bx: Wrap): string => P("Hallo Clara,") + P("Dana braucht noch zwei Angaben von dir:")
    + bx(li("Termin für die Begehung") + P(red("Dienstag um 10 Uhr passt mir.")) + li("Schlüssel für den Technikraum") + P(red(AT_DESK))) + PLAN;
  add("box-answer", "same", "133 single red bq", earlier("133", single(box, red)), { answer: ANSWER });
  add("box-answer", "same", "133 single blue bq", earlier("133", single(box, blue)), { answer: ANSWER });
  add("box-answer", "same", "133 single hl bq", earlier("133", single(box, hl)), { answer: ANSWER });
  add("box-answer", "same", "133 single red wbox", earlier("133", single(wbox, red)), { answer: ANSWER });
  add("box-answer", "same", "133 bullets red bq", earlier("133", bullets(box)), { answer: "Dienstag um 10 Uhr passt mir." });
  add("box-answer", "same", "132 single red bq", earlier("132", single(box, red)), { answer: ANSWER });
  add("box-answer", "same", "132 bullets red bq", earlier("132", bullets(box)), { answer: "Dienstag um 10 Uhr passt mir." });
  const mark = (t: string): string => `<b><i>${blue("[Clara Muster] ")}</i></b>${blue(t)}`;
  for (const id of IDS) {
    add("box-answer", "same", `${id} [Name] blue comment in box`, earlier(id, P("Hallo Clara,") + P("Dana fragt wegen der Begehung:")
      + box(P("Kannst du am Dienstag um 10 Uhr zur Begehung des Technikraums kommen?") + P(mark(ANSWER))) + PLAN), { answer: ANSWER });
    add("box-answer", "same", `${id} [Name] same ink at level + in box`, earlier(id, P("Hallo Clara,") + P(QF) + P(nm("Ja, sie ist Position 3 im Angebot."))
      + ASK + box(P(Q_KEY) + P(nm(AT_DESK))) + PLAN), { answer: AT_DESK });
  }
  const TUESDAY = "Am Dienstag um 10 Uhr.";
  add("older-hop", "same", "132 red answers in the second hop (Mac container)", below("132", DANA_QA), { answer: TUESDAY });
  add("older-hop", "same", "133 red answers in the second hop (Windows control)", below("133", DANA_QA), { answer: TUESDAY });
  add("older-hop", "open", "132 red in Dana's hop, Ben's hop plain", earlier("132", PLAIN_BEN + winHop(DANA_QA)), { answer: TUESDAY });
  add("older-hop", "same", "133 red in Dana's hop, Ben's hop plain", earlier("133", PLAIN_BEN + winHop(DANA_QA)), { answer: TUESDAY });
  add("hop-answer", "open", "132 red below an attribution, no box", earlier("132", PLAIN_BEN + BY + DANA_QA), { answer: TUESDAY });
  add("hop-answer", "same", "133 red below an attribution, no box", earlier("133", PLAIN_BEN + BY + DANA_QA), { answer: TUESDAY });
  const KOMMT = "Am Dienstag um 10 Uhr kommt er.";
  const between = (q: Wrap): string => PLAIN_BEN + BY + q(P("1. Wann kommt der Techniker genau?")) + P(red(KOMMT)) + q(P(`2. ${Q_KEY}`) + P("Gruss Dana")) + P(red(AT_DESK));
  for (const id of IDS) for (const [k, q] of [["bq", box], ["cite", cite], ["gmail", gmail], ["wbox", wbox]] as const) {
    add("box-answer", opens(id, k === "wbox"), `${id} red between quote parts (${k})`, earlier(id, between(q)), { answer: KOMMT });
  }
  const shortBetween = PLAIN_BEN + BY + box(P(`1. ${QF}`)) + P(red("JA")) + box(P("2. Um wie viel Uhr sollen die Techniker kommen?")) + P(red("14:00"))
    + box(P("Danke für die Rückmeldung, ich plane den Termin danach ein.") + P("Gruss Dana"));
  add("box-answer", "same", "133 short answers between quote parts", earlier("133", shortBetween), { answer: "14:00" });
  add("box-answer", "same", "132 short answers between quote parts", earlier("132", shortBetween), { answer: "14:00" });
  // Between Ben's lead-in and his sign-off: his question to Clara below the box, an answer typed in or after it.
  const head = P("Hallo Clara,") + BL + ASK;
  const sign = BL + P("Gruss") + P("Ben");
  const asks = P("Kannst du ihr das bitte direkt beantworten?");
  const inBox: Array<[string, string, string]> = [
    ["red answer ending the box", box(P(Q_WHEN) + P(red(AT_TEN))) + asks, AT_TEN],
    ["long red answer ending the box", box(P(Q_WHEN) + P(red("Um 10 Uhr morgen früh, er meldet sich vorher am Empfang bei Frau Muster."))) + asks, "Um 10 Uhr morgen früh"],
    ["blue answer ending the box", box(P(Q_WHEN) + P(blue(AT_TEN))) + asks, AT_TEN],
    ["highlighted answer ending the box", box(P(Q_WHEN) + P(hl(AT_TEN))) + asks, AT_TEN],
    ["[CM] answer ending the box", box(P(Q_WHEN) + P(cm(AT_TEN))) + asks, AT_TEN],
    ["red answer ending a Word box", wbox(P(Q_WHEN) + P(red(AT_TEN))) + asks, AT_TEN],
    ["red answer ending a purple quote box", box(P(purple(Q_WHEN)) + P(red(AT_TEN))) + asks, AT_TEN],
    ["red answer ending each of two adjacent boxes", box(P(Q_WHEN) + P(red(AT_TEN))) + box(P(Q_KEY) + P(red(AT_DESK))) + asks, AT_TEN],
    ["red answer ending two boxes split by text", box(P(Q_WHEN) + P(red(AT_TEN))) + P("Und ausserdem:") + box(P(Q_KEY) + P(red(AT_DESK))) + asks, AT_TEN],
    ["[Name] answer in each of two adjacent boxes", box(P(Q_WHEN) + P(nm(AT_TEN))) + box(P(Q_KEY) + P(nm(AT_DESK))) + asks, AT_TEN],
    ["[Name] answer in a box and at the level", box(P(Q_WHEN) + P(nm(AT_TEN))) + asks + P(nm("Ja, ich schreibe ihr gleich selbst.")), AT_TEN],
    ["two [Name] answers in one box", box(P(Q_WHEN) + P(nm(AT_TEN)) + P(Q_KEY) + P(nm(AT_DESK))) + asks, AT_TEN],
    ["[Name] answers in two boxes split by text", box(P(Q_WHEN) + P(nm(AT_TEN))) + P("Und ausserdem:") + box(P(Q_KEY) + P(nm(AT_DESK))) + asks, AT_TEN],
    ["red answer after the box, prose after", box(P(Q_WHEN)) + P(red(AT_TEN)) + asks, AT_TEN],
    ["red answer inside the box, quoted prose after it", box(P(Q_WHEN) + P(red(AT_TEN)) + P(Q_KEY)) + asks, AT_TEN],
  ];
  for (const host of IDS) {
    for (const [name, middle, typed] of inBox) add("box-end", "same", `${host} ${name}`, earlier(host, head + middle + sign), { answer: typed });
    add("box-end-control", "owner", `${host} no answers (as the fixture: it folds)`, earlier(host, head + box(P(Q_WHEN)) + asks + sign));
  }
  const danaHead = P("Hallo Ben,") + BL;
  const danaSign = BL + P("Viele Grüsse") + P("Dana");
  const PLAENE = P("Die Pläne der Lüftung bringe ich selbst mit, keine Sorge.");
  add("hop-answer", "same", "134 red answer in hop 2 after its box, prose after", danaHop(danaHead + box(P(Q_WHEN)) + P(red(AT_TEN)) + PLAENE + danaSign), { answer: AT_TEN });
  add("hop-answer", "same", "134 red answer in hop 2, no box in hop 2", danaHop(danaHead + P(Q_WHEN) + P(red(AT_TEN)) + PLAENE + danaSign), { answer: AT_TEN });
  add("hop-answer", "same", "134 two [Name] answers in hop 2 after its box", danaHop(danaHead + box(P(Q_WHEN)) + P(nm(AT_TEN)) + P(Q_KEY) + P(nm(AT_DESK)) + danaSign), { answer: AT_TEN });
  add("hop-answer", "same", "134 red answer below an attribution inside Ben's message", fixture("134").html!.replace(/(<p class="MsoNormal">Ben<o:p><\/o:p><\/p>)/,
    `$1${BY}${P("Hallo Ben,")}${P("1. Wann kommt der Techniker genau?")}${P(red(KOMMT))}${P(`2. ${Q_KEY}`)}${P(red(AT_DESK))}${P(PLAN_T)}${P("Gruss Dana")}`), { answer: KOMMT });
  add("box-end-control", "owner", "134 as it is (it folds)", fixture("134").html!);
  for (const host of IDS) {
    for (const [k, q] of [["bq", box], ["wbox", wbox], ["cite", cite]] as const) for (const ans of ["JA", "NEIN", "OK", "14:00"]) {
      add("short-under-box", "same", `${host} ${k} lone '${ans}' at level under a boxed question`, earlier(host, P("Hallo Clara,") + ASK + q(P(QF)) + P(red(ans)) + PLAN), { answer: ans });
    }
    add("short-under-box", "same", `${host} lone 'JA' at level, question at level (control)`, earlier(host, P("Hallo Clara,") + P(QF) + P(red("JA")) + PLAN), { answer: "JA" });
    add("short-under-box", "same", `${host} lone 'JA' as the box's last line (control)`, earlier(host, P("Hallo Clara,") + ASK + box(P(QF) + P(red("JA"))) + PLAN), { answer: "JA" });
    add("short-under-box", "same", `${host} lone highlighted 'JA' at level under a boxed question`, earlier(host, P("Hallo Clara,") + ASK + box(P(QF)) + P(hl("JA")) + PLAN), { answer: "JA" });
  }
  for (const host of IDS) for (const [k, q] of [["bq", box], ["cite", cite], ["wbox", wbox]] as const) {
    add("long-parts", "same", `${host} ${k} 'siehe unten.' + 3 long red answers between parts`, earlier(host, P("Hallo Clara,") + P("siehe unten.") + parts(q, 3)), { answer: LONG[0] });
    add("long-parts", opens(host, k === "wbox"), `${host} ${k} sign-off + attribution + 3 long red answers between parts`, earlier(host, PLAIN_BEN + BY + parts(q, 3)), { answer: LONG[0] });
    add("long-parts", opens(host, k === "wbox"), `${host} ${k} sign-off + attribution + 2 long red answers between parts`, earlier(host, PLAIN_BEN + BY + parts(q, 2)), { answer: LONG[0] });
  }
  for (const host of IDS) {
    const asksDana = P("Hallo Clara,") + P("Dana fragt:");
    const end = P("Gruss") + P("Ben");
    add("answered-boxes", "same", `${host} red answer ends the first box, 'Und:' then a second box with a red answer`, earlier(host, asksDana + box(P(Q_WHEN) + P(red(AT_TEN))) + P("Und:")
      + box(P(Q_KEY) + P(red(AT_DESK))) + end), { answer: AT_TEN });
    add("answered-boxes", "same", `${host} red answer ends the first box, 'Und:' then a plain second box`, earlier(host, asksDana + box(P(Q_WHEN) + P(red(AT_TEN))) + P("Und:") + box(P(Q_KEY)) + end),
      { answer: AT_TEN });
    add("answered-boxes", "same", `${host} red answer at level between boxes`, earlier(host, asksDana + box(P(Q_WHEN)) + P(red(AT_TEN)) + box(P(Q_KEY)) + end), { answer: AT_TEN });
  }
  // Ben's reply over an attribution and Dana's quote: a coloured signature keeps 0.30.16's reading.
  const benReply = P("Hallo Clara,") + BL + P('Ja, Donnerstag um 10 Uhr passt uns. Den Plan findest du hier: <a href="https://example.com/plan">Plan Technikraum</a>') + BL + P("Gruss") + P("Ben");
  const colSig = '<div class="gmail_signature"><p class="MsoNormal"><b><span style="color:#1F497D">Ben Sample</span></b></p><p class="MsoNormal">'
    + '<span style="color:#1F497D">Projektleiter Haustechnik | Beispiel AG</span></p></div>';
  for (const host of ["132", "133"]) {
    for (const [k, q] of [["gmail", gmail], ["cite", cite]] as const) {
      add("reply-signature", opens(host), `${host} ${k} Ben's coloured signature, then attribution + quote of Dana`, earlier(host, benReply + colSig + BY + q(DANA)));
      add("reply-signature", "owner", `${host} ${k} Ben's plain signature, then attribution + quote of Dana`, earlier(host, benReply + BY + q(DANA)));
      add("reply-signature", opens(host), `${host} ${k} Dana's quoted message: coloured signature then her own older quote`, earlier(host, benReply + BY
        + q(P("Hallo Ben,") + P("Können wir die Begehung verschieben? Am Dienstag bin ich leider nicht im Haus.") + P("Viele Grüsse")
          + `<p class="MsoNormal">${obl("Dana Example | Example GmbH")}</p>` + P("Am 26.10.2026 um 09:00 schrieb Ben Sample &lt;ben.sample@example.org&gt;:")
          + q(P("Hallo Dana,") + P("passt euch der Dienstag um 10 Uhr für die Begehung des Technikraums?") + P("Gruss Ben")))));
    }
    add("reply-signature", "same", `${host} older hop with Dana's old red inline answers`, below(host, DANA_QA));
  }
  const words = "bitte vorher beim Empfang im Erdgeschoss nachfragen und dort den Ausweis zeigen sowie unterschreiben".split(" ");
  for (const n of [0, 2, 4, 6, 8, 10, 12]) {
    const more = n === 0 ? "" : `, ${words.slice(0, n).join(" ")}`;
    const first = `Am Dienstag um 10 Uhr${more}.`;
    add("answer-length", "same", `133 answers ${n} words longer`, earlier("133", PLAIN_BEN + BY + box(P(`1. ${Q_WHEN}`)) + P(red(first)) + box(P(`2. ${Q_KEY}`) + P("Gruss Dana"))
      + P(red(`Der Hauswart hat ihn${more}.`))), { answer: first });
  }
  add("answer-length", "same", "133 Ben's longer own text over the answers (control)", earlier("133", P("Hallo Clara,")
    + P("Dana hat Fragen zur Begehung, siehe unten. Ich bin bis Montag im Urlaub und kann ihr leider nicht selbst antworten, darum bitte direkt an sie.")
    + P("Gruss") + P("Ben") + BY + parts(box, 2)), { answer: LONG[0] });
  add("short-at-level", "same", "133 lone 'Ja, Position 3.' at level under a boxed question", earlier("133", P("Hallo Clara,") + ASK + box(P(QF)) + P(red("Ja, Position 3.")) + PLAN),
    { answer: "Ja, Position 3." });
  add("short-at-level", "same", "133 two short 'JA'/'14:00' at level under boxed questions", earlier("133", P("Hallo Clara,") + ASK + box(P(QF)) + P(red("JA"))
    + box(P("Um wie viel Uhr sollen die Techniker kommen?")) + P(red("14:00")) + PLAN), { answer: "JA" });
  add("short-at-level", "same", "133 lone 'JA' under a boxed question, the line above it ends with '?'", earlier("133", P("Hallo Clara,") + P("Kannst du Dana das beantworten?")
    + box(P(QF)) + P(red("JA")) + PLAN), { answer: "JA" });
  const yahoo = (inner: string): string => '<html><head></head><body><div class="ydp1 yahoo-style-wrap" style="font-family:Helvetica Neue, Helvetica, Arial, sans-serif;font-size:13px;">'
    + '<div dir="ltr" data-setdir="false"><div>Hallo Ben, danke, ich habe Dana direkt geantwortet, siehe unten.</div><div>Gruss Clara</div></div></div>'
    + '<div id="ydp2yahoo_quoted_1" class="ydp2yahoo_quoted"><div style="font-family:\'Helvetica Neue\', Helvetica, Arial, sans-serif;font-size:13px;color:#26282a;">'
    + "<div>On Wednesday, 28 October 2026 at 14:12:00 CET, Ben Sample &lt;ben.sample@example.org&gt; wrote:</div><div><br></div><div><div dir=\"ltr\">"
    + `${inner}</div></div></div></div></body></html>`;
  const benOutlook = (danaBody: string): string => P("Hallo Clara,") + P("kannst du Dana bitte direkt antworten? Ich bin bis Montag weg.") + P("Gruss") + P("Ben") + winHop(danaBody);
  const RECEPTION = "Am Dienstag um 10 Uhr, er meldet sich am Empfang.";
  const answered = P(`1. ${Q_WHEN}`) + P(red(RECEPTION)) + P(`2. ${Q_KEY}`) + P(red(AT_DESK)) + P(PLAN_T) + P("Gruss") + P("Dana");
  add("yahoo-outlook", "same", "Yahoo: red answers after Dana's own quote, below an Outlook header", yahoo(benOutlook(P("Hallo Ben,") + box(P(QF))
    + P("Das müssen wir noch klären, ich frage nach.") + answered)), { answer: RECEPTION });
  add("yahoo-outlook", "same", "Yahoo: red answers below an Outlook header, no quote", yahoo(benOutlook(P("Hallo Ben,") + answered)), { answer: RECEPTION });
  add("yahoo-outlook", "same", "Yahoo: Dana's own quote + answer below an Outlook header", yahoo(benOutlook(P("Hallo Ben,") + box(P(QF))
    + P("Ja, sie ist Position 3 im Angebot, siehe Anhang.") + P("Gruss") + P("Dana"))));
}

// ── adversarial shapes, several quotes in one message, residuals, siblings ────────────────

function adversarial(add: Add): void {
  const W = (b: string): string => `<html><body><div class="WordSection1">${b}</div></body></html>`;
  const benQs = (a1: string, a2: string): string => P("Hallo Clara,") + P(`1. ${QF}`) + a1 + P("2. Brauchen Ihre Techniker einen Schlüssel für den Technikraum?") + a2
    + P("Bitte gebt mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.") + P("Gruss") + P("Ben");
  const POSITION = "Ja, sie ist Position 3 im Angebot.";
  const KEY = "Ja, bitte am Empfang hinterlegen.";
  add("adversarial", "same", "macNew red answers at the message's level", W(LEAD + HEADERS.macNew!(benQs(P(red(POSITION)), P(red(KEY))))), { answer: POSITION });
  add("adversarial", "same", "macNew [CM] black answers at the message's level", W(LEAD + HEADERS.macNew!(benQs(P(cm(POSITION)), P(cm(KEY))))), { answer: POSITION });
  const nested = (a1: string, a2: string): string => P("Hallo Clara,") + P("zu deinen Fragen:") + gmail(P("1. Wann kommt der Techniker?") + P(a1) + P("2. Wer hat den Schlüssel?") + P(a2))
    + P("Bitte gebt mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.") + P("Gruss") + P("Ben");
  add("adversarial", "same", "winDe [CM] answers inside a nested quote", W(LEAD + HEADERS.winDe!(nested(cm("Am Dienstag um 10 Uhr."), cm("Der Hauswart hat ihn.")))),
    { answer: "Am Dienstag um 10 Uhr." });
  add("adversarial", "same", "winDe red answers inside a nested quote", W(LEAD + HEADERS.winDe!(nested(red("Am Dienstag um 10 Uhr."), red("Der Hauswart hat ihn.")))),
    { answer: "Am Dienstag um 10 Uhr." });
  add("adversarial", "same", "Gmail split-quote answers", '<div dir="ltr">Hi Ben,<div><br></div><div>answers below.</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">'
    + "On Wed, 28 Oct 2026 at 14:12, Ben Sample &lt;ben@example.org&gt; wrote:<br></div>" + gmail("<div>Can the technician come Tuesday?</div>") + "<div>Yes, Tuesday at 10 works for us.</div>"
    + gmail("<div>Who has the key?</div>") + "<div>The caretaker has it, ask at the desk.</div></div>", { answer: "Yes, Tuesday at 10 works for us." });
  add("adversarial", "same", "Thunderbird forward of a quote and answer over an older hop", '<p>Hallo Dana,</p><p>zur Info, bitte lesen.</p><div class="moz-forward-container"><br><br>'
    + '-------- Weitergeleitete Nachricht --------<table class="moz-email-headers-table"><tbody><tr><th>Betreff: </th><td>AW: Begehung Technikraum</td></tr>'
    + "<tr><th>Datum: </th><td>Wed, 28 Oct 2026 14:12:00 +0100</td></tr><tr><th>Von: </th><td>Ben Sample &lt;ben.sample@example.org&gt;</td></tr>"
    + "<tr><th>An: </th><td>Clara Muster &lt;clara.muster@example.org&gt;</td></tr></tbody></table><br>" + P("Hallo Clara,") + gmail(BULLET)
    + P('Ja, Donnerstag um 10 Uhr passt uns. Den Plan findest du hier: <a href="https://example.com/plan">Plan</a>') + P("Gruss") + P("Ben") + OLDER + "</div>",
  { subject: "WG: AW: Begehung Technikraum" });
  // Two quotes, each answered: with a greeting it is the shape; opening with the quote, 0.30.16's reading.
  const multi = (ink: Wrap, greet: boolean): string => (greet ? P("Hallo Clara, meine Antworten:") : "")
    + gmail(P(ink("Können wir die Begehung des Technikraums auf Donnerstag verschieben?"))) + P("Ja, Donnerstag um 10 Uhr passt uns gut.")
    + gmail(P(ink("Bringt ihr bitte die Pläne der Lüftung mit?"))) + P("Ja, die Pläne bringen wir in Papierform mit.") + P("Gruss") + P("Ben");
  for (const h of ["macNew", "winDe"]) for (const [c, ink] of [[null, black], ["#500050", purple]] as const) for (const greet of [true, false]) {
    add("two-quotes", greet ? "owner" : "same", `${h} ink=${c} greet=${greet ? 1 : 0}`, W(LEAD + HEADERS[h]!(multi(ink, greet))));
  }
  add("residual", "same", "winDe original wholly in quote parts, red answers between", W(LEAD + HEADERS.winDe!(gmail(P("Hallo Clara,") + P(`1. ${Q_WHEN}`)) + P(red("Am Dienstag um 10 Uhr."))
    + gmail(P(`2. ${Q_KEY}`) + P("Gruss Ben")) + P(red(AT_DESK)))), { answer: "Am Dienstag um 10 Uhr." });
  add("residual", "same", "winDe coloured quote, no greeting, long quote", W(LEAD + HEADERS.winDe!(gmail(P(obl("Können wir die Begehung des Technikraums auf Donnerstag verschieben?"))
    + P(obl("Und bringt ihr bitte die Pläne der Lüftung mit?"))) + P("Ja, Donnerstag um 10 Uhr passt uns. Die Pläne bringen wir mit.") + P("Gruss") + P("Ben"))));
  add("residual", "same", "macNew coloured quote, no greeting", W(LEAD + HEADERS.macNew!(gmail(P(obl("Können wir die Begehung des Technikraums auf Donnerstag verschieben?")))
    + P("Ja, Donnerstag um 10 Uhr passt uns. Die Pläne bringen wir mit.") + P("Gruss") + P("Ben"))));
  const p = (t: string): string => `<p>${t}</p>`;
  const qa = gmail(BULLET) + p("Ja, Donnerstag um 10 Uhr passt uns. Bis dann.") + p("Gruss") + p("Ben");
  add("sibling", "same", "Yahoo container over a quote and answer", '<div>Hallo Ben, danke dir.</div><div>Clara</div><div id="yahoo_quoted_1" class="yahoo_quoted">'
    + `<div>On Wednesday, 28 October 2026 at 14:12, Ben Sample &lt;ben@example.org&gt; wrote:</div><div><br></div><div><div dir="ltr">${p("Hallo Clara,")}${qa}</div></div></div>`);
  add("sibling", "same", "forward whose folded hop holds a quote and answer", '<p>Hallo Dana,</p><p>zur Info.</p><div class="moz-forward-container">-------- Weitergeleitete Nachricht --------'
    + '<table class="moz-email-headers-table"><tbody><tr><th>Betreff: </th><td>AW: Begehung</td></tr><tr><th>Datum: </th><td>Wed, 28 Oct 2026 14:12:00 +0100</td></tr>'
    + "<tr><th>Von: </th><td>Ben Sample &lt;ben.sample@example.org&gt;</td></tr><tr><th>An: </th><td>Clara Muster &lt;clara.muster@example.org&gt;</td></tr></tbody></table>"
    + `${p("Hallo Clara, kurz zur Begehung.")}${p("Gruss Ben")}${OLDER.replace(P("Können wir die Begehung des Technikraums auf Donnerstag verschieben?"), qa)}</div>`,
  { subject: "WG: AW: Begehung" });
  add("sibling", "same", "comment heading inside the history", '<p>Hallo Ben,</p><p>danke, passt so.</p><p>Clara</p><div style="border:none;border-top:solid #E1E1E1 1.0pt">'
    + "<p><b>Von:</b> Ben Sample &lt;ben@example.org&gt;<br><b>Gesendet:</b> Mittwoch, 28. Oktober 2026 14:12<br><b>An:</b> Clara Muster<br><b>Betreff:</b> AW: Begehung</p></div>"
    + "<p>Hallo Clara,</p><p>Meine Anmerkungen:</p><p>Der Termin am Donnerstag passt uns gut.</p><p>Gruss Ben</p>");
  for (const t of qhTypedAnswers()) add("typed", "same", t.name, t.html, { answer: t.answer, text: t.text });
}

// ── the class's edges: what it folds, its named cost, and what it never captures ──────────

function classEdges(add: Add): void {
  const A = "Dienstag passt mir gut.";
  const answer = (t: string): More => ({ answer: t });
  for (const id of IDS) {
    // The writer's answer as its own box: in the message's ink in a new-Outlook history it folds (the named cost);
    // below a question, or in another ink, 0.30.16's reading.
    for (const [bk, bx] of [["indent bq", indentBq], ["plain bq", plain], ["cite", cite], ["ruled bq", box]] as const) {
      for (const [ik, ink] of [["red", red], ["black", black], ["purple", purple]] as const) {
        const cost: QhProbeLabel = id === "132" && ik === "black" ? "cost" : "same";
        add("answer-box", cost, `${id} answer box (${bk}, ${ik}) under a statement`, earlier(id, P("Hallo Clara,") + P("Die Begehung ist am Dienstag um 10 Uhr geplant.") + bx(P(ink(A))) + PLAN), answer(A));
        add("answer-box", "same", `${id} answer box (${bk}, ${ik}) under a question`, earlier(id, P("Hallo Clara,") + P("Passt dir der Dienstag um 10 Uhr?") + bx(P(ink(A))) + PLAN), answer(A));
        add("answer-box", cost, `${id} answer box (${bk}, ${ik}) under the greeting`, earlier(id, P("Hallo Clara,") + bx(P(ink(A))) + PLAN), answer(A));
      }
    }
    for (const [qk, ink] of [["purple", purple], ["black", black], ["blue", blue]] as const) {
      add("answer-in-box", "same", `${id} 'JA' in the box's ink under the quoted question (${qk})`, earlier(id, P("Hallo Clara,") + box(P(ink(QMOVE)) + P(ink("JA")))
        + P("Ja, Donnerstag um 10 Uhr passt uns.") + PLAN), answer("JA"));
      add("answer-in-box", "same", `${id} '14:00' in the box's ink under the quoted question (${qk})`, earlier(id, P("Hallo Clara,") + box(P(ink("Um wie viel Uhr kommt der Techniker?")) + P(ink("14:00")))
        + P("Ja, Donnerstag passt uns.") + PLAN), answer("14:00"));
      add("answer-in-box", "same", `${id} sentence in the box's ink under the quoted question (${qk})`, earlier(id, P("Hallo Clara,") + box(P(ink(QMOVE)) + P(ink("Ja, Donnerstag um 10 Uhr passt mir gut.")))
        + P("Danke dir.") + PLAN), answer("Ja, Donnerstag um 10 Uhr passt mir gut."));
      add("answer-in-box", "same", `${id} red answer under the quoted question (${qk} quote)`, earlier(id, P("Hallo Clara,") + box(P(ink(QMOVE)) + P(red("JA"))) + P("Ja, Donnerstag um 10 Uhr passt uns.") + PLAN),
        answer("JA"));
    }
    const asked = P("Hallo Clara,") + box(P(QMOVE)) + P("Ja, Donnerstag passt uns.") + P("Kannst du die Schlüssel holen?");
    add("answer-in-line", "same", `${id} red word appended to the earlier writer's own line`, earlier(id, P("Hallo Clara,") + box(P(QMOVE)) + P(`Passt dir Dienstag oder Mittwoch? ${red("Dienstag")}`) + PLAN),
      answer("Dienstag"));
    add("answer-in-line", "same", `${id} partial highlight in a line`, earlier(id, P("Hallo Clara,") + box(P(QMOVE)) + P(`Ja, Donnerstag passt. ${hl("NEIN, Dienstag")}`) + PLAN), answer("NEIN, Dienstag"));
    add("answer-in-line", "same", `${id} single [Name] mark at level, same ink`, earlier(id, asked + P(nm("Ja, mache ich.")) + PLAN), answer("Ja, mache ich."));
    add("answer-in-line", "same", `${id} '-> ' prefix answer at level, same ink`, earlier(id, asked + P("-&gt; Ja, mache ich.") + PLAN), answer("Ja, mache ich."));
    add("answer-in-line", id === "132" ? "cost" : "same", `${id} bold answer at level, same ink`, earlier(id, asked + P("<b>Ja, mache ich.</b>") + PLAN), answer("Ja, mache ich."));
    const shape = box(P(QMOVE)) + P("Ja, Donnerstag um 10 Uhr passt uns.");
    add("structure", "same", `${id} message opens with its quote (no greeting)`, earlier(id, shape + P("Gruss") + P("Ben")));
    add("structure", "same", `${id} writer's red answer is the only level text under a quote`, earlier(id, box(P(QMOVE)) + P(red("Ja, Donnerstag passt mir.")) + P(PLAN_T)),
      answer("Ja, Donnerstag passt mir."));
    add("structure", "owner", `${id} quote, answer, quote, answer (multi, black)`, earlier(id, P("Hallo Clara,") + box(P(QMOVE)) + P("Ja, Donnerstag passt uns.") + box(P("Bringt ihr die Pläne mit?"))
      + P("Ja, die Pläne bringen wir mit.") + P("Gruss") + P("Ben")));
    add("structure", "owner", `${id} quote, answer, quote, answer (multi, purple)`, earlier(id, P("Hallo Clara,") + box(P(purple(QMOVE))) + P("Ja, Donnerstag passt uns.")
      + box(P(purple("Bringt ihr die Pläne mit?"))) + P("Ja, die Pläne bringen wir mit.") + P("Gruss") + P("Ben")));
    add("structure", "owner", `${id} intro sentence, then the quote, then the answer`, earlier(id, P("Hallo Clara,") + P("danke für deine Nachricht.") + shape + P("Gruss") + P("Ben")));
    add("structure", "same", `${id} quoted question plus its explanation in one box`, earlier(id, P("Hallo Clara,") + box(P(QMOVE) + P("Am Dienstag bin ich leider nicht im Haus."))
      + P("Ja, Donnerstag um 10 Uhr passt uns.") + P("Gruss") + P("Ben")));
    add("structure", "same", `${id} the quote-and-answer shape with Ben's coloured signature`, earlier(id, P("Hallo Clara,") + shape + P("Gruss") + SIG));
    add("structure", "same", `${id} the quote-and-answer shape, a red answer after Ben's sign-off`, earlier(id, P("Hallo Clara,") + shape + P("Kannst du die Schlüssel holen?") + P("Gruss") + P("Ben")
      + P(red("Ja, mache ich."))), answer("Ja, mache ich."));
    add("structure", id === "132" ? "cost" : "same", `${id} the quote-and-answer shape, the writer's black answer under Ben's question`, earlier(id, P("Hallo Clara,") + shape
      + P("Kannst du die Schlüssel holen?") + P("Ja, mache ich.") + P("Gruss") + P("Ben")), answer("Ja, mache ich."));
    add("lead", "same", `${id} lead announces answers below in red`, earlier(id, P("Hallo Clara,") + shape + P("Gruss") + P("Ben"))
      .replace("danke, so machen wir es.", "meine Antworten findest du unten in Rot."));
    add("lead", "same", `${id} the quote-and-answer shape as a forward (subject WG:)`, fixture(id).html, { subject: "WG: Begehung Technikraum" });
  }
  // 134's inner message quoting in any box and ink is the shape; the writer's red answer there is not.
  const PLAENE = "Wer bringt die Pläne der Lüftung zur Begehung mit?";
  const brings = P("Die bringe ich mit, ich habe sie gestern vom Planungsbüro bekommen.") + BL + P("Viele Grüsse") + P("Dana");
  for (const [bk, bx] of [["ruled bq", box], ["Word box", wbox], ["cite", cite], ["gmail", gmail], ["margin bq", marginBq]] as const) {
    for (const [ik, ink] of [["#1F497D", obl], ["black", black], ["purple", purple]] as const) add("inner-message", "owner", `134 inner ${bk} ${ik}`, danaHop(P("Hallo Ben,") + BL + bx(P(ink(PLAENE))) + brings));
  }
  add("inner-message", "same", "134 writer's red answer in Dana's hop under her quote", danaHop(P("Hallo Ben,") + BL + box(P(obl(PLAENE))) + P(red("Ich bringe sie mit.")) + brings),
    answer("Ich bringe sie mit."));
  // A word or two right below a quote, the writer's or Ben's own, keeps 0.30.16's reading.
  for (const id of IDS) for (const [qk, ink] of [["black", black], ["purple", purple]] as const) {
    for (const a of ["JA", "14:00", "OK", "NEIN", "Ja, passt."]) {
      add("short-answer", "same", `${id} black '${a}' at level under a ${qk} quoted question, prose after`, earlier(id, P("Hallo Clara,") + ASK + box(P(ink(QF))) + P(a) + PLAN), answer(a));
    }
    add("short-answer", "same", `${id} Ben's own short answer 'Ja, passt.' under a ${qk} quote (control)`, earlier(id, P("Hallo Clara,") + box(P(ink(QMOVE))) + P("Ja, passt.") + P("Gruss") + P("Ben")));
  }
  const statement = P("Hallo Clara,") + P("Die Begehung ist am Dienstag um 10 Uhr geplant.");
  for (const id of IDS) {
    for (const [bk, bx] of [["indent bq", indentBq], ["cite", cite], ["ruled bq", box], ["Roosterjs quote", rooster]] as const) {
      add("own-box", "same", `${id} writer's red counter-question as its own ${bk} under a statement`, earlier(id, statement + bx(P(red("Geht auch Mittwoch?"))) + PLAN), answer("Geht auch Mittwoch?"));
      add("own-box", "same", `${id} writer's red answer as its own ${bk} under a statement`, earlier(id, statement + bx(P(red(A))) + PLAN), answer(A));
      add("own-box", id === "132" ? "cost" : "same", `${id} writer's grey answer as its own ${bk} under a statement`, earlier(id, statement + bx(P(A)) + PLAN), answer(A));
    }
    // A coloured quote of a statement keeps 0.30.16's reading; a black one, a whole quoted message, Ben's own ink are the shape.
    const reserved = P("Donnerstag um 10 Uhr passt uns, ich habe den Raum reserviert.") + P("Gruss") + P("Ben");
    add("own-quote", "same", `${id} purple Gmail quote of a statement bullet, then the answer`, earlier(id, P("Hallo Clara,")
      + gmail(`<ul><li>${purple("Termin für die Begehung des Technikraums festlegen.")}</li></ul>`) + reserved));
    add("own-quote", "owner", `${id} black quote of a statement bullet, then the answer`, earlier(id, P("Hallo Clara,") + box("<ul><li>Termin für die Begehung des Technikraums festlegen.</li></ul>") + reserved));
    add("own-quote", "owner", `${id} answer, then attribution + whole quoted message at the end`, earlier(id, REPLY + BY
      + gmail(P("Hallo Ben,") + P(QMOVE) + P("Viele Grüsse") + P("Dana"))));
    add("own-quote", "owner", `${id} Ben's whole text in Outlook blue, black quote box`, earlier(id, P(obl("Hallo Clara,")) + box(P(QMOVE)) + P(obl("Ja, Donnerstag um 10 Uhr passt uns."))
      + P(obl("Gruss")) + P(obl("Ben"))));
  }
}

// ── around the new-Outlook container; separator-led hops; the named cost ──────────────────

function aroundTheContainer(add: Add): void {
  const html132 = fixture("132").html!;
  const CONTAINER = '<div id="mail-editor-reference-message-container">';
  const END = "</div></div></body>";
  const PS = "PS: Ich bringe die Schlüssel mit, keine Sorge.";
  const after = (h: string): string => h.replace(END, `</div></div><p class="MsoNormal">${PS}</p></body>`);
  const rule = '<p class="MsoNormal">________________________________</p>';
  const by = '<p class="MsoNormal">Am 28.10.2026 um 14:12 schrieb Ben Sample &lt;ben.sample@example.org&gt;:</p>';
  add("container", "owner", "132 lead holds the writer's own blockquote above the container", html132.replace('<p class="MsoNormal">danke, so machen wir es.',
    '<blockquote type="cite"><p class="MsoNormal">Können wir verschieben?</p></blockquote><p class="MsoNormal">danke, so machen wir es.'));
  add("container", "same", "132 the writer's text continues after the container", after(html132), { answer: PS });
  add("container", "same", "132 a signature after the container", html132.replace(END, '</div></div><p class="MsoNormal">--</p><p class="MsoNormal">Clara Muster</p></body>'));
  add("container", "owner", "132 a signature inside the container's end", html132.replace(END, '<p class="MsoNormal">--</p><p class="MsoNormal">Clara Muster</p></body>'));
  add("container", "same", "132 with no lead: the writer typed nothing", html132.replace(/<div class="WordSection1">[^]*?<div id="mail-editor-reference-message-container">/, `<div class="WordSection1">${CONTAINER}`));
  add("container", "same", "132 a rule above the container, the writer's text after it", after(html132.replace(CONTAINER, rule + CONTAINER)), { answer: PS });
  add("container", "owner", "132 a rule above the container (the quote-and-answer shape)", html132.replace(CONTAINER, rule + CONTAINER));
  add("container", "same", "132 as a forward by its subject", html132, { subject: "WG: Begehung Technikraum" });
  add("container", "same", "132 an attribution above the container, the writer's text after it", after(html132.replace(CONTAINER, by + CONTAINER)), { answer: PS });
  add("container", "owner", "132 an attribution above the container (the quote-and-answer shape)", html132.replace(CONTAINER, by + CONTAINER));
  const purpleBen = P("Hallo Clara,") + box(P(purple(QMOVE))) + P("Ja, Donnerstag um 10 Uhr passt uns gut.") + P("Gruss") + P("Ben");
  const danaHeader = "Von: Dana Example &lt;dana.example@example.net&gt;<br>Gesendet: Dienstag, 27. Oktober 2026 17:40<br>An: Ben Sample &lt;ben.sample@example.org&gt;<br>Betreff: Begehung Technikraum";
  add("separator", "same", "133 a separator-led first hop over the quote-and-answer shape (purple quote)", fixture("133").html!
    .replace(/<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">/, '<p class="MsoNormal">-----Ursprüngliche Nachricht-----</p><div><div>')
    .replace(EARLIER, purpleBen));
  add("separator", "same", "133 the quote-and-answer shape (purple quote) over a separator-led older hop", earlier("133", purpleBen + P("-----Ursprüngliche Nachricht-----") + P(danaHeader)
    + P("Hallo Ben,") + P("Können wir die Begehung verschieben? Am Dienstag bin ich nicht im Haus.") + P("Viele Grüsse") + P("Dana")));
  add("separator", "same", "133 the quote-and-answer shape, a quoted message with its own header, then a red question shallower than that header", earlier("133", purpleBen + BY
    + box(P(danaHeader) + P("Hallo Ben,") + P("Passt dir der Donnerstag?") + P("Dana")) + P(red("Geht auch Mittwoch?"))), { answer: "Geht auch Mittwoch?" });
  // The writer's same-ink words under the earlier writer's question: folded with a coloured quote (the cost), as 0.30.16 does with a black one.
  for (const id of ["133", "135"]) for (const [qk, label, ink] of [["purple", "cost", purple], ["black", "same", black]] as const) {
    const what = qk === "purple" ? "the writer's same-ink sentence under the earlier writer's question" : "the same (0.30.16 already folds it)";
    add("cost", label, `${id} ${qk} quote: ${what}`, earlier(id, P("Hallo Clara,") + box(P(ink(QMOVE))) + P("Ja, Donnerstag um 10 Uhr passt uns gut.")
      + P("Kannst du die Schlüssel beim Hauswart holen?") + P("Ja, das mache ich am Mittwoch.") + P("Gruss") + P("Ben")), { answer: "Ja, das mache ich am Mittwoch." });
  }
  add("separator", "same", "133 the writer's red question box after the earlier writer's purple quote and answer", earlier("133", P("Hallo Clara,") + box(P(purple(QMOVE)))
    + P("Ja, Donnerstag um 10 Uhr passt uns gut.") + box(P(red("Geht auch Mittwoch?"))) + P("Bitte gib mir bis Freitag Bescheid, dann plane ich ein.") + P("Gruss") + P("Ben")),
  { answer: "Geht auch Mittwoch?" });
  // A forward's own introducer above the container (in a laid-out mail or a table cell, where it is no
  // header of its own): the forward rule reads it, never the class.
  const fwd = '<div class="moz-cite-prefix">-------- Weitergeleitete Nachricht --------</div>';
  add("forward-introducer", "same", "132 a forward introducer above the container, laid out", html132.replace('<div class="WordSection1">', '<div class="WordSection1" style="max-width:640px">')
    .replace(CONTAINER, fwd + CONTAINER));
  add("forward-introducer", "same", "132 a forward introducer above the container, in a table cell", html132.replace(/<div class="WordSection1">[^]*?<div id="mail-editor-reference-message-container">/,
    `<div class="WordSection1"><table><tr><td>${P("Hallo Dana,")}${P("zur Info, bitte lesen.")}${fwd}</td></tr></table>${CONTAINER}`));
  // A container that opens with a quoted header block, not one of its own: outside the class.
  const quotedHeader = gmail("<p>From: Ben Sample &lt;ben.sample@example.org&gt;<br>Sent: Wednesday, October 28, 2026 2:12 PM<br>To: Clara Muster &lt;clara.muster@example.org&gt;"
    + "<br>Subject: Visit</p><p>Hi Clara,</p><p>Can we move the visit to Thursday?</p><p>Ben</p>");
  add("quoted-header", "same", "a Gmail container opening with a quoted Outlook header, an answer in a ruled box below", '<div dir="ltr">Hi Ben,<div><br></div><div>thanks, see below.</div></div><br>'
    + `<div class="gmail_quote">${quotedHeader}<div style="border-left:1px solid #cccccc;padding-left:1ex"><p>Thursday at 10 works for us, see you then.</p></div></div>`,
  { answer: "Thursday at 10 works for us, see you then." });
}

// ── new Outlook's history read to its end, as the Windows header path reads the body ──────

function wholeHistory(add: Add): void {
  const JA = "JA, er kommt um 10 Uhr.";
  const TUESDAY = "Am Dienstag um 10 Uhr.";
  const benQa = P("Hallo Clara,") + P("Kommt der Techniker morgen?") + P(red(JA)) + P(PLAN_T) + P("Gruss") + P("Ben");
  // The writer's reply text holds its own quote, so the container is not the first quote run.
  const leadQuote = (h: string): string => h.replace('<p class="MsoNormal">danke, so machen wir es.',
    `${cite(P("Können wir verschieben?"))}<p class="MsoNormal">danke, so machen wir es.`);
  for (const id of ["132", "133"]) {
    add("lead-quote", opens(id), `${id} red answer + prose in the earlier message`, leadQuote(earlier(id, benQa)), { answer: JA });
    add("lead-quote", opens(id), `${id} red answers in an older hop`, leadQuote(earlier(id, PLAIN_BEN + winHop(DANA_QA))), { answer: TUESDAY });
  }
  add("lead-quote", "same", "132 no answers (it folds)", leadQuote(earlier("132", PLAIN_BEN + winHop(DANA_QA.replace(/<span style="color:#C00000">([^<]*)<\/span>/g, "$1")))));
  // A long older quote in one saturated ink past an attribution: the writer's red answer above it stays open.
  const long = (ink: Wrap): string => P(ink("Hallo Ben,")) + [1, 2, 3].map((k) => P(ink(`Punkt ${k}: Die Begehung des Technikraums muss mit dem Hauswart und der Verwaltung `
    + "abgestimmt werden, bevor wir den Termin bestätigen."))).join("") + P(ink("Viele Grüsse")) + P(ink("Dana"));
  for (const [qk, q] of [["gmail", gmail], ["cite", cite], ["plain lines", black]] as const) for (const [ik, ink] of [["#1F497D", obl], ["#500050", purple]] as const) {
    add("hop-ink", "same", `132 red answer + prose, attribution, ${qk} quote in ${ik}`, earlier("132", benQa + BY + q(long(ink))), { answer: JA });
  }
  // A container led by a quoted header block, not its own: read to its first message, as before.
  const sig = P(obl("Ben Sample")) + P(obl("Projektleiter Haustechnik | Beispiel AG"));
  add("quoted-header-led", "same", "a Gmail container opening with a quoted Outlook header, a coloured signature above an attribution",
    '<div dir="ltr">Hi Ben,<div><br></div><div>thanks, that works.</div></div><br><div class="gmail_quote">'
    + gmail(P("From: Ben Sample &lt;ben.sample@example.org&gt;") + P("Sent: Wednesday, October 28, 2026 2:12 PM") + P("To: Clara Muster &lt;clara.muster@example.org&gt;")
      + P("Subject: Visit") + P("Hi Clara,") + P("Thursday at 10 works for us, see you then.") + sig + P("On Tue, 27 Oct 2026 at 17:40, Dana Example &lt;dana@example.net&gt; wrote:")
      + gmail(P("Hi Ben,") + P("Can we move the visit of the technical room to Thursday? On Tuesday I am not in the house.") + P("Dana"))) + "</div>");
}

/** Every probe, in a fixed order: the corpus first, then each family. */
export function qhProbeCases(): QhProbe[] {
  const cases: QhProbe[] = [];
  const add: Add = (family, label, name, html, more = {}) => {
    cases.push({ family, name, label, html, ...more });
  };
  // The corpus: 132-135 are the class's own fixtures, 136 is new Outlook read to its end; every other one reads as 0.30.16 reads it.
  for (const f of (corpus ??= qhFixtures())) {
    add("corpus", /^13[2-5]$/.test(f.id) ? "owner" : f.id === "136" ? "open" : "same", f.name, f.html, { text: f.text, subject: f.subject, answer: f.expect.inlineAnswers[0] });
  }
  ownerMatrices(add);
  typedAnswers(add);
  answersEverywhere(add);
  adversarial(add);
  classEdges(add);
  aroundTheContainer(add);
  wholeHistory(add);
  return cases;
}
