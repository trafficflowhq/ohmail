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

/**
 * A CREDENTIAL'S OWN VERDICT (a wrong password, code or passkey), said apart from a lapsed
 * session's `unauthorized`. Its 401 is the answer, so no client renews and re-sends on it; each
 * client's path list stays for servers older than this code. The server's constant
 * (`packages/services/src/auth/credential-refused.ts`) is held equal by
 * `test/factor-routes-never-refresh.test.ts`, the sidecar's twin by the one-classifier test.
 */
export const CREDENTIAL_REFUSED = "credential_refused";

/**
 * `fault.code` is a vocabulary word for a log line — the envelope's code or `http_<status>`.
 * `erased` is `410 account_erased`: the account is gone, and `account` is the one the server named
 * (`X-Ohmail-Account`, null when absent) — the caller ends the session only for its own account.
 */
export type RefreshAnswer =
  | { kind: "minted"; tokens: { accessToken: string; refreshToken: string; expiresIn?: number } }
  | { kind: "refused"; code: string; message: string | null }
  | { kind: "erased"; account: string | null }
  | { kind: "fault"; code: string };

/** The request header a client names `account_erased` in; the server answers 401 without it. */
export const ERASED_ANSWER_HEADER = "x-ohmail-accepts";
export const ACCOUNT_ERASED = "account_erased";

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

/** Does this answer refuse the CREDENTIAL by name? Reads a clone, so the caller keeps the body. */
export async function isCredentialRefusal(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const error = (await jsonOf(res.clone()) as { error?: { code?: unknown } } | null | undefined)?.error;
  return error?.code === CREDENTIAL_REFUSED;
}

/** Read one `/auth/refresh` answer. Reads the body once; never throws. */
export async function readRefreshAnswer(res: Response): Promise<RefreshAnswer> {
  const body = await jsonOf(res);
  if (res.ok) {
    const pair = (body as { tokens?: Record<string, unknown> } | null | undefined)?.tokens;
    const access = pair?.accessToken;
    const refresh = pair?.refreshToken;
    if (typeof access === "string" && access !== "" && typeof refresh === "string" && refresh !== "") {
      // The access window the door stated, in seconds, when it stated one: what a client reads to
      // renew BEFORE a press whose 401 it may not renew on (`expiresIn` is never persisted).
      const expiresIn = pair?.expiresIn;
      const stated = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0;
      return { kind: "minted", tokens: { accessToken: access, refreshToken: refresh, ...(stated ? { expiresIn } : {}) } };
    }
    return { kind: "fault", code: body === undefined ? "unreadable_response" : "no_token_pair" };
  }
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
  const code = typeof error?.code === "string" && CODE_SHAPE.test(error.code) ? error.code : null;
  if (isSessionRefusal(res.status, code)) {
    return { kind: "refused", code, message: typeof error?.message === "string" ? error.message : null };
  }
  if (res.status === 410 && code === ACCOUNT_ERASED) {
    return { kind: "erased", account: res.headers.get("X-Ohmail-Account") };
  }
  return { kind: "fault", code: code ?? `http_${res.status}` };
}
