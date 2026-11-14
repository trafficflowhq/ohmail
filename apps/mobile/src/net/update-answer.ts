/**
 * A SERVER SAID THIS APP IS TOO OLD FOR IT, OR THAT IT IS BEING UPDATED — one sink, one card. Every
 * authenticated request rides the paired session's transport, and any server may answer `426
 * client_too_old` or `503 server_updating` (`@ohmail/client-engine`'s `updateAnswerOf`: status AND code
 * together, so an edge's own 503 and a stray 426 stay the failures they were). The shell subscribes
 * here instead of meeting it one failed read at a time, and the gate puts one card over the mail
 * (`state/gate.ts`, `ui/Gated.tsx`). The `Response` is handed back whole: the act that was under way
 * meets the engine's own rule, and a queued act stays queued.
 *
 * `tooOld` stands until the app is updated (nothing in this process lifts it, and the process
 * restarts with the update); `serverUpdating` lifts on the next 2xx from the same server. A STANDALONE
 * phone has no server: the wrap sits beside the paired door's manager alone (`net/pairing.ts`) and
 * can never raise either, as the account wall cannot.
 */
import { sameOrigin } from "./request-base";

/** Which answer. WIRE WORDS, as the client engine's `updateAnswerOf` holds them (`test/update-answer.test.ts` holds the two equal). */
export type UpdateAnswer = "tooOld" | "serverUpdating";

/**
 * A MIRROR of `@ohmail/client-engine`'s `updateAnswerOf`, not an import: this file is not on the phone's list of
 * engine importers (`test/privacy.test.ts`), the way `access-lock.ts` mirrors the 402's constants. Status AND
 * code together; an edge's own 503 and a stray 426 are not answers.
 */
export function updateAnswerOf(status: number, code: unknown): UpdateAnswer | null {
  if (status === 426 && code === "client_too_old") return "tooOld";
  if (status === 503 && code === "server_updating") return "serverUpdating";
  return null;
}

/** What the card needs to know: which answer, and from which server (the origin its session is paired with). */
export interface UpdateAnswerFacts {
  answer: UpdateAnswer;
  origin: string;
}

let standing: UpdateAnswerFacts | null = null;
const watchers = new Set<(facts: UpdateAnswerFacts | null) => void>();

/** What the card is showing, or `null` while the app is the app. */
export function updateAnswer(): UpdateAnswerFacts | null {
  return standing;
}

/** Subscribe to the slot. Returns the unsubscribe; every subscriber is told. */
export function onUpdateAnswer(watch: (facts: UpdateAnswerFacts | null) => void): () => void {
  watchers.add(watch);
  return () => { watchers.delete(watch); };
}

function tell(): void {
  for (const watch of [...watchers]) {
    // A watcher that throws must not stop the others hearing, nor replace the answer with its own failure.
    try { watch(standing); } catch { /* the slot is set either way */ }
  }
}

/** Put the card up. "Too old" is the sterner sentence and is never replaced by "being updated". */
export function raiseUpdateAnswer(facts: UpdateAnswerFacts): void {
  if (standing !== null && standing.origin === facts.origin) {
    if (standing.answer === facts.answer) return;
    if (standing.answer === "tooOld") return;
  }
  standing = facts;
  tell();
}

/** The same server answered: a "being updated" card has done its work. Nothing else is lifted. */
export function lowerServerUpdating(origin: string): void {
  if (standing === null || standing.answer !== "serverUpdating" || standing.origin !== origin) return;
  standing = null;
  tell();
}

/**
 * Take the card down. The ONE caller is the connection layer, at the moment a session is established: a
 * pairing, a switch or a reconnect is a different server's turn to be judged (the wall's own rule).
 */
export function clearUpdateAnswer(): void {
  if (standing === null) return;
  standing = null;
  tell();
}

/** Tests only: forget the slot AND every watcher, so one case cannot see another's. */
export function resetUpdateAnswerForTests(): void {
  standing = null;
  watchers.clear();
}

/* ── the wrap ─────────────────────────────────────────────────────────────────────────────── */

/** The loose-init fetch shape this app's transports all have (`net/bearer.ts#FetchLike`). */
type FetchLike = (url: string, init?: unknown) => Promise<Response>;

/**
 * Wrap a paired session's transport so a 426 or a 503 with our envelope raises the card once, for the whole
 * app, and a 2xx lifts a "being updated" one. Only the server's own origin is judged: a staged upload's
 * grant goes elsewhere. The body of one of the two statuses is READ AND REBUILT rather than cloned, which is
 * React Native's shape (`access-lock.ts#withAccessLock`): this runtime's `Response` has no `body`, so a
 * copy arrives EMPTY. An ordinary answer is never read. A read that throws says NOTHING.
 */
export function withUpdateAnswer(inner: FetchLike, origin: string): FetchLike {
  return async (url, init) => {
    const res = await inner(url, init);
    if (!sameOrigin(url, origin)) return res;
    if (res.ok) {
      lowerServerUpdating(origin);
      return res;
    }
    if (res.status !== 426 && res.status !== 503) return res;
    let text: string;
    try {
      text = await res.text();
    } catch {
      return res;
    }
    let code: unknown;
    try {
      code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
    } catch {
      code = undefined;
    }
    const answer = updateAnswerOf(res.status, code);
    if (answer !== null) raiseUpdateAnswer({ answer, origin });
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
