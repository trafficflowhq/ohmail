// @vitest-environment jsdom
/**
 * ═══ THE PHONE READER'S MAIL DOCUMENT SAYS NOTHING THE RULES DO NOT ADMIT ════════════════════
 *
 * The web reader's security cases, asked of the phone's sanitizer (`src/mail/sanitize.ts` over
 * htmlparser2 — RN has no DOM for DOMPurify), plus the phone's own frame rules: no real URL in
 * the document (link tokens), the navigation gate, the height heuristic and the filename strip.
 * Mutations watched (deciding line mutated, seen red, restored, `cmp`-proven): the img cid
 * branch's data-URI gate removed ⇒ hostile-map cases red; the href gate widened ⇒ the
 * javascript:-href and no-sender-URL cases red; the nav exit gate dropped ⇒ poisoned table red.
 */
import { describe, expect, it } from "vitest";
import { BLANK_GIF } from "@ohmail/client-engine";
import { sanitizeMailHtmlPhone, PHONE_LINK_SCHEME } from "../src/mail/sanitize";
import { frameNavDecision } from "../src/mail/frame-nav";
import { buildPhoneMailDocument } from "../src/mail/mail-document";
import { shareFilename } from "../src/mail/open-attachment";
import { blockedNotice } from "../src/mail/notice";
import { DECKS } from "../src/copy";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { within } from "@testing-library/react";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const THEME = { bg: "#fbfaf9", ink: "#251f1b", ink2: "#625952", accent: "#a3461c", fontScale: 1 };

describe("cid images: this message's own parts, exactly", () => {
  it("a missing part draws nothing, costs nothing, and is asked for by id", () => {
    const out = sanitizeMailHtmlPhone('<p>hi</p><img src="cid:logo@x">');
    expect(out.html).toContain(`src="${BLANK_GIF}"`);
    expect(out.cids).toEqual(["logo@x"]);
    expect(out.blocked).toEqual([]); // a cid is never a blocked remote image
  });

  it("brackets are stripped and case is kept — RFC 5322 id-left is case-significant", () => {
    const map = new Map([["Logo@x", PNG]]);
    const bracketed = sanitizeMailHtmlPhone('<img src="cid:<Logo@x>">', { inlineImages: map });
    expect(bracketed.html).toContain(`src="${PNG}"`);
    // The LOWERCASED id is a different id: unresolved, blank, asked for.
    const cased = sanitizeMailHtmlPhone('<img src="cid:logo@x">', { inlineImages: map });
    expect(cased.html).toContain(`src="${BLANK_GIF}"`);
    expect(cased.cids).toEqual(["logo@x"]);
  });

  it("reference order rides into the ask, deduplicated", () => {
    const out = sanitizeMailHtmlPhone('<img src="cid:b"><img src="cid:a"><img src="cid:b">');
    expect(out.cids).toEqual(["b", "a"]);
  });

  it("a non-image or hostile map value is not drawn — the gate sits at the write", () => {
    for (const bad of [
      "data:text/html;base64,PGh0bWw+",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "javascript:alert(1)",
      "https://evil.example/x.png",
    ]) {
      const out = sanitizeMailHtmlPhone('<img src="cid:p@x">', { inlineImages: new Map([["p@x", bad]]) });
      expect(out.html, bad).toContain(`src="${BLANK_GIF}"`);
      expect(out.html, bad).not.toContain(bad);
    }
  });

  it("a `url(cid:…)` in an inline style resolves through the same map and the same gate", () => {
    const map = new Map([["bg@x", PNG], ["evil@x", "data:text/html;base64,x"]]);
    const out = sanitizeMailHtmlPhone(
      '<div style="background:url(cid:bg@x)">a</div><div style="background:url(cid:evil@x)">b</div>',
      { inlineImages: map },
    );
    expect(out.html).toContain(`url(&quot;${PNG}&quot;)`);
    // The ungated value stays a verbatim, inert cid reference — never the hostile bytes.
    expect(out.html).toContain("url(cid:evil@x)");
    expect(out.html).not.toContain("text/html");
  });

  it("a `url(cid:…)` in a STYLE SHEET stays verbatim and inert — the web's own posture", () => {
    const map = new Map([["bg@x", PNG]]);
    const out = sanitizeMailHtmlPhone("<style>.a{background:url(cid:bg@x)}</style><p>x</p>", {
      inlineImages: map,
    });
    expect(out.html).toContain("url(cid:bg@x)");
    expect(out.html).not.toContain(PNG);
  });
});

