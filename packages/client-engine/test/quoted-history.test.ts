/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  QUOTED_HISTORY_LIMITS,
  quotedDomTree,
  quotedHistoryCut,
  quotedHistoryOfHtml,
  quotedHistoryOfText,
  quotedHistoryVerdictOfHtml,
  type QuotedDomNode,
} from "../src/quoted-history.js";
import { qhFixtures, qhFolds, qhNorm, type QhFixture } from "./quoted-history-fixtures.js";

/**
 * THE CORPUS DECIDES. Every fixture's sidecar says where the new message ends and the history
 * begins; the detector must agree on both parts — the text part's lines and the html tree — and
 * never hide a line the sidecar calls visible (an inline answer, a signature below the quote).
 */
const FIXTURES = qhFixtures();
const strip = (l: string): string => qhNorm(l.replace(/^[\s>]+/, ""));

function textCase(fx: QhFixture) {
  const lines = fx.text.split("\n");
  const r = quotedHistoryOfText(lines);
  const visible = r === null ? lines : [...lines.slice(0, r.start), ...lines.slice(r.end)];
  return { lines, r, visible: visible.map(strip) };
}

function htmlCase(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body as unknown as QuotedDomNode;
  const r = quotedHistoryOfHtml(root, quotedDomTree);
  const cut = r === null ? { history: [], after: [] } : quotedHistoryCut(root, quotedDomTree, r);
  const historyText = qhNorm(cut.history.map((n) => (n as unknown as Node).textContent ?? "").join(" "));
  for (const n of cut.history) (n as unknown as ChildNode).remove();
  return { doc, r, historyText, visibleText: qhNorm(doc.body.textContent ?? "") };
}

describe("the text part: every fixture's expected range", () => {
  for (const fx of FIXTURES) {
    const t = fx.expect.text;
    if (t === null) continue;
    it(`${fx.name}`, () => {
      const { lines, r, visible } = textCase(fx);
      const e = fx.expect;
      if (!qhFolds(e)) {
        expect(r, "this body must not fold").toBeNull();
      } else {
        expect(r, "this body must fold").not.toBeNull();
        expect(r!.at).toBe(e.fold === "leading" ? "leading" : "trailing");
        const startAt = strip(lines[r!.start]!);
        if (e.fold === "trailing-tail-only") {
          expect(startAt).toBe(strip(e.trailingTail!.startLine));
        } else {
          // The sidecar's first history line, or an introducer just above it.
          const hs = lines.findIndex((l, i) => i >= r!.start && strip(l) === qhNorm(t.historyStartLineNormalized!));
          expect(hs, `history starts at "${startAt}"`).toBeGreaterThanOrEqual(r!.start);
          expect(hs - r!.start).toBeLessThanOrEqual(3);
        }
        if (e.fold === "trailing-before-signature") {
          expect(r!.end).toBeLessThan(lines.length);
          for (const s of t.signatureAfterHistory ?? []) expect(visible).toContain(qhNorm(s));
        } else if (e.fold !== "leading") {
          expect(lines.slice(r!.end).every((l) => l.trim() === ""), "the history runs to the end").toBe(true);
        }
      }
      if (t.visibleFirstLine) expect(visible).toContain(qhNorm(t.visibleFirstLine));
      if (t.visibleLastLine) expect(visible).toContain(qhNorm(t.visibleLastLine));
      for (const a of e.inlineAnswers) expect(visible.join("\n")).toContain(qhNorm(a));
    });
  }
});

describe("the html part: every fixture's expected range", () => {
  for (const fx of FIXTURES) {
    const h = fx.expect.html;
    if (h === null || fx.html === null) continue;
    it(`${fx.name}`, () => {
      const e = fx.expect;
      const before = new DOMParser().parseFromString(fx.html!, "text/html");
      const marked = h.historyStartSelector ? before.querySelector(h.historyStartSelector) : null;
      const { r, historyText, visibleText } = htmlCase(fx.html!);
      if (!qhFolds(e)) {
        expect(r, "this body must not fold").toBeNull();
      } else {
        expect(r, "this body must fold").not.toBeNull();
        expect(r!.at).toBe(e.fold === "leading" ? "leading" : "trailing");
        expect(marked, "the sidecar's selector").not.toBeNull();
        const opening = qhNorm(h.attributionBefore ?? h.historyStartText!);
        expect(historyText.startsWith(opening) || historyText.startsWith(qhNorm(h.historyStartText!)),
          `history starts "${historyText.slice(0, 80)}"`).toBe(true);
        expect(visibleText).not.toContain(qhNorm(h.historyStartText!));
      }
      if (h.visibleFirstText) expect(visibleText).toContain(qhNorm(h.visibleFirstText));
      if (h.visibleLastText) expect(visibleText).toContain(qhNorm(h.visibleLastText));
      for (const s of h.signatureAfterHistory ?? []) expect(visibleText).toContain(qhNorm(s));
      for (const a of e.inlineAnswers) expect(visibleText).toContain(qhNorm(a));
    });
  }
});

