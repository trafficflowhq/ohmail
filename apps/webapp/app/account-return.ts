import { account } from "./api-client";

/** How long a return page waits on the confirm before it moves on and polls. */
export const RETURN_CONFIRM_BOUND_MS = 5_000;

/**
 * A RETURN FROM CHECKOUT, CONFIRMED ONCE (mail 0135): the payment page sends the person back with
 * `?session_id=`, and the service is asked to apply that payment now rather than when its webhook
 * arrives. Bounded and never throwing — whatever it answers, the caller then polls access as it did
 * before. No `session_id`, nothing is asked.
 */
export async function confirmAccountReturn(
  search: string, boundMs: number = RETURN_CONFIRM_BOUND_MS,
): Promise<void> {
  const sessionId = new URLSearchParams(search).get("session_id");
  if (!sessionId) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      account.confirmReturn(sessionId),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, boundMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
