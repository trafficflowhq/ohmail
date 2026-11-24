/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { qhFixtures, qhFolds, qhNorm, qhTypedAnswers, type QhFixture } from "../../../packages/client-engine/test/quoted-history-fixtures.js";

/**
 * EVERY THREAD MEMBER AND EVERY OPENED MESSAGE FOLDS ITS HISTORY (owner, 2026-10-23: "most of the
 * threads contain the history uncollapsed, this should work reliably through all types of history
 * attachments"). The whole corpus through the real `MessageBody`, mounted as a conversation member
 * (`.pm-body`) and as the opened message (`.msg-body`), on each path a body can take: the prose
 * rendering of its html, its text part alone, and the frame (html with no text part). Folded, the
 * history is not in the document at all; nothing the sidecar calls visible is lost; the body's end
 * marker stands above the toggle; and the toggle brings the history back.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}
afterEach(unmount);

async function renderBody(cls: string, props: { text: string; html: string | null; subject?: string; onControls?: (c: readonly Control[]) => void }): Promise<HTMLDivElement> {
  await unmount();
  const { MessageBody } = await import("../../../packages/letter-body/src/MessageBody.js");
  host = document.createElement("div");
  host.className = cls;
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, { owner: null, messageId: "m1", ...props })); });
  return host;
}

const textOf = (el: Element): string => qhNorm(el.textContent ?? "");
const srcdocText = (el: Element): string => {
  const doc = el.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  return qhNorm(new DOMParser().parseFromString(doc, "text/html").body.textContent ?? "");
};
const toggleIn = (el: Element): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>("button.msg-history-toggle");
const press = async (b: HTMLElement): Promise<void> => { await act(async () => { b.click(); }); };
const follows = (a: Node, b: Node): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const textNodeWith = (el: Element, s: string): Node | null => {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (qhNorm(n.nodeValue ?? "").includes(s.slice(0, 24))) return n;
  return null;
};

interface Expect {
  history: string | null;
  first: string | null;
  last: string | null;
  keep: string[];
}

function expectOf(fx: QhFixture, part: "text" | "html"): Expect | null {
  const e = fx.expect;
  if (part === "html") {
    const x = e.html;
    if (x === null) return null;
    return {
      history: x.historyStartText, first: x.visibleFirstText, last: x.visibleLastText,
      keep: [...e.inlineAnswers, ...(x.signatureAfterHistory ?? [])],
    };
  }
  const x = e.text;
  if (x === null) return null;
  return {
    history: e.fold === "trailing-tail-only" ? e.trailingTail!.startLine.replace(/^[>\s]+/, "") : x.historyStartLineNormalized,
    first: x.visibleFirstLine, last: x.visibleLastLine, keep: [...e.inlineAnswers, ...(x.signatureAfterHistory ?? [])],
  };
}

/** The prose path (the html's own structure, or the text part): the fold is native. */
async function checkProse(el: HTMLDivElement, fx: QhFixture, x: Expect): Promise<void> {
  const folds = qhFolds(fx.expect);
  const toggle = toggleIn(el);
  // A drawn link's label is its host and path, never its scheme.
  const drawn = (v: string): string => qhNorm(v).replace(/https?:\/\//g, "");
  for (const s of [x.first, x.last, ...x.keep]) if (s) expect(drawn(textOf(el)), "a visible line is lost").toContain(drawn(s));
  if (!folds) {
    expect(toggle, "this body must not fold").toBeNull();
    return;
  }
  expect(toggle, "no toggle").not.toBeNull();
  expect(toggle!.getAttribute("aria-expanded")).toBe("false");
  expect(textOf(el), "the history is in the document while folded").not.toContain(qhNorm(x.history!));
  const ends = el.querySelectorAll("[data-own-end]");
  expect(ends, "exactly one end marker").toHaveLength(1);
  if (fx.expect.fold === "leading") {
    const reply = textNodeWith(el, qhNorm(x.first!));
    expect(reply && follows(toggle!, reply), "the toggle stands above the reply").toBe(true);
    expect(follows(toggle!, ends[0]!), "the end marker closes the reply").toBe(true);
  } else {
    expect(follows(ends[0]!, toggle!), "the end marker stands above the toggle").toBe(true);
  }
  await press(toggle!);
  expect(toggleIn(el)!.getAttribute("aria-expanded")).toBe("true");
  expect(textOf(el)).toContain(qhNorm(x.history!));
  await press(toggleIn(el)!);
  expect(textOf(el)).not.toContain(qhNorm(x.history!));
}

/** The frame: the folded document is cut before it becomes srcdoc; the toggle is outside it. */
async function checkFramed(el: HTMLDivElement, fx: QhFixture, x: Expect): Promise<void> {
  const folds = qhFolds(fx.expect);
  expect(el.querySelector("iframe"), "framed").not.toBeNull();
  for (const s of [x.first, x.last, ...x.keep]) if (s) expect(srcdocText(el), "a visible line is lost").toContain(qhNorm(s));
  const toggle = toggleIn(el);
  if (!folds) {
    expect(toggle).toBeNull();
    return;
  }
  expect(toggle, "no toggle").not.toBeNull();
  expect(srcdocText(el), "the history is in the frame while folded").not.toContain(qhNorm(x.history!));
  expect(srcdocText(el)).not.toContain("Show history");
  await press(toggle!);
  expect(srcdocText(el), "opening rebuilds the frame with the history").toContain(qhNorm(x.history!));
  expect(toggleIn(el)!.getAttribute("aria-expanded")).toBe("true");
}

const FIXTURES = qhFixtures();

for (const cls of ["pm-body", "msg-body"]) {
  describe(`.${cls}: the corpus through MessageBody`, () => {
    for (const fx of FIXTURES) {
      const html = expectOf(fx, "html");
      const text = expectOf(fx, "text");
      if (fx.html !== null && html !== null) {
        it(`${fx.name} — its html`, async () => {
          const el = await renderBody(cls, { text: fx.text, html: fx.html, subject: fx.subject });
          if (el.querySelector("iframe")) await checkFramed(el, fx, html);
          else await checkProse(el, fx, html);
        });
        it(`${fx.name} — framed (no text part)`, async () => {
          const el = await renderBody(cls, { text: "", html: fx.html, subject: fx.subject });
          await checkFramed(el, fx, html);
        });
      }
      if (text !== null) {
        it(`${fx.name} — its text part`, async () => {
          const el = await renderBody(cls, { text: fx.text, html: null, subject: fx.subject });
          await checkProse(el, fx, text);
        });
      }
    }
  });
}

type Control = import("../../../packages/letter-body/src/MessageBody.js").BodyControl;

describe("a host that draws the body's controls is handed a framed letter's history", () => {
  it("the body draws no toggle, and the handed one opens the history in the frame", async () => {
    const fx = FIXTURES.find((f) => f.id === "01")!;
    let last: readonly Control[] = [];
    const el = await renderBody("msg-body", { text: "", html: fx.html, onControls: (c) => { last = c; } });
    const history = () => last.find((c) => c.id === "history");
    expect(history()).toMatchObject({ expanded: false, at: "trailing" });
    expect(toggleIn(el), "the body drew the toggle the host takes").toBeNull();
    expect(document.getElementById(history()!.controls!), "the control names no sheet").not.toBeNull();
    await act(async () => { history()!.onPress(); });
    expect(history()).toMatchObject({ expanded: true });
    expect(srcdocText(el)).toContain(qhNorm(fx.expect.html!.historyStartText!));
  });
});

describe("'Show original' shows the sender's whole document", () => {
  it("a folded prose letter flips to its frame unfolded, with no toggle", async () => {
    const fx = FIXTURES.find((f) => f.id === "01")!;
    const el = await renderBody("msg-body", { text: fx.text, html: fx.html });
    expect(toggleIn(el)).not.toBeNull();
    await press(el.querySelector<HTMLButtonElement>("button.mb-flip")!);
    expect(el.querySelector("iframe")).not.toBeNull();
    expect(srcdocText(el)).toContain(qhNorm(fx.expect.html!.historyStartText!));
    expect(toggleIn(el)).toBeNull();
  });
});

describe("the text part rendered instead of the html follows the html's own reading", () => {
  const fx73 = () => FIXTURES.find((f) => f.id === "73")!;
  const fx68 = () => FIXTURES.find((f) => f.id === "68")!;
  const answers = ["Ja, die Filterreinigung ist Position 3 im Angebot.", "Ja, bitte am Empfang hinterlegen."];
  /** Older Outlook hops under 73's history: `lines` paragraphs of `para` each. */
  const hops = (count: number, lines: number, para: string) => {
    let html = "";
    let text = "";
    for (let i = 1; i <= count; i++) {
      const head = [`Von: Carla Muster <carla.muster@example.net>`, `Gesendet: Montag, ${i}. Oktober 2026 08:00`,
        `An: Ben Sample <ben.sample@example.org>`, `Betreff: Begehung ${i}`];
      html += `<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal">${head.map((l) => l.replace(/</g, "&lt;")).join("<br>")}</p></div>`
        + Array.from({ length: lines }, () => `<p class="MsoNormal">${para}</p>`).join("");
      text += `\n\n${head.join("\n")}\n\n${Array.from({ length: lines }, () => para).join("\n\n")}`;
    }
    const fx = fx73();
    return { html: fx.html!.replace("</div></body>", `${html}</div></body>`), text: fx.text + text };
  };
  const shows = (el: Element, s: string) => expect(textOf(el)).toContain(qhNorm(s));

  for (const cls of ["pm-body", "msg-body"]) {
    it(`.${cls}: 73 past the walk's budget stays whole on its text part`, async () => {
      const long = hops(40, 1, "Ein älterer Absatz über die Begehung und den Technikraum. ".repeat(40));
      const { sanitizeMailHtml } = await import("../../../packages/letter-body/src/MessageBody.js");
      const s = sanitizeMailHtml(long.html, { history: true });
      expect([s.prose, s.rich, s.fold]).toEqual([true, null, null]);
      const el = await renderBody(cls, long);
      expect(toggleIn(el)).toBeNull();
      for (const a of answers) shows(el, a);
    });

    it(`.${cls}: 73 past the parse budget stays whole on its text part`, async () => {
      const huge = hops(40, 120, "Eine ältere Zeile.");
      const el = await renderBody(cls, huge);
      expect(el.querySelector(".mb-note")).not.toBeNull();
      expect(toggleIn(el)).toBeNull();
      for (const a of answers) shows(el, a);
    });

    it(`.${cls}: 68 past one frame shows its card on the text part`, async () => {
      const rows = Array.from({ length: 800 }, (_, i) => `<tr><td><p>Story ${i + 1}</p></td></tr>`).join("");
      const html = fx68().html!.replace("</table></td></tr></table>", `${rows}</table></td></tr></table>`);
      const el = await renderBody(cls, { text: fx68().text, html });
      expect(el.querySelector(".mb-note")).not.toBeNull();
      expect(toggleIn(el)).toBeNull();
      shows(el, "From: Support Desk");
      shows(el, "A reply card like this one is what our template builder draws for you.");
    });
  }
});

describe("answers typed into the history keep it open", () => {
  for (const cls of ["pm-body", "msg-body"]) {
    for (const t of qhTypedAnswers()) {
      it(`.${cls}: ${t.name}, with its text part and framed`, async () => {
        for (const props of [{ text: t.text, html: t.html }, { text: "", html: t.html }]) {
          const el = await renderBody(cls, props);
          expect(toggleIn(el)).toBeNull();
          expect(textOf(el) + srcdocText(el)).toContain(qhNorm(t.answer));
        }
      });
    }
  }
});

describe("an Outlook mobile reply over a forwarded booking mail folds its history", () => {
  // The booking mail is laid out on a 600 px canvas with cells in a brand colour; its design is no typed answer.
  const booking = `<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p><b>Von:</b> Example Venue &lt;venue@example.com&gt;<br>`
    + `<b>Gesendet:</b> Dienstag, 6. Oktober 2026 19:05<br><b>An:</b> Clara Example &lt;clara@example.com&gt;<br><b>Betreff:</b> Booking #01234</p></div>`
    + `<table width="600" cellpadding="0" cellspacing="0" style="width:600px"><tr><td>We have received your request for the following slot:</td></tr>`
    + `<tr><td style="color:#1b4f72">(Booking #01234) (</td><td style="color:#1b4f72">4. Mai 2026</td><td style="color:#1b4f72">)</td></tr>`
    + `<tr><td>Room</td><td>Garden</td></tr><tr><td>Guests</td><td>12</td></tr>`
    + `<tr><td style="color:#1b4f72">Contact person</td><td>Ana Sample</td></tr><tr><td style="color:#1b4f72">#00412</td><td>Main hall</td></tr>`
    + `<tr><td>Please bring your confirmation. We look forward to your visit.</td></tr>`
    + `<tr><td style="font-size:9px;color:#999999">Example Venue Ltd, Lake Road 1, 1000 Town</td></tr></table>`;
  const html = `<div dir="ltr"><div>Thanks, Monday works for us. I will send the guest list tomorrow.</div><div>Best</div><div>Ben</div></div>`
    + `<div id="ms-outlook-mobile-signature"><div>Outlook for iOS</div></div>`
    + `<div id="mail-editor-reference-message-container"><hr style="border-width:1pt medium medium;border-style:solid none none;padding:3pt 0in 0in;width:98%">`
    + `<b>Von: </b>Clara Example &lt;clara@example.com&gt;<br><b>Datum: </b>Freitag, 13. November 2026 um 15:28<br><b>An: </b>Ben Sample &lt;ben@example.com&gt;<br><b>Betreff: </b>Re: Booking #01234<br>`
    + `<div id="mail-editor-reference-message-body"><div>Dear Ben,</div><div>here is the plan for the workshop on Monday. We start at nine.</div><div>Clara</div>`
    + `<div class="gmail_quote">On Thu, Nov 12, 2026 at 09:05:12, Dora Test &lt;dora@example.com&gt; wrote:</div>`
    + `<blockquote style="margin: 0px 0px 0px 0.8ex; padding-left: 1ex; border-left: 1px solid rgb(204, 204, 204);"><div>Hello Clara, the garden room is free.</div><div>Dora</div>${booking}</blockquote></div></div>`;
  const text = "Thanks, Monday works for us. I will send the guest list tomorrow.\nBest\nBen\n\nOutlook for iOS\n________________________________\n"
    + "Von: Clara Example <clara@example.com>\nDatum: Freitag, 13. November 2026 um 15:28\nAn: Ben Sample <ben@example.com>\nBetreff: Re: Booking #01234\n\n"
    + "Dear Ben,\nhere is the plan for the workshop on Monday. We start at nine.\nClara\n";
  const first = "Von: Clara Example";
  const history = "Datum: Freitag, 13. November 2026 um 15:28";
  for (const cls of ["pm-body", "msg-body"]) {
    for (const [name, props] of [["framed (no text part)", { text: "", html }], ["with its text part", { text, html }]] as const) {
      it(`.${cls}: ${name}`, async () => {
        const el = await renderBody(cls, { ...props, subject: "AW: AW: WG: Booking #01234" });
        const drawn = () => textOf(el) + " " + srcdocText(el);
        const toggle = toggleIn(el);
        expect(toggle, "no toggle").not.toBeNull();
        expect(drawn()).toContain("Thanks, Monday works for us.");
        expect(drawn()).toContain("Outlook for iOS");
        expect(drawn(), "the history's first line is in the document while folded").not.toContain(first);
        expect(drawn(), "the history is in the document while folded").not.toContain(history);
        expect(drawn()).not.toContain("We look forward to your visit.");
        await press(toggle!);
        expect(toggleIn(el)!.getAttribute("aria-expanded")).toBe("true");
        expect(drawn()).toContain(first);
        expect(drawn()).toContain(history);
      });
    }
  }
});

describe("an html part the reader does not render keeps its reading", () => {
  const card = '<div class="wrap"><p>Example Weekly</p><p>The Example team</p><p>From: Support Desk &lt;desk@example.com&gt;<br>'
    + "Sent: Monday, October 19, 2026 9:00 AM<br>To: A Customer &lt;c@example.org&gt;<br>Subject: Your ticket is solved</p>"
    + "<p>A reply card like this one is what our builder draws.</p></div>";
  it("a canvas declared in the head's sheet: no history found, so its text folds only '>' runs", async () => {
    const { unrenderedHtmlVerdict } = await import("../../../packages/letter-body/src/MessageBody.js");
    expect(unrenderedHtmlVerdict(`<html><head><style>.wrap{max-width:600px}</style></head><body>${card}</body></html>`)).toBe("unread");
    expect(unrenderedHtmlVerdict(`<html><body>${card}</body></html>`)).toBe("trailing");
  });
});
