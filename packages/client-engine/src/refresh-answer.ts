/**
 * WHAT A REFRESH ANSWER SAYS ABOUT THE SESSION — one reading for the phone and the paired browser
 * client. Only the refresh door's own verdict ends a session: a 401 whose envelope names one of
 * {@link SESSION_REFUSAL_CODES}. Anything else — a 403, an uncoded 401, a sign-in page, a proxy's
 * body, a 200 that is not a token pair — is the network's answer: the session stays and the next
 * attempt repeats the same attempt name. No imports, so a host that links the barrel pays one
 * file. The sidecar may not link this package and keeps a twin (`apps/sidecar/src/cloud-auth.ts`),
 * held equal by `test/refresh-answer-one-classifier.test.ts`.
 */

/** The door's codes (`packages/services/src/auth/session-lifecycle.ts`), plus the legacy one. */
export const SESSION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "refresh_missing", "refresh_expired", "refresh_revoked", "unauthorized",
]);

/** `fault.code` is a vocabulary word for a log line — the envelope's code or `http_<status>`. */
export type RefreshAnswer =
  | { kind: "minted"; tokens: { accessToken: string; refreshToken: string } }
  | { kind: "refused"; code: string; message: string | null }
  | { kind: "fault"; code: string };

/** Our envelope's code shape; anything else is not ours and names nothing. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,47}$/;

/** THE DECIDING LINE: the server refused this credential by name. */
export function isSessionRefusal(status: number, code: string | null): code is string {
  return status === 401 && code !== null && SESSION_REFUSAL_CODES.has(code);
}

/** The body as JSON, or undefined where it is not JSON at all — a sign-in page, an empty body. */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Read one `/auth/refresh` answer. Reads the body once; never throws. */
export async function readRefreshAnswer(res: Response): Promise<RefreshAnswer> {
  const body = await jsonOf(res);
  if (res.ok) {
    const pair = (body as { tokens?: Record<string, unknown> } | null | undefined)?.tokens;
    const access = pair?.accessToken;
    const refresh = pair?.refreshToken;
    if (typeof access === "string" && access !== "" && typeof refresh === "string" && refresh !== "") {
      return { kind: "minted", tokens: { accessToken: access, refreshToken: refresh } };
    }
    return { kind: "fault", code: body === undefined ? "unreadable_response" : "no_token_pair" };
  }
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
  const code = typeof error?.code === "string" && CODE_SHAPE.test(error.code) ? error.code : null;
  if (isSessionRefusal(res.status, code)) {
    return { kind: "refused", code, message: typeof error?.message === "string" ? error.message : null };
  }
  return { kind: "fault", code: code ?? `http_${res.status}` };
}
