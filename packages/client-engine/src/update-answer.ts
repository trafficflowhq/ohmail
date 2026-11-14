/**
 * THE TWO ANSWERS EVERY CLIENT UNDERSTANDS, read the same way at every door: `426 client_too_old`
 * (this app is too old for this server) and `503 server_updating` (the server is being updated).
 * An answer is one only by STATUS AND CODE TOGETHER: an edge's own 503 and a stray 426 without
 * ohmail's envelope stay the failures they always were. No server of this release sends either.
 */
export type UpdateAnswer = "tooOld" | "serverUpdating";

export const CLIENT_TOO_OLD_STATUS = 426;
export const CLIENT_TOO_OLD_CODE = "client_too_old";
export const SERVER_UPDATING_STATUS = 503;
export const SERVER_UPDATING_CODE = "server_updating";

export function updateAnswerOf(status: number, code: unknown): UpdateAnswer | null {
  if (status === CLIENT_TOO_OLD_STATUS && code === CLIENT_TOO_OLD_CODE) return "tooOld";
  if (status === SERVER_UPDATING_STATUS && code === SERVER_UPDATING_CODE) return "serverUpdating";
  return null;
}

/** Read one answer. The body is decoded only on the two statuses, from a clone; never throws. */
export async function readUpdateAnswer(res: Response): Promise<UpdateAnswer | null> {
  if (res.status !== CLIENT_TOO_OLD_STATUS && res.status !== SERVER_UPDATING_STATUS) return null;
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } } | null;
    return updateAnswerOf(res.status, body?.error?.code);
  } catch {
    return null;
  }
}
