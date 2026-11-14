/**
 * Asks the standing Microsoft double (the one `.cal-bench.env` names) the calls the acceptance list names,
 * prints their status codes, and JUDGES them: exit 1 with a NOT AS LISTED line when one differs from the
 * list below. This machine only.
 *
 *   OHCAL_CAL_BENCH_ENV_FILE=<.cal-bench.env> node ms-double-probe.ts
 */
import { MsDoubleClient } from "./ms-double-client.ts";

const ms = MsDoubleClient.fromEnv(process.env);
const window = { startDateTime: "2026-11-16T00:00:00Z", endDateTime: "2027-01-01T00:00:00Z" };
const code = (a: { json: Record<string, unknown> }) => (a.json.error as { code?: string } | undefined)?.code ?? "-";
const values = (a: { json: Record<string, unknown> }) => (Array.isArray(a.json.value) ? (a.json.value as Record<string, unknown>[]) : []);
await ms.reset();
const calendars = await ms.graph("GET", "/me/calendars");
const wrong = await ms.graph("GET", "/me/calendars", { token: "not-the-token" });
const view = await ms.graph("GET", "/me/calendars/cal-studio/calendarView", { query: { ...window, $top: "50" } });
const viewNoDates = await ms.graph("GET", "/me/calendars/cal-studio/calendarView");
const deltaNoDates = await ms.graph("GET", "/me/calendars/cal-studio/calendarView/delta");
let page = await ms.graph("GET", "/me/calendars/cal-studio/calendarView/delta", { query: window, headers: { Prefer: "odata.maxpagesize=5" } });
let pages = 1;
while (page.json["@odata.nextLink"]) (page = await ms.graph("GET", page.json["@odata.nextLink"] as string, { headers: { Prefer: "odata.maxpagesize=5" } })), pages++;
const deltaLink = (page.json["@odata.deltaLink"] as string | undefined) ?? "/no-delta-link-was-given";
const made = await ms.graph("POST", "/me/calendars/cal-studio/events", { body: { subject: "Kiln cooling", start: { dateTime: "2026-11-30T08:00:00", timeZone: "Europe/Zurich" }, end: { dateTime: "2026-11-30T09:00:00", timeZone: "Europe/Zurich" } } });
const got = await ms.graph("GET", `/me/events/${made.json.id}`);
const patched = await ms.graph("PATCH", `/me/events/${made.json.id}`, { body: { subject: "Kiln cooling, slowly" } });
const removed = await ms.graph("DELETE", `/me/events/evt-catalogue-proofs`);
const next = await ms.graph("GET", deltaLink);
const accept = await ms.graph("POST", "/me/events/evt-catalogue-shoot/accept", { body: { sendResponse: true } });
const tentative = await ms.graph("POST", "/me/events/evt-catalogue-shoot/tentativelyAccept", { body: { sendResponse: true } });
const decline = await ms.graph("POST", "/me/events/evt-kiln-service/decline", { body: { sendResponse: false } });
await ms.throttleNext(1, 3);
const throttled = await ms.graph("GET", "/me/calendars");
await ms.expireSyncState();
const stale = await ms.graph("GET", deltaLink);
const say = (line: string) => process.stdout.write(line + "\n");
const changed = values(next).filter((e) => !e["@removed"]).length;
const gone = values(next).filter((e) => e["@removed"]).length;
say(`ms-double: calendars ${calendars.status} (${values(calendars).length}) | wrong token ${wrong.status} ${code(wrong)}`);
say(`ms-double: calendarView ${view.status} (${values(view).length} days) | without dates ${viewNoDates.status} ${code(viewNoDates)}`);
say(`ms-double: delta without dates ${deltaNoDates.status} ${code(deltaNoDates)} | a full round ${page.status} in ${pages} pages, ends with a deltaLink ${page.json["@odata.deltaLink"] !== undefined}`);
say(`ms-double: POST ${made.status} | GET ${got.status} | PATCH ${patched.status} changeKey moved ${patched.json.changeKey !== made.json.changeKey} | DELETE ${removed.status}`);
say(`ms-double: next round ${next.status}: changed ${changed}, removed ${gone}`);
say(`ms-double: accept ${accept.status} | tentativelyAccept ${tentative.status} | decline ${decline.status}`);
say(`ms-double: throttled ${throttled.status} with Retry-After ${throttled.headers.get("retry-after")} | stale token ${stale.status} ${code(stale)} with Location ${stale.headers.has("location")}`);
await ms.reset();

// The list: what each call must answer, by Microsoft's pages and the seed. [what, read, listed]
const listed: [string, string | number | boolean, string | number | boolean][] = [
  ["calendars", `${calendars.status} (${values(calendars).length})`, "200 (3)"],
  ["a wrong token", `${wrong.status} ${code(wrong)}`, "401 InvalidAuthenticationToken"],
  ["calendarView", `${view.status} (${values(view).length} days)`, "200 (11 days)"],
  ["calendarView without dates", `${viewNoDates.status} ${code(viewNoDates)}`, "400 ErrorInvalidParameter"],
  ["delta without dates", `${deltaNoDates.status} ${code(deltaNoDates)}`, "400 ErrorInvalidParameter"],
  ["a full delta round", `${page.status} in ${pages} pages, deltaLink ${page.json["@odata.deltaLink"] !== undefined}`, "200 in 3 pages, deltaLink true"],
  ["POST", made.status, 201],
  ["GET", got.status, 200],
  ["PATCH", `${patched.status} changeKey moved ${patched.json.changeKey !== made.json.changeKey}`, "200 changeKey moved true"],
  ["DELETE", removed.status, 204],
  ["the next round", `${next.status}: changed ${changed}, removed ${gone}`, "200: changed 1, removed 1"],
  ["accept", accept.status, 202],
  ["tentativelyAccept", tentative.status, 202],
  ["decline", decline.status, 202],
  ["throttled", `${throttled.status} Retry-After ${throttled.headers.get("retry-after")}`, "429 Retry-After 3"],
  ["a stale token", `${stale.status} ${code(stale)} Location ${stale.headers.has("location")}`, "410 SyncStateNotFound Location true"],
];
const off = listed.filter(([, read, want]) => read !== want);
say(off.length === 0 ? `ms-double: as listed, ${listed.length} of ${listed.length}` : `ms-double: NOT AS LISTED: ${off.map(([what, read, want]) => `${what} read ${read}, listed ${want}`).join("; ")}`);
process.exit(off.length === 0 ? 0 : 1);
