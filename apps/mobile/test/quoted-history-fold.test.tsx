/** @vitest-environment jsdom */
/**
 * THE PHONE FOLDS EVERY BODY'S QUOTED HISTORY (owner, 2026-10-23: "this should work reliably through
 * all types of history attachments"). A conversation member and the opened message draw their text
 * under `HistoryFold`: the new words, the end marker the read rule takes (before the row), one row,
 * and the history only once it is pressed open. The html half cuts the document before the frame
 * gets it (`sanitizeMailHtmlPhone`'s `fold`): nothing of the history is drawn, fetched or linked.
 */
import { createElement as h, act } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, rnDom } from "./_rendered-dom";
import { qhFixtures, qhFolds, qhNorm } from "../../../packages/client-engine/test/quoted-history-fixtures";

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return { Txt: rnDom.Text, Tap: rnDom.Pressable };
});
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), radius: { pill: 999 }, type: new Proxy({}, { get: () => ({}) }) }),
}));

const { BodyPages } = await import("../src/ui/BodyPages");
const { HistoryFold } = await import("../src/ui/HistoryFold");
const { sanitizeMailHtmlPhone } = await import("../src/mail/sanitize");
const { EN } = await import("../src/copy.en");
const { DE } = await import("../src/copy.de");

const FIXTURES = qhFixtures();
const strip = (s: string): string => qhNorm(s.replace(/^[\s>]+/gm, ""));
let mounted: { el: HTMLElement; unmount(): void } | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

function body(text: string, variant: "streamBody" | "readerBody", ends: string[] = [], html: string | null = null, subject?: string) {
  mounted = mount(
    h("div", { "data-panel": "" },
      h(HistoryFold, {
        foldKey: "m1",
        html,
        subject,
        end: h(rnDom.View, { style: { height: 0 }, onLayout: () => ends.push("end") }),
        children: h(BodyPages, { variant, tone: "ink2", text }),
      })),
  );
  return mounted.el;
}
const row = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>('[data-role="button"]');
const shown = (el: HTMLElement): string => strip(el.textContent ?? "");
const press = (b: HTMLElement): void => { act(() => { b.click(); }); };

describe("a member and the opened message fold the text part, over the corpus", () => {
  for (const variant of ["streamBody", "readerBody"] as const) {
    for (const fx of FIXTURES) {
      const t = fx.expect.text;
      if (t === null) continue;
      it(`${variant}: ${fx.name}`, () => {
        const ends: string[] = [];
        const el = body(fx.text, variant, ends, null, fx.subject);
        const r = row(el);
        for (const s of [t.visibleFirstLine, t.visibleLastLine, ...fx.expect.inlineAnswers, ...(t.signatureAfterHistory ?? [])]) {
          if (s) expect(shown(el), "a visible line is lost").toContain(strip(s));
        }
        expect(ends, "one end marker, reported").toEqual(["end"]);
        if (!qhFolds(fx.expect)) {
          expect(r, "this body must not fold").toBeNull();
          return;
        }
        const start = strip(fx.expect.fold === "trailing-tail-only" ? fx.expect.trailingTail!.startLine : t.historyStartLineNormalized!);
        expect(r).not.toBeNull();
        expect(shown(el), "the history is mounted while folded").not.toContain(start);
        const marker = el.querySelector('[data-style="{\\"height\\":0}"]')!;
        const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        if (fx.expect.fold === "leading") expect(before(r!, marker), "the reply's end closes it, below the row").toBe(true);
        else expect(before(marker, r!), "the end marker stands before the row").toBe(true);
        press(r!);
        expect(shown(el)).toContain(start);
        press(row(el)!);
        expect(shown(el)).not.toContain(start);
      });
    }
  }
});

