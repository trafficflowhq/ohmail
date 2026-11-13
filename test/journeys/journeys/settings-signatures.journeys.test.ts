import { paneGuards, paneJourneys, openPane } from "../bench/panes.js";
import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";
import { say } from "../vocabulary/catalogue.js";

const PANE = paneGuards("settings-signatures");
export const GUARDS: Guard[] = [
  ...PANE,
  {
    title: "Leaving Signatures with an unsaved signature asks before it is dropped",
    rows: ["signature-draft-dropped-on-leave"], surfaces: WEB, needs: [],
  },
];

/** The mailbox a planted world has; its signature's editor is named after it. */
const MAILBOX = "mila@lichtgrat.example";

journeysOf("settings-signatures", () => {
  paneJourneys("settings-signatures", PANE, "signature-save");
  journey(GUARDS[PANE.length]!, async (b) => {
    const { person } = await openPane(b, "settings-signatures", "signature-save");
    const named = `${say("settings.signatures.title", {}, person.lang)}: ${MAILBOX}`;
    await person.act("write", "signature-editor", { named, value: "Mila, Lichtgrat" });
    await person.act("press", "menu-settings-general");
    await person.reads("settings.signatures.leaveAsk");
    await person.act("press", "leave-keep");
    await person.see("signature-editor", { named });
  });
});
