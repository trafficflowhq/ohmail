/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { frameCsp, sanitizeMailHtml } from "../../webapp/app/components/MessageBody";

/**
 * THE DESKTOP CANNOT SHOW A PICTURE, AND THIS IS THE FRAME SAYING SO.
 *
 * Pictures do not load here, and the reason is not the setting: the hosted client has loaded
 * them by default since mail 0048, and the desktop never has. Not a default, a capability — `apps/desktop/vite.config.ts` defines `NEXT_PUBLIC_API_BASE` as
 * `undefined`, so `apiConfigured()` is false, `useRemoteImages` returns `undefined`, and the
 * pane hands `MessageBody` a null `imageProxy`. These assertions read the FRAME, which is
 * where the claim actually lives: the sanitized document a desktop reader is served, and the
 * policy it is served under.
 */

const SENDER = "images.newsletter.example";
const PICTURE = `https://${SENDER}/hero.png`;
const BEACON = `https://${SENDER}/wf/open?upn=abc`;
const HTML =
  `<table width="600"><tr><td><p>hello</p>` +
  `<img src="${PICTURE}" width="600" height="200">` +
  `<img src="${BEACON}" width="1" height="1">` +
  `</td></tr></table>`;

/**
 * Every url the frame's document names in a fetching position, EXCLUDING `data:`.
 *
 * The exclusion is the point rather than a convenience: a blocked image is not removed from
 * the document, it is replaced by a transparent `data:` GIF so the layout does not collapse.
 * A test that read every `src` would therefore see two urls for a frame that fetches nothing
 * and call that "the picture loaded" — measured, on the first run of this file.
 */
function namedInFrame(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll("img")]
    .map((n) => n.getAttribute("src") ?? "")
    .filter((s) => s.length > 0 && !s.startsWith("data:"));
}

describe("the desktop reading pane and the picture it cannot show", () => {
  /**
   * THE RED. A desktop pane sanitizes with `imageProxy: null` — the only value it can pass,
   * since the hook that would supply one hands back `undefined` on a client with no API base.
   * The picture is therefore named nowhere, and no press can change that: there is no button
   * either, because `MessageBody` draws no control it cannot honour.
   *
   * Mutation that must redden this once the seam lands: remove the local proxy from the
   * desktop's composition, i.e. return to `imageProxy: null`.
   */
  it("names the sender's picture nowhere, because it has no proxy to name it through", () => {
    const out = sanitizeMailHtml(HTML, { imageProxy: null });
    expect(
      namedInFrame(out.html),
      "the desktop frame named a remote url with no proxy behind it",
    ).toEqual([]);
    expect(out.blocked.map((b) => b.url), "the picture was not even counted as blocked")
      .toContain(PICTURE);
  });

  /**
   * AND THE POLICY AGREES, which is the half that makes the first assertion structural rather
   * than incidental: with no proxy source the frame's `img-src` admits `data:` and nothing
   * else, so even a desktop pane that DID name `https://…/hero.png` would be refused by its
   * own document's policy. This is the line that decides whether a picture can ever arrive.
   */
  it("serves a policy that admits data: and no remote source at all", () => {
    const csp = frameCsp(null);
    expect(csp, "the desktop frame's img-src gained a source").toContain("img-src data:;");
    expect(csp, "the desktop frame admitted a remote origin").not.toMatch(/img-src[^;]*https?:/);
  });

  /**
   * THE BEACON STAYS REFUSED — the arm that must not move when the seam lands. Asserted here
   * so the red above cannot be answered by loosening the pixel rule: a 1×1 is classified from
   * the message's own declaration and overrides any proxy, in every mode.
   */
  it("classifies the 1x1 as a pixel, which no proxy may override", () => {
    const out = sanitizeMailHtml(HTML, { imageProxy: (u) => `/img?u=${encodeURIComponent(u)}` });
    const named = namedInFrame(out.html);
    expect(named.some((u) => u.includes(encodeURIComponent(PICTURE))),
      "a proxy was supplied and the picture still did not load").toBe(true);
    expect(named.some((u) => u.includes(encodeURIComponent(BEACON))),
      "the tracking pixel rode the proxy").toBe(false);
  });
});

