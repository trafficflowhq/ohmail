/**
 * THE READER-FRAME HARNESS OVER THE NEW READER: the letter's body as the new reader mounts it (`letterBody`, the
 * body entry the browser hosts hand the reader: `MessageBody` in its sheet look), handed its picture inputs by the
 * reader's own `letterPictures` over the real picture door (`useRemoteImages`), inside the kit's reading column
 * (`Sheet kind="reading"`, the kit's `Message`), in a real browser with the kit's sheets. The door's wire is a stub
 * `fetchImage` (20 ms, one fixed PNG); `file://` is an opaque origin, so there is no proxy, as on macOS.
 * `?fx=` picks the fixture, `?w=`/`?h=` the column and `?head=` the chrome above the letter's text.
 *
 * The rig's reads (`rig.ts`) stand as they did over today's pane: the column's scroller is `#pane`, what scrolls in
 * it `#mount`, the counters `window.__rf`. The instruments go on the column's box BEFORE React renders, so the first
 * probe is counted too (the scroller is React's, so its writes are counted where they land: on the prototype).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { letterPictures } from "@ohmail/app-logic/reader";
import { useRemoteImages } from "@ohmail/app-logic/reader/remote-images";
import { letterBody } from "@ohmail/app/reader/body";
import { TextProvider, type Messages } from "@ohmail/app/text";
import "@ohmail/ui/base";
import { Message, Sheet } from "@ohmail/ui/mail";
import "../../../../packages/app/src/reader/column.css";
import en from "../../messages/en.json" with { type: "json" };
import type { ReaderFrame } from "./harness";

declare const __FIXTURES__: Record<string, string>;

const ID = "fixture-message";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const params = new URLSearchParams(location.search);
const html = __FIXTURES__[params.get("fx") ?? "wp-report"] ?? "";
const col = document.getElementById("col")!;
col.style.width = `${params.get("w") ?? "790"}px`;
col.style.height = `${params.get("h") ?? "1030"}px`;

const rf: ReaderFrame = {
  fetches: {}, held: 0, probes: 0, styleWrites: 0, heights: [], scrollTopWrites: 0, scrollEvents: 0,
  copyMap: false, rerender: () => {},
  reset: () => {
    rf.probes = 0; rf.styleWrites = 0; rf.heights = []; rf.scrollTopWrites = 0; rf.scrollEvents = 0;
  },
};
window.__rf = rf;

new MutationObserver((recs) => {
  for (const r of recs) {
    if (!(r.target instanceof HTMLIFrameElement)) continue;
    rf.styleWrites += 1;
    rf.heights.push(r.target.style.height);
    if (/height:\s*600px/.test(r.oldValue ?? "")) rf.probes += 1;
  }
}).observe(col, { subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true });
const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
Object.defineProperty(Element.prototype, "scrollTop", {
  configurable: true,
  get(this: Element) { return top.get!.call(this); },
  set(this: Element, v: number) { if (this.id === "pane") rf.scrollTopWrites += 1; top.set!.call(this, v); },
});
col.addEventListener("scroll", (e) => { if ((e.target as Element).id === "pane") rf.scrollEvents += 1; }, true);

async function fetchImage(_messageId: string, url: string): Promise<string | null> {
  rf.fetches[url] = (rf.fetches[url] ?? 0) + 1;
  await new Promise((r) => setTimeout(r, 20));
  return PNG;
}

/** The door's pipe: the stub fetcher, and a press that records nothing (no case here presses). */
const PIPE = { fetch: fetchImage, record: () => Promise.reject(new Error("this harness records no press")) };

/** The body's words, as the hosts hand the reader its catalogue. */
const WORDS = { mailBody: en.mailBody, bodyText: en.bodyText } as Messages;

/** The letter as the reader reads it off the mirror: let in, in the Ohbox. */
const LETTER = { id: ID, folder: "INBOX" };

/** The scroller the kit's column hands out is the rig's `#pane`. */
function asPane(el: HTMLDivElement | null): void {
  if (el) el.id = "pane";
}

function Harness() {
  const [, setTick] = useState(0);
  rf.rerender = () => setTick((t) => t + 1);
  const door = useRemoteImages({ onFailed: () => {}, mode: "auto", loadPixels: false, wire: PIPE });
  rf.held = door?.resolvedFor(ID).size ?? 0;
  /* `copyMap`: every render hands the body a NEW map of the same pictures, as a door that copies would. */
  const seam = door && rf.copyMap ? { ...door, resolvedFor: (id: string) => new Map(door.resolvedFor(id)) } : door;
  const Body = letterBody;
  return (
    <div className="rd-column" data-read-column="">
      <Sheet kind="reading" label="Reading" scroller={asPane}>
        <div id="mount">
          <div className="rd-letter" data-conv-id={ID} aria-current="true">
            <Message head={<div className="rf-head" style={{ height: Number(params.get("head") ?? "120") }} />}>
              <div data-read-body="">
                <Body
                  {...letterPictures(LETTER, false, seam ?? "none", "none", true, true)}
                  messageId={ID}
                  text=""
                  html={html}
                  subject="Your weekly report"
                  scheme="light"
                  owner={null}
                  onNotice={() => {}}
                  onControls={() => {}}
                />
              </div>
            </Message>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

createRoot(col).render(
  <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
    <Harness />
  </TextProvider>,
);
