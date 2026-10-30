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
import { qhFixtures, qhFolds, qhHostileBodies, qhNorm, qhTypedAnswers, type QhFixture } from "./quoted-history-fixtures.js";

/**
 * THE CORPUS DECIDES. Every fixture's sidecar says where the new message ends and the history
 * begins; the detector must agree on both parts — the text part's lines and the html tree — and
 * never hide a line the sidecar calls visible (an inline answer, a signature below the quote).
 */
const FIXTURES = qhFixtures();
const strip = (l: string): string => qhNorm(l.replace(/^[\s>]+/, ""));

function textCase(fx: QhFixture) {
  const lines = fx.text.split("\n");
  const r = quotedHistoryOfText(lines, { subject: fx.subject });
  const visible = r === null ? lines : [...lines.slice(0, r.start), ...lines.slice(r.end)];
  return { lines, r, visible: visible.map(strip) };
}

function htmlCase(html: string, subject?: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body as unknown as QuotedDomNode;
  const r = quotedHistoryOfHtml(root, quotedDomTree, { subject });
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
      const { r, historyText, visibleText } = htmlCase(fx.html!, fx.subject);
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

  it("a forward's subject keeps what it forwards open, in every client's prefix; a reply's does not", () => {
    const lines = fixture("11").text.split("\n");
    const at = (subject: string): string | undefined => {
      const r = quotedHistoryOfText(lines, { subject });
      return r === null ? undefined : lines[r.start + 1];
    };
    for (const p of ["WG: AW:", "Fwd:", "FW:", "Fw :", "TR:", "I:", "RV:", "Doorst:", "[EXTERN] WG:"]) {
      expect(at(`${p} Wartung`), p).toBe("Von: Ana Example <ana.example@example.com>");
    }
    for (const p of ["AW: WG:", "Re: FW:", "Wartung", ""]) expect(at(`${p} Wartung`), p).toBe("Von: Ben Sample <ben.sample@example.org>");
    // The html reads the same hint: 11 folds at its second hop with it, at its first without.
    expect(htmlCase(fixture("11").html!, fixture("11").subject).historyText).toMatch(/^Von: Ana Example/);
    expect(htmlCase(fixture("11").html!).historyText).toMatch(/^Von: Ben Sample/);
  });

  it("a forward of one message folds nothing; a forward with nothing typed folds only below what it forwards", () => {
    expect(htmlCase(fixture("104").html!, "WG: Wartung").r).toBeNull();
    expect(verdictOf(fixture("104").html!, "WG: Wartung")).toBeNull();
    const bare = fixture("11").text.split("\n").slice(8);
    expect(quotedHistoryOfText(bare), "no hint: a bare block is nobody's words").toBeNull();
    const r = quotedHistoryOfText(bare, { subject: "WG: Wartung" })!;
    expect(bare.slice(0, r.start).join("\n")).toContain("vielen Dank für das Angebot.");
    expect(bare[r.start + 1]).toBe("Von: Ana Example <ana.example@example.com>");
  });

  it("a forward's introducer alone keeps the forwarded message open and folds the thread below it", () => {
    const nested = "\n\nOn Wed, 21 Oct 2026 at 10:00, Dana Example <dana@example.net> wrote:\n> Is the fair open on Sunday?\n> Dana";
    const text = fixture("86").text.replace(/\n*$/, nested);
    const r = foldText(text)!;
    expect(r).not.toBeNull();
    expect(visibleOf(text, r)).toContain("you are invited to the regional crafts fair");
    expect(visibleOf(text, r)).not.toContain("Is the fair open on Sunday?");
    // Answers in the hop below stay open: nothing folds.
    expect(foldText(text.replace("> Dana", "Yes, from 10:00.\n> Dana"))).toBeNull();
  });

  it("a forward of a forward keeps open what the inner forward delivers; a reply's hop below it still folds", () => {
    const fx = fixture("130");
    const at = (text: string, subject = fx.subject): string | undefined => {
      const lines = text.split("\n");
      const r = quotedHistoryOfText(lines, { subject });
      return r === null ? undefined : lines[r.start];
    };
    expect(at(fx.text)).toBe("Von: Ben Sample <ben.sample@example.org>");
    // The kept hop's own Betreff decides: an AW: there makes the invoice the history.
    expect(at(fx.text.replace("Betreff: WG: Rechnung", "Betreff: AW: Rechnung"), "WG: AW: Rechnung 4711")).toBe("Von: Ana Example <ana.example@example.com>");
    // A forward the invoice answers is history like any other hop.
    expect(at(fx.text.replace("Betreff: Rechnung 4711", "Betreff: WG: Rechnung 4711"))).toBe("Von: Ben Sample <ben.sample@example.org>");
    // With nothing below the delivered letter, nothing folds.
    expect(at(fx.text.slice(0, fx.text.indexOf("\nVon: Ben Sample")))).toBeUndefined();
    expect(htmlCase(fx.html!, fx.subject).historyText).toMatch(/^Von: Ben Sample/);
    // An introducer alone says the same, with no subject: Apple Mail's and Gmail's.
    expect(foldText(fixture("128").text)).toBeNull();
    expect(htmlCase(fixture("128").html!).r).toBeNull();
    expect(strip(fixture("129").text.split("\n")[foldText(fixture("129").text)!.start]!)).toMatch(/^On Fri, 23 Oct 2026/);
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

  it("32,000 hostile attribution and label lines are read in one linear pass", { timeout: 4000 }, () => {
    const hostile: string[] = ["Hi"];
    for (let i = 0; i < 8000; i++) hostile.push(`On ${i} Mon, ${"x ".repeat(60)} wrote:`, "Von: a@example.com", "> q", "answer");
    const t0 = Date.now();
    quotedHistoryOfText(hostile);
    expect(Date.now() - t0).toBeLessThan(1500);
    const t1 = Date.now();
    quotedHistoryOfText(hostile, { subject: "Fwd: x" });
    expect(Date.now() - t1, "as a forward").toBeLessThan(1500);
  });

  it("4,000 container runs between label lines are read in one linear pass", { timeout: 4000 }, () => {
    const html = `<p>Hello there, a short note.</p>${'<div class="gmail_quote">From: a1:</div><div>From: a1:</div>'.repeat(4000)}`;
    const root = domOf(html);
    const t0 = Date.now();
    quotedHistoryOfHtml(root, quotedDomTree);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("2,600 quote boxes and answers under a header block are read in one linear pass", { timeout: 4000 }, () => {
    const html = '<p>Hi Ben, thanks.</p><div style="border:none;border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> Ben &lt;ben@example.org&gt;<br>'
      + "<b>Sent:</b> Monday, October 19, 2026 9:00 AM<br><b>To:</b> Ana<br><b>Subject:</b> Visit</p></div><p>Hi Ana,</p>"
      + '<blockquote><p style="color:#C00000">Is the plan ready?</p></blockquote><p>It is ready and in the folder.</p>'.repeat(2600);
    const root = domOf(html);
    const t0 = Date.now();
    expect(quotedHistoryOfHtml(root, quotedDomTree)).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  for (const b of qhHostileBodies()) {
    it(`${b.name}: one linear pass`, { timeout: 4000 }, () => {
      const root = domOf(b.html);
      const t0 = Date.now();
      const v = quotedHistoryVerdictOfHtml(root, quotedDomTree);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(v, "read to a verdict, within the budget").not.toBe("unread");
    });
  }
});

const domOf = (html: string): QuotedDomNode => new DOMParser().parseFromString(html, "text/html").body as unknown as QuotedDomNode;
const verdictOf = (html: string, subject?: string) => quotedHistoryVerdictOfHtml(domOf(html), quotedDomTree, { subject });
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
      const v = verdictOf(fx.html, fx.subject);
      const r = foldText(fx.text, { html: v, subject: fx.subject });
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

describe("answers marked with the writer's initials or name, in the body's own ink", () => {
  const both = (html: string, text: string) => {
    const v = verdictOf(html);
    return { v, html: htmlCase(html).r, text: foldText(text), held: foldText(text, { html: v }) };
  };
  const named = (s: string): string => s.replace(/\[AE\] /g, "[Ana Example] ");

  it("124: black '[AE] ' answers keep the html and the text open", () => {
    const fx = fixture("124");
    expect(both(fx.html!, fx.text)).toEqual({ v: null, html: null, text: null, held: null });
  });

  it("124 with '[Ana Example] ' answers stays open on both parts", () => {
    const fx = fixture("124");
    expect(both(named(fx.html!), named(fx.text))).toEqual({ v: null, html: null, text: null, held: null });
  });

  it("an '[EXTERNAL]' banner and '[cid:...]' placeholders in the history still fold", () => {
    const fx = fixture("124");
    const html = fx.html!.replace(/<b><i>\[AE\] <\/i><\/b>/g, "")
      .replace("<p class=\"MsoNormal\">Hi Ana,", "<p class=\"MsoNormal\">[EXTERNAL] This message comes from outside the organisation.</p><p class=\"MsoNormal\">Hi Ana,")
      .replace("Ben Sample<o:p></o:p></p></div>", "Ben Sample<o:p></o:p></p><p class=\"MsoNormal\">[cid:image001.png] [cid:image002.png]</p><p class=\"MsoNormal\">[cid:image001.png] Example Works</p><p class=\"MsoNormal\">[Example Works logo] Example Works AG</p><p class=\"MsoNormal\">Musterstrasse 1, 8000 Zürich</p></div>");
    const text = fx.text.replace(/\[AE\] /g, "").replace("\nHi Ana,", "\n[EXTERNAL] This message comes from outside the organisation.\nHi Ana,")
      .replace(/Ben Sample\n?$/, "Ben Sample\n[cid:image001.png] [cid:image002.png]\n[cid:image001.png] Example Works\n[Example Works logo] Example Works AG\nMusterstrasse 1, 8000 Zürich\n");
    for (const s of [html, text]) expect(s).toMatch(/\[EXTERNAL\][^]*\[cid:image001\.png\][^]*\[Example Works logo\] [^]*Musterstrasse/);
    const r = both(html, text);
    expect(r.v).toBe("trailing");
    expect(r.html).not.toBeNull();
    expect(r.text).not.toBeNull();
    expect(r.held).not.toBeNull();
  });

  it("124 with one question and its '[AE] ' answer above the sign-off stays open on both parts", () => {
    const fx = fixture("124");
    const html = fx.html!.replace("<p class=\"MsoNormal\"><o:p>&nbsp;</o:p></p><p class=\"MsoNormal\">2. Do your technicians need a key for the plant room?<o:p></o:p></p><p class=\"MsoNormal\"><b><i>[AE] </i></b>Yes, please leave it at the front desk.<o:p></o:p></p>", "");
    const text = fx.text.replace("\n\n2. Do your technicians need a key for the plant room?\n[AE] Yes, please leave it at the front desk.", "");
    for (const s of [html, text]) expect(s).toMatch(/offer\?[^]*\[AE\] [^]*item 3 of the offer\.(?![^]*plant room)[^]*Best regards,/);
    expect(both(html, text)).toEqual({ v: null, html: null, text: null, held: null });
  });
});

describe("arrow bullets and Q/A lines in an Outlook history are no answers in html", () => {
  const listed = (lines: string[]): string => fixture("124").html!.replace(/two questions before[^]*?(?=<p class="MsoNormal">Best regards,)/,
    lines.map((l) => `<p class="MsoNormal">${l.replace(/>/g, "&gt;")}<o:p></o:p></p>`).join(""));

  for (const lines of [
    ["wie besprochen:", "-> Termin am Dienstag um 10 Uhr", "-> Pläne bitte mitbringen", "Bitte bestätige mir kurz den Termin."],
    ["as discussed:", "=> Site visit on Tuesday at 10", "=> Please bring the plans", "Please confirm the date briefly."],
    ["Q: Is the filter cleaning included?", "A: It is item 3 of the offer.", "Please confirm the date briefly."],
  ]) {
    it(`'${lines[1]}' folds`, () => {
      const html = listed(lines);
      expect(html).not.toContain("[AE]");
      expect(verdictOf(html)).toBe("trailing");
      const c = htmlCase(html);
      expect(c.visibleText).toContain("thanks, done.");
      expect(c.historyText).toContain(lines.at(-1));
    });
  }
});

describe("a GMX, WEB.DE or mail.com reply header (the date first) folds by its quote box", () => {
  const lead = (s: string): string => s.replace("Dienstag passt mir gut, ich bringe die Pläne mit.", "Ja, Dienstag um 10 Uhr passt mir gut.")
    .replace(/Gruss Clara\n\n/, "").replace("<div>Gruss Clara</div><div>&nbsp;</div>", "");
  // The sanitizer drops `name`: only the box's border is left to read.
  const sanitized = (s: string): string => s.replace(/ name="quote(?:d-content)?"/g, "");

  it("108 with a one-sentence lead folds trailing in html, and its text part with it", () => {
    const fx = fixture("108");
    const html = sanitized(lead(fx.html!));
    expect(html).not.toMatch(/Gruss Clara| name=/);
    expect(verdictOf(html)).toBe("trailing");
    expect(htmlCase(html).visibleText).toContain("Ja, Dienstag um 10 Uhr passt mir gut.");
    const text = lead(fx.text);
    expect(text).not.toContain("Gruss Clara");
    expect(foldText(text, { html: verdictOf(html) })?.at).toBe("trailing");
    // A text part alone has no box: after a sentence the block reads as a paste.
    expect(foldText(text)).toBeNull();
  });

  it("a pasted 'Gesendet:/Von:' mail in plain paragraphs after a one-sentence lead stays open", () => {
    const lines = ["Hallo Ben,", "", "hier ist die Antwort vom Vermieter von gestern Abend.", "",
      "Gesendet: Donnerstag, 22. Oktober 2026 um 09:14 Uhr", "Von: \"Rolf Vermieter\" <rolf@example.org>", "An: clara.muster@example.net",
      "Betreff: Begehung", "", "Hallo Clara,", "Dienstag geht leider nicht.", "Rolf", "",
      "Kannst du ihn bitte morgen anrufen und einen neuen Termin vereinbaren?", "", "Gruss Clara"];
    const esc = (l: string): string => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<div style="font-family: Verdana;font-size: 12.0px;">${lines.map((l) => `<div>${l === "" ? "&nbsp;" : esc(l)}</div>`).join("")}</div>`;
    const text = lines.join("\n");
    const v = verdictOf(html);
    expect({ v, text: foldText(text), held: foldText(text, { html: v }) }).toEqual({ v: null, text: null, held: null });
    expect(htmlCase(html).visibleText).toContain("Gruss Clara");
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

/** Twelve recipients: an `An: ` line past 400 characters. */
const GROUP = Array.from({ length: 12 }, (_, i) => `Person${i + 1} Example <person${i + 1}@example.org>`).join("; ");

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
    // To a group: a To line past 400 characters is still the memo's first label.
    const big = memo.replace("To: All staff", `To: ${GROUP}`);
    expect(foldText(big)).toBeNull();
    expect(htmlCase(asHtml(big)).r).toBeNull();
  });

  it("an Outlook reply to a group (its An: line past 400 characters) folds at its header block, on both parts", () => {
    const fx = fixture("01");
    const html = fx.html!.replace("<b>An:</b> Ben Sample &lt;ben.sample@example.org&gt;", `<b>An:</b> ${GROUP.replace(/</g, "&lt;").replace(/>/g, "&gt;")}`);
    const text = fx.text.replace("An: Ben Sample <ben.sample@example.org>", `An: ${GROUP}`);
    expect(html).not.toBe(fx.html);
    expect(htmlCase(html).historyText).toMatch(/^Von: Ana Example/);
    expect(text.split("\n")[foldText(text, { html: verdictOf(html) })!.start]).toMatch(/^Von: Ana Example/);
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

describe("a quote and its answer inside the history are the history's (132-135)", () => {
  const P = (t: string): string => `<p class="MsoNormal">${t}<o:p></o:p></p>`;
  const red = (t: string): string => `<span style="color:#C00000">${t}</span>`;
  const box = (x: string): string => `<blockquote style="margin:0cm 0cm 0cm 4.8pt;border-left:solid #CCCCCC 1.0pt;padding:0cm 0cm 0cm 6.0pt">${x}</blockquote>`;
  // Ben's message under the header, replaced whole.
  const earlier = (id: string, body: string): string => fixture(id).html!.replace(/<p class="MsoNormal">Hallo Clara,[^]*Ben<o:p><\/o:p><\/p>/, body);
  const qa = (a1: string, a2: string): string => P("Hallo Clara,") + P("1. Ist die Filterreinigung im Angebot enthalten?") + P(a1)
    + P("2. Brauchen Ihre Techniker einen Schlüssel für den Technikraum?") + P(a2) + P("Bitte gebt mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.") + P("Gruss") + P("Ben");
  const cm = (t: string): string => `<b><i>[CM] </i></b>${t}`;

  it("the text part held by its html folds at the header", () => {
    for (const id of ["132", "133", "134", "135"]) {
      const fx = fixture(id);
      const r = foldText(fx.text, { html: verdictOf(fx.html!, fx.subject), subject: fx.subject });
      expect(r, id).not.toBeNull();
      expect(fx.text.split("\n")[r!.start], id).toMatch(/^Von: Ben Sample/);
    }
  });

  it("answers in another hand under a new-Mac header stay open, red or marked", () => {
    for (const [a1, a2] of [[red("Ja, sie ist Position 3 im Angebot."), red("Ja, bitte am Empfang hinterlegen.")],
      [cm("Ja, sie ist Position 3 im Angebot."), cm("Ja, bitte am Empfang hinterlegen.")]]) {
      const html = earlier("132", qa(a1!, a2!));
      expect(html).toContain("mail-editor-reference-message-container");
      expect(htmlCase(html).r).toBeNull();
      expect(verdictOf(html)).toBeNull();
    }
  });

  it("answers in another hand inside a quote box under a Windows header stay open", () => {
    const inBox = (a1: string, a2: string): string => P("Hallo Clara,") + P("zu deinen Fragen:") + box(P("1. Wann kommt der Techniker?") + P(a1)
      + P("2. Wer hat den Schlüssel?") + P(a2)) + P("Bitte gebt mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.") + P("Gruss") + P("Ben");
    expect(htmlCase(earlier("133", inBox(cm("Am Dienstag um 10 Uhr."), cm("Der Hauswart hat ihn.")))).r, "[CM]").toBeNull();
    expect(htmlCase(earlier("133", inBox(red("Am Dienstag um 10 Uhr."), red("Der Hauswart hat ihn.")))).r, "red").toBeNull();
    // An original quoted whole in parts, red answers between them.
    const parts = box(P("Hallo Clara,") + P("1. Wann kommt der Techniker morgen genau?")) + P(red("Am Dienstag um 10 Uhr."))
      + box(P("2. Wer hat den Schlüssel für den Technikraum?") + P("Gruss Ben")) + P(red("Der Hauswart hat ihn, bitte am Empfang fragen."));
    expect(htmlCase(earlier("133", parts)).r, "quote parts").toBeNull();
  });

  it("control: answers between a Gmail container's quote parts stay open", () => {
    const q = (t: string): string => `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div>${t}</div></blockquote>`;
    const html = '<div dir="ltr">Hi Ben,<div><br></div><div>thanks, see you then.</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">'
      + "On Wed, 28 Oct 2026 at 14:12, Ben Sample &lt;ben@example.org&gt; wrote:<br></div>" + q("Can the technician come Tuesday?")
      + "<div>Yes, Tuesday at 10 works for us.</div>" + q("Who has the key?") + "<div>The caretaker has it, ask at the desk.</div></div>";
    expect(htmlCase(html).r).toBeNull();
  });

  // The current writer's answers typed into the history: they keep it open.
  const blue = (t: string): string => `<span style="color:#0070C0">${t}</span>`;
  const hl = (t: string): string => `<span style="background:yellow;mso-highlight:yellow">${t}</span>`;
  const nm = (t: string): string => `<b><i>[Clara Muster] </i></b>${t}`;
  const wordBox = (x: string): string => `<div style="border:none;border-left:solid #CCCCCC 1.0pt;padding:0cm 0cm 0cm 6.0pt">${x}</div>`;
  const cite = (x: string): string => `<blockquote type="cite">${x}</blockquote>`;
  const Q1 = "Wann kommt der Techniker morgen genau?";
  const Q2 = "Wer hat den Schlüssel für den Technikraum?";
  const ANSWER = "Um 10 Uhr, er meldet sich am Empfang.";
  const ask = P("Dana fragt noch:");
  const tail = P("Kannst du ihr das bitte direkt beantworten?") + P("Gruss") + P("Ben");
  const stays = (html: string, why: string): void => {
    expect(htmlCase(html).r, why).toBeNull();
    expect(verdictOf(html), why).toBeNull();
  };

  it("an answer typed as a quote box's last line, the message's text below the box, stays open", () => {
    const long = "Um 10 Uhr morgen früh, er meldet sich vorher am Empfang bei Frau Muster.";
    for (const id of ["132", "133", "135"]) {
      for (const [name, a] of [["red", red(ANSWER)], ["blue", blue(ANSWER)], ["highlight", hl(ANSWER)], ["longer than the question", red(long)], ["comment mark", blue(nm(ANSWER))]]) {
        for (const [kind, bx] of [["blockquote", box], ["Word box", wordBox]] as const) stays(earlier(id, P("Hallo Clara,") + ask + bx(P(Q1) + P(a!)) + tail), `${id} ${name} ${kind}`);
      }
      stays(earlier(id, P("Hallo Clara,") + ask + box(P(`<span style="color:#500050">${Q1}</span>`) + P(red(ANSWER))) + tail), `${id} under a coloured quote`);
      stays(earlier(id, P("Hallo Clara,") + ask + box(P(Q1) + P(red(ANSWER))) + P("Und ausserdem:") + box(P(Q2) + P(red("Der Hauswart hat ihn."))) + tail), `${id} two boxes`);
    }
    // The text part follows its html: it stays open too.
    for (const t of qhTypedAnswers()) {
      expect(verdictOf(t.html), t.name).toBeNull();
      expect(foldText(t.text, { html: verdictOf(t.html) }), t.name).toBeNull();
    }
  });

  it("answers at the message's level between the parts of a quote below an attribution stay open", () => {
    const by = P("Hallo Clara,") + P("Dana hat Fragen, siehe unten.") + P("Gruss") + P("Ben") + P("Am 27.10.2026 um 17:40 schrieb Dana Example &lt;dana.example@example.net&gt;:");
    for (const id of ["132", "133"]) {
      for (const [kind, q] of [["blockquote", box], ["cite", cite]] as const) {
        stays(earlier(id, by + q(P("1. " + Q1)) + P(red("Am Dienstag um 10 Uhr kommt er.")) + q(P("2. " + Q2) + P("Gruss Dana"))
          + P(red("Der Hauswart hat ihn, bitte am Empfang fragen."))), `${id} ${kind}`);
      }
      stays(earlier(id, by + box(P("1. Ist die Filterreinigung im Angebot enthalten?")) + P(red("JA")) + box(P("2. Um wie viel Uhr sollen die Techniker kommen?"))
        + P(red("14:00")) + box(P("Danke für die Rückmeldung, ich plane den Termin danach ein.") + P("Gruss Dana"))), `${id} short answers`);
    }
  });

  it("a name mark repeated across a quote box and the message's text is an answer mark", () => {
    for (const id of ["132", "133", "135"]) {
      stays(earlier(id, P("Hallo Clara,") + ask + box(P(Q1) + P(nm(ANSWER))) + P("Kannst du ihr das bitte direkt beantworten?") + P(nm("Ja, ich schreibe ihr gleich selbst."))
        + P("Gruss") + P("Ben")), `${id} box and text`);
      stays(earlier(id, P("Hallo Clara,") + ask + box(P(Q1) + P(nm(ANSWER))) + P("Und ausserdem:") + box(P(Q2) + P(nm("Der Hauswart hat ihn."))) + tail), `${id} two boxes`);
    }
  });

  // Dana's older message under its own Outlook header.
  const hop = (body: string): string => '<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>Von:</b> '
    + "Dana Example &lt;dana.example@example.net&gt;<br><b>Gesendet:</b> Dienstag, 27. Oktober 2026 17:40<br><b>An:</b> Ben Sample &lt;ben.sample@example.org&gt;<br>"
    + `<b>Betreff:</b> Begehung Technikraum</p></div></div>${body}`;

  it("answers in an older hop keep a new-Mac container open: its quote and the words after it are the letter", () => {
    const below = (id: string, body: string): string => fixture(id).html!.replace(/(<p class="MsoNormal">Ben<o:p><\/o:p><\/p>)/, `$1${hop(body)}`);
    const sign = P("Viele Grüsse") + P("Dana");
    stays(below("132", P("Hallo Ben,") + P("1. Wann kommt der Techniker genau?") + P(red("Am Dienstag um 10 Uhr.")) + P("2. " + Q2) + P(red("Der Hauswart hat ihn."))
      + P("Bitte gebt mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.") + sign), "questions");
    stays(below("132", P("Hallo Ben,") + box(P(Q1)) + P(red(ANSWER)) + P("Die Pläne der Lüftung bringe ich selbst mit, keine Sorge.") + sign), "after a box");
    stays(below("132", P("Hallo Ben,") + box(P(Q1)) + P(nm(ANSWER)) + P(Q2) + P(nm("Der Hauswart hat ihn."))), "name marks");
    // 134's second hop (Dana's, under its own header) with the answer.
    const h = fixture("134").html!;
    const i = h.lastIndexOf('<p class="MsoNormal">Hallo Ben,<o:p></o:p></p>');
    const j = h.indexOf("Dana<o:p></o:p></p>", i) + "Dana<o:p></o:p></p>".length;
    stays(h.slice(0, i) + P("Hallo Ben,") + box(P(Q1)) + P(red(ANSWER)) + P("Die Pläne der Lüftung bringe ich selbst mit, keine Sorge.") + sign + h.slice(j), "134");
  });

  // Answers that outweigh the message's own words, or sit under a banner or a coloured signature.
  const by = P("Am 27.10.2026 um 17:40 schrieb Dana Example &lt;dana.example@example.net&gt;:");
  const signed = P("Hallo Clara,") + P("Dana hat Fragen, siehe unten.") + P("Gruss") + P("Ben") + by;
  const plan = P("Bitte gib mir bis Freitag Bescheid, dann plane ich die Begehung fest ein.") + P("Gruss") + P("Ben");
  const sig = P('<b><span style="color:#1F497D">Ben Sample</span></b>') + P('<span style="color:#1F497D">Projektleiter Haustechnik | Beispiel AG</span>');
  const LONG = ["Am Dienstag um 10 Uhr, er meldet sich vorher telefonisch bei Frau Muster am Empfang.",
    "Der Hauswart hat ihn, bitte vorher beim Empfang im Erdgeschoss nachfragen und unterschreiben.",
    "Ja, die Filterreinigung ist Position 3 im Angebot und wird beim gleichen Termin erledigt."];
  const ASKED = ["1. Wann kommt der Techniker morgen genau? Wir müssen den Raum vorher aufschliessen und lüften.",
    "2. Wer hat den Schlüssel für den Technikraum? Letztes Mal hat das eine Stunde gedauert.", "3. Ist die Filterreinigung im Angebot enthalten? Im letzten Jahr wurde sie extra verrechnet."];
  const parts = (q: (x: string) => string, n: number): string =>
    ASKED.slice(0, n).map((x, k) => q(P(x)) + P(red(LONG[k]!))).join("") + q(P("Danke und Gruss") + P("Dana"));

  it("answers outweighing the message's own words between a quote's parts stay open", () => {
    for (const id of ["132", "133", "135"]) {
      // Not 132's Word box: a new-Mac container is read only to its first message (a fix of its own).
      const boxes = [["blockquote", box], ["cite", cite], ["Word box", wordBox]] as const;
      for (const [kind, q] of id === "132" ? boxes.slice(0, 2) : boxes) {
        stays(earlier(id, P("Hallo Clara,") + P("siehe unten.") + parts(q, 3)), `${id} ${kind} below the greeting`);
        stays(earlier(id, signed + parts(q, 3)), `${id} ${kind} three`);
        stays(earlier(id, signed + parts(q, 2)), `${id} ${kind} two`);
      }
    }
    const more = "bitte vorher beim Empfang im Erdgeschoss nachfragen und dort den Ausweis zeigen sowie unterschreiben".split(" ");
    for (let n = 0; n <= 12; n += 2) {
      const longer = n === 0 ? "" : `, ${more.slice(0, n).join(" ")}`;
      stays(earlier("133", signed + box(P(`1. ${Q1}`)) + P(red(`Am Dienstag um 10 Uhr${longer}.`)) + box(P(`2. ${Q2}`) + P("Gruss Dana"))
        + P(red(`Der Hauswart hat ihn${longer}.`))), `${n} words more`);
    }
    stays(earlier("133", P("Hallo Clara,") + P("Dana hat Fragen zur Begehung, siehe unten. Ich bin bis Montag im Urlaub und kann ihr leider nicht selbst antworten.")
      + P("Gruss") + P("Ben") + by + parts(box, 2)), "the message's words outweigh them");
  });

  it("a lone short answer under a question quoted in a box stays open", () => {
    const q = P("Ist die Filterreinigung im Angebot enthalten?");
    for (const id of ["132", "133", "135"]) {
      for (const [kind, bx] of [["blockquote", box], ["Word box", wordBox], ["cite", cite]] as const) {
        for (const [name, a] of [["JA", red("JA")], ["NEIN", red("NEIN")], ["OK", red("OK")], ["14:00", red("14:00")], ["highlight", hl("JA")]]) {
          stays(earlier(id, P("Hallo Clara,") + ask + bx(q) + P(a!) + plan), `${id} ${kind} ${name}`);
        }
      }
      stays(earlier(id, P("Hallo Clara,") + q + P(red("JA")) + plan), `${id} under the message's own question`);
      stays(earlier(id, P("Hallo Clara,") + ask + box(q + P(red("JA"))) + plan), `${id} inside the box`);
    }
    stays(earlier("133", P("Hallo Clara,") + ask + box(q) + P(red("Ja, Position 3.")) + plan), "a sentence");
    stays(earlier("133", P("Hallo Clara,") + ask + box(q) + P(red("JA")) + box(P("Um wie viel Uhr sollen die Techniker kommen?")) + P(red("14:00")) + plan), "two");
    stays(earlier("133", P("Hallo Clara,") + P("Kannst du Dana das beantworten?") + box(q) + P(red("JA")) + plan), "a question above the box");
  });

  it("an answer ending a quote box stays open when only quoted text follows it", () => {
    const keyAnswer = red("Der Hauswart hat ihn, bitte am Empfang fragen.");
    for (const id of ["132", "133", "135"]) {
      const asks = P("Hallo Clara,") + P("Dana fragt:");
      stays(earlier(id, asks + box(P(Q1) + P(red(ANSWER))) + P("Und:") + box(P(Q2) + P(keyAnswer)) + P("Gruss") + P("Ben")), `${id} two answered boxes`);
      stays(earlier(id, asks + box(P(Q1) + P(red(ANSWER))) + P("Und:") + box(P(Q2)) + P("Gruss") + P("Ben")), `${id} a quoted box after it`);
      stays(earlier(id, asks + box(P(Q1)) + P(red(ANSWER)) + box(P(Q2)) + P("Gruss") + P("Ben")), `${id} between two boxes`);
    }
  });

  it("a banner or a coloured signature in the message is not its hand", () => {
    const banner = P('<span style="color:#9C0006">ACHTUNG: Diese E-Mail stammt von ausserhalb der Organisation. Klicken Sie nicht auf Links.</span>');
    const table = `<table style="width:100%"><tr><td style="background:#FFEB9C">${P('<b><span style="color:#9C0006">CAUTION: This email originated from outside of the organization. '
      + "Do not click links unless you recognize the sender.</span></b>")}</td></tr></table>`;
    for (const id of ["132", "133", "135"]) {
      for (const [kind, top] of [["banner", banner], ["table banner", table]] as const) {
        stays(earlier(id, top + P("Hallo Clara,") + P("1. Ist die Filterreinigung im Angebot enthalten?") + P(blue("Ja, sie ist Position 3 im Angebot."))
          + P("2. Brauchen Ihre Techniker einen Schlüssel für den Technikraum?") + P(blue("Ja, bitte am Empfang hinterlegen.")) + plan), `${id} ${kind}, inline`);
        stays(earlier(id, top + P("Hallo Clara,") + ask + box(P(Q1)) + P(blue(ANSWER)) + plan), `${id} ${kind}, under a quoted question`);
      }
      stays(earlier(id, P("Hallo Clara,") + P("Dana hat Fragen, siehe unten.") + P("Gruss") + sig + by + box(P(`1. ${Q1}`)) + P(red("Am Dienstag um 10 Uhr kommt er."))
        + box(P(`2. ${Q2}`) + P("Gruss Dana")) + P(red("Der Hauswart hat ihn, bitte am Empfang fragen."))), `${id} signature over answers`);
      stays(earlier(id, P("Hallo Clara,") + P("siehe unten.") + sig + by + parts(box, 2)), `${id} signature over long answers`);
    }
  });

  it("a reply above an attribution and its quote is the history's: it folds", () => {
    const gmail = (x: string): string => `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${x}</blockquote>`;
    const dana = P("Hallo Ben,") + P("Können wir die Begehung des Technikraums auf Donnerstag verschieben? Am Dienstag bin ich leider nicht im Haus.") + P("Viele Grüsse") + P("Dana");
    const reply = P("Hallo Clara,") + P("Ja, Donnerstag um 10 Uhr passt uns.") + P("Gruss") + P("Ben");
    for (const id of ["132", "133", "135"]) {
      for (const [kind, q] of [["Gmail", gmail], ["Apple", cite]] as const) {
        const c = htmlCase(earlier(id, reply + by + q(dana)));
        expect(c.r, `${id} ${kind}`).not.toBeNull();
        expect(c.visibleText, `${id} ${kind}`).not.toContain("Ben Sample");
      }
    }
  });
});
