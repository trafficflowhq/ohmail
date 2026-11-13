/**
 * A small Google Calendar client for the bench, under the two scopes in use
 * (`calendar.events`, `calendar.calendarlist.readonly`): list the calendars, and plant, list, change and
 * remove events on the one writable calendar.
 *
 * What it refuses, by construction:
 * - a write without `sendUpdates` (Google's default is not ours to lean on);
 * - an invitee that is not one of the two test accounts' own addresses;
 * - a second write that carries invitees in one process (`inviteOnce`), and any invitation while one stands.
 *
 * The access token is made from the stored sign-in, lives in this object and is written nowhere.
 * `GoogleConsentEnded` is Google's seven-day test consent: it needs one press by a person.
 */
import { isTestAccountAddress, Secret, type CalendarTestAccounts } from "./calendar-test-accounts.ts";
import { BENCH_INVITE_MARKER, BENCH_MARKER } from "./bench-events.ts";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export type SendUpdates = "all" | "externalOnly" | "none";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type GoogleJson = Record<string, unknown>;

export class GoogleConsentEnded extends Error {
  constructor() {
    super("Google's test consent has ended (invalid_grant): it needs one consent press");
  }
}

/** An invitee is handed over as a Secret, so that it cannot be printed on its way in. */
export interface EventInput extends GoogleJson {
  attendees?: { email: Secret }[];
}

let inviteeWritesThisProcess = 0;

export class GoogleTestClient {
  readonly #accounts: CalendarTestAccounts;
  readonly #fetch: FetchLike;
  readonly #benchId: string;
  #token: { value: Secret; until: number } | undefined;

