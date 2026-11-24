/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  quotedDomTree,
  quotedHistoryCut,
  quotedHistoryOfText,
  quotedHistoryReadingOfHtml,
  type QuotedDomNode,
  type QuotedVerdict,
} from "../src/quoted-history.js";

/**
 * ONE CASE PER REPLY FORMAT. Each mail client writes its quoted history in its own shape; every
 * shape below folds at its own attribution or header block, with the new words and their signature
 * left visible, and its text part folds the same. The deepest hop of several cases is a forwarded,
 * laid-out booking mail (a 600 px table with cells in a brand colour): its design is never read as
 * answers typed into the history. Invented words and example.com addresses only.
 */

const norm = (s: string): string => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

/** A node's text with its text nodes kept apart (blocks do not run together). */
function words(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return norm(n.nodeValue ?? "");
  const out: string[] = [];
  const walk = n.ownerDocument!.createTreeWalker(n, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) out.push(t.nodeValue ?? "");
  return norm(out.join(" "));
}

/** The html part as the reader sees it: its verdict, the history's first text, and what stays visible. */
function readHtml(html: string, subject: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body as unknown as QuotedDomNode;
  const r = quotedHistoryReadingOfHtml(root, quotedDomTree, { subject });
  let history = "";
  if (r.range) {
    const cut = quotedHistoryCut(root, quotedDomTree, r.range);
    history = norm(cut.history.map((n) => words(n as unknown as Node)).join(" "));
    for (const n of cut.history) (n as unknown as ChildNode).remove();
  }
  return { verdict: r.verdict, at: r.range?.at ?? null, history, visible: words(doc.body) };
}

/** The text part, read under its html part's verdict (absent: a text-only message). */
function readText(text: string, subject: string, html?: QuotedVerdict) {
  const lines = text.split("\n");
  const r = quotedHistoryOfText(lines, { subject, ...(html === undefined ? {} : { html }) });
  const visible = (r === null ? lines : [...lines.slice(0, r.start), ...lines.slice(r.end)]).map(norm).filter(Boolean);
  return { at: r?.at ?? null, first: r === null ? null : norm(lines[r.start]!), last: visible[visible.length - 1] ?? null, visible };
}

function folds(html: string, subject: string, starts: string, last: string) {
  const h = readHtml(html, subject);
  expect(h.verdict, "the html must fold").toBe("trailing");
  expect(h.at).toBe("trailing");
  expect(h.history.startsWith(starts), `history starts at "${h.history.slice(0, 60)}"`).toBe(true);
  expect(h.visible.endsWith(last), `visible ends at "…${h.visible.slice(-60)}"`).toBe(true);
  return h;
}

function staysOpen(html: string, subject: string) {
  const h = readHtml(html, subject);
  expect(h.verdict, "the html must not fold").toBeNull();
  return h;
}

// ── the shapes ─────────────────────────────────────────────────────────────────────────────

/** k. A laid-out booking mail on a 600 px canvas: brand-ink cells, default-ink rows, a sentence in a cell, a grey footer. */
const TEMPLATE = `<table width="600" cellpadding="0" cellspacing="0" style="width:600px"><tr><td><img src="cid:logo@example.com" width="120" alt="Example Venue"></td></tr>
<tr><td>We have received your request for the following slot:</td></tr>
<tr><td style="color:#1b4f72">(Booking #01234) (</td><td style="color:#1b4f72">4. Mai 2026</td><td style="color:#1b4f72">)</td></tr>
<tr><td>Room</td><td>Garden</td></tr><tr><td>Guests</td><td>12</td></tr><tr><td>Price</td><td>480.00</td></tr>
<tr><td style="color:#1b4f72">Contact person</td><td>Ana Sample</td></tr><tr><td style="color:#1b4f72">#00412</td><td>Main hall</td></tr>
<tr><td style="color:#1b4f72">Venue "Garden"</td><td style="color:#1b4f72">#27315</td></tr>
<tr><td>Please bring your confirmation. We look forward to your visit.</td></tr>
<tr><td style="font-size:9px;color:#999999">Example Venue Ltd, Lake Road 1, 1000 Town</td></tr></table>`;

