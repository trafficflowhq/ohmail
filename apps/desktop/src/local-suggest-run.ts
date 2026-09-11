/**
 * ASKING YOUR OWN MODEL ABOUT WAITING SENDERS — the part that talks, with nothing that draws;
 * split from the control so it can be proven against a REAL engine, with no browser and no React.
 * One run asks a CHOSEN number of senders in small chunks: answers land as they arrive, and a
 * stop costs at most one chunk — no cancellation in the transport (`bridge-fetch.ts`), and with
 * your own key that is your money. A re-run is cheap: the engine answers from what it stored
 * before reaching the model. Measured against a real `llama3.2` daemon, 2, 4 and 8 lanes changed
 * twelve serial calls (2 699 ms per sender) by 1.02x, 0.99x and 1.01x — `this_machine` keeps ONE
 * lane; a hosted key waits on the network and gets a few, bounded small (a 429 mid-run is worse).
 */

import { bridgeFetch } from "./bridge-fetch.js";
import type { SenderSuggestion, SuggestSkipShown } from "../../webapp/app/shell/screener-suggest.js";
import { toSuggestion, toSkips, batchSizes } from "../../webapp/app/shell/screener-suggest.js";

/**
 * HOW MANY SENDERS ONE REQUEST CARRIES.
 *
 * Small on purpose, and not a throughput setting. It is the granularity of two things: how often
 * answers appear, and how much work a stop cannot take back.
 */
export const CHUNK = 5;

/**
 * THE DEFAULT SIZE A PRESS ASKS ABOUT, when nothing has been chosen yet. It used to be the ONLY
 * size (`PER_PRESS`, fixed at fifty), so three hundred waiting senders meant "Suggest for 50
 * senders" six times over with no indication that was the intent. The recorded argument for the
 * cap — one request, a buy ladder needing an honest number — was wrong about this code: a press
 * already became several requests ({@link CHUNK} is five), and there is no purchase on this
 * door at all. The honest number here is the COUNT, and the control now shows it and lets it
 * be chosen. Fifty remains the RESTING choice because it is a watchable amount of work, not
 * because anything refuses fifty-one.
 */
export const DEFAULT_PER_PRESS = 50;

/**
 * THE SIZES ONE PRESS MAY CHOOSE — the hosted control's ladder, over the queue instead of a
 * price. `batchSizes` is imported rather than reimplemented so both doors offer the same rungs.
 * The second argument is `available` itself, which makes the top rung ALL OF THEM — the hosted
 * ladder passes its purchase ceiling there because a purchase has one; this door has nothing to
 * buy. The endpoint's own per-request cap is not a ceiling on this ladder: a run is already a
 * sequence of {@link CHUNK}-sized requests, each far below it.
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

  /* ── WHAT THE LANES SHARE — a fixed number of workers pulling from one index, never a
   * `Promise.all` over chunks. THE BOUND IS THE BOUND: dispatch-all with a hundred chunks opens
   * a hundred requests — the burst the header refuses, and on a hosted key the shape that earns
   * a 429 mid-run. A STOP STOPS: every worker re-checks `alive()` before taking its next chunk,
   * so a stop costs at most the `lanes` chunks in flight — dispatched-at-once, a stop would
   * cost the whole run. The FIRST REFUSAL WINS AND ENDS THE RUN, latched rather than thrown so
   * draining lanes do not race to report different reasons; the caller gets the engine's own
   * first sentence. */
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
