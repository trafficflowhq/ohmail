/**
 * THE PLACES' STATES (News, Receipts, the three piles, History, Tags, a folder, an address, Drafts, Trash): every state
 * and every `also` key of their eleven screens in the comparison's registry, each with the task that answers for it and
 * how the fake world of the places' tests produces it. The list `failures` starts on; the screen comparison reads it.
 *
 * Owners: `places` draws the place; `failures` a refusal or a sentence told after a press; `write` the composer in a
 * place's column and the Reply Run's panel; `reader` a designed letter drawn in place; `phone-touch` a
 * foldable's posture; `settings` the folder questions asked in the rail.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const STREAM_SCREENS = ["news", "receipts", "later", "parked", "resurface"];
export const LIST_SCREENS = ["history", "tags", "folder", "address", "drafts", "trash"];
export const PLACE_SCREENS = [...STREAM_SCREENS, ...LIST_SCREENS];

/** How the places' fake world stands a state, by what its key asks. The first match answers. */
const HOW = [
  [
    /fx=pile-unscreened/,
    "news: the pile's note over letters from senders never let in (the failures' sentence)",
  ],
  [
    /letters=designed/,
    "the stream or the column over a designed letter: waits for the reader's letter in place",
  ],
  [
    /run=1/,
    "later: the Reply Run started on the first letter, its reply open (the run's panel is the writing column's)",
  ],
  [/reply=1/, "news: an issue open with its reply in the column (write's composer)"],
  [/screen=resurface&state=set/, "resurface: a row with the hour it comes back, and Done"],
  [/screen=(news|receipts)&state=seen/, "news, receipts: every item under the line, nothing new above it"],
  [
    /screen=(news|receipts|later|parked|resurface)&state=empty/,
    "the stream or the pile with no letters: said once",
  ],
  [/posture=|device=(duo|book)/, "the plan of that device and posture"],
  [
    /^(?=.*screen=(news|receipts)(&|$))(?=.*(open=|show=open))/,
    "news, receipts: an item opened in the stream",
  ],
  [/open=.*screen=later/, "later: a row's letter opened in the reader's column"],
  [/told=restore/, "trash: the seam's restore window answers (held, refused, gone, retried, stuck)"],
  [/told=discard|told=draft|told=sched/, "drafts: the door's verdict or refusal after a press"],
  [/told=tag/, "tags: the tag's verb answered through the seat"],
  [/told=folder|ask=/, "folder: the rail's folder question or its answer (settings' panes)"],
  [/state=letter/, "trash: a live row opened, its body read, reading or failed"],
  [
    /state=(server|reading|unread|none|nofolder|late|away|onefolder|older|looking)/,
    "trash: the live wire's page in that state",
  ],
  [
    /state=(schedfailed|filesgone|waiting|held|scheduled|empty)/,
    "drafts: rows with that status, a waiting send or none",
  ],
  [/state=(device|nodate)/, "history: the store silent, or a letter with no date"],
  [/state=gone/, "folder: the routed folder left the mirror"],
  [/show=rename/, "tags: Rename asked from the list's menu"],
  [/shut=/, "tags: every tag, one group shut"],
  [/./, "the place over plain rows"],
];

function ownerOf(key) {
  if (/told=|fx=|state=letter-failed/.test(key)) return "failures";
  if (/ask=/.test(key)) return "settings";
  if (/posture=/.test(key)) return "phone-touch";
  if (/letters=designed/.test(key)) return "reader";
  if (/run=1|reply=1/.test(key)) return "write";
  if (/screen=drafts/.test(key) && /open=draft-/.test(key) && !/state=held/.test(key)) return "write";
  return "places";
}

/** The registry's rows of the given screens (all eleven by default), each with its owner and how it is stood. */
export function listPlacesStates(screens = PLACE_SCREENS) {
  const registry = JSON.parse(readFileSync(join(ROOT, "test/compare/registry.json"), "utf8"));
  return registry.states
    .filter((s) => screens.includes(s.screen))
    .map((s) => ({
      key: s.key,
      screen: s.screen,
      kind: s.kind,
      owner: ownerOf(s.key),
      how: HOW.find(([test]) => test.test(s.key))[1],
    }));
}

/**
 * The keys the comparison draws for a screen: each of its states once, and the named state in each of its seven
 * links (the registry's rows that carry `link`: every theme, scheme and size).
 */
export function comparedKeys(screen) {
  const registry = JSON.parse(readFileSync(join(ROOT, "test/compare/registry.json"), "utf8"));
  return registry.states
    .filter((s) => s.screen === screen && (s.kind === "state" || s.link))
    .map((s) => s.key);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const row of listPlacesStates())
    console.log([row.owner, row.screen, row.kind, row.key, row.how].join("\t"));
}
