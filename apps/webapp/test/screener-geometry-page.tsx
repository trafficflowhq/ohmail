import type { ScreenerState } from "@ohmail/app-logic/screener";
import { createRoot } from "react-dom/client";
import { Frame } from "../../../packages/app/src/frame/index.js";
import { ScreenerAbove, screenerPlace } from "../../../packages/app/src/screener/index.js";
import { BESIDE, inWords, modelOf, screenerEngine, sender, TestConsent } from "../../../packages/app/test/screener/screener-world.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeAppearance, fakeWindow } from "../../../packages/app/test/support/fake-window.js";

const screen = fakeWindow(innerWidth < 700 ? "phone" : "desktop");
screen.resize(innerWidth, innerHeight);
const screenedOut = Array.from({ length: 24 }, (_, n) => sender(`offers-${n}`, `Vane Offers ${n}`, {
  segment: "screened",
  held: Array.from({ length: n === 0 ? 80 : 2 }, (_, index) => {
    const i = (n === 0 ? 79 : 1) - index;
    return {
      id: `offer-${n}-${i}`, subject: `Offer ${n}/${i}: quarry invoice glacier review`,
      time: "09:00", body: "", snippet: "An offer held for a decision.",
    };
  }),
})) as unknown as ScreenerState["screenedOut"];
const model = modelOf({ flushes: 0 }, { screenedOut });
const bodies = Object.fromEntries(screenedOut.flatMap((entry) => entry.held.map((letter) => [
  letter.id, { state: "ready", text: "Thistle review invoice garden beacon ember pantry glacier harbour. "
    .repeat(letter.id === "offer-0-0" ? 120 : 10), html: null },
])));
const query = new URLSearchParams(location.search);
const scope = "acct-1";
const { host } = fakeHost({
  engine: screenerEngine(bodies).engine, service: "self", scope,
  places: { screener: screenerPlace }, window: screen, address: fakeAddress("#/screener/screened"),
  appearance: fakeAppearance({
    face: query.get("face") === "ohmarchy" ? "ohmarchy" : "paper",
    scheme: query.get("theme") === "dark" ? "dark" : "light",
  }),
});
createRoot(document.getElementById("root")!).render(inWords(
  <TestConsent scope={scope} transport="none">
    <ScreenerAbove model={model} beside={BESIDE}>
      <Frame host={host} />
    </ScreenerAbove>
  </TestConsent>,
));
