import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { MANAGED_ENV, PLAIN_ENV, PROCESS_DOOR, env, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";

/**
 * THE DOOR A CALENDAR'S PROVIDER RINGS, AS THE ONE PROGRAM COMPOSES IT: mounted with the calendar
 * and only with it, its door in the same bag, on the managed service and on a self-hosted server
 * alike. Asked through the program's own dispatch, so the host's part is in it too: the body's
 * ceiling, the path's canonical form, the request id. No call here names a channel, so none
 * reaches a database.
 */

const open: Program[] = [];
afterEach(async () => { for (const p of open.splice(0)) await p.close(); });

const managed = (extra: Record<string, string> = {}): Program => {
  const p = buildProgram(loadSettings(env(MANAGED_ENV, extra), functionDoor()), functionInput(recordingLogger().logger));
  open.push(p);
  return p;
};
const plain = (extra: Record<string, string> = {}): Program => {
  const p = buildProgram(loadSettings(env(PLAIN_ENV, extra), PROCESS_DOOR), processInput(recordingLogger().logger));
  open.push(p);
  return p;
};
const ON = { OHMAIL_CALENDAR: "1" };
const post = (p: Program, path: string, init: RequestInit = {}): Promise<Response> =>
  p.dispatch(new Request(`https://api.ohmail.app${path}`, { method: "POST", ...init }));
/** An answer whole, the request's own id read as an id. */
async function whole(res: Response): Promise<unknown> {
  const headers = [...res.headers].map(([k, v]) => [k, k === "x-request-id" && /^[0-9a-f-]{36}$/.test(v) ? "<a fresh id>" : v]).sort();
  return [res.status, headers, await res.text()];
}
const ALIKE = [202, [["cache-control", "no-store"], ["x-request-id", "<a fresh id>"]], ""];
const ROUTES = ["/calendar/notices/google", "/calendar/notices/microsoft"];

describe("the notice door in the one program", () => {
  it("without a calendar there is no door and no route, on either service", async () => {
    for (const p of [managed(), plain(), managed({ OHCAL_NOTICE_ORIGIN: "https://api.ohmail.app", OHCAL_MICROSOFT: "1" })]) {
      expect(p.services.calendarNotices).toBeUndefined();
      for (const path of ROUTES) expect((await post(p, path)).status, path).toBe(404);
    }
  });

  it("with a calendar the door is in the bag and both routes answer the one answer, on either service", async () => {
    for (const p of [managed(ON), plain(ON)]) {
      expect(p.services.calendarNotices).toBeDefined();
      for (const path of ROUTES) {
        expect(await whole(await post(p, path)), path).toEqual(ALIKE);
        // Through the web app's split too: one `/api` is stripped before the route is found.
        expect(await whole(await post(p, `/api${path}`)), `/api${path}`).toEqual(ALIKE);
      }
    }
  });

  it("answers alike what any other route would refuse: no media type, another origin, a paging number that is none", async () => {
    const p = plain(ON);
    const calls: ReadonlyArray<readonly [string, string, RequestInit]> = [
      ["a form's media type", ROUTES[1]!, { headers: { "content-type": "text/plain" }, body: "value=1" }],
      ["a cross-site origin", ROUTES[0]!, { headers: { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" } }],
      ["a paging number that is none", `${ROUTES[0]}?limit=none&offset=-1`, {}],
      ["a session's cookie and bearer", ROUTES[0]!, { headers: { cookie: "tf_session=a-session", authorization: "Bearer a-session" } }],
    ];
    for (const [what, path, init] of calls) expect(await whole(await post(p, path, init)), what).toEqual(ALIKE);
    // The control: the same media type at a route that carries the request guard is refused for it.
    expect((await post(p, "/auth/login", { headers: { "content-type": "text/plain" }, body: "value=1" })).status).toBe(415);
  });

  it("refuses a body past the route's ceiling before the route, from its size alone", async () => {
    const p = plain(ON);
    const big = JSON.stringify({ value: [{ pad: "x".repeat(70_000) }] });
    const res = await post(p, ROUTES[1]!, { headers: { "content-type": "application/json" }, body: big });
    expect([res.status, (await res.json() as { error: { code: string } }).error.code]).toEqual([413, "payload_too_large"]);
    // Under the ceiling it is the route's own to judge.
    const small = JSON.stringify({ value: [{ pad: "x".repeat(40_000) }] });
    expect(await whole(await post(p, ROUTES[1]!, { headers: { "content-type": "application/json" }, body: small }))).toEqual(ALIKE);
    // Google's body is never read, whatever its size: it is dropped unread and the call answered. A
    // process that left bytes unread on a connection ends that connection, as it does for every route.
    const unread = await post(p, ROUTES[0]!, { headers: { "content-type": "application/json" }, body: big });
    expect([unread.status, unread.headers.get("cache-control"), unread.headers.get("connection"), await unread.text()])
      .toEqual([202, "no-store", "close", ""]);
    // A function's platform drains what is left itself: there the answer is the one answer.
    expect(await whole(await post(managed(ON), ROUTES[0]!, { headers: { "content-type": "application/json" }, body: big }))).toEqual(ALIKE);
  });

  it("echoes Microsoft's validation token only with OHCAL_MICROSOFT=1 and OHCAL_NOTICE_ORIGIN both set", async () => {
    const ask = "/calendar/notices/microsoft?validationToken=a-token-of-microsoft";
    const cases: ReadonlyArray<readonly [Record<string, string>, boolean]> = [
      [{}, false],
      [{ OHCAL_MICROSOFT: "1" }, false],
      [{ OHCAL_NOTICE_ORIGIN: "https://api.ohmail.app" }, false],
      [{ OHCAL_MICROSOFT: "true", OHCAL_NOTICE_ORIGIN: "https://api.ohmail.app" }, false],
      [{ OHCAL_MICROSOFT: "1", OHCAL_NOTICE_ORIGIN: "  " }, false],
      [{ OHCAL_MICROSOFT: "1", OHCAL_NOTICE_ORIGIN: "https://api.ohmail.app" }, true],
    ];
    for (const [extra, echoes] of cases) {
      const settings = loadSettings(env(PLAIN_ENV, ON, extra), PROCESS_DOOR);
      expect(settings.calendar.notices.microsoftValidation, JSON.stringify(extra)).toBe(echoes);
      for (const p of [plain({ ...ON, ...extra }), managed({ ...ON, ...extra })]) {
        const res = await post(p, ask);
        if (!echoes) {
          expect(await whole(res), JSON.stringify(extra)).toEqual(ALIKE);
          continue;
        }
        expect([res.status, res.headers.get("content-type"), res.headers.get("x-content-type-options"), await res.text()])
          .toEqual([200, "text/plain; charset=utf-8", "nosniff", "a-token-of-microsoft"]);
        // Google's route echoes nothing, whatever is set.
        expect(await whole(await post(p, "/calendar/notices/google?validationToken=a-token-of-microsoft"))).toEqual(ALIKE);
      }
    }
  });
});
