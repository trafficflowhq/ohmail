import { openPane, paneGuards, paneJourneys, where } from "../bench/panes.js";
import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";
import { PEOPLE } from "../vocabulary/world.js";

/** The rules that file mail. With no rule the section has no control: it says that it holds none. */
const PANE = paneGuards("settings-rules");
const { listed } = where("settings-rules");
export const GUARDS: Guard[] = [
  ...PANE,
  { title: "Rules says so when the account has no rule", rows: [], surfaces: listed, needs: [] },
  { title: "A rule the account has is listed under Rules, with the way to revoke it", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("settings-rules", () => {
  paneJourneys("settings-rules", PANE);
  journey(GUARDS[PANE.length]!, async (b) => {
    const { person } = await openPane(b, "settings-rules");
    await person.reads("rules.empty");
  });
  journey(GUARDS[PANE.length + 1]!, async (b) => {
    const account = await b.account();
    await account.planter.plant({ conversations: [], rules: [{ from: PEOPLE.skylark, pile: "reads" }] });
    const person = await b.person({ account });
    await person.arrive("settings-rules");
    await person.see("rule-revoke");
  });
});
