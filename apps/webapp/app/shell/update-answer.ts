/**
 * A SERVER SAID THIS APP IS TOO OLD, OR THAT IT IS BEING UPDATED — one door per host, one line.
 * `426 client_too_old` and `503 server_updating` (`@ohmail/client-engine`'s `updateAnswerOf`, status
 * and code together) are heard where a host's responses come in, and each tells the ONE update line
 * (`app-update.ts`) the sentence for it. Nothing here says anything about the act that was under
 * way: a queued act stays queued (the engine's rule), and the surface that asked renders the same
 * sentence if it renders the error at all.
 *
 * Three rules keep the line from nagging: Later puts the answer away for the run (`putAwayThisRun`),
 * so a line re-armed by the next failing request does not defeat it; nothing lifts `tooOld` but the
 * update itself; and a 2xx from the same server lifts `serverUpdating`.
 */
import { readUpdateAnswer, type UpdateAnswer } from "@ohmail/client-engine";
import { announceUpdate, currentUpdateOffer, putAwayThisRun, type UpdateOffer } from "./app-update";
import { activeTranslator } from "./locale";

/** How a host's remedy for "too old" reads on the line, and what pressing it does. */
export interface UpdateRemedy {
  verb: "reload" | "update";
  act: () => void;
}

/** A tab's remedy for "too old": load the build the origin serves now. */
export const RELOAD_REMEDY: UpdateRemedy = {
  verb: "reload",
  act: () => { if (typeof window !== "undefined") window.location.reload(); },
};

/**
 * THE ONE SENTENCE FOR AN ANSWER, in the reader's language, for a surface that is not the update line:
 * an error that carries it as its message, a sign-in form that shows it as its refusal. The line's
 * own keys, so the two can never say different words; English where no catalogue is active.
 */
export function updateAnswerSentence(answer: UpdateAnswer): string {
  return activeTranslator("update")?.(answer === "tooOld" ? "lineTooOld" : "lineServerUpdating")
    || (answer === "tooOld" ? "This ohmail is too old for its server." : "ohmail is being updated and will be back shortly.");
}

/** How a remedy's verb reads, from the line's own keys, for the same surfaces. */
export function updateVerbLabel(verb: UpdateRemedy["verb"]): string {
  return activeTranslator("update")?.(verb === "update" ? "lineUpdateAction" : "lineReloadAction")
    || (verb === "update" ? "Update" : "Reload");
}

/** The key each answer's line is shown under, so Later can put it away for the run. */
export const UPDATE_ANSWER_KEY: Readonly<Record<UpdateAnswer, string>> = {
  tooOld: "answer:tooOld",
  serverUpdating: "answer:serverUpdating",
};

/**
 * Put the line up for an answer. `tooOld` stands over every line but a downloaded or downloading
 * update (the update is the fix); `serverUpdating` stands over nothing that is already saying
 * something. Quiet where Later put it away this run.
 */
export function noticeUpdateAnswer(answer: UpdateAnswer, remedy?: UpdateRemedy): void {
  const key = UPDATE_ANSWER_KEY[answer];
  if (putAwayThisRun(key)) return;
  const standing = currentUpdateOffer();
  if (standing !== null) {
    if (standing.key === key) return;
    if (standing.kind === "ready" || standing.kind === "downloading") return;
    if (answer === "serverUpdating" && standing.kind !== "failed") return;
  }
  const offer: UpdateOffer = answer === "tooOld"
    ? { kind: "tooOld", key, ...(remedy ? { verb: remedy.verb, act: remedy.act } : {}) }
    : { kind: "serverUpdating", key };
  announceUpdate(offer);
}

/** The same server answered: a "being updated" line has done its work. Nothing else is lifted. */
export function noticeServerAnswered(): void {
  if (currentUpdateOffer()?.kind === "serverUpdating") announceUpdate(null);
}

/**
 * Read one response at a host's door: an update answer arms the line (only the two statuses are
 * decoded, from a clone, so no ordinary answer pays for it), a 2xx lifts a "being updated" line.
 * Never throws.
 */
export async function hearUpdateAnswer(res: Response, remedy?: UpdateRemedy): Promise<void> {
  try {
    if (res.ok) {
      noticeServerAnswered();
      return;
    }
    const answer = await readUpdateAnswer(res);
    if (answer !== null) noticeUpdateAnswer(answer, remedy);
  } catch {
    /* a response that cannot be read is not an answer we know */
  }
}

/** A host's transport, wrapped so each response it hands back is heard once. */
export function updateAwareFetch(
  inner: (url: string, init?: RequestInit) => Promise<Response>,
  remedy?: UpdateRemedy,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const res = await inner(url, init);
    await hearUpdateAnswer(res, remedy);
    return res;
  };
}
