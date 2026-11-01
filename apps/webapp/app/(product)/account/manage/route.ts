import { resolveApiOrigin, resolveInternalApiOrigin } from "../../../api-origin";
import { SESSION_COOKIE } from "../../../session-gate";
import { cookieFromJar } from "../../../shell/cookie-jar";
import { localeFromCookieHeader } from "../../../shell/locale";
import { readOwnerMarker } from "../../../shell/owner-cookie";
import { LOGIN_FOR_MANAGE, manageHandoff } from "../../../manage-handoff";

/**
 * `/account/manage` — the door `manage-handoff.ts` decides for. A HEAD or a prefetch never mints:
 * a link preview must not cost a token, and the redirect it would follow carries one.
 */
export const dynamic = "force-dynamic";

const SELF_HOST_BUILD = process.env.NEXT_PUBLIC_OHMAIL_FLAVOR === "selfhost";

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

function answer(status: number, location: string): Response {
  return new Response(null, { status, headers: { ...NO_STORE, Location: location } });
}

function prefetch(request: Request): boolean {
  const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`;
  return /prefetch/i.test(purpose);
}

function sessionToken(request: Request): string | null {
  return cookieFromJar(request.headers.get("cookie") ?? "", SESSION_COOKIE);
}

/** The edge gate never runs here, so its pending-sign-out branch is asked here. */
function signOutPending(request: Request): boolean {
  return readOwnerMarker(request.headers.get("cookie") ?? "").kind === "signed-out";
}

/** Nothing to mint for: no session, or one a sign-out has not finished with. */
function toLogin(request: Request): boolean {
  return sessionToken(request) === null || signOutPending(request);
}

export async function GET(request: Request): Promise<Response> {
  if (prefetch(request)) {
    return toLogin(request) ? answer(307, LOGIN_FOR_MANAGE) : new Response(null, { status: 204, headers: NO_STORE });
  }
  const handoff = await manageHandoff({
    sessionToken: sessionToken(request),
    signOutPending: signOutPending(request),
    locale: localeFromCookieHeader(request.headers.get("cookie")),
    apiOrigin: SELF_HOST_BUILD
      ? resolveInternalApiOrigin(process.env.OHMAIL_INTERNAL_API_ORIGIN)
      : resolveApiOrigin(process.env.TF_API_ORIGIN),
  });
  if (handoff.kind === "leave") return answer(302, handoff.location);
  return answer(handoff.kind === "login" ? 307 : 303, handoff.location);
}

export function HEAD(request: Request): Response {
  return toLogin(request)
    ? answer(307, LOGIN_FOR_MANAGE)
    : new Response(null, { status: 204, headers: NO_STORE });
}
