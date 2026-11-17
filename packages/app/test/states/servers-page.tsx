/**
 * THE PHONE'S LIST OF SERVERS' STATES PAGE: one state of `servers-states.tsx` by address. The address carries the
 * reference's own words (`device=phone&screen=servers&state=own&ask=drafts`, `os`, `face`, `scheme`) and the page's
 * own `lang`. The comparison's subjects open it at their keys and walk the state's steps (`servers-open.ts`).
 */
import { createRoot } from "react-dom/client";
import { TextProvider } from "../../src/text/index.js";
import { deviceOf } from "./connect-states.js";
import { drawnAt, SERVERS_WORDS, ServersStateDrawn, type Lang } from "./servers-states.js";

const words = new URLSearchParams(location.search);
const lang: Lang = words.get("lang") === "de" ? "de" : "en";
const drawn = drawnAt(words);
const root = document.documentElement;
/* What the old theme provider stamps in the product: the face and today's theme, and the page's language. */
root.setAttribute("data-face", words.get("face") === "ohmarchy" ? "ohmarchy" : "paper");
root.setAttribute("data-theme", words.get("scheme") === "dark" ? "dark" : "light");
root.setAttribute("lang", lang);

createRoot(document.getElementById("root")!).render(
  drawn === null ? (
    <p>{`no such state: ${location.search}`}</p>
  ) : (
    <TextProvider locale={lang} messages={SERVERS_WORDS[lang] as never} timeZone="Europe/Zurich">
      <ServersStateDrawn drawn={drawn} device={deviceOf(words, root)} />
    </TextProvider>
  ),
);
