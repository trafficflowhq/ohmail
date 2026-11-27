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
import { qhFixtures, qhFolds, qhNorm, qhTypedAnswers } from "../../../packages/client-engine/test/quoted-history-fixtures";

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  Linking: { openURL: openedLink.open },
}));
/** The html detector made to throw, as a hostile part might make it. */
const detector = vi.hoisted(() => ({ throws: false }));
vi.mock("@ohmail/client-engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ohmail/client-engine")>();
  return {
    ...real,
    quotedHistoryVerdictOfHtml: (...args: Parameters<typeof real.quotedHistoryVerdictOfHtml>) => {
      if (detector.throws) throw new RangeError("Maximum call stack size exceeded");
      return real.quotedHistoryVerdictOfHtml(...args);
    },
  };
});
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return { Txt: rnDom.Text, Tap: rnDom.Pressable };
});
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: new Proxy({}, { get: () => "#000" }), radius: { pill: 999 }, type: new Proxy({}, { get: () => ({}) }) }),
}));
const openedLink = vi.hoisted(() => ({ compose: vi.fn(), open: vi.fn(async () => undefined) }));
vi.mock("expo-router", () => ({ router: { push: openedLink.compose } }));
vi.mock("../src/state/world", () => ({ useWorldToast: () => ({ say: vi.fn() }) }));
vi.mock("../src/ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  SheetRow: ({ label, onPress }: { label: string; onPress: () => void }) => h("button", { onClick: onPress }, label),
}));

const { BodyPages } = await import("../src/ui/BodyPages");
const { HistoryFold } = await import("../src/ui/HistoryFold");
const { sanitizeMailHtmlPhone } = await import("../src/mail/sanitize");
const { frameNavDecision } = await import("../src/mail/frame-nav");
const { buildPhoneMailDocument } = await import("../src/mail/mail-document");
const { MailLinkSheet } = await import("../src/ui/MailLinks");
const { htmlHistoryVerdict } = await import("../src/mail/quoted-tree");
const { EN } = await import("../src/copy.en");
const { DE } = await import("../src/copy.de");

const FIXTURES = qhFixtures();
const strip = (s: string): string => qhNorm(s.replace(/^[\s>]+/gm, ""));
let mounted: { el: HTMLElement; unmount(): void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  openedLink.compose.mockClear();
  openedLink.open.mockClear();
});

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

it("makes body addresses and URLs into underlined links and asks before opening a website", async () => {
  const url = "https://example.test/contact?veryLongTrackingCode=12345678901234567890";
  const el = body(`Contact desk@example.test or see (${url}). Keep custom:notes and javascript:blocked as text.`, "readerBody");
  const links = [...el.querySelectorAll<HTMLElement>('[data-role="link"]')];
  expect(links.map((link) => link.textContent)).toEqual(["desk@example.test", url]);
  expect(links.every((link) => JSON.parse(link.getAttribute("data-style")!).textDecorationLine === "underline")).toBe(true);
  expect(el.textContent).toContain("custom:notes");
  expect(el.textContent).toContain("javascript:blocked");
  press(links[0]!);
  expect(openedLink.compose).toHaveBeenCalledWith({ pathname: "/compose", params: { mailto: "mailto:desk@example.test" } });
  press(links[1]!);
  expect(openedLink.open).not.toHaveBeenCalled();
  expect(el.textContent).toContain(EN.mailOpenLinkTitle);
  await act(async () => el.querySelector("button")!.click());
  expect(openedLink.open).toHaveBeenCalledWith(url);
});

it.each([
  ["https://example.test/guide_(overview)", "(", ")."],
  ["https://example.test/[guide]", "[", "]."],
])("keeps the destination's own punctuation in %s", async (url, before, after) => {
  const el = body(`See ${before}${url}${after}`, "readerBody");
  const link = el.querySelector<HTMLElement>('[data-role="link"]');
  expect(link?.textContent).toBe(url);
  press(link!);
  await act(async () => el.querySelector("button")!.click());
  expect(openedLink.open).toHaveBeenLastCalledWith(url);
});

it("shows the actual host separately when long user information fills the URL", async () => {
  const hostname = "contact." + "details.".repeat(5) + "example.test";
  const url = `https://${"account".repeat(50)}@${hostname}/guide`;
  mounted = mount(h(MailLinkSheet, { url, onClose: vi.fn() }));
  expect([...mounted.el.querySelectorAll('[data-rn="Text"]')].some((part) => part.textContent === hostname)).toBe(true);
  expect(openedLink.open).not.toHaveBeenCalled();
  await act(async () => mounted!.el.querySelector("button")!.click());
  expect(openedLink.open).toHaveBeenCalledWith(url);
});

it("keeps a formatted link's label and confirms only its admitted destination", () => {
  const url = "https://example.test/contact";
  const part = sanitizeMailHtmlPhone(`<p><a href="${url}">Contact the team</a> <a href="javascript:blocked">Other words</a></p>`);
  const document = new DOMParser().parseFromString(buildPhoneMailDocument(part.html, {
    bg: "#fff", ink: "#111", ink2: "#555", accent: "#923d17", fontScale: 1,
  }), "text/html");
  const anchors = [...document.querySelectorAll("a[href]")];
  expect(anchors.map((anchor) => anchor.textContent)).toEqual(["Contact the team"]);
  expect(document.querySelector("style")?.textContent).toMatch(/a\[href\]\{text-decoration:underline\s*!important\}/);
  expect(frameNavDecision(anchors[0]!.getAttribute("href")!, part.links)).toEqual({ kind: "confirm", url });
  expect(document.body.textContent).toContain("Other words");
});

