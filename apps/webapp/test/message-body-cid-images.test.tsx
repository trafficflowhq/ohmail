/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/react";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../app/shell/locale";

/**
 * ── EMBEDDED (`cid:`) IMAGES RENDER IN PLACE, FROM THE MESSAGE'S OWN BYTES ──────────────────
 *
 * A `cid:` src names a part of the very message being read — a signature logo, a pasted
 * screenshot — and until this slice every one of them rendered as a blanked box while the part
 * was listed as a downloadable "attachment". Now the shell fetches the referenced parts and
 * hands their bytes in as `data:` URIs ({@link SanitizeOptions.cidImages}), and the post-pass
 * resolves the reference — an ATTRIBUTE write, which is the only kind of write the post-pass is
 * allowed (the mutation-XSS rule this component is arranged around).
 *
 * The security half is the map-value gate. The map arrives through a PROP, so "only the engine
 * fills it" is wiring, not a property of this component — `INLINE_IMAGE_SRC` is what makes a
 * hostile value indistinguishable from an absent one. Every assertion on it was watched go red
 * against the named mutation and then restored.
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
afterEach(async () => { await unmount(); });

type Mod = typeof import("../app/components/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/components/MessageBody.js");

async function clean(html: string, opts: Parameters<Mod["sanitizeMailHtml"]>[1] = {}) {
  const { sanitizeMailHtml } = await mod();
  return sanitizeMailHtml(html, opts);
}

async function render(props: Parameters<Mod["MessageBody"]>[0]): Promise<HTMLDivElement> {
  await unmount();
  const { MessageBody } = await mod();
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(MessageBody, props)); });
  return host;
}

const srcdoc = (): string =>
  host!.querySelector("iframe")?.getAttribute("srcdoc") ?? "";

/** A well-formed tiny PNG data URI — the only shape a resolved embedded image may take. */
const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

/** A 1×1 transparent GIF is what every unresolved or refused image is blanked to. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const SIGNED_LETTER =
  `<p>Hello</p><img src="cid:logo@corp"><p>— Anna</p>`;

/** A declared 600px canvas — rigid, so the component renders it FRAMED. */
const NEWSLETTER =
  `<table width="600" cellpadding="0"><tr><td>` +
  `<img src="cid:logo@corp" width="600" height="120">` +
  `<p>This month at the atelier.</p></td></tr></table>`;

