import { looksLikeSessionToken } from "./session-gate";
import type { AppLocale } from "./shell/locale";

/**
 * `GET /account/manage` — mint a fresh account-page link and leave for it. The address a plane
 * page forwards to when its own link has expired, so it must work from a bare navigation: the
 * session token rides as a Bearer exactly as the edge gate sends it (`session-gate.ts`), and no
 * session, or one the API refuses, continues through `/login?next=manage`, whose already-signed-in
 * ladder renews a lapsed session and comes straight back. Pure over its inputs; `route.ts` is the door.
 */

export const LOGIN_FOR_MANAGE = "/login?next=manage";

/** How long the mint may take before the person is sent back to the app instead. */
export const MANAGE_MINT_TIMEOUT_MS = 8_000;

export type Handoff =
  | { kind: "login"; location: typeof LOGIN_FOR_MANAGE }
  | { kind: "leave"; location: string }
  | { kind: "app"; location: "/" };

const TO_LOGIN: Handoff = { kind: "login", location: LOGIN_FOR_MANAGE };
const TO_APP: Handoff = { kind: "app", location: "/" };

/**
 * Only an https address on ohmail.app or one of its subdomains may be left for. The service picks
 * the address; this is what keeps a mis-set one from making `/account/manage` an open redirect.
 */
export function mayLeaveFor(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw === "") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  return host === "ohmail.app" || host.endsWith(".ohmail.app");
}

export async function manageHandoff(input: {
  sessionToken: string | null;
  locale: AppLocale | null;
  apiOrigin: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Handoff> {
  const token = input.sessionToken?.trim() ?? "";
  if (token === "" || !looksLikeSessionToken(token)) return TO_LOGIN;
  if (input.apiOrigin === null) return TO_APP;
  let res: Response;
  try {
    res = await (input.fetchImpl ?? fetch)(`${input.apiOrigin}/account/manage-link`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input.locale ? { lang: input.locale } : {}),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? MANAGE_MINT_TIMEOUT_MS),
    });
  } catch {
    return TO_APP;
  }
  // A dead access token: the sign-in page renews it when it can and asks for a password only when not.
  if (res.status === 401) return TO_LOGIN;
  if (res.status !== 200) return TO_APP;
  let url: unknown;
  try {
    url = ((await res.json()) as { url?: unknown } | null)?.url;
  } catch {
    return TO_APP;
  }
  return mayLeaveFor(url) ? { kind: "leave", location: url } : TO_APP;
}