const OLD = `<div>Dear Ben,</div><div>here is the plan for the workshop on Monday. We start at nine and finish at four.</div><div>Kind regards</div><div>Clara Example</div>`;
const LEAD = `<div>Thanks, Monday works for us. I will send the guest list tomorrow.</div><div>Best</div><div>Ben</div>`;
const outlookBox = (lines: string[]) => `<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal">${lines.join("<br>")}</p></div>`;
/** The forwarded booking mail as a hop: an Outlook Von/Gesendet/An/Betreff block over the template. */
const BOOKING_HOP = outlookBox([
  "<b>Von:</b> Example Venue &lt;venue@example.com&gt;", "<b>Gesendet:</b> Dienstag, 6. Oktober 2026 19:05",
  "<b>An:</b> Clara Example &lt;clara@example.com&gt;", "<b>Betreff:</b> [Venue]: Booking #01234",
]) + TEMPLATE;
const gmailQuote = (attr: string, inner: string) =>
  `<div class="gmail_quote">${attr}<br><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${inner}</blockquote></div>`;
const gmailAttr = (s: string) => `<div dir="ltr" class="gmail_attr">${s}<br></div>`;
const SH_ATTR = `On Thu, Nov 12, 2026 at 09:05:12, Clara Example <span dir="ltr">&lt;<a href="mailto:clara@example.com" target="_blank">clara@example.com</a>&gt;</span> wrote:`;
const OLDER = (deep: string) => `<div>Hello Clara, the garden room is free on that day.</div><div>Regards, Dora</div>${deep}`;

/** Outlook mobile: a reference container with a rule and a Von/Datum block, the quoted letter with no blockquote, then the older quote. */
const outlookMobile = (deep: string) => `<div dir="ltr">${LEAD}</div><div id="ms-outlook-mobile-signature"><div>Outlook for iOS</div></div>
<div id="mail-editor-reference-message-container"><hr style="border-width:1pt medium medium;border-style:solid none none;border-color:rgb(181,196,223) currentcolor currentcolor;padding:3pt 0in 0in;width:98%">
<b>Von: </b>Clara Example &lt;clara@example.com&gt;<br><b>Datum: </b>Freitag, 13. November 2026 um 15:28<br><b>An: </b>Ben Sample &lt;ben@example.com&gt;<br><b>Cc: </b>Dora Test &lt;dora@example.com&gt;<br><b>Betreff: </b>Re: AW: [Venue]: Booking #01234<br>
<div id="mail-editor-reference-message-body">${OLD}
<div class="gmail_quote">On Thu, Nov 12, 2026 at 09:05:12, Dora Test &lt;dora@example.com&gt; wrote:</div><blockquote style="margin: 0px 0px 0px 0.8ex; padding-left: 1ex; border-left: 1px solid rgb(204, 204, 204);">${OLDER(deep)}</blockquote></div></div>`;
const OUTLOOK_MOBILE_TEXT = `Thanks, Monday works for us. I will send the guest list tomorrow.
Best
Ben

Outlook for iOS
________________________________
Von: Clara Example <clara@example.com>
Datum: Freitag, 13. November 2026 um 15:28
An: Ben Sample <ben@example.com>
Cc: Dora Test <dora@example.com>
Betreff: Re: AW: [Venue]: Booking #01234

Dear Ben,
here is the plan for the workshop on Monday. We start at nine and finish at four.
Kind regards
Clara Example

On Thu, Nov 12, 2026 at 09:05:12, Dora Test <dora@example.com> wrote:
Hello Clara, the garden room is free on that day.
Regards, Dora
`;

const outlookDesktop = (head: string[], body: string) =>
  `<div class="WordSection1"><p class="MsoNormal">Thanks, Monday works for us. I will send the guest list tomorrow.</p><p class="MsoNormal">Ben</p><p class="MsoNormal">&nbsp;</p>${outlookBox(head)}<p class="MsoNormal">&nbsp;</p>${body}</div>`;
const DESKTOP_DE = ["<b>Von:</b> Clara Example &lt;clara@example.com&gt;", "<b>Gesendet:</b> Donnerstag, 12. November 2026 09:05",
  "<b>An:</b> Ben Sample &lt;ben@example.com&gt;", "<b>Betreff:</b> WG: Booking"];

const outlookWeb = (head: string[], body: string) =>
  `<div>${LEAD}</div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000">${head.join("<br>")}</font><div>&nbsp;</div></div>${body}`;

