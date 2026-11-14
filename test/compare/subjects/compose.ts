/**
 * Write's states, drawn by address through the real frame over the fake host (write's states page,
 * `packages/app/test/states/write-page.tsx`): the place `write` with `WriteAbove` over a composition double that
 * holds the letter the reference shows. Each key is the reference's own address, read by the page as it stands; the
 * presses a state needs are made by the page through the controls a person uses. A key of the screen that is not
 * here stands in `packages/app/test/compare/write-declared.json` with its class and its reason.
 */
import type { Subject } from "../subject.js";

/** The states this screen builds: every state of the screen and its named variants, the send lines, the notes, the
 * drafts on other devices, the saves, the From notes and the forward's lines. A key the page does not draw (a
 * posture of a folding phone; what stands after the letter has left) is declared whole in `write-declared.json`. */
const STATES = ["blank", "suggest", "many", "chips", "refused", "marks", "emoji", "files", "look", "quality", "attach", "drop", "toobig", "twice", "forward", "from", "later", "pick", "scheduled", "sending", "draft-none", "draft-ask", "draft-text", "draft-drafting", "draft-made", "draft-yours", "draft-nocredits", "draft-nomodel", "draft-off"];
const KEYS = [
  ...STATES.map((state) => `screen=compose&state=${state}`),
  ...["phone", "fold", "foldl"].map((device) => `device=${device}&screen=compose&state=marks`),
  "face=ohmarchy&screen=compose&state=marks",
  "scheme=dark&screen=compose&state=marks",
  "face=ohmarchy&scheme=dark&screen=compose&state=marks",
  ...[["sent", "draft"], ["sentkept", "draft"], ["deleted", "draft"], ["deletedkept", "draft"], ["changed", "draft"], ["changedunsaved", "draft"], ["sentsend", "draft"], ["deletedsend", "draft"], ["changedsend", "draft"], ["resumed", "draft"], ["lastsession", "draft"], ["unread", "draft"], ["sent", "forward"], ["changed", "forward"], ["unsure", "draft"], ["checking", "draft"], ["interrupted", "draft"], ["unresolved", "draft"]].map(([draft, state]) => `draft=${draft}&screen=compose&state=${state}`),
  ...["failed", "timeout", "unreachable", "busy", "unsecured", "login", "signin", "disabled", "toolong", "toolarge", "staging", "expired", "changed", "unsavedfirst", "unsaved", "fwdgone", "fwdall", "fwdchanged", "fwdmismatch", "fwdmoved", "twice", "twiceunsure", "twicegoing", "twicefrom", "queued", "accepted", "previous", "slow"].map((send) => `screen=compose&send=${send}&state=draft`),
  "device=phone&screen=compose&send=timeout&state=draft",
  ...["saved", "onlyhere", "toolong", "stayed"].map((saved) => `saved=${saved}&screen=compose&state=draft`),
  "fromnote=matched&screen=compose&state=draft",
  "fromnote=substituted&screen=compose&state=draft",
  ...[["laterforward", "draft"], ["laterfiles", "attach"], ["laterfar", "attach"], ["laternofiles", "attach"], ["laterpast", "draft"], ["laterskip", "draft"], ["latercomputer", "draft"], ["filesnotkept", "draft"], ["unreadable", "attach"], ["overcap", "attach"], ["attaching", "attach"], ["servermore", "attach"], ["nothing", "draft"]].map(([note, state]) => `note=${note}&screen=compose&state=${state}`),
  ...[["fwdnote", "forward"], ["fwdlarge", "forward"], ["quality", "draft"], ["schedfailed", "draft"], ["qualitycap", "draft"]].map(([line, state]) => `line=${line}&screen=compose&state=${state}`),
  "from=mailto&screen=compose&state=blank",
  "screen=compose&state=blank&support=1",
  "diag=off&screen=compose&state=blank&support=1",
];

const ORIGIN = "http://write.states.invalid";
let page: Promise<string> | null = null;

/** The states page as one document, built once a run (its typefaces from the tokens package). */
async function document(): Promise<string> {
  page ??= import("../../../packages/app/test/states/write-states.mjs").then(
    (m: { writeStatesPage: () => Promise<string> }) => m.writeStatesPage(),
  );
  return page;
}

export const subjects: Subject[] = KEYS.map((key) => ({
  key,
  open: async (p) => {
    const html = await document();
    await p.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    await p.goto(`${ORIGIN}/?${key}`);
    await p.waitForSelector('html[data-ready="1"]', { timeout: 15_000 });
  },
}));