/**
 * ── THE SEAM THAT MAKES A PICTURE ARRIVE ON A DOOR WITH NO ORIGIN ────────────────────────
 *
 * The desktop's engine is reached over a pipe, not a port — `bridge-fetch.ts` says why, and the
 * posture stands: nothing listens, so no `<img src>` can name it. The bytes therefore travel the
 * way a `cid:` part's already do, through the same image proxy, and arrive as a `data:` URI. What
 * is asserted here is that the policy did not have to move an inch to allow it.
 */
const RESOLVED = "data:image/png;base64,iVBORw0KGgo=";

describe("a picture the desktop already holds the bytes of", () => {
  /**
   * CONTROL (a). Mutation: drop the `resolved` branch from the sanitizer's img arm. Real failure
   * text: "the resolved picture did not reach the frame: expected [] to contain '<data uri>'".
   */
  it("renders the picture, and still refuses the tracker beside it", () => {
    const out = sanitizeMailHtml(HTML, {
      imageProxy: null,
      resolvedRemoteImages: new Map([[PICTURE, RESOLVED]]),
    });
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    const srcs = [...doc.querySelectorAll("img")].map((n) => n.getAttribute("src") ?? "");
    expect(srcs, "the resolved picture did not reach the frame").toContain(RESOLVED);
    /* The beacon is still the transparent placeholder and still MARKED, which is the fact the
       caption is drawn from — a resolved map must not be a way round the pixel rule. */
    const beacon = [...doc.querySelectorAll("img")].find(
      (n) => n.getAttribute("data-ohmail-pixel") === "1",
    );
    expect(beacon, "the 1x1 lost its pixel marking").toBeTruthy();
    expect(beacon!.getAttribute("src"), "the tracker was served real bytes").not.toBe(RESOLVED);
  });

  /**
   * AND A MAP THAT CARRIES THE BEACON ANYWAY. The map is built by this app, so this is a
   * defence against our own future bug rather than against a sender — which is exactly the
   * class of thing that is worth making unrepresentable in the one place it is decided.
   *
   * Mutation: drop the `!pixel` term from the `resolved` line. Real failure text:
   * "a beacon was served from the resolved map: expected 'data:image/png;base64,…' not to be …".
   */
  it("refuses a beacon even when the resolved map names one", () => {
    const out = sanitizeMailHtml(HTML, {
      imageProxy: null,
      resolvedRemoteImages: new Map([[PICTURE, RESOLVED], [BEACON, RESOLVED]]),
    });
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    const beacon = [...doc.querySelectorAll("img")].find(
      (n) => n.getAttribute("data-ohmail-pixel") === "1",
    );
    expect(beacon!.getAttribute("src"), "a beacon was served from the resolved map")
      .not.toBe(RESOLVED);
  });

  /**
   * CONTROL (e), and it is a byte comparison rather than a reading of the policy's parts: the
   * whole argument for `data:` over a door origin is that the frame's policy does not move, and
   * "img-src still mentions data:" would stay green through a widening that added a source
   * beside it.
   */
  it("leaves the frame's policy byte-identical", () => {
    expect(
      frameCsp(null),
      "the desktop's frame policy moved to let a resolved picture in",
    ).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; "
      + "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; "
      + "base-uri 'none'",
    );
  });

  /**
   * A PICTURE THAT IS NOT IN THE MAP IS THE BLANKED BOX — which is what "over the ceiling"
   * looks like from here, and also what "not fetched yet" and "the fetch failed" look like.
   * One rendering for all three is the point: the frame never shows a broken-image icon, which
   * would be a claim about the mail rather than about this app's budget.
   *
   * The CEILING ITSELF is asserted where it is spent, against the constant the embedded
   * pictures already use — a number restated here would be a second budget, which is the thing
   * this design exists not to create.
   */
  it("leaves an unresolved picture as the blanked box", () => {
    const out = sanitizeMailHtml(HTML, { imageProxy: null, resolvedRemoteImages: new Map() });
    const doc = new DOMParser().parseFromString(out.html, "text/html");
    const blanked = [...doc.querySelectorAll("img[data-ohmail-blocked]")];
    expect(blanked.length, "an unresolved picture was not left as a blanked box").toBe(2);
  });
});
