import { expect } from "vitest";
import { paneGuards, paneJourneys, openPane } from "../bench/panes.js";
import type { Person } from "../bench/seam.js";
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
const SIGNATURE = "Mila, Lichtgrat";

async function editSignature(person: Person): Promise<string> {
  const named = `${say("settings.signatures.title", {}, person.lang)}: ${MAILBOX}`;
  await person.act("write", "signature-editor", { named, value: SIGNATURE });
  await person.see("signature-save");
  expect((await person.spoken("signature-save")).disabled).toBe(false);
  return named;
}

journeysOf("settings-signatures", () => {
  journey(PANE[0]!, async (b) => {
    const { person } = await openPane(b, "settings");
    await person.act("press", "menu-settings-signatures");
    await person.here("settings-signatures");
    await person.gone("signature-save");
    await editSignature(person);
  });
  paneJourneys("settings-signatures", PANE.slice(1));
  journey(GUARDS[PANE.length]!, async (b) => {
    const { person } = await openPane(b, "settings-signatures");
    const named = await editSignature(person);
    await person.act("press", "menu-settings-general");
    await person.reads("settings.signatures.leaveAsk");
    await person.act("press", "leave-keep");
    await person.see("signature-editor", { named });
    expect(await person.text("signature-editor", { named })).toBe(SIGNATURE);
  });
});