const tuta = (attr: string) =>
  `<div>${LEAD}</div><div><br></div><div>${attr}<br></div><blockquote class="tutanota_quote" style="border-left: 1px solid #93A3B8; padding-left: 10px; margin-left: 5px;">${OLD}</blockquote>`;

const TUTA_TEXT = (attr: string) => `Thanks, Monday works for us. I will send the guest list tomorrow.
Best
Ben

${attr}
> Dear Ben,
> here is the plan for the workshop on Monday. We start at nine and finish at four.
> Kind regards
> Clara Example
`;

/** Outlook's text part: the new words, then each hop's Von/Gesendet/An/Betreff block over its letter, the booking mail deepest. */
const OUTLOOK_DE_TEXT = (lead: string) => `${lead}

Von: Clara Example <clara@example.com>
Gesendet: Donnerstag, 12. November 2026 09:05
An: Ben Sample <ben@example.com>
Betreff: WG: Booking

Dear Ben,
here is the plan for the workshop on Monday. We start at nine and finish at four.
Kind regards
Clara Example

Von: Example Venue <venue@example.com>
Gesendet: Dienstag, 6. Oktober 2026 19:05
An: Clara Example <clara@example.com>
Betreff: [Venue]: Booking #01234

We have received your request for the following slot:
(Booking #01234) (4. Mai 2026)
Room Garden
Please bring your confirmation. We look forward to your visit.
`;

/** A Word grid table of questions in the quoted letter, its answer cells in red (or empty), at a canvas-like width. */
const wordGrid = (width: number, answered: boolean) => {
  const cell = (inner: string) => `<td width="${width / 2}" valign="top" style="width:${(width * 0.375).toFixed(1)}pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt"><p class="MsoNormal">${inner}</p></td>`;
  const rows = [["How many guests will come?", "Twelve, all from our team."], ["Do you need a projector?", "Yes, one with a long cable."],
    ["Shall we start at nine?", "Nine works for all of us."]]
    .map(([q, a]) => `<tr>${cell(q!)}${cell(answered ? `<span style="color:red">${a}</span>` : "&nbsp;")}</tr>`).join("");
  return `<table class="MsoTableGrid" border="1" cellspacing="0" cellpadding="0" width="${width}" style="width:${(width * 0.75).toFixed(1)}pt;border-collapse:collapse;border:none">${rows}</table>`;
};
const P = (t: string) => `<p class="MsoNormal">${t}</p>`;
const ASK = P("Hello Ben, please fill in the open points in the table below.");
const CLOSE = P("Thank you very much, I look forward to your answers.") + P("Clara");
/** The quoted letter: a line asking for answers, the table, a closing sentence and a name. */
const wordTable = (width: number, answered: boolean) => ASK + wordGrid(width, answered) + CLOSE;

// ── the formats ────────────────────────────────────────────────────────────────────────────