describe("a picture the sender left unnamed is read as a picture, never as its data", () => {
  /** The pictures a screen reader meets in the document the WebView is handed, by name. */
  const spoken = (html: string, opts: Parameters<typeof sanitizeMailHtmlPhone>[1] = {}): string[] => {
    document.documentElement.innerHTML = buildPhoneMailDocument(sanitizeMailHtmlPhone(html, opts).html, THEME);
    const names: string[] = [];
    within(document.body).queryAllByRole("img", { name: (name) => names.push(name) > 0 });
    return names;
  };
  const map = new Map([["a@x", PNG], ["b@x", PNG]]);

  it("an embedded picture with no alt is named 'Picture' (Bild in German), and a named one keeps its name", () => {
    const html = '<img src="cid:a@x"><img src="cid:b@x" alt="Logo"><img src="cid:a@x" title="Plan">';
    expect(spoken(html, { inlineImages: map })).toEqual([DECKS.en.mailPicture, "Logo", "Plan"]);
    expect(spoken(html)).toEqual([DECKS.en.mailPicture, "Logo", "Plan"]); // unresolved, blank
    expect(DECKS.en.mailPicture).toBe("Picture");
    setActiveLocale("de");
    try {
      expect(spoken('<img src="cid:a@x">', { inlineImages: map })).toEqual(["Bild"]);
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("a tracking pixel or a 1×1 spacer is hidden from the reader; alt='' stays decorative", () => {
    const html =
      '<img src="cid:a@x" width="1" height="1"><img src="https://t.example/wf/open?u=1"><img src="cid:b@x" alt="">';
    expect(spoken(html, { inlineImages: map })).toEqual([]);
  });
});

describe("remote content: blocked, counted, classified", () => {
  it("a remote image is blanked and counted with its host", () => {
    const out = sanitizeMailHtmlPhone('<img src="https://cdn.example.com/pic.jpg" width="400" height="300">');
    expect(out.html).toContain(`src="${BLANK_GIF}"`);
    expect(out.html).not.toContain("cdn.example.com");
    expect(out.blocked).toEqual([
      { url: "https://cdn.example.com/pic.jpg", host: "cdn.example.com", via: "img", pixel: false },
    ]);
  });

  it("the three pixel signals classify: declared 1×1, style-declared, beacon path", () => {
    const declared = sanitizeMailHtmlPhone('<img src="https://t.example/i" width="1" height="1">');
    expect(declared.blocked[0]!.pixel).toBe(true);
    const styled = sanitizeMailHtmlPhone('<img src="https://t.example/i" style="width:1px;height:1px">');
    expect(styled.blocked[0]!.pixel).toBe(true);
    const beacon = sanitizeMailHtmlPhone('<img src="https://t.example/wf/open?u=1" width="600" height="20">');
    expect(beacon.blocked[0]!.pixel).toBe(true);
  });

  /** The beacon path encoding on the phone: `%6F` is `o`, and a reserved escape keeps its meaning. */
  it("a percent-encoded beacon path is a beacon, and /wf%2Fopen is not /wf/open", () => {
    for (const u of ["https://t.example/%6fpen?u=1", "https://t.example/p%69xel.gif", "https://t.example/wf/%6Fpen"]) {
      expect(sanitizeMailHtmlPhone(`<img src="${u}" width="600" height="20">`).blocked[0]!.pixel, u).toBe(true);
    }
    expect(sanitizeMailHtmlPhone('<img src="https://t.example/wf%2Fopen?u=1" width="600" height="20">').blocked[0]!.pixel).toBe(false);
  });

  /** The web's rule, asked of the phone: a size query on a sized picture is not a beacon. */
  it("a sized picture whose url carries a size query is a picture, and resolves", () => {
    const sized = "https://images.example/p.png?w=120";
    const out = sanitizeMailHtmlPhone(`<img src="${sized}" width="120" height="120">`, {
      resolvedRemote: new Map([[sized, PNG]]),
    });
    expect(out.blocked[0]!.pixel, "the sized picture was called a tracking pixel").toBe(false);
    expect(out.html, "the sized picture was left blank").toContain(PNG);
    const gif = sanitizeMailHtmlPhone('<img src="https://t.example/b.gif?u=1" width="1" height="1">');
    expect(gif.blocked[0]!.pixel).toBe(true);
  });

  it("a consented resolution enters ONLY through the gate, and never for a pixel", () => {
    const resolved = new Map([
      ["https://cdn.example.com/pic.jpg", PNG],
      ["https://t.example/wf/open?u=1", PNG],
      ["https://cdn.example.com/evil.jpg", "data:text/html;base64,x"],
    ]);
    const out = sanitizeMailHtmlPhone(
      '<img src="https://cdn.example.com/pic.jpg"><img src="https://t.example/wf/open?u=1" width="1" height="1"><img src="https://cdn.example.com/evil.jpg">',
      { resolvedRemote: resolved },
    );
    expect(out.html).toContain(PNG); // the picture
    const blanks = out.html.split(BLANK_GIF).length - 1;
    expect(blanks).toBe(2); // the beacon AND the ungated value stay blank
  });

  it("srcset and background are dropped whole and still counted", () => {
    const out = sanitizeMailHtmlPhone(
      '<img src="cid:a" srcset="https://a.example/1x.png 1x, https://a.example/2x.png 2x"><td background="https://b.example/t.gif">x</td>',
    );
    expect(out.html).not.toContain("srcset");
    expect(out.html).not.toContain("background=");
    const urls = out.blocked.map((b) => b.url).sort();
    expect(urls).toEqual([
      "https://a.example/1x.png",
      "https://a.example/2x.png",
      "https://b.example/t.gif",
    ]);
  });

  it("a remote stylesheet import is cut, said separately, and css remote urls are counted", () => {
    const out = sanitizeMailHtmlPhone(
      '<style>@import "https://s.example/mail.css"; .a{background:url(https://c.example/bg.png)}</style><p>x</p>',
    );
    expect(out.sheets).toEqual(["https://s.example/mail.css"]);
    expect(out.blocked).toEqual([
      { url: "https://c.example/bg.png", host: "c.example", via: "css", pixel: false },
    ]);
    expect(out.html).not.toContain("s.example");
    expect(out.html).toContain("none");
  });

  // CSS Syntax 4.3.5: an escaped newline inside a string continues it and is removed.
  it("a url string with an escaped CRLF is counted and resolved under the name CSS reads", () => {
    const meant = "https://c.example/assets/css3.png";
    const html = '<style>.a{background:url("https://c.example/assets/css3\\\r\n.png")}</style><p>x</p>';
    expect(sanitizeMailHtmlPhone(html).blocked).toEqual([{ url: meant, host: "c.example", via: "css", pixel: false }]);
    expect(sanitizeMailHtmlPhone(html, { resolvedRemote: new Map([[meant, PNG]]) }).html).toContain(PNG);
  });
});

describe("what the document may say", () => {
  it("script, iframe and object are stripped; script content goes with it", () => {
    const out = sanitizeMailHtmlPhone(
      '<p>a</p><script>document.title="x"</script><iframe src="https://e.example"></iframe><object data="x"><b>kept</b></object>',
    );
    expect(out.html).not.toContain("script");
    expect(out.html).not.toContain("iframe");
    expect(out.html).not.toContain("object");
    expect(out.html).not.toContain("document.title");
    expect(out.html).toContain("<b>kept</b>"); // a refused tag outside DROP_CONTENT keeps children
  });

  it("a javascript: href is refused — visible, inert, no token minted", () => {
    const out = sanitizeMailHtmlPhone('<a href="javascript:alert(1)">press</a>');
    expect(out.html).toContain(">press</a>");
    expect(out.html).not.toContain("href");
    expect(out.links).toEqual([]);
  });

  it("no sender URL enters the document: links become indexed tokens", () => {
    const out = sanitizeMailHtmlPhone(
      '<a href="https://shop.example/sale?x=1">sale</a><a href="mailto:a@b.c">write</a><a href="cid:part@x">part</a>',
    );
    expect(out.links).toEqual(["https://shop.example/sale?x=1", "mailto:a@b.c"]);
    expect(out.html).toContain(`href="${PHONE_LINK_SCHEME}0"`);
    expect(out.html).toContain(`href="${PHONE_LINK_SCHEME}1"`);
    expect(out.html).not.toContain("shop.example");
    expect(out.html).not.toContain("mailto:");
    expect(out.html).not.toContain("cid:part@x"); // a cid href is inert, not a token
  });

  it("presentation survives; text and attributes are re-escaped on emit", () => {
    const out = sanitizeMailHtmlPhone(
      '<table width="100%" align="center" cellpadding="0"><tr><td bgcolor="#fff" title="a<b">1 < 2 & 3</td></tr></table>',
    );
    expect(out.html).toContain('width="100%"');
    expect(out.html).toContain('align="center"');
    expect(out.html).toContain('title="a&lt;b"');
    expect(out.html).toContain("1 &lt; 2 &amp; 3");
  });

  it("a style element cannot close itself — `<` leaves as a CSS escape", () => {
    const out = sanitizeMailHtmlPhone("<style>.a{content:\"</style><img src=x onerror=1>\"}</style>");
    const styleBody = out.html.slice(out.html.indexOf("<style>") + 7, out.html.indexOf("</style>"));
    expect(styleBody).not.toContain("<");
    expect(out.html).not.toContain("onerror");
  });

  it("head styles are carried into the document in source order; head itself is dropped", () => {
    const out = sanitizeMailHtmlPhone(
      "<html><head><title>t</title><style>.a{color:red}</style></head><body><p>x</p></body></html>",
    );
    expect(out.html.startsWith("<style>")).toBe(true);
    expect(out.html).toContain(".a{color:red}");
    expect(out.html).not.toContain("title");
  });

  it("an oversize html part is not rendered at all", () => {
    const out = sanitizeMailHtmlPhone(`<p>${"a".repeat(513 * 1024)}</p>`);
    expect(out.oversize).toBe(true);
    expect(out.html).toBe("");
  });
});

describe("the frame's navigation gate", () => {
  const links = ["https://shop.example/x", "mailto:a@b.c"];
  it("admits only the document's own load", () => {
    expect(frameNavDecision("about:blank", links)).toEqual({ kind: "load" });
    expect(frameNavDecision("data:text/html;charset=utf-8,x", links)).toEqual({ kind: "load" });
    expect(frameNavDecision("https://shop.example/x", links)).toEqual({ kind: "refuse" });
    expect(frameNavDecision("file:///etc/passwd", links)).toEqual({ kind: "refuse" });
  });
  it("maps a token to its confirm, and only an exact index", () => {
    expect(frameNavDecision("ohmail-link:0", links)).toEqual({ kind: "confirm", url: links[0] });
    // A mailto goes to ohmail's own composer, not the confirm sheet (PHONE-MAILTO-LEAVES-THE-APP).
    expect(frameNavDecision("ohmail-link:1", links)).toEqual({ kind: "compose", url: links[1] });
    for (const bad of ["ohmail-link:2", "ohmail-link:-1", "ohmail-link:1junk", "ohmail-link:+1", "ohmail-link:"]) {
      expect(frameNavDecision(bad, links), bad).toEqual({ kind: "refuse" });
    }
  });
  it("re-asks the gate at the exit — a poisoned table cannot open", () => {
    expect(frameNavDecision("ohmail-link:0", ["javascript:alert(1)"])).toEqual({ kind: "refuse" });
    expect(frameNavDecision("ohmail-link:0", ["cid:part@x"])).toEqual({ kind: "refuse" });
  });
});

describe("the document shell and the strip's helpers", () => {
  it("carries the lockdown CSP and the theme, and bounds every image to the pane", () => {
    const doc = buildPhoneMailDocument("<p>x</p>", THEME);
    expect(doc).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(doc).toContain("img{max-width:100%");
    expect(doc).toContain(THEME.bg);
    expect(doc).toContain("<p>x</p>");
  });
  it("a sender's height on html or body cannot pin the document to the frame it is measured in", () => {
    expect(buildPhoneMailDocument("<p>x</p>", THEME)).toContain(":root,:root>body{height:auto !important}");
  });
  it("the reader's gutter carries the body's alignment, and a table cell breaks words only where it must", () => {
    const doc = buildPhoneMailDocument("<p>x</p>", THEME);
    expect(doc).toContain("body{margin:0;padding:14px 16px 20px;");
    // `word-break:break-word` on body collapsed an auto-layout column to one glyph a line ("Ro / w / 1").
    expect(doc).toContain("td,th{word-break:normal}");
    expect(doc).toContain("overflow-wrap:break-word");
  });
  it("a sender-authored filename cannot leave the cache directory", () => {
    const traversal = shareFilename("../../etc/passwd");
    expect(traversal).not.toContain("/");
    expect(traversal.startsWith(".")).toBe(false);
    expect(shareFilename("a/b\\c:d.pdf")).toBe("a_b_c_d.pdf");
    expect(shareFilename("...")).toBe("attachment");
    expect(shareFilename("x".repeat(300)).length).toBe(128);
  });
});

describe("a letter is set on a light sheet, and a dark reader inverts only a light one", () => {
  const INVERT = { paper: "#e4e4e4", canvas: "#1b1b1b" };
  const FILTER = "filter:invert(1) hue-rotate(180deg)";
  it("the sheet is light whatever the app's scheme: the light paper and ink, no dark colour scheme", () => {
    const doc = buildPhoneMailDocument("<p>x</p>", THEME);
    expect(doc).toContain(":root{color-scheme:light}");
    expect(doc).toContain(`background:${THEME.bg};color:${THEME.ink}`);
    expect(doc).not.toContain(FILTER);
  });
  it("inverted, the body flips as a whole onto the dark sheet and every picture flips back", () => {
    const doc = buildPhoneMailDocument('<p style="color:#333">Hi</p><img src="x">', { ...THEME, invert: INVERT });
    expect(doc).toContain(`body{background:${INVERT.paper};${FILTER}}`);
    expect(doc).toContain(`:root{background:${INVERT.canvas}}`);
    expect(doc).toContain(`img,video,picture,[style*="url(" i]{${FILTER}}`);
    // After the base rule, so the inverted paper wins over the light one.
    expect(doc.indexOf(`body{background:${INVERT.paper}`)).toBeGreaterThan(doc.indexOf(`background:${THEME.bg}`));
  });
  it("a mail that declares no paper, or a light one, is light; a dark canvas is not", () => {
    const light = (html: string) => sanitizeMailHtmlPhone(html).light;
    expect(light('<p style="color:#333">Plain bulk mail</p>')).toBe(true);
    expect(light('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>')).toBe(true);
    expect(light('<body bgcolor="#111"><p>x</p></body>')).toBe(false);
    expect(light('<html><head><style>body{background:#0b0b0b}</style></head><body><p>x</p></body></html>')).toBe(false);
    expect(light('<div style="background:#111 url(x) no-repeat"><p style="color:#eee">x</p></div>')).toBe(false);
    expect(light('<table style="background-color:rgb(17,17,17)"><tr><td>x</td></tr></table>')).toBe(false);
    // A translucent wash or a highlighted word is not the paper.
    expect(light('<div style="background:rgba(0,0,0,.2)"><p>x</p></div>')).toBe(true);
    expect(light('<p>a <span style="background:#000;color:#fff">word</span></p>')).toBe(true);
  });
  it("the page's own paper and ink are read off body; a wrapper's ground paints only itself", () => {
    const of = (html: string) => { const m = sanitizeMailHtmlPhone(html); return { paper: m.paper, ink: m.ink }; };
    expect(of('<body bgcolor="#000" text="#fff"><p>x</p></body>')).toEqual({ paper: "#000000", ink: "#ffffff" });
    expect(of('<body style="background-color:#121212;color:#f5f5f5"><p>x</p></body>')).toEqual({ paper: "#121212", ink: "#f5f5f5" });
    // A function colour keeps its spaces (rgb(18, 18, 18)), inline and in the page's own rule.
    const spaced = sanitizeMailHtmlPhone('<body style="background-color: rgb(18, 18, 18); color: rgb(245, 245, 245)"><p>x</p></body>');
    expect({ light: spaced.light, paper: spaced.paper, ink: spaced.ink }).toEqual({ light: false, paper: "#121212", ink: "#f5f5f5" });
    expect(of('<html><head><style>body{background: url(x.png) rgb(16, 16, 16)}</style></head><body><p>x</p></body></html>').paper).toBe("#101010");
    expect(of('<table><tr><td bgcolor="#111">Brand</td></tr><tr><td style="color:#333">Shipped</td></tr></table>')).toEqual({ paper: null, ink: null });
    // A body that writes light ink for its dark wrapper keeps that wrapper's ground as the page's.
    expect(of('<body style="color:#fff"><table bgcolor="#000"><tr><td>x</td></tr></table></body>')).toEqual({ paper: "#000000", ink: "#ffffff" });
  });
  it("a body rule inside an at-rule block (the sender's own dark adaptation) is not the page's paper", () => {
    const of = (sheet: string) => {
      const m = sanitizeMailHtmlPhone(`<html><head><style>${sheet}</style></head><body><table><tr><td style="color:#333333">Your receipt</td></tr></table></body></html>`);
      return { light: m.light, paper: m.paper };
    };
    const LIGHT = { light: true, paper: null };
    expect(of("@media (prefers-color-scheme: dark){ .logo{display:none} body{background-color:#1e1e1e !important} }")).toEqual(LIGHT);
    expect(of("@media (prefers-color-scheme: dark){ body{background:#1e1e1e} .logo{display:none} }")).toEqual(LIGHT);
    expect(of("@supports (color:red){ @media (prefers-color-scheme:dark){ .a{color:#fff} html,body{background:#000} } } .b{color:red}")).toEqual(LIGHT);
    expect(of("p{margin:0}/* body{background:#000} */")).toEqual(LIGHT);
    // A top-level rule after the blocks, or in a picture's url, still reads.
    expect(of("@import url(x.css); @media screen{ body{background:#fff} } body{background:#0b0b0b}")).toEqual({ light: false, paper: "#0b0b0b" });
    expect(of("body{background:url(logo@2x.png) #101010}")).toEqual({ light: false, paper: "#101010" });
  });
  it("the drawn sheet holds no condition: a dark-scheme block is dropped, a light one unwrapped, a quoted brace kept", () => {
    const { html } = sanitizeMailHtmlPhone(
      '<html><head><style>@media (prefers-color-scheme: dark){body{background:#1e1e1e !important}} @media (prefers-color-scheme: light){.x{color:red}}'
      + ' .q::after{content:"@media (prefers-color-scheme: dark){"} @supports (color:red){@media screen and (prefers-color-scheme:dark){.y{color:#fff}}}</style></head><body><p>x</p></body></html>',
    );
    expect(html).not.toContain("#1e1e1e");
    expect(html).not.toContain(".y{");
    expect(html).toContain(".x{color:red}");
    expect(html).toContain('content:"@media (prefers-color-scheme: dark){"');
    expect(html.replace('"@media (prefers-color-scheme: dark){"', "")).not.toMatch(/@media|@supports/);
    // A sheet's own media attribute is read by the same rule: a dark-only sheet is dropped, a light one kept.
    const dark = sanitizeMailHtmlPhone('<html><head><style media="(prefers-color-scheme: dark)">body{background:#111111}</style></head><body><p>x</p></body></html>');
    expect(dark.html).not.toContain("#111111");
    expect(dark.light).toBe(true);
    const light = sanitizeMailHtmlPhone('<html><head><style media="screen and (prefers-color-scheme: light)">body{background:#0b0b0b}</style></head><body><p>x</p></body></html>');
    expect(light.html).toContain("body{background:#0b0b0b}");
    expect({ light: light.light, paper: light.paper }).toEqual({ light: false, paper: "#0b0b0b" });
  });
  it("the page rule the gate reads is the one painted: a light-scheme block applies, the last body rule wins, a quoted brace is text", () => {
    const of = (sheet: string) => {
      const m = sanitizeMailHtmlPhone(`<html><head><style>${sheet}</style></head><body><table><tr><td style="color:#333333">Your receipt</td></tr></table></body></html>`);
      return { light: m.light, paper: m.paper };
    };
    const LIGHT = { light: true, paper: null };
    const DARK = { light: false, paper: "#0b0b0b" };
    expect(of("@media (prefers-color-scheme: light){ body{background:#0b0b0b} }")).toEqual(DARK);
    expect(of("body{background:#ffffff} @media screen{ body{background-color:#0b0b0b} }")).toEqual(DARK);
    expect(of("body{background:#0b0b0b} @media (prefers-color-scheme: light){ body{background:#ffffff} }")).toEqual(LIGHT);
    expect(of("body{background:#ffffff} html{background:#0b0b0b}")).toEqual(LIGHT);
    expect(of('@media print{.a::after{content:"}"} body{background:#0b0b0b}}')).toEqual(LIGHT);
    expect(of('@media (prefers-color-scheme: dark){.a::after{content:"\\"}"} body{background:#0b0b0b}}')).toEqual(LIGHT);
    expect(of("@media print{.a{color:red}/* } */ body{background:#0b0b0b}}")).toEqual(LIGHT);
    expect(of('.a::after{content:"}"} body{background:#0b0b0b}')).toEqual(DARK);
  });
  it("the page is read at the frame's own width: a size block is the page exactly where the frame is that size", () => {
    const of = (sheet: string, width: number) => {
      const m = sanitizeMailHtmlPhone(`<html><head><style>${sheet}</style></head><body><p style="color:#eeeeee">Night edition</p></body></html>`, { frame: { width } });
      return { light: m.light, paper: m.paper };
    };
    const LIGHT = { light: true, paper: null };
    const DARK = { light: false, paper: "#0b0b0b" };
    for (const wrap of ["@media all", "@media screen", "@media only screen", "@media screen, print", "@media not print",
      "@supports (display:grid)", "@layer base", "@media (prefers-color-scheme: light)", "@media (max-height: 900px)"]) {
      for (const w of [343, 730]) expect(of(`${wrap}{ .a{color:red} body{background:#0b0b0b} }`, w), `${wrap} at ${w}`).toEqual(DARK);
    }
    for (const wrap of ["@media screen and (max-width: 600px)", "@media only all and (orientation: portrait)", "@media screen and (max-device-width: 480px)",
      "@media print, (max-width: 600px)", "@media (prefers-color-scheme: light) and (max-width: 600px)"]) {
      expect(of(`${wrap}{ body{background:#0b0b0b} }`, 343), wrap).toEqual(DARK);
      expect(of(`${wrap}{ body{background:#0b0b0b} }`, 730), wrap).toEqual(LIGHT);
    }
    expect(of("@media (min-aspect-ratio: 1/1){ body{background:#0b0b0b} }", 343)).toEqual(LIGHT);
    expect(of("@media (min-aspect-ratio: 1/1){ body{background:#0b0b0b} }", 730)).toEqual(DARK);
    for (const wrap of ["@media tv", "@media not screen", "@container (min-width: 0)", "@media screen and (hover: hover)",
      "@media print", "@media speech", "@media screen and (prefers-color-scheme: dark)", "@media (prefers-reduced-motion: reduce)", "@font-face", "@keyframes k"]) {
      for (const w of [343, 730]) expect(of(`${wrap}{ body{background:#0b0b0b} }`, w), `${wrap} at ${w}`).toEqual(LIGHT);
    }
    // The resolution names the widths it compared against, so the frame knows when to read it again.
    const narrow = sanitizeMailHtmlPhone("<style>@media only screen and (max-width:600px){body{background-color:#000000}}</style><p>Words</p>", { frame: { width: 343 } });
    expect({ light: narrow.light, frameWidth: narrow.frameWidth, breaks: narrow.breaks }).toEqual({ light: false, frameWidth: 343, breaks: [{ px: 600, strict: true }] });
    expect(narrow.html).toContain("body{background-color:#000000}");
    expect(narrow.html).not.toContain("@media");
  });
  it("the page is the html/body rule the frame paints, not the body's own background, which the frame never draws", () => {
    const of = (html: string) => {
      const m = sanitizeMailHtmlPhone(html);
      return { light: m.light, paper: m.paper, ink: m.ink };
    };
    const BLACK_BODY = 'style="background:#000;color:#fff"';
    // The body's own light ink is not taken on the light page painted over it.
    expect(of(`<html><head><style>body{background:#ffffff}</style></head><body ${BLACK_BODY}><p>words</p></body></html>`))
      .toEqual({ light: true, paper: null, ink: null });
    expect(of(`<html><body ${BLACK_BODY}><style>body{background:#ffffff}</style><p>words</p></body></html>`))
      .toEqual({ light: true, paper: null, ink: null });
    // With no such rule the body's own background is the page.
    expect(of(`<html><body ${BLACK_BODY}><p>words</p></body></html>`)).toEqual({ light: false, paper: "#000000", ink: "#ffffff" });
    // A sheet before the body is drawn as a browser's parser draws it: in the head.
    expect(of('<style>body{background:#000000}</style><body style="background:#fff;color:#111"><p>words</p></body>'))
      .toEqual({ light: false, paper: "#000000", ink: null });
  });
  it("a deeply nested letter is read without throwing; a block past the depth is not drawn", () => {
    for (const k of [1_000, 12_000, 30_000]) {
      for (const open of ["@layer a{", "@supports (a:b){"]) {
        const m = sanitizeMailHtmlPhone(`<html><head><style>${open.repeat(k)}body{background:#0b0b0b}${"}".repeat(k)}</style></head><body><p>x</p></body></html>`);
        expect({ oversize: m.oversize, light: m.light, paper: m.paper }, `${open} x${k}`).toEqual({ oversize: undefined, light: true, paper: null });
      }
    }
    // A crafted body style or page rule stays a light letter, read in bounded work.
    expect(sanitizeMailHtmlPhone(`<body style="background: ${"a ".repeat(120_000)}"><p>x</p></body>`).light).toBe(true);
    expect(sanitizeMailHtmlPhone(`<html><head><style>body{background: ${"a ".repeat(120_000)}}</style></head><body><p>x</p></body></html>`).light).toBe(true);
  });
});

describe("the notice says what happened, in both languages", () => {
  const b = (n: number, pixels: number) =>
    Array.from({ length: n }, (_, i) => ({
      url: `https://x.example/${i}`,
      host: "x.example",
      via: "img" as const,
      pixel: i < pixels,
    }));
  it("blocked: the images lead, the pixels follow, the sheet stays last", () => {
    expect(blockedNotice(b(3, 1), [], false, null)).toBe(
      `${DECKS.en.mailImagesBlockedMany(3)} ${DECKS.en.mailPixelOne}`,
    );
    expect(blockedNotice(b(1, 1), ["https://s.example/a.css"], false, null)).toBe(
      `${DECKS.en.mailPixelOnly} ${DECKS.en.mailSheetBlockedOne}`,
    );
    expect(blockedNotice([], [], false, null)).toBeNull();
  });
  it("before the press, a door with no server proxy says whose address the senders see", () => {
    expect(blockedNotice(b(3, 1), [], false, "phone")).toBe(
      `${DECKS.en.mailImagesBlockedMany(3)} ${DECKS.en.mailPixelOne} ${DECKS.en.mailImagesFromPhone}`,
    );
    expect(blockedNotice(b(2, 0), ["https://s.example/a.css"], false, "computer")).toBe(
      `${DECKS.en.mailImagesBlockedMany(2)} ${DECKS.en.mailImagesFromComputer} ${DECKS.en.mailSheetBlockedOne}`,
    );
    // Only beacons blocked: there is nothing to show, so nothing to warn about.
    expect(blockedNotice(b(1, 1), [], false, "phone")).toBe(DECKS.en.mailPixelOnly);
  });
  it("shown: only the refused beacons are said", () => {
    expect(blockedNotice(b(3, 2), [], true, "phone")).toBe(DECKS.en.mailPixelsRefused(2));
    expect(blockedNotice(b(3, 0), [], true, "computer")).toBeNull();
  });
  it("shown: a picture this phone fetched whose own bytes are a pixel joins the refused beacons", () => {
    expect(blockedNotice(b(3, 1), [], true, "phone", 1)).toBe(DECKS.en.mailPixelsRefused(2));
    expect(blockedNotice(b(3, 0), [], true, "phone", 1)).toBe(DECKS.en.mailPixelOnly);
  });
});
