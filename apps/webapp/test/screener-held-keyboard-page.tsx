import type { ScreenerState } from "@ohmail/app-logic/screener";
import { createRoot } from "react-dom/client";
import { Frame } from "../../../packages/app/src/frame/index.js";
import { ScreenerAbove, screenerPlace } from "../../../packages/app/src/screener/index.js";
import { BESIDE, inWords, modelOf, screenerEngine, sender } from "../../../packages/app/test/screener/screener-world.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";

const room = fakeWindow(innerWidth < 700 ? "phone" : "desktop");
room.resize(innerWidth, innerHeight);
const queue: ScreenerState["waiting"] = Array.from({ length: 24 }, (_, n) => sender(`sender-${n}`, `Sender ${n}`, {
  held: ["Oldest", "Middle", "Newest"].map((age, index) => ({
    id: `letter-${n}-${index}`, subject: `${age} letter ${n}`, time: "09:00",
    body: "", snippet: "A held letter.",
  })),
}));
const model = modelOf({ flushes: 0 }, { waiting: queue, waitingCount: queue.length });
const bodies = Object.fromEntries(queue.flatMap((entry) => entry.held.map((letter) => [
  letter.id, { state: "ready", text: "A letter held for a decision. ".repeat(240), html: null },
])));
const { host } = fakeHost({
  engine: screenerEngine(bodies).engine, service: "self", scope: "acct-1",
  places: { screener: screenerPlace }, window: room, address: fakeAddress("#/screener"),
});
createRoot(document.getElementById("root")!).render(inWords(
  <ScreenerAbove model={model} beside={BESIDE}>
    <Frame host={host} />
  </ScreenerAbove>,
));
