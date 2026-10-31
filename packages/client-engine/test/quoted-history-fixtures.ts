/**
 * The quoted-history corpus (`fixtures/quoted-history/`, synthetic): each `.eml`, its sidecar and the
 * parsed parts storage keeps (`body.txt`, `body.html`; `packages/core/test/quoted-history-parts.test.ts`
 * holds them to the `.eml`). Read by the engine, web and phone tests alike.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const QH_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "quoted-history");

export interface QhExpect {
  fold: "trailing" | "leading" | "none" | "trailing-tail-only" | "trailing-before-signature";
  mustNotFold: boolean;
  onlyHistory: boolean;
  text: {
    visibleFirstLine: string | null;
    visibleLastLine: string | null;
    historyStartLine: string | null;
    historyStartLineNormalized: string | null;
    signatureAfterHistory?: string[];
  } | null;
  html: {
    historyStartSelector: string | null;
    attributionBefore: string | null;
    historyStartText: string | null;
    visibleFirstText: string | null;
    visibleLastText: string | null;
    signatureAfterHistory?: string[];
  } | null;
  inlineAnswers: string[];
  trailingTail: { startLine: string; foldable: boolean } | null;
}

export interface QhFixture {
  id: string;
  name: string;
  expect: QhExpect;
  /** The `.eml`'s Subject, decoded: what every reader hands the detector. */
  subject: string;
  text: string;
  html: string | null;
}

/** The header's Subject, its encoded words (utf-8 B and Q, all the corpus uses) decoded. */
function subjectOf(eml: string): string {
  const head = eml.split(/\r?\n\r?\n/, 1)[0]!;
  const raw = /^Subject:(.*(?:\r?\n[ \t].*)*)/im.exec(head)?.[1] ?? "";
  return raw.replace(/\r?\n[ \t]+/g, " ").trim().replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, enc: string, t: string) =>
    enc.toLowerCase() === "b"
      ? Buffer.from(t, "base64").toString("utf8")
      : Buffer.from(t.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m: string, x: string) => String.fromCharCode(parseInt(x, 16))), "latin1").toString("utf8"));
}

export function qhFixtures(): QhFixture[] {
  return readdirSync(QH_DIR).filter((f) => f.endsWith(".eml")).sort().map((f) => {
    const base = join(QH_DIR, f.replace(/\.eml$/, ""));
    const side = JSON.parse(readFileSync(`${base}.expected.json`, "utf8")) as { id: string; shape: string; expect: QhExpect };
    return {
      id: side.id,
      name: f.replace(/\.eml$/, ""),
      expect: side.expect,
      subject: subjectOf(readFileSync(join(QH_DIR, f), "utf8")),
      text: readFileSync(`${base}.body.txt`, "utf8"),
      html: existsSync(`${base}.body.html`) ? readFileSync(`${base}.body.html`, "utf8") : null,
    };
  });
}

/** Text as the sidecars compare it: no-break spaces as spaces, whitespace collapsed. */
export const qhNorm = (s: string): string => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

/** Does the expectation fold at all? */
export const qhFolds = (e: QhExpect): boolean => e.fold !== "none" && !e.onlyHistory;

/**
 * Fixture 133 with the current writer's answers typed into the history (both parts): as a quote
 * box's last line, between a quote's parts below an attribution (also longer than the message's own
 * words, and under a coloured signature), with a name mark in a box and in the message's text, a
 * lone short one under a quoted question, and one ending a box with only quoted text after it.
 * Each must keep the history open.
 */
