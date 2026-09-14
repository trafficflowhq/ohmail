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