const fixture = (id: string): QhFixture => FIXTURES.find((f) => f.id === id)!;

describe("each guard is what keeps its fixture open", () => {
  it("the Subject rule: a ticket or invoice with a Subject line added reads as a header block", () => {
    expect(quotedHistoryOfText(fixture("66").text.split("\n"))).toBeNull();
    expect(quotedHistoryOfText(fixture("67").text.split("\n"))).toBeNull();
    const ticket = fixture("66").text.replace("Datum:", "Betreff: Reise\nDatum:");
    expect(quotedHistoryOfText(ticket.split("\n"))).not.toBeNull();
  });

  it("the announcement: 71 and 55 fold once the lead stops saying where the answers are", () => {
    const t71 = fixture("71").text;
    expect(quotedHistoryOfText(t71.split("\n"))).toBeNull();
    const bare71 = t71.replace("my comments are at the end.", "see below.").replace("Comments:\n", "");
    expect(quotedHistoryOfText(bare71.split("\n"))).not.toBeNull();
    const t55 = fixture("55").text;
    expect(quotedHistoryOfText(t55.split("\n"))).toBeNull();
    const plain55 = t55.replace("meine Antworten finden Sie unten in Blau.", "danke.");
    expect(quotedHistoryOfText(plain55.replace(/\[AE\] /g, "").split("\n"))).not.toBeNull();
  });

  it("the answer prefix: 55's text stays open on its [AE] answers alone", () => {
    const plain55 = fixture("55").text.replace("meine Antworten finden Sie unten in Blau.", "danke für die Fragen.");
    expect(quotedHistoryOfText(plain55.split("\n"))).toBeNull();
  });

  it("'siehe unten' and 'Details below' alone still fold", () => {
    const t = fixture("71").text.replace("Comments:\n", "");
    expect(quotedHistoryOfText(t.replace("my comments are at the end.", "Details below.").split("\n"))).not.toBeNull();
    expect(quotedHistoryOfText(t.replace("my comments are at the end.", "siehe unten.").split("\n"))).not.toBeNull();
  });

  it("the colour guard: 73 folds once its answers are in the body's own ink", () => {
    expect(htmlCase(fixture("73").html!).r).toBeNull();
    expect(htmlCase(fixture("73").html!.replace(/#0070C0/g, "#595959").replace(/<\/?b>/g, "")).r).not.toBeNull();
    // An earlier lead in Outlook's own blue is that message's body, not an answer.
    expect(htmlCase(fixture("74").html!).r).not.toBeNull();
  });

  it("the designed gate: 68's header card folds once the layout is a letter", () => {
    expect(htmlCase(fixture("68").html!).r).toBeNull();
    const flat = fixture("68").html!.replace(/<\/?table[^>]*>|<\/?tr[^>]*>|<\/?td[^>]*>/g, "");
    expect(htmlCase(flat).r).not.toBeNull();
  });

  it("trailing empty nodes are transparent: an Apple quote with breaks after it still folds", () => {
    const apple = fixture("24").html!.replace("</body>", "<br><div><br></div><p>&nbsp;</p></body>");
    const { r } = htmlCase(apple);
    expect(r).not.toBeNull();
    expect(r!.end).toBeNull();
  });

  it("the signature end: 47's history stops before the signature below it", () => {
    const lines = fixture("47").text.split("\n");
    const r = quotedHistoryOfText(lines)!;
    expect(lines.slice(r.end).some((l) => l.trim() === "--")).toBe(true);
    expect(lines.slice(r.end).map(strip)).toContain("David Placeholder");
  });

  it("the interleave rule: '>' depth returning to prose keeps the quote; only an unanswered tail folds", () => {
    expect(quotedHistoryOfText(fixture("53").text.split("\n"))).toBeNull();
    const lines = fixture("54").text.split("\n");
    const r = quotedHistoryOfText(lines)!;
    for (const a of fixture("54").expect.inlineAnswers) expect(lines.slice(0, r.start).join("\n")).toContain(a);
  });

  it("a bare forward never folds, and neither does prose that says someone wrote", () => {
    for (const id of ["20", "27", "69", "70", "72"]) {
      expect(quotedHistoryOfText(fixture(id).text.split("\n")), id).toBeNull();
      if (fixture(id).html) expect(htmlCase(fixture(id).html!).r, id).toBeNull();
    }
  });

  it("a forward with a note shows its forwarded message whole; a reply quoting that forward folds", () => {
    for (const id of ["19", "26", "32", "86"]) {
      expect(quotedHistoryOfText(fixture(id).text.split("\n")), id).toBeNull();
      expect(htmlCase(fixture(id).html!).r, id).toBeNull();
      expect(quotedHistoryVerdictOfHtml(new DOMParser().parseFromString(fixture(id).html!, "text/html").body as unknown as QuotedDomNode, quotedDomTree), id).toBeNull();
    }
    expect(htmlCase(fixture("86").html!).visibleText).toContain("you are invited to the regional crafts fair");
    // The forward's wording is what keeps it open: the same block under a reply's separator folds.
    const asReply = (s: string): string => s.replace("---------- Forwarded message ---------", "-----Original Message-----");
    expect(quotedHistoryOfText(asReply(fixture("86").text).split("\n"))).not.toBeNull();
    expect(htmlCase(asReply(fixture("86").html!)).r).not.toBeNull();
    const reply = htmlCase(fixture("123").html!);
    expect(reply.r).not.toBeNull();
    expect(reply.visibleText).not.toContain("Forwarded message");
    expect(quotedHistoryOfText(fixture("123").text.split("\n"))).not.toBeNull();
  });

  it("a bottom-posted reply folds the quote at the top and leaves the reply whole", () => {
    const lines = fixture("31").text.split("\n");
    const r = quotedHistoryOfText(lines)!;
    expect(r.at).toBe("leading");
    expect(lines.slice(r.end).join("\n")).toContain("Hallo Frau Example,");
  });
});

describe("bounded", () => {
  it("past the line or character budget nothing is read", () => {
    const tooMany = Array.from({ length: QUOTED_HISTORY_LIMITS.lines + 1 }, () => "> x");
    expect(quotedHistoryOfText(["Hi", "", ...tooMany])).toBeNull();
    expect(quotedHistoryOfText(["Hi", "", `> ${"y".repeat(QUOTED_HISTORY_LIMITS.chars)}`])).toBeNull();
  });

  it("past the node budget the tree is not read", () => {
    const html = `<p>Hi</p>${"<span>a</span>".repeat(QUOTED_HISTORY_LIMITS.nodes)}<blockquote>old</blockquote>`;
    expect(htmlCase(html).r).toBeNull();
  });

  it("32,000 hostile attribution and label lines are read in one linear pass", { timeout: 2000 }, () => {
    const hostile: string[] = ["Hi"];
    for (let i = 0; i < 8000; i++) hostile.push(`On ${i} Mon, ${"x ".repeat(60)} wrote:`, "Von: a@example.com", "> q", "answer");
    const t0 = Date.now();
    quotedHistoryOfText(hostile);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("4,000 container runs between label lines are read in one linear pass", { timeout: 4000 }, () => {
    const html = `<p>Hello there, a short note.</p>${'<div class="gmail_quote">From: a1:</div><div>From: a1:</div>'.repeat(4000)}`;
    const root = domOf(html);
    const t0 = Date.now();
    quotedHistoryOfHtml(root, quotedDomTree);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

const domOf = (html: string): QuotedDomNode => new DOMParser().parseFromString(html, "text/html").body as unknown as QuotedDomNode;
const verdictOf = (html: string) => quotedHistoryVerdictOfHtml(domOf(html), quotedDomTree);
const foldText = (text: string, html?: Parameters<typeof quotedHistoryOfText>[1]) => quotedHistoryOfText(text.split("\n"), html);
const visibleOf = (text: string, r: { start: number; end: number } | null): string => {
  const lines = text.split("\n");
  return (r === null ? lines : [...lines.slice(0, r.start), ...lines.slice(r.end)]).join("\n");
};

describe("the html part's verdict holds its text part", () => {
  it("68 and 73: the stored text of an html-only mail stays whole once its html says no", () => {
    // 73: a guard (answers in another ink) says no; 68: the designed gate found nothing, so only '>' runs may fold.
    expect(verdictOf(fixture("73").html!)).toBeNull();
    expect(verdictOf(fixture("68").html!)).toBe("unread");
    for (const id of ["68", "73"]) {
      const fx = fixture(id);
      expect(foldText(fx.text, { html: verdictOf(fx.html!) }), id).toBeNull();
    }
    // 73's text alone has no colour to read; 68's lead ends in a sentence, a paste on its own.
    expect(foldText(fixture("73").text), "73 folds on its text alone").not.toBeNull();
    expect(foldText(fixture("68").text)).toBeNull();
  });

  it("every fixture: the text folds only where its html folds, at the same kind", () => {
    for (const fx of FIXTURES) {
      if (fx.html === null) continue;
      const v = verdictOf(fx.html);
      const r = foldText(fx.text, { html: v });
      if (v === null) expect(r, fx.name).toBeNull();
      else if (r !== null && v !== "unread") expect(r.at, fx.name).toBe(v);
      // A phone member reads the text part: where the html folds, so does it.
      if (v !== null && qhFolds(fx.expect) && fx.expect.text !== null) expect(r, `${fx.name} folds as a member`).not.toBeNull();
      for (const a of fx.expect.inlineAnswers) expect(visibleOf(fx.text, r), fx.name).toContain(a.replace(/^\[AE\] /, ""));
    }
  });

  it("a multipart Outlook reply whose lead names no answers: its html's no keeps the text whole", () => {
    const fx = fixture("55");
    const html = fx.html!.replace("meine Antworten finden Sie unten in Blau.", "danke für die Fragen.");
    const text = fx.text.replace("meine Antworten finden Sie unten in Blau.", "danke für die Fragen.").replace(/\[AE\] /g, "");
    expect(verdictOf(html)).toBeNull();
    expect(foldText(text, { html: verdictOf(html) })).toBeNull();
  });

  it("104: a note ending in ':' over a marked Outlook block folds its text once the html vouches", () => {
    const fx = fixture("104");
    expect(foldText(fx.text), "alone, a colon above a bare block is a paste").toBeNull();
    expect(verdictOf(fx.html!)).toBe("trailing");
    const r = foldText(fx.text, { html: "trailing" });
    expect(r).not.toBeNull();
    expect(fx.text.split("\n")[r!.start]).toMatch(/^Von: Ana Example/);
  });

  it("a part the html reading refused: only '>' runs fold", () => {
    expect(foldText(fixture("73").text, { html: "unread" })).toBeNull();
    expect(foldText(fixture("37").text, { html: "unread" })).toBeNull();
    expect(foldText(fixture("54").text, { html: "unread" })).not.toBeNull();
    expect(foldText(fixture("13").text, { html: "unread" })).not.toBeNull();
    const big = `<p>Hi</p>${"<span>a</span>".repeat(QUOTED_HISTORY_LIMITS.nodes)}<blockquote>old</blockquote>`;
    expect(verdictOf(big)).toBe("unread");
    expect(verdictOf(fixture("01").html!)).toBe("trailing");
  });

  it("an html part that finds no history, no guard saying no: its text folds only '>' runs", () => {
    const html = '<table width="600"><tr><td><p>Hi Ben,</p><p>Thanks, Tuesday works.</p></td></tr></table>';
    expect(verdictOf(html)).toBe("unread");
    const text = "Hi Ben,\n\nThanks, Tuesday works.\n\nOn Thu, 22 Oct 2026 at 09:14, Ben Sample <ben@example.org> wrote:\n> Does Tuesday work?";
    expect(foldText(text, { html: verdictOf(html) })).not.toBeNull();
    expect(foldText(fixture("37").text, { html: verdictOf(html) })).toBeNull();
  });

  it("a nested-table signature is no designed layout: 111 and 109 fold on both parts", () => {
    for (const id of ["109", "111"]) {
      const fx = fixture(id);
      expect(verdictOf(fx.html!), id).toBe("trailing");
      expect(foldText(fx.text, { html: verdictOf(fx.html!) }), id).not.toBeNull();
    }
  });

  it("a responsive newsletter with a header card is a designed layout without being told", () => {
    const html = '<div style="max-width:600px;margin:0 auto"><h1>Example Weekly</h1><p>This week: how teams answer mail faster.</p>'
      + "<p>From: Support Desk &lt;desk@example.com&gt;<br>Sent: Monday, October 19, 2026 9:00 AM<br>To: A Customer &lt;c@example.org&gt;<br>"
      + "Subject: Your ticket is solved</p><p>A reply card like this one is what our builder draws.</p><p>Read more on our blog.</p></div>";
    expect(htmlCase(html).r).toBeNull();
    expect(verdictOf(html), "no history found: the text folds only '>' runs").toBe("unread");
    expect(verdictOf(html.replace("max-width:600px;", "").replace("faster.</p>", "faster.</p><p>The Example team</p>"))).toBe("trailing");
  });
});

describe("the colour guard reads the history's own ink", () => {
  const blue = (html: string): string => {
    let s = html;
    for (const line of ["Hallo Frau Example,", "drei Punkte vor der Begehung:", "1. Ist die Filterreinigung im Angebot enthalten?",
      "2. Brauchen Ihre Techniker einen Schlüssel für den Technikraum?"]) s = s.replace(`>${line}<`, `><span style="color:#1F497D">${line}</span><`);
    return s;
  };
  const answers = ["Ja, die Filterreinigung ist Position 3 im Angebot.", "Ja, bitte am Empfang hinterlegen."];
  const visible = (html: string): string => htmlCase(html).visibleText;

  it("answers in red under a history written in Outlook blue stay open", () => {
    const html = blue(fixture("73").html!).replace(/#0070C0/g, "#C00000");
    for (const a of answers) expect(visible(html)).toContain(a);
    expect(htmlCase(html).r).toBeNull();
  });

  it("answers marked by a highlight in the body's own ink stay open", () => {
    const yellow = fixture("73").html!.replace(/<b><span style="color:#0070C0">/g, '<span style="background:yellow;mso-highlight:yellow">').replace(/<\/span><\/b>/g, "</span>");
    expect(htmlCase(yellow).r).toBeNull();
    const fill = fixture("73").html!.replace(/<b><span style="color:#0070C0">/g, '<span style="background-color:#FFFF00">').replace(/<\/span><\/b>/g, "</span>");
    expect(htmlCase(fill).r).toBeNull();
  });

  it("red answers prefixed 'A:' are answers, not a To line", () => {
    const html = fixture("73").html!.replace(/#0070C0/g, "#C00000").replace(/>Ja, /g, ">A: Ja, ");
    expect(htmlCase(html).r).toBeNull();
    for (const a of answers) expect(visible(html)).toContain(`A: ${a}`);
  });

  it("control: 74's earlier lead in Outlook blue still folds", () => {
    expect(htmlCase(fixture("74").html!).r).not.toBeNull();
  });

  it("one red heading over prose is emphasis: 107 folds; under a question, or with a second, it is an answer", () => {
    const html = fixture("107").html!;
    expect(htmlCase(html).r).not.toBeNull();
    const asked = html.replace("Bonjour Hugo,", "Bonjour Hugo, est-ce urgent ?");
    expect(htmlCase(asked).r, "under a question").toBeNull();
    expect(htmlCase(asked).visibleText).toContain("URGENT");
    const two = html.replace("production de décembre.<o:p></o:p></p>",
      'production de décembre.<o:p></o:p></p><p class="MsoNormal"><span style="color:#C00000">5 000 CHF</span></p>');
    expect(htmlCase(two).r, "two such lines").toBeNull();
    expect(htmlCase(two).visibleText).toContain("5 000 CHF");
  });
});

describe("an announcement in the lead reads every common wording", () => {
  const outlook = (lead: string): string => ["Hi Ben,", "", lead, "", "Ana", "", "From: Ben Sample <ben.sample@example.org>",
    "Sent: Wednesday, October 21, 2026 9:12 AM", "To: Ana Example <ana.example@example.com>", "Subject: Site visit", "", "Hi Ana,", "",
    "1. Is the filter cleaning included?", "Yes, it is item 3.", "", "2. Do your technicians need a key?", "Yes, please leave it at the desk.",
    "", "Best regards,", "Ben"].join("\n");
  for (const lead of ["See inline.", "Please see inline.", "Answered inline.", "Replied inline.", "Siehe im Text.", "Inline beantwortet.",
    "Voir dans le texte.", "Vedi nel testo.", "Ver en el texto.", "Zie in de tekst.", "I answered below."]) {
    it(`"${lead}" keeps the answers open`, () => {
      expect(foldText(outlook(lead))).toBeNull();
    });
  }
  it("control: 'siehe unten.' and 'Details below.' still fold", () => {
    expect(foldText(outlook("siehe unten."))).not.toBeNull();
    expect(foldText(outlook("Details below."))).not.toBeNull();
  });
  it("'I pasted the photo inline.' names no answers: 14, 24, 28, 30 and 33 still fold", () => {
    for (const id of ["14", "24", "28", "30", "33"]) {
      const fx = fixture(id);
      const first = fx.text.split("\n").find((l) => l.trim().length > 20)!;
      const lead = "I pasted the photo inline.";
      expect(foldText(fx.text.replace(first, lead)), id).not.toBeNull();
      expect(htmlCase(fx.html!.replace(first, lead)).r, id).not.toBeNull();
    }
  });
  it("on the html path too", () => {
    const html = (lead: string) => `<p>Hi Ben,</p><p>${lead}</p><p>Ana</p><div style="border:none;border-top:solid #E1E1E1 1.0pt">`
      + "<p><b>From:</b> Ben Sample &lt;ben@example.org&gt;<br><b>Sent:</b> Wednesday, October 21, 2026 9:12 AM<br>"
      + "<b>To:</b> Ana Example<br><b>Subject:</b> Site visit</p></div><p>Hi Ana,</p><p>1. Is the filter cleaning included?</p>"
      + "<p>AE: Yes, it is item 3.</p><p>Best regards,</p><p>Ben</p>";
    expect(htmlCase(html("See inline.")).r).toBeNull();
    expect(htmlCase(html("Thanks.")).r).not.toBeNull();
  });
});

describe("a pasted mail or a memo is the writer's letter, not history", () => {
  const paste = ["Hi Tom,", "the supplier sent this yesterday:", "From: Bob Supplier <bob@example.com>", "Sent: Tuesday, October 20, 2026 4:12 PM",
    "To: Dave Example <dave@example.org>", "Subject: Price change", "", "Prices go up 5% from 1 December.", "",
    "I think we should push back. Can you call them tomorrow and ask for a 2% cap?", "", "Thanks, Dave"].join("\n");
  const memo = ["Hi all,", "please read the memo below before Friday.", "", "MEMORANDUM", "To: All staff", "From: Jane Example, HR Director",
    "Date: October 20, 2026", "Subject: Holiday schedule", "", "The office closes from 24 December to 2 January.", "", "Jane"].join("\n");
  const asHtml = (text: string): string => text.split("\n").map((l) => `<div>${l === "" ? "<br>" : l.replace(/</g, "&lt;")}</div>`).join("");

  it("a paste the lead introduces with a colon stays whole, as text and as html", () => {
    expect(foldText(paste)).toBeNull();
    expect(htmlCase(asHtml(paste)).r).toBeNull();
  });

  it("a memo whose label run opens with To stays whole", () => {
    expect(foldText(memo)).toBeNull();
    expect(htmlCase(asHtml(memo)).r).toBeNull();
  });

  it("comments under a pasted message stay open, whatever the lead says", () => {
    expect(foldText(fixture("71").text.replace("my comments are at the end.", "see below."))).toBeNull();
    const greeted = `Hi Ana,\n\n${fixture("70").text}`;
    expect(foldText(greeted)).toBeNull();
  });

  it("control: a reply over an Outlook header block still folds", () => {
    expect(foldText(paste.replace("the supplier sent this yesterday:", "Best, Dave"))).not.toBeNull();
  });
});

describe("a wrapped attribution is one line wrapped, never the writer's sentence above it", () => {
  for (const [lead, says] of [
    ["On the call at 3pm Bob said he would send the numbers today.", "This is what he wrote:"],
    ["On the call at 3pm Bob said he would send the numbers for today", "so here is what he wrote:"],
    ["Le client a confirmé la commande de 3 palettes hier soir.", "Voici ce que Marie a écrit :"],
  ]) {
    it(lead, () => {
      const text = ["Hi Anna,", lead!, says!, "> Numbers follow on Friday.", "> Bob"].join("\n");
      const r = foldText(text)!;
      expect(r).not.toBeNull();
      expect(visibleOf(text, r)).toContain(lead!);
    });
  }
  it("control: 52's attribution wrapped at its address still folds whole", () => {
    const lines = fixture("52").text.split("\n");
    const r = quotedHistoryOfText(lines)!;
    expect(lines[r.start]).toMatch(/^On Sat, Oct 10, 2026/);
  });
});

describe("a label-shaped line of the new text stays the writer's", () => {
  it("an 'A:' answer above the attribution", () => {
    const text = "Hi Ben,\n\nQ: Does the price include VAT?\nA: Yes, 8.1 %.\n\nOn Thu, 22 Oct 2026 at 09:14, Ben Sample <ben@example.org> wrote:\n> Does the price include VAT?\n> Ben";
    const r = foldText(text);
    expect(r).not.toBeNull();
    expect(visibleOf(text, r)).toContain("A: Yes, 8.1 %.");
  });
  it("an Attachments line above the attribution", () => {
    const text = "Hi Ben,\n\nthe signed offer is attached.\nAttachments: offer-signed.pdf\n\nOn Thu, 22 Oct 2026 at 09:14, Ben Sample <ben@example.org> wrote:\n> Please sign the offer.";
    expect(visibleOf(text, foldText(text))).toContain("Attachments: offer-signed.pdf");
  });
  it("the last 'A:' answer of an interleaved reply above the original's quoted sign-off", () => {
    const text = "Hi Ben,\n\n> Can we meet Monday?\nA: Monday works, before noon.\n> Thanks,\n> Ben";
    expect(visibleOf(text, foldText(text))).toContain("A: Monday works, before noon.");
  });
});

describe("a footer or a tracking pixel after the quote ends the history", () => {
  const disclaimer = '<p style="font-size:8pt;color:#808080">Diese E-Mail ist vertraulich. Wenn Sie nicht der richtige Adressat sind, informieren Sie bitte den Absender.</p>';
  const appended = (html: string, tail: string): string => (html.includes("</body>") ? html.replace("</body>", `${tail}</body>`) : html + tail);
  for (const id of ["28", "14", "23", "30"]) {
    it(`${id} with an appended disclaimer folds, the disclaimer visible`, () => {
      const html = appended(fixture(id).html!, disclaimer);
      const { r, visibleText } = htmlCase(html);
      expect(r).not.toBeNull();
      expect(visibleText).toContain("Diese E-Mail ist vertraulich.");
    });
    it(`${id} with a trailing 1×1 pixel folds`, () => {
      expect(htmlCase(appended(fixture(id).html!, '<img src="https://t.example.com/o.gif" width="1" height="1">')).r).not.toBeNull();
      expect(htmlCase(appended(fixture(id).html!, '<div><img src="https://t.example.com/o.gif" width="0" height="0"></div>')).r).not.toBeNull();
    });
  }
  it("a Gmail reply with a CONFIDENTIALITY paragraph keeps it visible", () => {
    const html = appended(fixture("14").html!, "<div>CONFIDENTIALITY: this message is for its addressee only.</div>");
    const { r, visibleText } = htmlCase(html);
    expect(r).not.toBeNull();
    expect(visibleText).toContain("CONFIDENTIALITY");
  });
  it("the text part with a trailing disclaimer paragraph folds before it", () => {
    const text = `${fixture("28").text}\n\nThis e-mail is confidential. If you received it in error, tell the sender.`;
    const r = foldText(text);
    expect(r).not.toBeNull();
    expect(visibleOf(text, r)).toContain("This e-mail is confidential.");
  });
  it("an answer under the quote is never part of a footer, even above a registration line", () => {
    const text = "Hi Elif,\n\nOn Wed, Oct 21, 2026 at 04:12:00PM +0200, Elif Testa wrote:\n> Can your trucks make the 7am slot?\n\n"
      + "Yes, the first truck can be there at 7:15.\n\n--\nDavid Placeholder\nBrightwater Samples Ltd, registered in England and Wales";
    expect(foldText(text)).toBeNull();
  });
  it("control: a reply after the quote is still not a footer", () => {
    expect(htmlCase(appended(fixture("28").html!, "<p>One more thing: the truck comes at 7 on Monday, please have the dock clear.</p>")).r).toBeNull();
  });
});