export function qhTypedAnswers(): Array<{ name: string; html: string; text: string; answer: string }> {
  const fx = qhFixtures().find((f) => f.id === "133")!;
  const P = (t: string): string => `<p class="MsoNormal">${t}<o:p></o:p></p>`;
  const red = (t: string): string => `<span style="color:#C00000">${t}</span>`;
  const nm = (t: string): string => `<b><i>[Clara Muster] </i></b>${t}`;
  const box = (x: string): string => `<blockquote style="margin:0cm 0cm 0cm 4.8pt;border-left:solid #CCCCCC 1.0pt;padding:0cm 0cm 0cm 6.0pt">${x}</blockquote>`;
  const shape = (name: string, answer: string, parts: Array<[string, string]>) => ({
    name, answer,
    html: fx.html!.replace(/<p class="MsoNormal">Hallo Clara,[^]*Ben<o:p><\/o:p><\/p>/, parts.map(([h]) => h).join("")),
    text: fx.text.replace(/\nHallo Clara,[^]*$/, `\n${parts.map(([, t]) => t).join("\n")}`),
  });
  const Q = "Wann kommt der Techniker morgen genau?";
  const A = "Um 10 Uhr, er meldet sich am Empfang.";
  const by = "Am 27.10.2026 um 17:40 schrieb Dana Example <dana.example@example.net>:";
  const p = (...ts: string[]): [string, string] => [ts.map(P).join(""), ts.join("\n")];
  const q = (...ts: string[]): [string, string] => [box(ts.map(P).join("")), ts.join("\n")];
  const r = (t: string): [string, string] => [P(red(t)), t];
  const long = ["Am Dienstag um 10 Uhr, er meldet sich vorher telefonisch bei Frau Muster am Empfang.",
    "Der Hauswart hat ihn, bitte vorher beim Empfang im Erdgeschoss nachfragen und unterschreiben."];
  const asked = [q("1. Wann kommt der Techniker morgen genau? Wir müssen den Raum vorher aufschliessen und lüften."), r(long[0]!),
    q("2. Wer hat den Schlüssel für den Technikraum? Letztes Mal hat das eine Stunde gedauert."), r(long[1]!), q("Danke und Gruss", "Dana")];
  const sig: [string, string] = [P('<b><span style="color:#1F497D">Ben Sample</span></b>') + P('<span style="color:#1F497D">Projektleiter Haustechnik | Beispiel AG</span>'),
    "Ben Sample\nProjektleiter Haustechnik | Beispiel AG"];
  const attribution: [string, string] = [P(by.replace(/</g, "&lt;").replace(/>/g, "&gt;")), by];
  return [
    shape("a red answer as a quote box's last line", A, [[P("Hallo Clara,"), "Hallo Clara,"], [P("Dana fragt noch:"), "Dana fragt noch:"],
      [box(P(Q) + P(red(A))), `${Q}\n${A}`], [P("Kannst du ihr das bitte direkt beantworten?"), "Kannst du ihr das bitte direkt beantworten?"], [P("Gruss") + P("Ben"), "Gruss\nBen"]]),
    shape("red answers between a quote's parts", A, [[P("Hallo Clara,") + P("Dana hat Fragen, siehe unten.") + P("Gruss") + P("Ben"), "Hallo Clara,\nDana hat Fragen, siehe unten.\nGruss\nBen"],
      [P(by.replace(/</g, "&lt;").replace(/>/g, "&gt;")), by], [box(P(`1. ${Q}`)), `1. ${Q}`], [P(red(A)), A],
      [box(P("2. Wer hat den Schlüssel für den Technikraum?") + P("Gruss Dana")), "2. Wer hat den Schlüssel für den Technikraum?\nGruss Dana"],
      [P(red("Der Hauswart hat ihn, bitte am Empfang fragen.")), "Der Hauswart hat ihn, bitte am Empfang fragen."]]),
    shape("a name mark in a box and in the message's text", A, [[P("Hallo Clara,") + P("Dana fragt noch:"), "Hallo Clara,\nDana fragt noch:"],
      [box(P(Q) + P(nm(A))), `${Q}\n[Clara Muster] ${A}`], [P("Kannst du ihr das bitte direkt beantworten?"), "Kannst du ihr das bitte direkt beantworten?"],
      [P(nm("Ja, ich schreibe ihr gleich selbst.")), "[Clara Muster] Ja, ich schreibe ihr gleich selbst."], [P("Gruss") + P("Ben"), "Gruss\nBen"]]),
    shape("long red answers between a quote's parts", long[0]!, [p("Hallo Clara,", "Dana hat Fragen, siehe unten.", "Gruss", "Ben"), attribution, ...asked]),
    shape("a lone short answer under a quoted question", "JA, POSITION 3", [p("Hallo Clara,", "Dana fragt noch:"), q("Ist die Filterreinigung im Angebot enthalten?"),
      r("JA, POSITION 3"), p("Bitte gib mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.", "Gruss", "Ben")]),
    shape("an answer ending a quote box, only quoted text after it", A, [p("Hallo Clara,", "Dana fragt:"), [box(P(Q) + P(red(A))), `${Q}\n${A}`], p("Und:"),
      [box(P("Wer hat den Schlüssel für den Technikraum?") + P(red("Der Hauswart hat ihn."))), "Wer hat den Schlüssel für den Technikraum?\nDer Hauswart hat ihn."], p("Gruss", "Ben")]),
    shape("a coloured signature above answers between a quote's parts", long[0]!, [p("Hallo Clara,", "siehe unten."), sig, attribution, ...asked]),
  ];
}

