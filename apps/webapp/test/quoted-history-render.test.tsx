/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { qhFixtures, qhFolds, qhNorm, type QhFixture } from "../../../packages/client-engine/test/quoted-history-fixtures.js";

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

async function renderBody(cls: string, props: { text: string; html: string | null }): Promise<HTMLDivElement> {
  await unmount();
  const { MessageBody } = await import("../app/components/MessageBody.js");
  host = document.createElement("div");
  host.className = cls;
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, { messageId: "m1", ...props })); });
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
          const el = await renderBody(cls, { text: fx.text, html: fx.html });
          if (el.querySelector("iframe")) await checkFramed(el, fx, html);
          else await checkProse(el, fx, html);
        });
        it(`${fx.name} — framed (no text part)`, async () => {
          const el = await renderBody(cls, { text: "", html: fx.html });
          await checkFramed(el, fx, html);
        });
      }
      if (text !== null) {
        it(`${fx.name} — its text part`, async () => {
          const el = await renderBody(cls, { text: fx.text, html: null });
          await checkProse(el, fx, text);
        });
      }
    }
  });
}

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
      const { sanitizeMailHtml } = await import("../app/components/MessageBody.js");
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

describe("an html part the reader does not render keeps its reading", () => {
  const card = '<div class="wrap"><p>Example Weekly</p><p>The Example team</p><p>From: Support Desk &lt;desk@example.com&gt;<br>'
    + "Sent: Monday, October 19, 2026 9:00 AM<br>To: A Customer &lt;c@example.org&gt;<br>Subject: Your ticket is solved</p>"
    + "<p>A reply card like this one is what our builder draws.</p></div>";
  it("a canvas declared in the head's sheet: no history found, so its text folds only '>' runs", async () => {
    const { unrenderedHtmlVerdict } = await import("../app/components/MessageBody.js");
    expect(unrenderedHtmlVerdict(`<html><head><style>.wrap{max-width:600px}</style></head><body>${card}</body></html>`)).toBe("unread");
    expect(unrenderedHtmlVerdict(`<html><body>${card}</body></html>`)).toBe("trailing");
  });
});
