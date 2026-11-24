/**
 * EVERY DOOR'S PAGE LIVE IN A BROWSER, with the page's own scripts: what the kit measures there (a page of two columns
 * taller than its window folds to one that scrolls; the delete page fits its address to its line) is what a person
 * meets. `?door=<name>&lang=<en|de>&pointer=<fine|coarse>&zoom=<the web door's Text size>` draws that door in the
 * state `doors-pages.tsx` names, over a window feed read off the real window, as `under-todays-sheets.test.tsx` draws
 * it in jsdom for its markup.
 */
import { createRoot } from "react-dom/client";
import { createFeed } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { DoorStage } from "../../src/doors/stage/index.js";
import doors from "../../messages/doors.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import mailboxes from "../../messages/mailboxes.en.json" with { type: "json" };
import mailboxesDe from "../../messages/mailboxes.de.json" with { type: "json" };
import { PAGES } from "./doors-pages.js";

const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const page = PAGES[q.get("door") ?? ""];
const zoom = Number(q.get("zoom") ?? "");
const root = document.documentElement;
root.setAttribute("lang", lang);
/* The web door's Text size, as the static case writes it: `zoom` and `--ui-zoom` on the root; the window's facts stay the window's. */
if (zoom > 0) root.setAttribute("style", `zoom:${zoom};--ui-zoom:${zoom}`);
/* `fold=off`, for a control alone: the kit's fold taken out, so a page of two columns taller than its window stays two. */
if (q.get("fold") === "off")
  new MutationObserver((changes) => {
    for (const change of changes)
      if (change.target instanceof Element && change.target.hasAttribute("data-folded"))
        change.target.removeAttribute("data-folded");
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-folded"] });
const device = () => ({
  window: createFeed({
    width: innerWidth,
    height: innerHeight,
    pointer: q.get("pointer") === "coarse" ? "coarse" : "fine",
    posture: "flat",
    reducedMotion: false,
  } as never),
  appearance: createFeed({ face: "paper", scheme: "light" } as never),
  root: {
    read: (name: string) => root.getAttribute(name),
    write: (name: string, value: string | null) =>
      value === null ? root.removeAttribute(name) : root.setAttribute(name, value),
  },
});
createRoot(document.getElementById("root")!).render(
  <TextProvider
    locale={lang}
    messages={(lang === "de" ? { ...doorsDe, ...mailboxesDe } : { ...doors, ...mailboxes }) as never}
    timeZone="UTC"
  >
    <DoorStage device={device}>{page ? page() : <p>{`no such door: ${q.get("door") ?? ""}`}</p>}</DoorStage>
  </TextProvider>,
);
