/**
 * THE READER-FRAME HARNESS: the real `MessageBody` behind the real `useRemoteImages`, in a real
 * browser, inside a `.read-col` pane with the app's stylesheets. The door is a stub `fetchImage`
 * (20 ms, one fixed PNG); `file://` is an opaque origin, so there is no proxy, as on macOS.
 * `?fx=` picks the fixture, `?w=`/`?h=` the pane and `?head=` the chrome above the message.
 * The instruments go on `#pane` BEFORE React renders, so the first probe is counted too.
 */
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageBody } from "../../app/letter-body/MessageBody";
import { useRemoteImages } from "../../app/shell/remote-images";
import "../../../../packages/ui/src/base.css";
import "../../../../packages/ui/src/composites/message.css";
import "../../app/app.css";

declare const __FIXTURES__: Record<string, string>;

export interface ReaderFrame {
  /** `fetchImage` calls, per url. */
  fetches: Record<string, number>;
  /** Pictures the hook holds for the message, as of the last render. */
  held: number;
  /** Writes of the 600px probe height to a frame's style (each probe leaves one old value). */
  probes: number;
  /** Every frame style write, and the heights they left. */
  styleWrites: number;
  heights: string[];
  /** Assignments to the pane's `scrollTop` (the probe's restore writes only after a clamp). */
  scrollTopWrites: number;
  scrollEvents: number;
  /** When true every render hands `MessageBody` a NEW map of the same pictures. */
  copyMap: boolean;
  rerender: () => void;
  reset: () => void;
}

declare global {
  interface Window { __rf: ReaderFrame }
}

const ID = "fixture-message";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const params = new URLSearchParams(location.search);
const html = __FIXTURES__[params.get("fx") ?? "wp-report"] ?? "";
const pane = document.getElementById("pane")!;
pane.style.width = `${params.get("w") ?? "790"}px`;
pane.style.height = `${params.get("h") ?? "938"}px`;

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
}).observe(pane, { subtree: true, attributes: true, attributeFilter: ["style"], attributeOldValue: true });
const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
Object.defineProperty(pane, "scrollTop", {
  configurable: true,
  get(this: Element) { return top.get!.call(this); },
  set(this: Element, v: number) { rf.scrollTopWrites += 1; top.set!.call(this, v); },
});
pane.addEventListener("scroll", () => { rf.scrollEvents += 1; });

async function fetchImage(_messageId: string, url: string): Promise<string | null> {
  rf.fetches[url] = (rf.fetches[url] ?? 0) + 1;
  await new Promise((r) => setTimeout(r, 20));
  return PNG;
}

function Harness() {
  const [, setTick] = useState(0);
  rf.rerender = () => setTick((t) => t + 1);
  const remoteImages = useRemoteImages({ onFailed: () => {}, mode: "auto", loadPixels: false, fetchImage });
  const onRemoteImages = useCallback(
    (urls: string[]) => remoteImages?.needRemote(ID, urls),
    [remoteImages],
  );
  const held = remoteImages?.resolvedFor(ID);
  rf.held = held?.size ?? 0;
  return (
    <div className="msg">
      <div className="rf-head" style={{ height: Number(params.get("head") ?? "120") }} />
      <div className="msg-body">
        <MessageBody
          messageId={ID}
          text=""
          html={html}
          remoteLoaded
          imageProxy={remoteImages ? remoteImages.proxyFor(ID) : null}
          resolvedRemoteImages={rf.copyMap && held ? new Map(held) : held}
          onRemoteImages={onRemoteImages}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("mount")!).render(<Harness />);
