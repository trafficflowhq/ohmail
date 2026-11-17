/**
 * THE PHONE'S WAYS IN'S STATES PAGE: one state of `phonedoor-states.tsx` by address. The address carries the
 * reference's own words (`device=phone&screen=phonedoor&state=refused`, `screen=onboarding&step=scan`, `os`,
 * `face`, `scheme`) and the page's own `lang`. The comparison's subjects open it at their keys and walk the state's
 * steps (`phonedoor-open.ts`).
 */
import { createRoot } from "react-dom/client";
import { TextProvider } from "../../src/text/index.js";
import { deviceOf } from "./connect-states.js";
import { drawnAt, PHONE_DOOR_WORDS, PhoneDoorStateDrawn, type Lang } from "./phonedoor-states.js";

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
    <TextProvider locale={lang} messages={PHONE_DOOR_WORDS[lang] as never} timeZone="Europe/Zurich">
      <PhoneDoorStateDrawn drawn={drawn} lang={lang} device={deviceOf(words, root)} />
    </TextProvider>
  ),
);