/**
 * Bodies the html half must read in one linear pass: a long run of date lines above an Outlook header
 * block (a date line starts GMX's header block, so every line of the run starts one), in a pre, between
 * line breaks, under Outlook's border-top marker and in new Outlook's container; and one long word of
 * punctuation where a sign-off is read, ending an opening quote box or below its answer, under both.
 */
export function qhHostileBodies(): Array<{ name: string; html: string }> {
  const run = (n: number, sep: string): string => [...Array.from({ length: n }, () => "Date:"),
    "Von: Dana Example", "An: Ben Sample", "Betreff: Termin", "-> eins", "Das ist ein ganzer Satz mit Inhalt."].join(sep);
  const pre = `<pre>${run(43_000, "\n")}</pre>`;
  // One word of 500,000 marks between two letters where a sign-off is read: an earlier Outlook message opens with a quote box.
  const word = `<p>x${"!".repeat(500_000)}x</p>`;
  const header = "<p><b>Von:</b> Ben Sample &lt;ben.sample@example.org&gt;<br><b>Gesendet:</b> Mittwoch, 28. Oktober 2026 14:12<br>"
    + "<b>An:</b> Clara Muster &lt;clara.muster@example.org&gt;<br><b>Betreff:</b> AW: Begehung</p>";
  const lead = "<p>Hallo Ben, danke dir.</p><p>Gruss Clara</p>";
  const win = (h: string): string => `${lead}<div style="border:none;border-top:solid #E1E1E1 1.0pt">${header}</div>${h}`;
  const mac = (h: string): string => `${lead}<div id="mail-editor-reference-message-container">${header}${h}</div>`;
  const move = "<p>Können wir die Begehung auf Donnerstag verschieben?</p>";
  const answer = "<p>Ja, Donnerstag um 10 Uhr passt uns gut.</p>";
  return [
    { name: "43,000 date lines over an Outlook header block in a pre", html: `<div>Hallo Ben</div>${pre}` },
    { name: "8,000 date lines over an Outlook header block between line breaks", html: `<div>Hallo Ben</div><div>${run(8_000, "<br>")}</div>` },
    { name: "the same pre under Outlook's border-top marker", html: `<div>Hallo Ben</div><div style="border:none;border-top:solid #E1E1E1 1.0pt">${pre}</div>` },
    { name: "the same pre in new Outlook's container", html: `<div>Hallo Ben, siehe unten.</div><div>Gruss Clara</div><div id="mail-editor-reference-message-container">${pre}</div>` },
    { name: "a 500,000-mark word ending an opening quote box under Outlook's header", html: win(`<blockquote>${word}</blockquote><p>ok</p>`) },
    { name: "the same word ending an opening quote box in new Outlook's container", html: mac(`<blockquote>${word}</blockquote>${answer}`) },
    { name: "the same word below an opening quote's answer under Outlook's header", html: win(`<blockquote>${move}</blockquote>${answer}${word}`) },
    { name: "the same word below an opening quote's answer in new Outlook's container", html: mac(`<blockquote>${move}</blockquote>${answer}${word}`) },
  ];
}
