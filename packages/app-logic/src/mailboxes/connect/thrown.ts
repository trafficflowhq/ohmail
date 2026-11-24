/**
 * WHAT A THROWING VERB SAID, read field by field. A shell's older verbs throw on a refusal (the hosted door's server
 * client, a computer's own engine); an adapter over them reads a throw here and nowhere else, structurally, so the
 * two doors' errors read alike.
 */
import { refusalOf } from "./refusal.js";
import type { Refusal } from "./types.js";

/** The engine's refusal of a press, as the hosted door's refusal of the same code: the press's own (422). */
const PRESS_REFUSED = 422;

/** What the engine threw when it refused: its sentence, its code (a word or none) and its details, with no status. */
function isEngineRefusal(thrown: unknown): thrown is { message: string; code: unknown; details: unknown } {
  if (typeof thrown !== "object" || thrown === null) return false;
  const t = thrown as Record<string, unknown>;
  return typeof t.message === "string" && "code" in t && "details" in t;
}

/**
 * A throw, as a refusal. A value with a status is a server's answer; the engine's own refusal carries no status and is
 * read as the press refused; anything else (a fault on the way, an exception) is no answer, and its text is never taken.
 * `repeats`, for a verb that carried a password: asked about the whole sentence, as `refusalOf` asks it.
 */
export function refusalOfThrown(thrown: unknown, repeats?: (text: string) => boolean): Refusal {
  if (typeof (thrown as { status?: unknown } | null)?.status === "number") return refusalOf(thrown, repeats);
  if (!isEngineRefusal(thrown)) return refusalOf(null);
  return refusalOf(
    { status: PRESS_REFUSED, code: thrown.code, message: thrown.message, details: thrown.details },
    repeats,
  );
}