it("links an address in the formatted reader without altering authored links or code", () => {
  const written = "https://example.test/guide";
  const part = sanitizeMailHtmlPhone(`<p>Write to desk@example.test</p>
    <p><a href="${written}">Visit ${written}</a></p>
    <p><code>https://example.test/template</code></p>`, { linkText: true });
  const body = new DOMParser().parseFromString(part.html, "text/html").body;
  expect([...body.querySelectorAll("a[href]")].map((anchor) => anchor.textContent))
    .toEqual(["desk@example.test", "Visit " + written]);
  expect(part.links).toEqual(["mailto:desk@example.test", written]);
  expect(body.querySelector("code")?.textContent).toBe("https://example.test/template");
});

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

  it("an html part whose reading throws is unread: its text folds by its own reading, and the screen stays", () => {
    const html = "<p>Thanks.</p><div>On Thu, 22 Oct 2026 at 09:14, A wrote:</div><blockquote type=\"cite\"><p>Old words</p></blockquote><p>Throw-once marker</p>";
    detector.throws = true;
    try {
      expect(htmlHistoryVerdict(html)).toBe("unread");
      const el = body("Thanks.\n\n> Old words", "readerBody", [], html);
      expect(shown(el)).toContain("Thanks.");
    } finally {
      detector.throws = false;
    }
  });

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

  // 132-135 and 140: the history holds its own quote and answer (140's message opens with its quote).
  for (const [id, greeting] of [["01", "Hallo Herr Sample,"], ["104", "Hallo Herr Sample,"], ["132", "Hallo Clara,"], ["133", "Hallo Clara,"],
    ["134", "Hallo Clara,"], ["135", "Hallo Clara,"], ["140", "Sag Bescheid, wenn etwas fehlt."]] as const) {
    it(`control: ${id}, a reply whose html folds, folds its text as a member`, () => {
      const fx = FIXTURES.find((f) => f.id === id)!;
      const el = body(fx.text, "streamBody", [], fx.html);
      expect(row(el)).not.toBeNull();
      expect(shown(el)).not.toContain(greeting);
    });
  }

  for (const t of qhTypedAnswers()) {
    it(`answers typed into the history keep it open, member and frame: ${t.name}`, () => {
      for (const variant of ["streamBody", "readerBody"] as const) {
        const el = body(t.text, variant, [], t.html);
        expect(row(el), variant).toBeNull();
        expect(shown(el), variant).toContain(qhNorm(t.answer));
        mounted?.unmount();
        mounted = null;
      }
      const framed = sanitizeMailHtmlPhone(t.html, { fold: true });
      expect(framed.history ?? null).toBeNull();
      expect(framed.html).toContain(t.answer);
    });
  }

  it("a responsive newsletter with a header card is not folded by the frame", () => {
    const html = '<html><body><div style="max-width:600px;margin:0 auto"><h1>Example Weekly</h1><p>This week: how teams answer mail faster.</p>'
      + "<p>From: Support Desk &lt;desk@example.com&gt;<br>Sent: Monday, October 19, 2026 9:00 AM<br>To: A Customer &lt;c@example.org&gt;<br>"
      + "Subject: Your ticket is solved</p><p>A reply card like this one is what our builder draws.</p></div></body></html>";
    const folded = sanitizeMailHtmlPhone(html, { fold: true, linkText: true });
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
    const whole = sanitizeMailHtmlPhone(html, { linkText: true });
    expect(whole.blocked.map((b) => b.url)).toEqual(["https://img.example.com/p.png"]);
    expect(whole.cids).toEqual(["logo@example.com"]);
    expect(whole.links).toEqual(["mailto:a@example.com", "https://example.com/old"]);
  });

  it("folded, the paper is read off the reply drawn: a sheet or wrapper in the quoted history is not its page", () => {
    const REPLY = '<p style="color:#333">Thanks, see below.</p><div><div>On Thu, 22 Oct 2026 at 09:14, A wrote:</div><blockquote type="cite">';
    const SHEET = `${REPLY}<style>body{background:#000000}</style><p style="color:#fff">Old dark letter</p></blockquote></div>`;
    const WRAPPER = `${REPLY}<div style="background:#000000"><p style="color:#fff">Old dark letter</p></div></blockquote></div>`;
    for (const html of [SHEET, WRAPPER]) {
      const folded = sanitizeMailHtmlPhone(html, { fold: true });
      expect(folded.history).not.toBeNull();
      expect(folded.html).not.toContain("Old dark letter");
      expect({ light: folded.light, paper: folded.paper, ink: folded.ink }).toEqual({ light: true, paper: null, ink: null });
      // Opened, the whole letter is drawn, and read whole.
      const open = sanitizeMailHtmlPhone(html);
      expect(open.html).toContain("Old dark letter");
      expect(open.light).toBe(false);
    }
    expect(sanitizeMailHtmlPhone(SHEET).paper).toBe("#000000");
  });
});
