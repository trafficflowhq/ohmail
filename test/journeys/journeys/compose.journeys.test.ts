import { expect } from "vitest";
import { EVERY_WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "A letter with a recipient, a subject and words can be sent", rows: [], surfaces: EVERY_WEB, needs: [] },
  { title: "The demo sends a letter and says so", rows: [], surfaces: ["W-d"], needs: [] },
  {
    title: "A letter whose formatting was removed and retyped plain is still sent",
rows: [], surfaces: ["W-d"], needs: [],
  },
];

journeysOf("compose", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    expect((await person.spoken("compose-send")).disabled).toBe(true);
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("write", "compose-body", { value: "See you at the kiln." });
    await person.until(async () => !(await person.spoken("compose-send")).disabled, "Send to be offered");
  });
  journey(GUARDS[1]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("write", "compose-body", { value: "See you at the kiln." });
    await person.act("press", "compose-send");
    await person.reads("compose.toastSent");
  });
  journey(GUARDS[2]!, async (b) => {
    const { person } = await signedIn(b);
    await person.arrive("compose");
    await person.act("type", "compose-to", { value: "ben@lichtgrat.example" });
    await person.act("type", "compose-subject", { value: "Friday" });
    await person.act("press", "compose-bold");
    await person.act("write", "compose-body", { value: "Loud words." });
    await person.act("keyIn", "compose-body", { value: "Control+A" });
    await person.act("keyIn", "compose-body", { value: "Delete" });
    await person.act("write", "compose-body", { value: "Plain words." });
    await person.act("press", "compose-send");
    await person.reads("compose.toastSent");
  });
});