describe("a body with an html part folds its text only where that html folds", () => {
  for (const variant of ["streamBody", "readerBody"] as const) {
    for (const fx of FIXTURES) {
      if (fx.html === null) continue;
      it(`${variant}: ${fx.name}`, () => {
        const el = body(fx.text, variant, [], fx.html, fx.subject);
        const folded = sanitizeMailHtmlPhone(fx.html!, { fold: true, subject: fx.subject }).history ?? null;
        for (const a of fx.expect.inlineAnswers) expect(shown(el), "an inline answer is hidden").toContain(strip(a.replace(/^\[AE\] /, "")));
        if (folded === null || !qhFolds(fx.expect)) expect(row(el), "the html says there is no history").toBeNull();
        else if (fx.expect.text !== null) expect(row(el), "the html folds, so does the member").not.toBeNull();
      });
    }
  }

  it("73 as a member and under Show as text: both answers on screen, no row", () => {
    const fx = FIXTURES.find((f) => f.id === "73")!;
    for (const variant of ["streamBody", "readerBody"] as const) {
      const el = body(fx.text, variant, [], fx.html);
      expect(row(el)).toBeNull();
      expect(shown(el)).toContain("Ja, die Filterreinigung ist Position 3 im Angebot.");
      expect(shown(el)).toContain("Ja, bitte am Empfang hinterlegen.");
      mounted?.unmount();
      mounted = null;
    }
  });

  it("a multipart interleaved reply whose lead names no answers keeps its answers", () => {
    const fx = FIXTURES.find((f) => f.id === "55")!;
    const lead = (s: string) => s.replace("meine Antworten finden Sie unten in Blau.", "siehe unten.");
    const el = body(lead(fx.text).replace(/\[AE\] /g, ""), "streamBody", [], lead(fx.html!));
    expect(row(el)).toBeNull();
    expect(shown(el)).toContain("Ja, Sie erhalten das Protokoll am selben Tag als PDF.");
  });

  for (const id of ["01", "104"]) {
    it(`control: ${id}, a reply whose html folds, folds its text as a member`, () => {
      const fx = FIXTURES.find((f) => f.id === id)!;
      const el = body(fx.text, "streamBody", [], fx.html);
      expect(row(el)).not.toBeNull();
      expect(shown(el)).not.toContain("Hallo Herr Sample,");
    });
  }

  it("a responsive newsletter with a header card is not folded by the frame", () => {
    const html = '<html><body><div style="max-width:600px;margin:0 auto"><h1>Example Weekly</h1><p>This week: how teams answer mail faster.</p>'
      + "<p>From: Support Desk &lt;desk@example.com&gt;<br>Sent: Monday, October 19, 2026 9:00 AM<br>To: A Customer &lt;c@example.org&gt;<br>"
      + "Subject: Your ticket is solved</p><p>A reply card like this one is what our builder draws.</p></div></body></html>";
    const folded = sanitizeMailHtmlPhone(html, { fold: true });
    expect(folded.history).toBeNull();
    expect(folded.html).toContain("A reply card like this one");
  });

  it("a canvas declared only in the head's sheet is read too, by the frame and by the member", () => {
    const html = '<html><head><style>.wrap{max-width:600px;margin:0 auto}</style></head><body><div class="wrap"><h1>Example Weekly</h1>'
      + "<p>This week: how teams answer mail faster.</p><p>The Example team</p><p>From: Support Desk &lt;desk@example.com&gt;<br>"
      + "Sent: Monday, October 19, 2026 9:00 AM<br>To: A Customer &lt;c@example.org&gt;<br>Subject: Your ticket is solved</p>"
      + "<p>A reply card like this one is what our builder draws.</p></div></body></html>";
    expect(sanitizeMailHtmlPhone(html, { fold: true }).history).toBeNull();
    const text = "Example Weekly\n\nThis week: how teams answer mail faster.\n\nThe Example team\n\nFrom: Support Desk <desk@example.com>\n"
      + "Sent: Monday, October 19, 2026 9:00 AM\nTo: A Customer <c@example.org>\nSubject: Your ticket is solved\n\nA reply card like this one is what our builder draws.";
    expect(row(body(text, "streamBody", [], html))).toBeNull();
  });
});