describe("every reply format folds at its own attribution", () => {
  it("a. Gmail (en)", () => {
    folds(`<div dir="ltr">${LEAD}</div><br>${gmailQuote(gmailAttr(`On Thu, Nov 12, 2026 at 9:05 AM Clara Example &lt;<a href="mailto:clara@example.com">clara@example.com</a>&gt; wrote:`), OLD)}`,
      "Re: Workshop", "On Thu, Nov 12, 2026 at 9:05 AM Clara Example", "Best Ben");
  });

  it("b. Superhuman, seconds and a comma, the booking mail as its deepest hop", () => {
    const h = folds(`<div>${LEAD}</div>${gmailQuote(SH_ATTR, OLD + `<blockquote class="sh-color-black sh-color">${OLDER(BOOKING_HOP)}</blockquote>`)}`,
      "Re: Workshop", "On Thu, Nov 12, 2026 at 09:05:12, Clara Example", "Best Ben");
    expect(h.history).toContain("We look forward to your visit.");
  });

  it("c. Outlook mobile (de) over the booking mail: folds at its Von: block, html and text", () => {
    const html = outlookMobile(BOOKING_HOP);
    const subject = "AW: AW: WG: [Venue]: Booking #01234";
    const h = folds(html, subject, "Von: Clara Example", "Outlook for iOS");
    expect(h.visible).toContain("Thanks, Monday works for us.");
    expect(h.history).toContain("We look forward to your visit.");
    const t = readText(OUTLOOK_MOBILE_TEXT, subject, h.verdict);
    expect(t.at).toBe("trailing");
    expect(t.first).toBe("________________________________");
    expect(t.visible).not.toContain("Dear Ben,");
    expect(t.last).toBe("Outlook for iOS");
  });

  it("d. Outlook mobile (de) with no booking mail below", () => {
    const h = folds(outlookMobile(""), "AW: Workshop", "Von: Clara Example", "Outlook for iOS");
    const t = readText(OUTLOOK_MOBILE_TEXT, "AW: Workshop", h.verdict);
    expect(t.at).toBe("trailing");
    expect(t.first).toBe("________________________________");
    expect(t.last).toBe("Outlook for iOS");
  });

  it("e. Outlook desktop (de) over the booking mail, html and text", () => {
    const h = folds(outlookDesktop(DESKTOP_DE, OLD + BOOKING_HOP), "AW: Workshop", "Von: Clara Example", "Ben");
    const t = readText(OUTLOOK_DE_TEXT("Thanks, Monday works for us. I will send the guest list tomorrow.\nBen"), "AW: Workshop", h.verdict);
    expect(t.at).toBe("trailing");
    expect(t.first).toBe("Von: Clara Example <clara@example.com>");
    expect(t.last).toBe("Ben");
  });

  it("f. Outlook web (en), and (de) over the booking mail", () => {
    folds(outlookWeb(["<b>From:</b> Clara Example &lt;clara@example.com&gt;", "<b>Sent:</b> Thursday, November 12, 2026 9:05 AM",
      "<b>To:</b> Ben Sample &lt;ben@example.com&gt;", "<b>Subject:</b> Workshop"], OLD), "RE: Workshop", "From: Clara Example", "Best Ben");
    const h = folds(outlookWeb(["<b>Von:</b> Clara Example &lt;clara@example.com&gt;", "<b>Gesendet:</b> Donnerstag, 12. November 2026 09:05",
      "<b>An:</b> Ben Sample &lt;ben@example.com&gt;", "<b>Betreff:</b> WG: Booking"], OLD + BOOKING_HOP), "AW: Workshop", "Von: Clara Example", "Best Ben");
    const t = readText(OUTLOOK_DE_TEXT("Thanks, Monday works for us. I will send the guest list tomorrow.\nBest\nBen\n________________________________"), "AW: Workshop", h.verdict);
    expect(t.at).toBe("trailing");
    expect(t.first).toBe("________________________________");
    expect(t.last).toBe("Ben");
  });

  it("g. Apple Mail (en and de), the attribution inside the cite", () => {
    folds(`<div>${LEAD}<div><br><blockquote type="cite"><div>On Nov 12, 2026, at 09:05, Clara Example &lt;clara@example.com&gt; wrote:</div><br class="Apple-interchange-newline"><div>${OLD}</div></blockquote></div></div>`,
      "Re: Workshop", "On Nov 12, 2026, at 09:05, Clara Example", "Best Ben");
    folds(`<div>${LEAD}<div><br><blockquote type="cite"><div>Am 12.11.2026 um 09:05 schrieb Clara Example &lt;clara@example.com&gt;:</div><br class="Apple-interchange-newline"><div>${OLD}</div></blockquote></div></div>`,
      "Re: Workshop", "Am 12.11.2026 um 09:05 schrieb Clara Example", "Best Ben");
  });

  it("h. Thunderbird (de)", () => {
    folds(`${LEAD}<div class="moz-cite-prefix">Am 12.11.26 um 09:05 schrieb Clara Example:<br></div><blockquote type="cite" cite="mid:abc@example.com">${OLD}</blockquote>`,
      "Re: Workshop", "Am 12.11.26 um 09:05 schrieb Clara Example:", "Best Ben");
  });

  it("i. Proton (en)", () => {
    folds(`<div>${LEAD}</div><div class="protonmail_quote">On Thursday, November 12th, 2026 at 09:05, Clara Example &lt;clara@example.com&gt; wrote:<br><blockquote class="protonmail_quote" type="cite">${OLD}</blockquote><br></div>`,
      "Re: Workshop", "On Thursday, November 12th, 2026 at 09:05, Clara Example", "Best Ben");
  });

  it("i. Tuta (en): the fold starts at its reply line, html and text", () => {
    const h = folds(tuta("Nov 12, 2026, 09:05 by clara@example.com:"), "Re: Workshop", "Nov 12, 2026, 09:05 by clara@example.com:", "Best Ben");
    const t = readText(TUTA_TEXT("Nov 12, 2026, 09:05 by clara@example.com:"), "Re: Workshop", h.verdict);
    expect(t.at).toBe("trailing");
    expect(t.first).toBe("Nov 12, 2026, 09:05 by clara@example.com:");
    expect(t.last).toBe("Ben");
  });

  it("i. Tuta (de): the fold starts at its reply line, html and text", () => {
    const h = folds(tuta("12.11.2026, 09:05 von clara@example.com:"), "Re: Workshop", "12.11.2026, 09:05 von clara@example.com:", "Best Ben");
    const t = readText(TUTA_TEXT("12.11.2026, 09:05 von clara@example.com:"), "Re: Workshop", h.verdict);
    expect(t.at).toBe("trailing");
    expect(t.first).toBe("12.11.2026, 09:05 von clara@example.com:");
    expect(t.last).toBe("Ben");
  });

  it("j. Gmail in French, Italian and German", () => {
    folds(`<div dir="ltr">${LEAD}</div><br>${gmailQuote(gmailAttr("Le jeu. 12 nov. 2026 à 09:05, Clara Example &lt;clara@example.com&gt; a écrit&nbsp;:"), OLD)}`,
      "Re: Atelier", "Le jeu. 12 nov. 2026 à 09:05, Clara Example", "Best Ben");
    folds(`<div dir="ltr">${LEAD}</div><br>${gmailQuote(gmailAttr("Il giorno gio 12 nov 2026 alle ore 09:05 Clara Example &lt;clara@example.com&gt; ha scritto:"), OLD)}`,
      "Re: Laboratorio", "Il giorno gio 12 nov 2026 alle ore 09:05 Clara Example", "Best Ben");
    folds(`<div dir="ltr">${LEAD}</div><br>${gmailQuote(gmailAttr("Am Do., 12. Nov. 2026 um 09:05&nbsp;Uhr schrieb Clara Example &lt;clara@example.com&gt;:"), OLD)}`,
      "Re: Workshop", "Am Do., 12. Nov. 2026 um 09:05 Uhr schrieb Clara Example", "Best Ben");
  });

  it("j. Outlook in French and Italian", () => {
    folds(`<div>${LEAD}</div>${outlookBox(["<b>De :</b> Clara Example &lt;clara@example.com&gt;", "<b>Envoyé :</b> jeudi 12 novembre 2026 09:05",
      "<b>À :</b> Ben Sample &lt;ben@example.com&gt;", "<b>Objet :</b> Atelier"])}${OLD}`, "RE: Atelier", "De : Clara Example", "Best Ben");
    folds(`<div>${LEAD}</div>${outlookBox(["<b>Da:</b> Clara Example &lt;clara@example.com&gt;", "<b>Inviato:</b> giovedì 12 novembre 2026 09:05",
      "<b>A:</b> Ben Sample &lt;ben@example.com&gt;", "<b>Oggetto:</b> Laboratorio"])}${OLD}`, "R: Laboratorio", "Da: Clara Example", "Best Ben");
  });
});

