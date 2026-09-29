/**
 * THE BROWSER APPROVAL'S VERDICT — what `/health` says about the one-confirm sign-in this install
 * is waiting on, so the wait outlives the window that started it and a reopened chooser resumes
 * it. States and codes only: nothing here ever takes the request id or the verifier, which stay
 * the engine's secret half (`cloud-engine.ts`). No timer: a wait past its expiry READS as ended.
 */
export type ApprovalVerdict =
  | { state: "pending"; note: "busy" | "unreachable" | null; expiresAt: string }
  | { state: "ended"; code: string; expiresAt: string };

/** The code a wait that ran out of time ends with — the chooser's own expired sentence. */
export const APPROVAL_EXPIRED = "approval_expired";

/** A fresh wait for a request that lives `expiresIn` seconds from `at`. */
export function approvalPending(at: number, expiresIn: number): Extract<ApprovalVerdict, { state: "pending" }> {
  return { state: "pending", note: null, expiresAt: new Date(at + expiresIn * 1000).toISOString() };
}

/** The wait at `at`: a pending one past its expiry is ended with {@link APPROVAL_EXPIRED}. */
export function approvalAt(verdict: ApprovalVerdict | null, at: number): ApprovalVerdict | null {
  if (verdict === null || verdict.state === "ended") return verdict;
  return Date.parse(verdict.expiresAt) <= at
    ? { state: "ended", code: APPROVAL_EXPIRED, expiresAt: verdict.expiresAt }
    : verdict;
}
