/**
 * ASKING YOUR OWN MODEL ABOUT WAITING SENDERS — the part that talks, with nothing that draws.
 *
 * Split out from the control that renders it, and not for tidiness: this is the half that has to be
 * proven against a REAL engine, and the engine's own test suite runs where there is no browser and
 * no React. A loop that could only be exercised through a rendered component could only ever be
 * tested against a stand-in for the thing it talks to, which is how two halves end up green and
 * unable to speak to each other.
 *
 * ── WHAT ONE RUN DOES ───────────────────────────────────────────────────────────────────────
 *
 * A CHOSEN number of senders, in the queue's own order, asked about in small requests. Chunks
 * exist for two reasons that have nothing to do with throughput: answers land as they arrive
 * rather than all at the end, and stopping costs at most one chunk. The transport carries no
 * cancellation — see `bridge-fetch.ts` — so a chunk already in flight runs to completion whatever
 * the caller does. With a key of your own that is your money, which is why the chunk is small.
 *
 * A re-run is cheap: the engine answers from what it has already stored before it reaches the
 * model, so a sender answered for once is not asked about twice.
 *
 * ── HOW MANY CHUNKS ARE IN FLIGHT, AND WHY IT DEPENDS ON WHERE THE MODEL IS ─────────────────
 *
 * This ran strictly serially, and the reason given was that "a burst competes with mail arriving,
 * and against a model server on this machine it competes for the machine". That is exactly right
 * for one of the two places a model can be, and an untested generalisation to the other.
 *
 * IT IS TRUE OF A MODEL ON THIS MACHINE, and now measured rather than believed. Against a real
 * `llama3.2` daemon on `127.0.0.1:11434`, twelve screening calls through the shipped provider:
 * **2 699 ms per sender serially** (min 2 586, p50 2 679, max 2 991 — a very tight spread), and
 * running the same twelve through 2, 4 and 8 lanes changed the total by nothing at all —
 * **1.02x, 0.99x and 1.01x**. One daemon answers one prompt at a time on the hardware it has, so
 * concurrency there buys no time and spends CPU the sync is using. `this_machine` keeps ONE lane.
 * (The box was under other load, so the absolute figures are pessimistic; the RATIO is the
 * finding and every arm ran under the same load.)
 *
 * It is NOT true of a hosted key. There the wait is a network round trip and a vendor's own
 * queue — this machine is idle for essentially all of it — so serial requests leave the whole
 * budget unspent and a backlog of hundreds takes as long as the sum of every round trip. A few
 * lanes there is the difference between minutes and tens of minutes, and it costs this machine
 * nothing.
 *
 * The bound stays SMALL on purpose even so. The key is the user's own, its rate limit is theirs,
 * and a 429 part-way through a run they authorised is a worse outcome than a run that takes
 * longer — the same reasoning that keeps the chunk small.
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { SenderSuggestion, SuggestSkipShown } from "../../webapp/app/shell/screener-suggest";
import { toSuggestion, toSkips, batchSizes } from "../../webapp/app/shell/screener-suggest";

/**
 * HOW MANY SENDERS ONE REQUEST CARRIES.
 *
 * Small on purpose, and not a throughput setting. It is the granularity of two things: how often
 * answers appear, and how much work a stop cannot take back.
 */
export const CHUNK = 5;

/**
 * THE DEFAULT SIZE A PRESS ASKS ABOUT, when nothing has been chosen yet.
 *
 * It used to be the ONLY size, named `PER_PRESS`, fixed at fifty and unchangeable — so a person
 * with three hundred senders waiting read "Suggest for 50 senders" and had no way to ask for the
 * rest except to press again, six times, with no indication that was the intent.
 *
 * The argument recorded for the fifty was that "the endpoint refuses more than this in a single
 * request, and a press that quietly became several requests' worth would be a buy ladder without
 * the number that made one honest". **Both halves of that were wrong about this code.** A press
 * already became several requests — {@link CHUNK} is five, so fifty senders was ten requests, not
 * one — and there is no purchase on this door at all: the model is one its owner set up, under
 * their own key or on their own machine, so there is no price for a number to be honest about.
 * The honest number here is the COUNT, and the control now shows it and lets it be chosen.
 *
 * Fifty remains the RESTING choice because it is a watchable amount of work rather than because
 * anything refuses fifty-one.
 */
export const DEFAULT_PER_PRESS = 50;