  constructor(o: { accounts: CalendarTestAccounts; benchId: string; fetch?: FetchLike }) {
    this.#accounts = o.accounts;
    this.#benchId = o.benchId;
    this.#fetch = o.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The refresh grant. Returns its status; a token it yields stays inside. */
  async signIn(): Promise<number> {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.#accounts.GOOGLE_OAUTH_CLIENT_ID.reveal(),
      client_secret: this.#accounts.GOOGLE_OAUTH_CLIENT_SECRET.reveal(),
      refresh_token: this.#accounts.GOOGLE_TEST_REFRESH_TOKEN.reveal(),
    });
    const r = await this.#fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const body = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (r.status !== 200 || !body.access_token) {
      if (body.error === "invalid_grant") throw new GoogleConsentEnded();
      return r.status;
    }
    this.#token = { value: new Secret(body.access_token), until: Date.now() + ((body.expires_in ?? 3600) - 120) * 1000 };
    return 200;
  }

  async #authorization(): Promise<string> {
    if (!this.#token || Date.now() > this.#token.until) {
      const status = await this.signIn();
      if (status !== 200) throw new Error(`Google's sign-in answered ${status}`);
    }
    return `Bearer ${this.#token!.value.reveal()}`;
  }

  async #call(method: string, path: string, query: Record<string, string>, body?: unknown): Promise<{ status: number; json: GoogleJson }> {
    const url = `${GOOGLE_CALENDAR_BASE}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`;
    const headers: Record<string, string> = { Authorization: await this.#authorization() };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await this.#fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: GoogleJson = {};
    try {
      json = text ? (JSON.parse(text) as GoogleJson) : {};
    } catch {
      /* an answer that is no JSON keeps its status and an empty body */
    }
    return { status: r.status, json };
  }

  async #pages(path: string, query: Record<string, string>): Promise<{ status: number; items: GoogleJson[] }> {
    const items: GoogleJson[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.#call("GET", path, pageToken ? { ...query, pageToken } : query);
      if (r.status !== 200) return { status: r.status, items };
      items.push(...((r.json.items as GoogleJson[] | undefined) ?? []));
      pageToken = r.json.nextPageToken as string | undefined;
    } while (pageToken);
    return { status: 200, items };
  }

  calendarList(): Promise<{ status: number; items: GoogleJson[] }> {
    return this.#pages("/users/me/calendarList", { maxResults: "250" });
  }

  /** The one calendar the account may write. More or fewer than one is a bench that changed: it throws. */
  async writableCalendar(): Promise<string> {
    const { status, items } = await this.calendarList();
    const writable = items.filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
    if (status !== 200 || writable.length !== 1) throw new Error(`the calendar list answered ${status} with ${writable.length} writable calendars; the bench expects exactly one`);
    return writable[0]!.id as string;
  }

  /** Events carrying the bench's marker (or another private marker), series as their rule plus changed days. */
  listMarked(calendarId: string, marker: string = BENCH_MARKER): Promise<{ status: number; items: GoogleJson[] }> {
    return this.#pages(`/calendars/${encodeURIComponent(calendarId)}/events`, { privateExtendedProperty: `${marker}=${this.#benchId}`, maxResults: "250", showDeleted: "false" });
  }

  instances(calendarId: string, eventId: string): Promise<{ status: number; items: GoogleJson[] }> {
    return this.#pages(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/instances`, { maxResults: "250" });
  }

  #checked(sendUpdates: SendUpdates): SendUpdates {
    if (sendUpdates !== "all" && sendUpdates !== "externalOnly" && sendUpdates !== "none") throw new Error("a write names sendUpdates: all, externalOnly or none");
    return sendUpdates;
  }

  /** events.insert. Invitees are refused unless each is a test account's own address. */
  async insertEvent(calendarId: string, event: EventInput, o: { sendUpdates: SendUpdates; conference?: boolean }): Promise<{ status: number; json: GoogleJson }> {
    const query: Record<string, string> = { sendUpdates: this.#checked(o?.sendUpdates) };
    if (o.conference) query.conferenceDataVersion = "1";
    const invitees = event.attendees ?? [];
    for (const a of invitees) {
      if (!(a.email instanceof Secret) || !isTestAccountAddress(this.#accounts, a.email)) throw new Error("refused: an invitee that is not a test account's own address");
    }
    if (invitees.length > 0 && ++inviteeWritesThisProcess > 1) throw new Error("refused: a second write with invitees in one process");
    const marked = { ...event, extendedProperties: { private: { ...((event.extendedProperties as { private?: Record<string, string> } | undefined)?.private ?? {}), [BENCH_MARKER]: this.#benchId } } };
    const body = invitees.length > 0 ? { ...marked, attendees: invitees.map((a) => ({ email: a.email.reveal() })) } : marked;
    return this.#call("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, query, body);
  }

  /** events.patch. It never carries invitees: the one invitation is made by `inviteOnce` and not edited. */
  async patchEvent(calendarId: string, eventId: string, patch: GoogleJson, o: { sendUpdates: SendUpdates }): Promise<{ status: number; json: GoogleJson }> {
    if ("attendees" in patch) throw new Error("refused: a patch does not carry invitees");
    return this.#call("PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: this.#checked(o?.sendUpdates) }, patch);
  }

  getEvent(calendarId: string, eventId: string): Promise<{ status: number; json: GoogleJson }> {
    return this.#call("GET", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {});
  }

  async deleteEvent(calendarId: string, eventId: string, o: { sendUpdates: SendUpdates }): Promise<number> {
    return (await this.#call("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: this.#checked(o?.sendUpdates) })).status;
  }

  /**
   * The one invitation: from the Google test account to the iCloud test account, and to nobody else.
   * Refused when the iCloud address is the Google one, when its domain is not Apple's own (a mailbox we
   * do not hold would be written to), or when an invitation already stands.
   */
  async inviteOnce(calendarId: string, event: GoogleJson): Promise<{ planted: boolean; why: string; status: number; json: GoogleJson }> {
    const invitee = this.#accounts.ICLOUD_APPLE_ID;
    const none = { planted: false, status: 0, json: {} };
    if (invitee.is(this.#accounts.GOOGLE_TEST_ACCOUNT)) return { ...none, why: "the two test accounts share one address" };
    if (!invitee.test(/^[^@\s]+@(icloud\.com|me\.com|mac\.com)$/i)) return { ...none, why: "the iCloud account's address is not on an Apple domain" };
    const standing = await this.listMarked(calendarId, BENCH_INVITE_MARKER);
    if (standing.status !== 200) return { ...none, status: standing.status, why: "the list of standing invitations did not answer 200" };
    if (standing.items.length > 0) return { ...none, status: 200, why: "an invitation already stands" };
    const body: EventInput = {
      ...event,
      attendees: [{ email: invitee }],
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false,
      extendedProperties: { private: { ...((event.extendedProperties as { private?: Record<string, string> } | undefined)?.private ?? {}), [BENCH_INVITE_MARKER]: this.#benchId } },
    };
    const r = await this.insertEvent(calendarId, body, { sendUpdates: "all" });
    return { planted: r.status === 200, why: r.status === 200 ? "" : `insert answered ${r.status}`, ...r };
  }

  /**
   * Removes every marked event; returns how many it removed and the statuses it met.
   * The invitation is removed with `sendUpdates=all` (one cancellation, to the one address) and only when
   * `withInvitation` says so; everything else goes without mail.
   */
  async removeMarked(calendarId: string, o: { withInvitation: boolean }): Promise<{ removed: number; kept: number; statuses: number[] }> {
    const { status, items } = await this.listMarked(calendarId);
    if (status !== 200) return { removed: 0, kept: 0, statuses: [status] };
    const statuses: number[] = [];
    let removed = 0;
    let kept = 0;
    // A series goes with its changed days; a changed day whose series is gone answers 410, which is "gone".
    const masters = items.filter((e) => e.recurringEventId === undefined);
    for (const e of masters) {
      const invitation = (e.extendedProperties as { private?: Record<string, string> } | undefined)?.private?.[BENCH_INVITE_MARKER] !== undefined;
      if (invitation && !o.withInvitation) {
        kept++;
        continue;
      }
      const s = await this.deleteEvent(calendarId, e.id as string, { sendUpdates: invitation ? "all" : "none" });
      statuses.push(s);
      if (s === 204 || s === 410) removed++;
    }
    return { removed, kept, statuses };
  }
}
