import { ApiError } from "../../api-client";

/**
 * What a refused step-up-gated verb asks of its pane. `factor`: the five-minute window is closed —
 * park the verb and run {@link StepUpPrompt}, which re-stamps the session this browser holds.
 * `sign-in`: the session is dead (401), never finished enrolment (403 `enrollment_incomplete`), or
 * was refused again right after a verified factor; a second prompt would loop, so the pane says
 * sign in again. `other`: the verb's own refusal, the pane's own sentence.
 */
export type GatedRefusal = "factor" | "sign-in" | "other";

export function gatedRefusal(err: unknown, afterFactor: boolean): GatedRefusal {
  if (!(err instanceof ApiError)) return "other";
  if (err.status === 403 && err.code === "step_up_required") return afterFactor ? "sign-in" : "factor";
  if (err.status === 401 || (err.status === 403 && err.code === "enrollment_incomplete")) return "sign-in";
  return "other";
}