/**
 * THE SIZES ONE PRESS MAY CHOOSE — the hosted control's ladder, over the queue instead of a price.
 *
 * `batchSizes` is imported rather than reimplemented so both doors offer the same rungs: a person
 * who moves between a standalone install and a hosted account should not find a different set of
 * numbers. The second argument is `available` itself, which is what makes the top rung ALL OF
 * THEM — the hosted ladder passes its purchase ceiling there because a purchase has one, and this
 * door has nothing to buy.
 *
 * The endpoint's own per-request cap is not a ceiling on this ladder and never was: a run is
 * already a sequence of {@link CHUNK}-sized requests, each of which is far below it.
 */
export function localBatchSizes(available: number): number[] {
  return batchSizes(available, Math.max(1, available));
}

/**
 * HOW MANY CHUNKS MAY BE IN FLIGHT AT ONCE, from where the model runs.
 *
 * See the header. `this_machine` is one lane because concurrency against a local daemon buys
 * nothing and costs the sync; a hosted key is several because the wait there is a round trip this
 * machine spends idle. `null` — no provider, or an engine that predates the field — takes the
 * cautious arm, which is the serial one this module shipped with.
 */
export function lanesFor(contentGoesTo: string | null | undefined): number {
  return contentGoesTo === "anthropic" || contentGoesTo === "openai" ? HOSTED_LANES : 1;
}

/**
 * The hosted arm's lane count. Small deliberately — the rate limit being spent is the user's own,
 * and a 429 part-way through a run is worse than a slower run. See the header.
 */
export const HOSTED_LANES = 4;

/** How much of the stored queue one hydration reads. It reaches no model and costs nothing. */
const HYDRATE_LIMIT = 200;

/** Only what this module reads. Declared here so the desktop owes the Cloud client nothing. */
interface SuggestWire {
  suggestions: Array<{
    sender: string;
    messageId: string;
    decision: "yes" | "no" | "hold";
    destination?: string;
    spam?: boolean;
    confidence: number;
    rationale: string;
  }>;
  skipped: Array<{ sender: string; reason: SuggestSkipShown | "not_held" }>;
}

/** One overlay entry, as the rows already speak it. */
export type SuggestionRow = { address: string; suggestion: SenderSuggestion };

/** Why a run stopped, in the engine's own words. */
export interface SuggestRefusal {
  code: string;
  message: string;
  /** True when the code means "this install has no usable model" rather than "that run failed". */
  noModel: boolean;
}

/** The codes that mean there is nothing to run against, whatever the settings pane last showed. */
const NO_MODEL_CODES = new Set([
  "suggest_unconfigured",
  "ai_provider_unavailable",
  "drafter_unconfigured",
]);

async function refusalOf(res: Response): Promise<SuggestRefusal> {
  let code = "";
  let message = `the mail engine answered ${res.status}`;
  try {
    const wire = (await res.json()) as { error?: { code?: string; message?: string } };
    code = wire.error?.code ?? "";
    message = wire.error?.message ?? message;
  } catch {
    /* Not JSON. The status is all there is to say. */
  }
  return { code, message, noModel: NO_MODEL_CODES.has(code) };
}

/** A fresh idempotency key, so a lost answer is replayed rather than re-asked of the model. */
function newKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * What the engine already holds, read once when the Screener is first opened.
 *
 * This is what makes an answer survive a relaunch: it is stored beside the mail, and without this
 * read the chips would live only as long as the window that asked for them. A failed read answers
 * with nothing — the rows are then exactly as they already render, without chips, which claims
 * nothing untrue.
 */
export async function hydrateSuggestions(): Promise<SuggestionRow[]> {
  let res: Response;
  try {
    res = await bridgeFetch(`/screener?limit=${HYDRATE_LIMIT}`);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const page = (await res.json()) as {
    items?: Array<{
      sender?: { address?: string };
      aiSuggestion?: {
        decision: "yes" | "no" | "hold"; destination?: string; confidence: number; rationale: string;
      } | null;
    }>;
  };
  const out: SuggestionRow[] = [];
  for (const item of page.items ?? []) {
    const address = item.sender?.address;
    if (!address || !item.aiSuggestion) continue;
    out.push({ address, suggestion: toSuggestion(item.aiSuggestion) });
  }
  return out;
}

export interface SuggestRun {
  /** Waiting senders with no answer yet, in queue order. Bounded by {@link SuggestRun.limit}. */
  senders: string[];
  /**
   * HOW MANY OF THEM THIS PRESS ASKS ABOUT — the rung the person chose.
   *
   * Absent falls back to {@link DEFAULT_PER_PRESS}, which is what every caller that predates the
   * ladder meant. It is a bound on the SET, not on the requests: the set is still delivered as a
   * sequence of {@link CHUNK}-sized requests whatever this says.
   */
  limit?: number;
  /**
   * HOW MANY CHUNKS MAY BE IN FLIGHT AT ONCE. Defaults to one — the serial behaviour this module
   * shipped with, and the right answer for a model on this machine. See {@link lanesFor}.
   */
  lanes?: number;
  /** Answers, as they arrive, for the one overlay the rows read their chips from. */
  absorb: (rows: SuggestionRow[]) => void;
  /** How many senders have been answered for so far, out of how many were asked about. */
  onProgress?: (done: number, total: number) => void;
  /**
   * FALSE ONCE SOMEBODY ELSE OWNS THE STATE — a stop, or a later run.
   *
   * Checked on the arrival of every chunk and before the next one is asked for, so a stopped run
   * paints nothing and asks for nothing more. It cannot un-ask the chunk already in flight; the
   * transport has no cancellation and the engine finishes what it was given.
   */
  alive?: () => boolean;
}

export interface SuggestOutcome {
  /** Senders answered for. Lower than the total when a chunk refused part-way. */
  done: number;
  total: number;
  /** Why it stopped early, in the engine's own words, or null when it did not. */
  refusal: SuggestRefusal | null;
  /** True when a stop or a later run took over. Nothing about this outcome should be painted. */
  abandoned: boolean;
}

export function chunksOf(senders: string[], size = CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < senders.length; i += size) out.push(senders.slice(i, i + size));
  return out;
}