describe("the row is a button a screen reader can read and operate", () => {
  it("says what a press does, states its expanded state, and hides its ornament", () => {
    const fx = FIXTURES.find((f) => f.id === "37")!;
    const el = body(fx.text, "readerBody");
    const r = row(el)!;
    expect(r.getAttribute("data-label")).toBe(EN.bodyHistoryShow);
    expect(r.getAttribute("data-expanded")).toBe("false");
    expect(r.querySelector("[data-ax-hidden]")?.textContent).toBe("···");
    press(r);
    expect(row(el)!.getAttribute("data-expanded")).toBe("true");
    expect(row(el)!.getAttribute("data-label")).toBe(EN.bodyHistoryHide);
  });

  it("the copy is the web body's own, in both languages", () => {
    const web = (l: string) => (JSON.parse(readFileSync(join(__dirname, `../../webapp/messages/${l}.json`), "utf8")) as {
      bodyText: { show: string; hide: string };
    }).bodyText;
    expect([EN.bodyHistoryShow, EN.bodyHistoryHide]).toEqual([web("en").show, web("en").hide]);
    expect([DE.bodyHistoryShow, DE.bodyHistoryHide]).toEqual([web("de").show, web("de").hide]);
  });

  it("a clamped preview never folds", () => {
    const fx = FIXTURES.find((f) => f.id === "37")!;
    mounted = mount(h(HistoryFold, { foldKey: "m1", children: h(BodyPages, { variant: "streamBody", numberOfLines: 2, text: fx.text }) }));
    expect(row(mounted.el)).toBeNull();
  });
});

describe("the html part: the frame's document is cut before it is drawn", () => {
  const textOf = (html: string): string => qhNorm(new DOMParser().parseFromString(html, "text/html").body.textContent ?? "");
  for (const fx of FIXTURES) {
    const x = fx.expect.html;
    if (fx.html === null || x === null) continue;
    it(fx.name, () => {
      const whole = sanitizeMailHtmlPhone(fx.html!, {});
      expect(whole.history, "unasked, nothing changes").toBeUndefined();
      const folded = sanitizeMailHtmlPhone(fx.html!, { fold: true, subject: fx.subject });
      for (const s of [x.visibleFirstText, x.visibleLastText, ...fx.expect.inlineAnswers]) {
        if (s) expect(textOf(folded.html)).toContain(qhNorm(s));
      }
      if (!qhFolds(fx.expect)) {
        expect(folded.history).toBeNull();
        expect(folded.html).toBe(whole.html);
        return;
      }
      expect(folded.history?.at).toBe(fx.expect.fold === "leading" ? "leading" : "trailing");
      expect(textOf(folded.html)).not.toContain(qhNorm(x.historyStartText!));
      expect(textOf(whole.html)).toContain(qhNorm(x.historyStartText!));
      // The folded document's lists are its own: every link and part it names is still in it.
      expect(folded.links.length).toBeLessThanOrEqual(whole.links.length);
      expect(folded.cids.every((c) => whole.cids.includes(c))).toBe(true);
    });
  }

  it("a folded history's pictures and links are not the document's", () => {
    const html = '<p>Thanks, see you.</p><div>On Thu, 22 Oct 2026 at 09:14, A &lt;a@example.com&gt; wrote:</div>'
      + '<blockquote type="cite"><img src="https://img.example.com/p.png" width="300" height="200"><img src="cid:logo@example.com">'
      + '<a href="https://example.com/old">old link</a></blockquote>';
    const folded = sanitizeMailHtmlPhone(html, { fold: true });
    expect(folded.history?.at).toBe("trailing");
    expect(folded.blocked).toEqual([]);
    expect(folded.cids).toEqual([]);
    expect(folded.links).toEqual([]);
    const whole = sanitizeMailHtmlPhone(html, {});
    expect(whole.blocked.map((b) => b.url)).toEqual(["https://img.example.com/p.png"]);
    expect(whole.cids).toEqual(["logo@example.com"]);
    expect(whole.links).toEqual(["https://example.com/old"]);
  });
});
