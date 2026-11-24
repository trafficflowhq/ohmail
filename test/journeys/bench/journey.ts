import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlaceId } from "../vocabulary/places.js";
import { PEOPLE, type ConversationSpec, type Planted } from "../vocabulary/world.js";
import { benchOf, sizeOf, type Account, type Bench, type BenchId, type Guard, type Person, type Setting, type Size, type Stack } from "./seam.js";
import { runsOn } from "./standing/index.js";

/**
 * How a journeys file runs: which bench `TF_JOURNEYS` names, started once per file, and each journey run
 * where its guard says it exists. A bench is loaded only when it is named, so a run of the web loads no
 * window driver of another surface.
 */
type Start = (setting: Setting, place: PlaceId, size: Size) => Promise<Bench>;

const FLAVOUR_OF = { "W-m": "managed", "W-s": "selfhost", "W-d": "demo" } as const;

export const BENCHES: Record<BenchId, Start> = {
  async web(setting, place, size) {
    const f = FLAVOUR_OF[setting as keyof typeof FLAVOUR_OF];
    if (!f) throw new Error(`the web bench has no setting ${setting}`);
    return (await import("./web.js")).startBench(f, place, { calendar: place === "calendar" }, size);
  },
  async stack(_setting, place, size) {
    return (await import("./stack.js")).startStack(place, size);
  },
  desktop: missing("desktop"),
  android: missing("android"),
};

/** A bench named and not there fails the run; it never skips. */
function missing(id: BenchId): Start {
  return async () => { throw new Error(`TF_JOURNEYS names the ${id} bench, and this tree has no ${id} bench yet`); };
}

let bench: Bench | null = null;
/** How many journeys have been registered to run on this bench, so a file with none starts nothing. */
let runnable = 0;

/** One place's journeys: skipped unless `TF_JOURNEYS` names a bench; with it, a missing build, browser or rig fails. */
export function journeysOf(place: PlaceId, body: () => void): void {
  // The guards read each file's GUARDS; they do not run its journeys a second time.
  if ((globalThis as { __journeysNamesOnly?: boolean }).__journeysNamesOnly) return;
  const named = benchOf();
  const size = sizeOf();
  describe.skipIf(named === null)(`journeys · ${place}${named ? ` · ${named.setting}${size === "expanded" ? "" : ` · ${size}`}` : ""}`, () => {
    const before = runnable;
    body();
    // A file whose journeys all stand outside this setting starts no bench: on the stack most files are such.
    const mine = runnable - before;
    beforeAll(async () => { if (mine > 0) bench = await BENCHES[named!.id](named!.setting, place, size); }, 900_000);
    afterAll(async () => {
      await bench?.stop();
      bench = null;
    });
  });
}

/**
 * One journey: one promise. It runs where its guard says it exists, fails where the guard names a
 * need this bench does not have, and is expected to fail while its row is open.
 */
export function journey(guard: Guard, walk: (b: Bench) => Promise<void>): void {
  const test = prepareJourney(guard, walk);
  (test.skip ? it.skip : guard.open ? it.fails : it)(test.title, test.options, test.run);
}

/** An active guard a test file can register directly under its own named Vitest case. */
export function namedJourney(guard: Guard, walk: (b: Bench) => Promise<void>) {
  if (guard.open) throw new Error("An open journey must be registered as an expected failure");
  return prepareJourney(guard, walk);
}

function prepareJourney(guard: Guard, walk: (b: Bench) => Promise<void>) {
  const named = benchOf();
  const size = sizeOf();
  const options = { timeout: 180_000, retry: 0 };
  if (named !== null && !runsOn(guard, { id: named.id, setting: named.setting, size })) {
    const title = `${guard.title} (not in ${named.setting}${size === "expanded" ? "" : ` at ${size}`})`;
    return { skip: true, title, options, run: async () => {} };
  }
  runnable += 1;
  const run = async () => {
    const b = bench;
    if (!b) throw new Error("the bench did not start");
    try {
      for (const need of guard.needs) {
        if (!b.has(need)) throw new Error(`this journey needs ${NEEDS[need]}, and this bench has none`);
      }
      await walk(b);
      expect(b.problems(guard.tolerates), "the page logged an error or tried to leave the machine").toEqual([]);
    } catch (e) {
      if (process.env.TF_JOURNEYS_DEBUG === "1") console.log(await b.story());
      throw e;
    } finally {
      await b.closePeople();
    }
  };
  return { skip: false, title: guard.title, options, run };
}

const NEEDS = { pg: "a real Postgres", mail: "a mail server", stack: "the self-hosted stack's containers", native: "native doors" } as const;

/**
 * A person looking at one conversation's row: the demo's own conversation of that kind, or one
 * planted for a fresh account. Where the world is planted, `account` is whose it is.
 */
export async function personWith(b: Bench, want: ConversationSpec): Promise<{ person: Person; row: Planted; named: string; account: Account | null }> {
  if (b.fixtures) {
    const row = b.fixtures.find({ pile: want.pile, unread: want.unread });
    return { person: await b.person(), row, named: `${row.from}: ${row.subject}`, account: null };
  }
  const account = await b.account();
  const [row] = await account.planter.plant({ conversations: [want] });
  return { person: await b.person({ account }), row: row!, named: `${row!.from}: ${row!.subject}`, account };
}

/** A person signed in to an account that has a mailbox and one letter; on the demo, the demo's visitor. */
export async function signedIn(b: Bench): Promise<{ person: Person; account: Account | null }> {
  if (b.fixtures) return { person: await b.person(), account: null };
  const account = await b.account();
  await account.planter.plant({ conversations: [{ from: PEOPLE.ben, subject: "Kiln is fixed", pile: "ohbox", unread: false }] });
  return { person: await b.person({ account }), account };
}

/** The self-hosted stack's own doors, for a journey that walks the stack: refused on any other bench. */
export function stackOf(b: Bench): Stack {
  if (!b.stack) throw new Error("this journey walks the self-hosted stack");
  return b.stack;
}