/**
 * Ask about `senders`, one small request at a time, landing answers as they arrive.
 *
 * Halts on the first chunk that refuses and reports why: what earlier chunks answered stays, and
 * the engine's own sentence is carried out rather than a class of failure invented here. Every
 * refusal on this path already has a true one written by the code that made the decision, and a
 * second taxonomy is how somebody with a stopped model server gets told their mail is broken.
 */
export async function runSuggest(run: SuggestRun): Promise<SuggestOutcome> {
  const alive = run.alive ?? ((): boolean => true);
  const set = run.senders.slice(0, Math.max(0, run.limit ?? DEFAULT_PER_PRESS));
  const total = set.length;
  const chunks = chunksOf(set);
  /* Never more lanes than there are chunks — otherwise a run of five senders starts four workers
     to do one chunk's work, three of which exist only to exit. */
  const lanes = Math.max(1, Math.min(run.lanes ?? 1, chunks.length || 1));

  let done = 0;
  run.onProgress?.(0, total);

  /* ── WHAT THE LANES SHARE, AND WHY IT IS THIS AND NOT A `Promise.all` OVER CHUNKS ──────────
   *
   * A fixed number of workers pulling from one index, rather than every chunk dispatched at
   * once. Two properties depend on it and neither is decorative:
   *
   *  · THE BOUND IS THE BOUND. `Promise.all(chunks.map(...))` with a hundred chunks opens a
   *    hundred requests, which is the burst this file's header refuses on either door — and on
   *    a hosted key it is the shape that earns a 429 mid-run.
   *  · A STOP STOPS. Every worker re-checks `alive()` before it takes its next chunk, so a stop
   *    costs at most the chunks already in flight — `lanes` of them, still bounded, and stated
   *    honestly by the control that offers the button. Dispatched-at-once, a stop would cost the
   *    whole run because every request is already gone.
   *
   * The FIRST REFUSAL WINS AND ENDS THE RUN. It is latched rather than thrown so the lanes still
   * to notice it drain quietly instead of racing to report different reasons for one stop; the
   * caller gets the engine's own first sentence, which is the one that explains the rest. */
  let refusal: SuggestRefusal | null = null;
  let abandoned = false;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (refusal !== null || abandoned) return;
      if (!alive()) { abandoned = true; return; }
      const i = next++;
      if (i >= chunks.length) return;
      const res = await bridgeFetch("/screener/suggest", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": newKey() },
        body: JSON.stringify({ senders: chunks[i] }),
      });
      if (!alive()) { abandoned = true; return; }
      if (!res.ok) {
        /* First writer wins: a second lane's refusal must not overwrite the sentence the caller
           is going to quote, and both describe the same stop. */
        refusal ??= await refusalOf(res);
        return;
      }
      const wire = (await res.json()) as SuggestWire;
      if (!alive()) { abandoned = true; return; }
      run.absorb([
        ...wire.suggestions.map((x) => ({ address: x.sender, suggestion: toSuggestion(x) })),
        ...toSkips(wire.skipped),
      ]);
      /* `done` is a count of answers, not of chunks, so it stays truthful under any lane count —
         and it is only ever incremented, so two lanes landing together cannot lose one. */
      done += wire.suggestions.length;
      run.onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: lanes }, () => worker()));

  if (abandoned) return { done, total, refusal: null, abandoned: true };
  return { done, total, refusal, abandoned: false };
}