describe("a line that only looks like Tuta's reply line is no attribution", () => {
  for (const line of ["Update, 9:30 by team@example.com:", "Call moved, 10:30 de jean@example.com:",
    "Deadline Friday, 17:00 by x@example.com:", "Bitte bis Freitag, 17:00 von anna@example.com:"]) {
    it(`"${line}" stays visible above the folded quote, html and text`, () => {
      const h = folds(tuta(line), "Re: Workshop", "Dear Ben,", line);
      expect(h.history).not.toContain(line);
      const t = readText(TUTA_TEXT(line), "Re: Workshop", h.verdict);
      expect(t.at).toBe("trailing");
      expect(t.first).toBe("> Dear Ben,");
      expect(t.last).toBe(line);
    });
  }
});

describe("forwards keep the forwarded message open", () => {
  it("l. a Gmail forward stays whole", () => {
    const h = staysOpen(`<div dir="ltr">FYI, see below.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <b>Clara Example</b> &lt;clara@example.com&gt;<br>Date: Thu, Nov 12, 2026 at 9:05 AM<br>Subject: Workshop<br>To: Ben Sample &lt;ben@example.com&gt;<br></div><br><br>${OLD}</div>`,
      "Fwd: Workshop");
    expect(h.visible).toContain("We start at nine and finish at four.");
  });

  it("l. an Outlook forward of a reply keeps the forwarded message and folds the hop below it", () => {
    const h = folds(`<div>FYI</div>${outlookBox(["<b>Von:</b> Clara Example &lt;clara@example.com&gt;", "<b>Gesendet:</b> Donnerstag, 12. November 2026 09:05",
      "<b>An:</b> Ben Sample", "<b>Betreff:</b> AW: Workshop"])}${OLD}${outlookBox(["<b>Von:</b> Dora Test &lt;dora@example.com&gt;",
      "<b>Gesendet:</b> Dienstag, 10. November 2026 17:20", "<b>An:</b> Clara Example", "<b>Betreff:</b> Workshop"])}<div>Is Monday fine for the workshop? Please let me know soon.</div><div>Dora</div>`,
      "WG: Workshop", "Von: Dora Test", "Clara Example");
    expect(h.visible).toContain("Von: Clara Example");
    expect(h.visible).toContain("We start at nine and finish at four.");
  });
});

