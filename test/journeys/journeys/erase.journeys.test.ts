import { expect } from "vitest";
import { openPane } from "../bench/panes.js";
import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";

export const GUARDS: Guard[] = [
  { title: "Delete my account is offered only once the account's own address is typed", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("erase", () => {
  journey(GUARDS[0]!, async (b) => {
    const { person, account } = await openPane(b, "settings-account", "erase-begin");
    expect((await person.spoken("erase-begin")).disabled).toBe(true);
    await person.act("type", "erase-confirm", { args: { email: account!.email }, value: account!.email });
    await person.until(async () => !(await person.spoken("erase-begin")).disabled, "Delete my account to be offered");
  });
});
