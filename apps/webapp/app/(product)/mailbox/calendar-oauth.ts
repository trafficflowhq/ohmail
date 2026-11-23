import {
  calendarOAuthResultOf, isCalendarOAuthProvider, type CalendarOAuthProvider, type CalendarOAuthResult,
} from "@ohmail/app-logic/calendar/setup";
import { ApiError, api } from "../../api-client";

const setup = "#/cal/cal-setup";
const path = (provider: CalendarOAuthProvider, action: "start" | "complete") => `/calendar/oauth/${provider}/${action}`;
const waiting = `${setup}?oauth=connecting`;

export async function startCalendarOAuth(
  provider: CalendarOAuthProvider, account: string, stillCurrent: () => boolean,
): Promise<CalendarOAuthResult | void> {
  const route = path(provider, "start");
  try {
    const { authorizeUrl } = await api<{ authorizeUrl: string }>(route, {
      method: "POST", body: {}, expectedOwner: account,
    });
    if (stillCurrent()) window.location.assign(authorizeUrl);
  } catch (error) {
    return calendarFailureOf(error) ?? "start_failed";
  }
}

function calendarFailureOf(error: unknown): CalendarOAuthResult | null {
  if (!(error instanceof ApiError)) return null;
  return calendarOAuthResultOf((error.details as { reason?: unknown } | null)?.reason) ?? calendarOAuthResultOf(error.code);
}

function replaceSetup(hash: string): void {
  const url = new URL(window.location.href);
  url.hash = hash;
  window.history.replaceState(window.history.state, "", url.href);
  window.dispatchEvent(new Event("hashchange"));
}

/** Hold the one-time inputs in memory after scrubbing the browser address before the frame reads it. */
export function readCalendarOAuthReturn() {
  if (typeof window === "undefined" || !window.location.hash.startsWith(`${setup}?`)) return null;
  const query = new URLSearchParams(window.location.hash.slice(setup.length + 1));
  if (window.location.hash === waiting) {
    replaceSetup(`${setup}?oauth=state_invalid`);
    return null;
  }
  if (query.get("oauth") !== "pending") return null;
  const provider = query.get("provider");
  const state = query.get("state");
  const code = query.get("code");
  const refusal = query.get("refusal");
  if (!isCalendarOAuthProvider(provider) || !state || (!code && !refusal)) {
    replaceSetup(`${setup}?oauth=state_invalid`);
    return null;
  }
  replaceSetup(waiting);
  return { provider, state, ...(refusal ? { refusal } : { code }) };
}

export async function completeCalendarOAuth(
  back: NonNullable<ReturnType<typeof readCalendarOAuthReturn>>, account: string, stillCurrent: () => boolean,
): Promise<void> {
  const route = path(back.provider, "complete");
  if (window.location.hash !== waiting) return;
  let result: string;
  try {
    const { provider: _provider, ...body } = back;
    const { connectionId } = await api<{ connectionId: string }>(route, {
      method: "POST", body, expectedOwner: account,
    });
    result = new URLSearchParams({ step: "calendars", connection: connectionId, oauth: "connected" }).toString();
  } catch (error) {
    result = new URLSearchParams({ oauth: calendarFailureOf(error) ?? "exchange_failed" }).toString();
  }
  if (window.location.hash === waiting && stillCurrent()) {
    replaceSetup(`${setup}?${result}`);
  }
}
