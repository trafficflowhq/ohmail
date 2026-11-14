// LIVE, read-only (one PROPFIND at iCloud). A reading: how many calendar addresses iCloud lists for the test account, and how many are on Apple's own
// domains. Counts and booleans only; no address is printed or kept.
import { CalDavTestClient, element } from "./caldav-test-client.ts";
import { readCalendarTestAccounts } from "./calendar-test-accounts.ts";
const a = readCalendarTestAccounts(process.env);
const c = new CalDavTestClient({ baseUrl: "https://caldav.icloud.com/", user: a.ICLOUD_APPLE_ID, password: a.ICLOUD_APP_PASSWORD });
const d = await c.discover();
const r = await c.request("PROPFIND", d.principal, { depth: "0", body: '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-user-address-set/><c:schedule-inbox-URL/><c:schedule-outbox-URL/></d:prop></d:propfind>' });
const set = element(r.text, "calendar-user-address-set") ?? "";
const mail = [...set.matchAll(/mailto:([^<"\s]+)/gi)].map((m) => m[1]!);
console.log("principal PROPFIND", r.status, "| addresses listed", mail.length, "| on an Apple domain", mail.filter((m) => /@(icloud\.com|me\.com|mac\.com)$/i.test(m)).length, "| the Apple ID among them", mail.some((m) => a.ICLOUD_APPLE_ID.is(m)), "| a scheduling inbox named", element(r.text, "schedule-inbox-URL") !== undefined && (element(r.text, "schedule-inbox-URL") ?? "").includes("href"), "| a scheduling outbox named", (element(r.text, "schedule-outbox-URL") ?? "").includes("href"));
console.log("the Apple ID is on an Apple domain", a.ICLOUD_APPLE_ID.test(/@(icloud\.com|me\.com|mac\.com)$/i), "| equals the Google account", a.ICLOUD_APPLE_ID.is(a.GOOGLE_TEST_ACCOUNT));
