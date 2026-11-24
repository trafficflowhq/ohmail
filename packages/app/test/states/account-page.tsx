/**
 * THE ACCOUNT GROUP'S STATES PAGE: one state of `account-states.tsx` by address, drawn in Settings as a shell draws
 * its pane, the frame and the menu around it over the fake host. The address carries the reference's own words
 * (`screen=settings&sec=devices&state=pair`, `ask=factor&how=code`, `device=phone`, `face=ohmarchy`, `scheme=dark`)
 * and the page's own: `lang`, `size` (the text size), `pick` (a state no picture draws, by its record and name).
 * The comparison's subjects open it at their keys (`account-open.ts`); what the frame and the menu draw is theirs.
 */
import { createRoot } from "react-dom/client";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider } from "../../src/text/index.js";
import { accountFrameHost } from "./account-frame.js";
import { ACCOUNT_WORDS, drawnAt, slotsFor, type Lang } from "./account-states.js";

const words = new URLSearchParams(location.search);
const lang: Lang = words.get("lang") === "de" ? "de" : "en";
const drawn = drawnAt(words, lang);
const look = {
  face: words.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
  scheme: words.get("scheme") === "dark" ? "dark" : "light",
} as const;
const root = document.documentElement;
/* What the old theme provider stamps in the product: the face and today's theme, and the page's language. */
root.setAttribute("data-face", look.face);
root.setAttribute("data-theme", look.scheme);
root.setAttribute("lang", lang);
/* The web's Text size, as its setting writes it on the root. */
const size = Number(words.get("size") ?? "1");
if (size !== 1) {
  root.style.setProperty("zoom", String(size));
  root.style.setProperty("--ui-zoom", String(size));
}

createRoot(document.getElementById("root")!).render(
  drawn === null ? (
    <p>{`no such state: ${location.search}`}</p>
  ) : (
    <TextProvider locale={lang} messages={ACCOUNT_WORDS[lang]} timeZone="Europe/Zurich">
      <Frame
        host={accountFrameHost(drawn, slotsFor(words, lang), {
          device: words.get("device"),
          look,
          lang,
        })}
      />
    </TextProvider>
  ),
);
