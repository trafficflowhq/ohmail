import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";
import { json } from "./shared.js";

const SETTINGS_PANES = ["account", "security", "devices", "storage", "mailboxes"];
const CALENDAR_PANES = ["calendar-google", "calendar-microsoft"];
const MANAGED_PANES = [...CALENDAR_PANES, "devices"];
const PURPOSE = "ohmail/settings-handoff/1";
const LIFETIME_MS = 5 * 60_000;

function answer(status: number, body: unknown): Response {
  const response = json(body, status);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function mint(pane: string, deps: ApiDeps, panes: readonly string[]): Promise<Response> {
  const session = deps.session;
  if (session?.scope !== "full" || session.via !== "bearer") return answer(401, {});
  if (!panes.includes(pane)) return answer(400, {});
  const account = session.accountId;
  const { ciphertext, keyVersion } = await deps.keyProvider.encrypt(JSON.stringify({
    purpose: PURPOSE, account, pane, expires: deps.now().getTime() + LIFETIME_MS,
  }));
  return answer(200, { account, reference: `${keyVersion}_${ciphertext}` });
}

async function check(reference: string, deps: ApiDeps, panes: readonly string[]): Promise<Response> {
  const match = /^(\d{1,10})_([A-Za-z0-9_-]{40,700})$/.exec(reference);
  if (!match) return answer(410, {});
  let payload: { purpose?: unknown; account?: unknown; pane?: unknown; expires?: unknown } | null;
  try {
    payload = JSON.parse(await deps.keyProvider.decrypt(match[2]!, Number(match[1])));
  } catch {
    return answer(410, {});
  }
  if (payload?.purpose !== PURPOSE || typeof payload.account !== "string" ||
      typeof payload.pane !== "string" || !panes.includes(payload.pane) ||
      typeof payload.expires !== "number" || payload.expires <= deps.now().getTime()) {
    return answer(410, {});
  }
  const session = deps.session;
  if (session?.scope !== "full" || session.via !== "cookie") return answer(401, {});
  if (session.accountId !== payload.account) return answer(409, {});
  return answer(200, { account: payload.account, pane: payload.pane });
}

/** The self-hosted session route also issues and checks short-lived routing references. */
export function withSettingsHandoff(route: Route): Route {
  return withHandoff(route, SETTINGS_PANES);
}

/** Managed apps hand off calendar sign-in and account device management to the browser. */
export function withManagedHandoff(route: Route): Route {
  return withHandoff(route, MANAGED_PANES);
}

function withHandoff(route: Route, panes: readonly string[]): Route {
  if (route.method !== "GET" || route.pattern !== "/auth/session") return route;
  return {
    ...route,
    async handler(request, deps, params) {
      const search = new URL(request.url).searchParams;
      const pane = search.get("settingsPane");
      const reference = search.get("settingsHandoff");
      if (pane !== null && reference !== null) return answer(400, {});
      if (pane !== null) return mint(pane, deps, panes);
      if (reference !== null) return check(reference, deps, panes);
      return route.handler(request, deps, params);
    },
  };
}