describe("sanitizeMailHtml — cid resolution", () => {
  it("resolves a referenced cid to the supplied data: URI, in place", async () => {
    // THE FEATURE. Mutation: delete the `CID_URL` branch of the img post-pass — the image
    // falls through to the blanking branch, this goes red on the src, and the `cids` report
    // below goes red with it.
    const out = await clean(SIGNED_LETTER, { cidImages: new Map([["logo@corp", PNG_URI]]) });
    expect(out.html).toContain(`src="${PNG_URI}"`);
    expect(out.html, "a resolved image is not a blanked one").not.toContain("data-ohmail-embedded");
    expect(out.cids, "nothing left for the shell to fetch").toEqual([]);
  });

  it("an unresolved cid stays a blanked box and is REPORTED, distinct and in document order", async () => {
    const out = await clean(
      `<img src="cid:one@corp"><img src="cid:two@corp"><img src="cid:one@corp">`,
    );
    expect(out.html).not.toContain("cid:");
    expect(out.html).toContain("data-ohmail-embedded");
    expect(out.html).toContain(BLANK);
    expect(out.cids).toEqual(["one@corp", "two@corp"]);
  });

  it("a partially resolved document reports exactly the remainder", async () => {
    const out = await clean(
      `<img src="cid:one@corp"><img src="cid:two@corp">`,
      { cidImages: new Map([["one@corp", PNG_URI]]) },
    );
    expect(out.html).toContain(`src="${PNG_URI}"`);
    expect(out.cids).toEqual(["two@corp"]);
  });

  it("REFUSES every map value that is not a small-raster data: URI — the gate on the prop boundary", async () => {
    // THE GUARD. Mutation: `const INLINE_IMAGE_SRC = /./` — every hostile src below lands
    // verbatim in the frame's markup and each assertion goes red on it. The map arrives
    // through a prop, so this gate is what makes "only the engine fills it" unnecessary
    // to trust.
    const hostile = new Map([
      ["a@x", "javascript:alert(1)"],
      ["b@x", "data:text/html;base64,PHNjcmlwdD5mZXRjaCgnaHR0cHM6Ly9ldmlsLmV4YW1wbGUnKTwvc2NyaXB0Pg=="],
      ["c@x", "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9J3N0ZWFsKCknPjwvc3ZnPg=="],
      ["d@x", 'data:image/png;base64,abc" onerror="fetch(\'https://evil.example\')'],
      ["e@x", "https://evil.example/definitely-not-inline.png"],
    ]);
    const out = await clean(
      `<img src="cid:a@x"><img src="cid:b@x"><img src="cid:c@x"><img src="cid:d@x"><img src="cid:e@x">`,
      { cidImages: hostile },
    );
    expect(out.html).not.toContain("javascript:");
    expect(out.html).not.toContain("text/html");
    expect(out.html).not.toContain("svg");
    expect(out.html).not.toContain("onerror");
    expect(out.html).not.toContain("evil.example");
    // Every one of them is the ordinary blanked box, and every one is still reported, so a
    // legitimate fetch can replace a hostile map with a real one.
    expect(out.cids).toEqual(["a@x", "b@x", "c@x", "d@x", "e@x"]);
  });

  it("matches the Content-ID exactly: brackets and whitespace stripped, case KEPT", async () => {
    // THE EXACT-MATCH LINE. `cidOfSrc` strips the scheme, one layer of angle brackets and the
    // surrounding whitespace — mime.ts stores contentId the same way — and the lookup is the
    // map's own `===`. Mutation: lowercase the cid before `cidImages?.get(cid)` — the cased
    // reference below resolves against the wrong key and the case assertion goes red.
    const out = await clean(
      `<img src="cid:<logo@corp>"><img src="cid: logo@corp "><img src="cid:LOGO@corp">`,
      { cidImages: new Map([["logo@corp", PNG_URI]]) },
    );
    // Both bracket and whitespace spellings resolve to the one part…
    expect(out.html.split(`src="${PNG_URI}"`).length - 1).toBe(2);
    // …and the case variant does NOT: RFC 5322 makes id-left case-significant, and the error
    // directions are not symmetric (a missed match is a blank box; a false match would paint
    // another part's bytes). It stays blanked and is reported under its own spelling.
    expect(out.cids).toEqual(["LOGO@corp"]);
  });

  it("an empty cid — `src=\"cid:\"` — is blanked and never reported", async () => {
    // `cidOfSrc` answers null for the empty id: there is nothing to fetch and nothing to key
    // a map entry on, so reporting it would make the shell ask the engine for "".
    const out = await clean(`<img src="cid:"><img src="cid:<>">`);
    expect(out.html).not.toContain("cid:");
    expect(out.html).toContain("data-ohmail-embedded");
    expect(out.cids).toEqual([]);
  });

  it("resolves url(cid:…) in an inline STYLE ATTRIBUTE from the same map, through the same gate", async () => {
    // The substitution is an ATTRIBUTE write (`neutraliseStyleAttr`), which is the only kind of
    // write the post-pass may perform. Mutation: drop the `INLINE_IMAGE_SRC` test from `cssCid`
    // — the hostile value below lands in a style attribute and its assertion goes red.
    const resolved = await clean(
      `<div style="background:url(cid:logo@corp)">x</div>`,
      { cidImages: new Map([["logo@corp", PNG_URI]]) },
    );
    // The serializer escapes the quotes (`&quot;`), so the assertion is on the URI and on the
    // reference being gone rather than on one escaping of the wrapper.
    expect(resolved.html).toContain(PNG_URI);
    expect(resolved.html).not.toContain("cid:logo@corp");
    expect(resolved.cids).toEqual([]);
  });

  it("an unresolved style url(cid:) stays verbatim — inert — and is REPORTED, never counted blocked", async () => {
    const out = await clean(`<div style="background:url(cid:bg@corp)">x</div>`);
    expect(out.html).toContain("url(cid:bg@corp)");
    expect(out.cids).toEqual(["bg@corp"]);
    // A `cid:` is not a remote image: no entry in the blocked list, no "images blocked" notice.
    expect(out.blocked).toEqual([]);
  });

  it("a hostile map value never reaches a style attribute", async () => {
    const out = await clean(
      `<div style="background:url(cid:a@x)">x</div>`,
      { cidImages: new Map([["a@x", "javascript:alert(1)"]]) },
    );
    expect(out.html).not.toContain("javascript:");
    expect(out.html).toContain("url(cid:a@x)");
    expect(out.cids).toEqual(["a@x"]);
  });

  it("a `<style>` SHEET keeps its url(cid:) verbatim — no substitution into element text, ever", async () => {
    // The mutation-XSS rule: `<style>` serializes raw, so the resolve step may not write into
    // it. The reference stays inert and is NOT reported — fetching bytes no rendering will
    // paint would be pure spend.
    const out = await clean(
      `<style>.x{background:url(cid:logo@corp)}</style><p>hi</p>`,
      { cidImages: new Map([["logo@corp", PNG_URI]]) },
    );
    expect(out.html).toContain("url(cid:logo@corp)");
    expect(out.html).not.toContain(PNG_URI);
    expect(out.cids).toEqual([]);
  });

  it("does not weaken the remote-image blocking beside it", async () => {
    // A map being present must change nothing about REMOTE images: they have a consent path
    // and a proxy, and `cid:` resolution must not become a second way to reach the network.
    const out = await clean(
      `<img src="https://tracker.example/wf/open?u=1"><img src="cid:logo@corp">`,
      { cidImages: new Map([["logo@corp", PNG_URI]]) },
    );
    expect(out.html).not.toMatch(/src\s*=\s*["']?https?:\/\//i);
    expect(out.html).toContain(`src="${PNG_URI}"`);
    expect(out.blocked).toHaveLength(1);
  });
});

describe("MessageBody — the fetch request and the frame", () => {
  it("a FRAMED rendering reports its unresolved cids, and stops once they resolve", async () => {
    const asked: string[][] = [];
    await render({
      text: "This month at the atelier.",
      html: NEWSLETTER,
      onCidImages: (cids) => asked.push(cids),
    });
    expect(host!.querySelector("iframe"), "the fixture must render framed to prove anything").not.toBeNull();
    // The SET form, `="1"` — the bare attribute name also appears in FRAME_CSS's dormant
    // selectors, which ship in every document resolved or not.
    expect(srcdoc()).toContain('data-ohmail-embedded="1"');
    expect(asked).toEqual([["logo@corp"]]);

    // The bytes arrive: the shell re-renders with the grown map. The frame now carries the
    // image and the effect has nothing left to report — which is what terminates the loop.
    await render({
      text: "This month at the atelier.",
      html: NEWSLETTER,
      cidImages: new Map([["logo@corp", PNG_URI]]),
      onCidImages: (cids) => asked.push(cids),
    });
    expect(srcdoc()).toContain(`src="${PNG_URI}"`);
    expect(srcdoc()).not.toContain('data-ohmail-embedded="1"');
    expect(asked, "everything resolved — no second ask").toEqual([["logo@corp"]]);
  });

  it("a PROSE rendering asks for its cids and draws the resolved picture IN PLACE", async () => {
    /**
     * The defect behind this slice (2026-09-19): a signature logo in ordinary mail — which classifies prose
     * — displayed nowhere. The frameless path now asks for the referenced parts exactly as the
     * frame does, and the walker carries the resolved bytes as an image run `BodyText` draws in
     * the app's own document. Mutation: put `img` back in `RICH_SKIP` — the ask still fires but
     * the drawn-image assertion goes red.
     */
    const asked: string[][] = [];
    await render({
      text: "Hello\n\n— Anna",
      html: `<p>Hello</p><img src="cid:logo@corp" alt="Corp logo"><p>— Anna</p>`,
      onCidImages: (cids) => asked.push(cids),
    });
    expect(host!.querySelector("iframe"), "the fixture must render frameless to prove anything").toBeNull();
    expect(asked, "the frameless rendering can show these now, so it asks").toEqual([["logo@corp"]]);
    // Unresolved: NOTHING is drawn — no 1×1 blank, no broken glyph; the strip lists the part.
    expect(host!.querySelector(".msg-img")).toBeNull();

    // The bytes arrive: the picture stands in the letter, at the reference's place, alt intact.
    await render({
      text: "Hello\n\n— Anna",
      html: `<p>Hello</p><img src="cid:logo@corp" alt="Corp logo"><p>— Anna</p>`,
      cidImages: new Map([["logo@corp", PNG_URI]]),
      onCidImages: (cids) => asked.push(cids),
    });
    expect(host!.querySelector("iframe")).toBeNull();
    const img = host!.querySelector<HTMLImageElement>(".msg-img");
    expect(img, "the resolved picture is drawn in the app's own typography").not.toBeNull();
    expect(img!.getAttribute("src")).toBe(PNG_URI);
    expect(img!.getAttribute("alt")).toBe("Corp logo");
    expect(asked, "everything resolved — no second ask").toEqual([["logo@corp"]]);
  });

  it("a PROSE rendering never draws a hostile map value — the same gate at the second sink", async () => {
    // Mutation: `INLINE_IMAGE_SRC = /./` in BodyText — the walker emits the hostile src and
    // the renderer constructs it; both assertions below go red.
    await render({
      text: "Hello\n\n— Anna",
      html: `<p>Hello</p><img src="cid:a@x"><p>— Anna</p>`,
      cidImages: new Map([["a@x", "javascript:alert(1)"]]),
    });
    expect(host!.querySelector("iframe")).toBeNull();
    expect(host!.querySelector(".msg-img")).toBeNull();
    expect(host!.innerHTML).not.toContain("javascript:");
  });

  it("the TEXT-PART fallback asks for nothing — it draws no images", async () => {
    /**
     * A prose message whose html yields no walkable structure renders the text part, which
     * cannot show a picture — so fetching would be pure spend. `MAX_RICH_NODES` overflow is the
     * cheapest way to force `rich: null` on a still-prose document.
     */
    const asked: string[][] = [];
    const overflow = `<p>line</p>`.repeat(5000) + `<img src="cid:logo@corp">`;
    await render({
      text: "the text part",
      html: overflow,
      onCidImages: (cids) => asked.push(cids),
    });
    expect(host!.querySelector("iframe")).toBeNull();
    expect(asked, "bytes a rendering cannot show are pure spend").toEqual([]);
  });
});

describe("a picture the sender left unnamed is read as a picture, never as its src", () => {
  /** The pictures a screen reader meets in the sanitized document, by name. */
  async function spoken(html: string, opts: Parameters<Mod["sanitizeMailHtml"]>[1] = {}): Promise<string[]> {
    const doc = document.createElement("div");
    doc.innerHTML = (await clean(html, opts)).html;
    const names: string[] = [];
    within(doc).queryAllByRole("img", { name: (name) => names.push(name) > 0 });
    return names;
  }
  const cidImages = new Map([["a@x", PNG_URI], ["b@x", PNG_URI]]);

  it("an embedded picture with no alt is named 'Picture' (Bild in German), and a named one keeps its name", async () => {
    const html = `<img src="cid:a@x"><img src="cid:b@x" alt="Logo"><img src="cid:a@x" title="Plan">`;
    expect(await spoken(html, { cidImages })).toEqual(["Picture", "Logo", "Plan"]);
    expect(await spoken(html)).toEqual(["Picture", "Logo", "Plan"]); // unresolved, blank
    setActiveCatalog("de", fillFrom(en as never, de as never) as never);
    try {
      expect(await spoken(`<img src="cid:a@x">`, { cidImages })).toEqual(["Bild"]);
    } finally {
      setActiveCatalog(DEFAULT_LOCALE, null);
    }
  });

  it("a tracking pixel or a 1×1 spacer is hidden from the reader; alt='' stays decorative", async () => {
    const html =
      `<img src="cid:a@x" width="1" height="1"><img src="https://t.example/wf/open?u=1"><img src="cid:b@x" alt="">`;
    expect(await spoken(html, { cidImages })).toEqual([]);
  });
});
