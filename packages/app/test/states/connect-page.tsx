/**
 * THE ONE CONNECT FORM'S STATES PAGE: one state of `connect-states.tsx` by address. The address carries the
 * reference's own words (`provider=other&screen=onboarding&state=c-auth&step=signin`, `screen=onboarding&step=provider`,
 * `device`, `face`, `scheme`) and the page's own `lang`. The comparison's subjects open it at their keys and walk the
 * state's steps (`connect-open.ts`).
 */
import { createRoot } from "react-dom/client";
import { TextProvider } from "../../src/text/index.js";
import { CONNECT_WORDS, ConnectState, deviceOf, drawnAt, type Lang } from "./connect-states.js";

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
    <TextProvider locale={lang} messages={CONNECT_WORDS[lang] as never} timeZone="Europe/Zurich">
      <ConnectState drawn={drawn} lang={lang} device={deviceOf(words, root)} />
    </TextProvider>
  ),
);
