/**
 * THE FRAME-LINKS HARNESS — the product's own sanitizer output in the product's own frame document,
 * under the exported `FRAME_SANDBOX`, served over a routed http origin so `allow-same-origin` means
 * what it means in the app. `?mode=` picks the wiring: `product` installs nothing on the frame (the
 * shipped desktop door is the shell's new-window handler); `listener` installs the parent-side
 * capture listener the desktop used to put on the frame. `?scripts=1` adds `allow-scripts`,
 * the harness-only positive control. `window.__links` hands the rig what each listener saw.
 */
import { buildMailDocument, FRAME_SANDBOX, sanitizeMailHtml } from "../../app/components/MessageBody";
import { enableExternalLinks, interceptLinkClicks } from "../../app/shell/open-external";

declare global {
  interface Window {
    __links: { raw: string[]; invoked: string[]; loaded: boolean; sandbox: string };
  }
}

/** A designed newsletter: a 600px layout table, so the product frames it rather than setting it as prose. */
export const FIXTURE = [
  '<table width="600" cellpadding="0" cellspacing="0"><tr><td>',
  "<p>FRAME-LINKS-MARKER</p>",
  '<p><a href="https://example.test/deactivate">Wie es deaktiviert wird</a></p>',
  '<p><a href="https://elsewhere.test/path?q=1">example.test</a></p>',
  '<p><a href="mailto:x@y.test?subject=A%26B">write to us</a></p>',
  '<p><a href="tel:+41000000000">call us</a></p>',
  '<p><a href="cid:part1@fixture.test">the attachment</a></p>',
  "</td></tr></table>",
].join("");

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "product";
const sandbox = params.get("scripts") === "1" ? `${FRAME_SANDBOX} allow-scripts` : FRAME_SANDBOX;
window.__links = { raw: [], invoked: [], loaded: false, sandbox };

if (mode === "listener") {
  // The new-window request, recorded and answered with no window: the listener's http arm ends
  // here when it runs at all.
  window.open = ((url?: string | URL) => {
    window.__links.invoked.push(String(url ?? ""));
    return null;
  }) as typeof window.open;
  enableExternalLinks();
}

const mail = sanitizeMailHtml(FIXTURE);
const frame = document.createElement("iframe");
frame.setAttribute("sandbox", sandbox);
frame.setAttribute("referrerpolicy", "no-referrer");
frame.setAttribute("title", "message");
frame.style.width = "700px";
frame.style.height = "400px";
frame.addEventListener("load", () => {
  const doc = frame.contentDocument;
  if (doc && mode === "listener") {
    // Registered first, so it sees the click before the product's listener can cancel it.
    doc.addEventListener(
      "click",
      (ev) => {
        const a = (ev.target as Element | null)?.closest?.("a[href]");
        window.__links.raw.push(a?.getAttribute("href") ?? "");
      },
      true,
    );
    interceptLinkClicks(doc, { trustSameOrigin: false });
  }
  window.__links.loaded = true;
});
frame.srcdoc = buildMailDocument(mail.html);
document.getElementById("mail")?.appendChild(frame);