describe("plain text replies", () => {
  it("m. Gmail's '>' lines under its attribution", () => {
    const t = readText("Thanks, Monday works for us.\nBen\n\nOn Thu, Nov 12, 2026 at 9:05 AM Clara Example <clara@example.com> wrote:\n\n> Dear Ben,\n> here is the plan for the workshop on Monday.\n> Kind regards\n> Clara\n",
      "Re: Workshop");
    expect(t.at).toBe("trailing");
    expect(t.first).toBe("On Thu, Nov 12, 2026 at 9:05 AM Clara Example <clara@example.com> wrote:");
    expect(t.last).toBe("Ben");
  });

  it("m. Superhuman's attribution wrapped over two lines", () => {
    const t = readText("Thanks, Monday works for us.\nBen\n\nOn Thu, Nov 12, 2026 at 09:05:12, Clara Example <\nclara@example.com> wrote:\n\n> Dear Ben,\n> here is the plan for the workshop on Monday.\n> Kind regards\n> Clara\n",
      "Re: Workshop");
    expect(t.at).toBe("trailing");
    expect(t.first).toBe("On Thu, Nov 12, 2026 at 09:05:12, Clara Example <");
    expect(t.last).toBe("Ben");
  });
});

describe("answers typed into the history keep it open", () => {
  it("n. a red answer in an Outlook reply's quoted prose, over the booking mail, stays whole, html and text", () => {
    const head = ["<b>Von:</b> Clara Example &lt;clara@example.com&gt;", "<b>Gesendet:</b> Donnerstag, 12. November 2026 09:05",
      "<b>An:</b> Ben Sample &lt;ben@example.com&gt;", "<b>Betreff:</b> Questions about the workshop"];
    const quoted = `<p class="MsoNormal">Hello Ben, please answer the questions below.</p><p class="MsoNormal">Shall we start at nine?</p>`
      + `<p class="MsoNormal" style="color:#ff0000">Yes, nine works well for all of us.</p>`
      + `<p class="MsoNormal">Thank you for the quick answer. I look forward to the day.</p><p class="MsoNormal">Clara</p>`;
    const h = staysOpen(outlookDesktop(head, quoted + BOOKING_HOP), "AW: Questions about the workshop");
    expect(h.visible).toContain("Yes, nine works well for all of us.");
    const text = "Thanks, see my answer in red.\nBen\n\nVon: Clara Example <clara@example.com>\nGesendet: Donnerstag, 12. November 2026 09:05\nAn: Ben Sample <ben@example.com>\nBetreff: Questions about the workshop\n\n"
      + "Hello Ben, please answer the questions below.\nShall we start at nine?\nYes, nine works well for all of us.\nThank you for the quick answer. I look forward to the day.\nClara\n";
    expect(readText(text, "AW: Questions about the workshop", h.verdict).at).toBeNull();
  });
});

describe("answers typed into the cells of a quoted Word table keep it open", () => {
  const head = ["<b>Von:</b> Clara Example &lt;clara@example.com&gt;", "<b>Gesendet:</b> Donnerstag, 12. November 2026 09:05",
    "<b>An:</b> Ben Sample &lt;ben@example.com&gt;", "<b>Betreff:</b> Open points for the workshop"];
  const subject = "AW: Open points for the workshop";
  const text = "Done, all filled in.\nBen\n\nVon: Clara Example <clara@example.com>\nGesendet: Donnerstag, 12. November 2026 09:05\nAn: Ben Sample <ben@example.com>\nBetreff: Open points for the workshop\n\n"
    + "Hello Ben, please fill in the open points in the table below.\nHow many guests will come?\nTwelve, all from our team.\nDo you need a projector?\nYes, one with a long cable.\n"
    + "Shall we start at nine?\nNine works for all of us.\nThank you very much, I look forward to your answers.\nClara\n";

  for (const width of [604, 680]) {
    it(`o. red answers in a ${width} px Word table of an Outlook reply's quoted letter stay whole, html and text`, () => {
      const h = staysOpen(outlookDesktop(head, wordTable(width, true)), subject);
      expect(h.visible).toContain("Twelve, all from our team.");
      expect(readText(text, subject, h.verdict).at).toBeNull();
    });
  }

  it("o. the same table under a Gmail quote stays whole", () => {
    const h = staysOpen(`<div dir="ltr">${LEAD}</div><br>${gmailQuote(gmailAttr("On Thu, Nov 12, 2026 at 9:05 AM Clara Example &lt;clara@example.com&gt; wrote:"), wordTable(604, true))}`, "Re: Open points for the workshop");
    expect(h.visible).toContain("Nine works for all of us.");
  });

  it("o. the same table with its answer cells empty folds", () => {
    folds(outlookDesktop(head, wordTable(604, false)), subject, "Von: Clara Example", "Ben");
  });

  const shortText = "Done, all filled in.\nBen\n\nVon: Clara Example <clara@example.com>\nGesendet: Donnerstag, 12. November 2026 09:05\nAn: Ben Sample <ben@example.com>\nBetreff: Open points for the workshop\n\n"
    + "Hello Ben, please fill in the open points in the table below.\nHow many guests will come?\nTwelve, all from our team.\nDo you need a projector?\nYes, one with a long cable.\n"
    + "Shall we start at nine?\nNine works for all of us.\nThanks!\nClara\n";

  it("o. the table closed by only a short thanks and a name stays whole, html and text", () => {
    const h = staysOpen(outlookDesktop(head, ASK + wordGrid(604, true) + P("Thanks!") + P("Clara")), subject);
    expect(h.visible).toContain("Twelve, all from our team.");
    expect(readText(shortText, subject, h.verdict).at).toBeNull();
  });

  it("o. the table closed by only a name stays whole", () => {
    const h = staysOpen(outlookDesktop(head, ASK + wordGrid(604, true) + P("Clara")), subject);
    expect(h.visible).toContain("Yes, one with a long cable.");
  });

  it("o. the table with no line above it stays whole", () => {
    const h = staysOpen(outlookDesktop(head, wordGrid(604, true) + CLOSE), subject);
    expect(h.visible).toContain("Nine works for all of us.");
  });

  it("o. the short-thanks shape under a Gmail quote stays whole", () => {
    const h = staysOpen(`<div dir="ltr">${LEAD}</div><br>${gmailQuote(gmailAttr("On Thu, Nov 12, 2026 at 9:05 AM Clara Example &lt;clara@example.com&gt; wrote:"), ASK + wordGrid(604, true) + P("Thanks!") + P("Clara"))}`, "Re: Open points for the workshop");
    expect(h.visible).toContain("Twelve, all from our team.");
  });

  // Not held today: a letter wrapped whole in one 600 px cell has the shape of a laid-out mail, so its cells are
  // read as design and the red answers fold. Expected to fail; when it holds, the case turns red and is
  // rewritten as an ordinary one.
  it.fails("o. the whole quoted letter wrapped in one 600 px cell stays whole", () => {
    const h = staysOpen(outlookDesktop(head, `<table width="600" cellpadding="0" cellspacing="0" style="width:600px"><tr><td>${wordTable(604, true)}</td></tr></table>`), subject);
    expect(h.visible).toContain("Twelve, all from our team.");
  });
});
