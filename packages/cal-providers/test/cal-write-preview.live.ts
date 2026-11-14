/**
 * THE PREVIEW BATCH'S RUN OF THE CALENDAR'S WRITES, live: the product's own write door and
 * worker on the preview stack, against the Google and iCloud test accounts, every outcome counted at the
 * provider by cal-accounts' test clients. OWED: the dispatcher runs it in the preview batch; no lane runs
 * it, and nothing it proves is claimed before that run.
 *
 *   OHCAL_TEST_ACCOUNTS_FILE=<the accounts file> OHCAL_PREVIEW_ENV_FILE=<the preview's file> \
 *     npx vitest run --config packages/cal-providers/vitest.live.config.ts packages/cal-providers/test/cal-write-preview.live.ts
 *
 * The preview's file (mode 600, `KEY=value` lines): OHCAL_PREVIEW_API_URL (the stack's API base),
 * OHCAL_PREVIEW_SESSION (a verified session of the preview's test account), OHCAL_PREVIEW_ACCOUNT_ID, and
 * OHCAL_PREVIEW_DB_URL, which only the store's side reads (`apps/worker/test/cal-write-preview-rig.live.ts`,
 * started here once for each question, since this package declares no database driver).
 * Before it: OHMAIL_CALENDAR=1 on server and worker, the account's calendar on, its Google and iCloud test
 * accounts connected, the sync landed, and `cal-bench.live.ts google|icloud count` exiting 0 (again after).
 *
 * Per provider, in the bench's calendar: a new event posted twice under one key is one row and ONE event at
 * the provider; that row set back to owed once (the lost close) still leaves one; a change of an untouched
 * event is applied and the next reading skips it at an equal version; a change made on a copy the provider
 * moved past is refused `version_stale`, the provider's object is left as it was, and the write's retry is
 * refused `calendar_write_left` (409); a removal is gone and the same removal again answers applied. Then
 * the account's calendar off: an act is refused `calendar_off` and recorded nowhere. Invented events only,
 * no invitee; what it made goes at its end. It prints statuses, counts and words, never an address, a key,
 * an id or a title.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BENCH_CALENDAR, BENCH_ID } from "./support/bench-events.ts";
import { CalDavTestClient } from "./support/caldav-test-client.ts";
import { readCalendarTestAccounts, Secret } from "./support/calendar-test-accounts.ts";
import { GoogleTestClient } from "./support/google-test-client.ts";

const say = (line: string): void => void process.stdout.write(`${line}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const codeOf = (err: unknown): string =>
  String(
    (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code ?? "error",
  );

const PREVIEW_KEYS = [
  "OHCAL_PREVIEW_API_URL",
  "OHCAL_PREVIEW_SESSION",
  "OHCAL_PREVIEW_ACCOUNT_ID",
  "OHCAL_PREVIEW_DB_URL",
] as const;
type Preview = Readonly<Record<(typeof PREVIEW_KEYS)[number], Secret>>;

/** The preview's file, by the rig's one rule (`^([A-Z][A-Z0-9_]*)=(.*)$`), every value a Secret; `null` when no file is named. */
function readPreview(env: Record<string, string | undefined>): Preview | null {
  const path = env.OHCAL_PREVIEW_ENV_FILE;
  if (!path) return null;
  const found = new Map<string, string>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
    if (m) found.set(m[1]!, m[2]!);
  }
  const empty = PREVIEW_KEYS.filter((k) => !found.get(k));
  if (empty.length > 0) throw new Error(`the preview's file leaves empty: ${empty.join(", ")}`);
  return Object.fromEntries(PREVIEW_KEYS.map((k) => [k, new Secret(found.get(k)!)])) as Preview;
}

/** The preview stack's API, as the account's own device asks it: a bearer session, a key on every write. */
function previewApi(p: Preview) {
  const base = p.OHCAL_PREVIEW_API_URL.reveal().replace(/\/*$/, "/");
  return async (
    method: string,
    path: string,
    o: { key?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: any }> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${p.OHCAL_PREVIEW_SESSION.reveal()}`,
      Accept: "application/json",
    };
    if (o.key !== undefined) headers["Idempotency-Key"] = o.key;
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    let r: Response;
    try {
      r = await fetch(new URL(path.replace(/^\/+/, ""), base).href, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        redirect: "manual",
      });
    } catch (err) {
      throw new Error(`the preview's API did not answer (${codeOf(err)})`);
    }
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json };
  };
}

const RIG = fileURLToPath(
  new URL("../../../apps/worker/test/cal-write-preview-rig.live.ts", import.meta.url),
);

/** One question to the store's side; its answer as JSON. The database's place travels in the preview's file, never on a line. */
function rig<T>(verb: string, ...args: string[]): T {
  const r = spawnSync(process.execPath, [RIG, verb, ...args], {
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status !== 0)
    throw new Error(
      `the store's side answered ${verb}: ${(r.stderr ?? "").trim().replace(/^cal-write-preview-rig: /, "") || `exit ${r.status}`}`,
    );
  return JSON.parse(r.stdout) as T;
}

/** Waits for `done`, reading every two seconds; past `ms` it is a failure that names what it waited for. */
async function until<T>(
  what: string,
  read: () => T | Promise<T>,
  done: (v: T) => boolean,
  ms = 180_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms / 1000} s`);
    await sleep(2_000);
  }
}

interface WriteRow {
  readonly id: string;
  readonly state: string;
  readonly refusal: string | null;
  readonly attempts: number;
  readonly event_id: string | null;
}
interface EventRow {
  readonly provider_id: string;
  readonly version_tag: string | null;
  readonly title: string;
  readonly updated_at: string;
}

/** One provider as the run meets it: the store's calendar row for its bench calendar, and the test client's hands on it. */
interface Side {
  readonly label: "google" | "icloud";
  readonly calendarRowId: string;
  readonly connectionId: string;
  /** The events at the provider whose title starts with `mark`: their ids, titles and versions. */
  marked(
    mark: string,
  ): Promise<{ readonly id: string; readonly title: string; readonly version: string | null }[]>;
  /** The object as the provider holds it now; `gone` for one removed. */
  held(id: string): Promise<{
    readonly gone: boolean;
    readonly title: string | null;
    readonly version: string | null;
    readonly bytes: string;
  }>;
  /** Someone else changes the event's title at the provider, sending no mail. */
  changeTheirs(id: string, title: string): Promise<void>;
  /** Removes an object of this run at the provider, sending no mail. */
  remove(id: string): Promise<number>;
}

const SUMMARY = /^SUMMARY(?:;[^:\r\n]*)?:(.*)$/m;
const unfold = (text: string): string => text.replace(/\r?\n[ \t]/g, "");
const pathOf = (url: string): string | null => {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};
/** One object's id as the store and the test client spell it: equal, or (an address) at the same path. */
const sameObject = (a: string | undefined, b: string): boolean =>
  a === b || (a !== undefined && pathOf(a) !== null && pathOf(a) === pathOf(b));

describe("the calendar's writes on the preview stack (owed)", () => {
  it(
    "one key is one event at each provider, through a lost close; unchanged and conflict read back; a removal; the switch off",
    { timeout: 20 * 60_000 },
    async () => {
      const preview = readPreview(process.env);
      if (preview === null) {
        say("cal-write-preview: NOT ASKED (the preview's file is not named to this run)");
        return;
      }
      const accounts = readCalendarTestAccounts(process.env);
      const api = previewApi(preview);
      const run = randomBytes(4).toString("hex");
      const mark = `cal-write preview ${run}`;
      // An invented hour three weeks on, so that a reading's window holds it.
      const day = new Date(Date.now() + 21 * 86_400_000);
      const ymd = day.toISOString().slice(0, 10);
      const at = (hour: number): string => `${ymd.replaceAll("-", "")}T${String(hour).padStart(2, "0")}0000Z`;
      const midnight = "00:00:00Z";
      const window = {
        min: `${ymd}T${midnight}`,
        max: `${new Date(day.getTime() + 86_400_000).toISOString().slice(0, 10)}T${midnight}`,
      };
      let sides: Side[] = [];
      let switchedOff = false;

      try {
        const settings = await api("GET", "/calendar/settings");
        say(
          `cal-write-preview: settings ${settings.status}, calendar on ${settings.json?.enabledAt != null}`,
        );
        expect([settings.status, settings.json?.enabledAt != null]).toEqual([200, true]);
        const stored =
          rig<{ id: string; provider_id: string; connection_id: string; provider: string }[]>("calendars");

        // ── the two providers, by cal-accounts' clients ──
        const google = new GoogleTestClient({ accounts, benchId: BENCH_ID });
        const googleCalendar = await google.writableCalendar();
        const googleRow = stored.find((c) => c.provider === "google" && c.provider_id === googleCalendar);
        const dav = new CalDavTestClient({
          baseUrl: "https://caldav.icloud.com/",
          user: accounts.ICLOUD_APPLE_ID,
          password: accounts.ICLOUD_APP_PASSWORD,
        });
        const home = (await dav.discover()).home;
        const bench = (await dav.collections(home)).collections.find(
          (x) => x.isCalendar && (pathOf(x.href) ?? "").endsWith(`/${BENCH_CALENDAR}/`),
        );
        const icloudRow =
          bench === undefined
            ? undefined
            : stored.find((c) => c.provider === "caldav" && pathOf(c.provider_id) === pathOf(bench.href));
        say(
          `cal-write-preview: the bench calendar in the store: google ${googleRow !== undefined}, icloud ${icloudRow !== undefined}`,
        );
        expect([googleRow !== undefined, icloudRow !== undefined]).toEqual([true, true]);

        sides = [
          {
            label: "google",
            calendarRowId: googleRow!.id,
            connectionId: googleRow!.connection_id,
            async marked(prefix) {
              const r = await google.listBetween(googleCalendar, window.min, window.max);
              if (r.status !== 200) throw new Error(`google: the window answered ${r.status}`);
              return r.items
                .filter((e) => typeof e.summary === "string" && e.summary.startsWith(prefix))
                .map((e) => ({
                  id: String(e.id),
                  title: String(e.summary),
                  version: typeof e.etag === "string" ? e.etag : null,
                }));
            },
            async held(id) {
              const r = await google.getEvent(googleCalendar, id);
              const gone = r.status === 404 || r.status === 410 || r.json.status === "cancelled";
              return {
                gone,
                title: typeof r.json.summary === "string" ? r.json.summary : null,
                version: typeof r.json.etag === "string" ? r.json.etag : null,
                bytes: JSON.stringify(r.json),
              };
            },
            async changeTheirs(id, title) {
              const r = await google.patchEvent(
                googleCalendar,
                id,
                { summary: title },
                { sendUpdates: "none" },
              );
              if (r.status !== 200) throw new Error(`google: the test client's change answered ${r.status}`);
            },
            remove: (id) => google.deleteEvent(googleCalendar, id, { sendUpdates: "none" }),
          },
          {
            label: "icloud",
            calendarRowId: icloudRow!.id,
            connectionId: icloudRow!.connection_id,
            async marked(prefix) {
              const q = await dav.query(bench!.href, { data: true });
              if (q.status !== 207) throw new Error(`icloud: the calendar query answered ${q.status}`);
              return q.objects.flatMap((o) => {
                const title = SUMMARY.exec(unfold(o.data ?? ""))?.[1]?.trim() ?? "";
                return title.startsWith(prefix) ? [{ id: o.href, title, version: o.etag ?? null }] : [];
              });
            },
            async held(id) {
              const r = await dav.get(id);
              return {
                gone: r.status === 404 || r.status === 410,
                title: SUMMARY.exec(unfold(r.text))?.[1]?.trim() ?? null,
                version: r.etag ?? null,
                bytes: r.text,
              };
            },
            async changeTheirs(id, title) {
              const now = await dav.get(id);
              const r = await dav.put(id, unfold(now.text).replace(SUMMARY, `SUMMARY:${title}`), {
                ifMatch: now.etag!,
              });
              if (r.status !== 204 && r.status !== 200 && r.status !== 201)
                throw new Error(`icloud: the test client's change answered ${r.status}`);
            },
            remove: async (id) => (await dav.delete(id)).status,
          },
        ];

        const rowOf = (key: string) => rig<WriteRow[]>("row", key);
        const eventOf = (id: string) => rig<EventRow | null>("event", id);
        const settled = (key: string) =>
          until(
            "the write's end",
            () => rowOf(key),
            (r) => r.length === 1 && r[0]!.state !== "pending",
          );
        /**
         * The calendar read now: made due, its connection woken; done when a reading has set its next time
         * again, and, with `moved`, when that reading also took the provider's change (its token moved on).
         */
        const readNow = async (side: Side, moved = false): Promise<void> => {
          const calendar = () =>
            rig<{ next: string | null; token: string | null }>("calendar", side.calendarRowId);
          const before = calendar();
          const { at: made } = rig<{ at: string }>("due", side.calendarRowId, side.connectionId);
          await until(
            "a reading of the calendar",
            calendar,
            (now) =>
              now.next !== null &&
              Date.parse(now.next) > Date.parse(made) &&
              (!moved || now.token !== before.token),
          );
        };
        const post = (key: string, act: unknown) => api("POST", "/calendar/writes", { key, body: act });

        for (const side of sides) {
          const title = `${mark} ${side.label}`;
          expect((await side.marked(title)).length).toBe(0);

          // 1. A new event posted twice under one key: one row, one event.
          const eventId = randomUUID();
          const create = {
            kind: "calendar_event_create",
            eventId,
            calendarId: side.calendarRowId,
            event: {
              title,
              start: { kind: "instant", value: at(9) },
              end: { kind: "instant", value: at(10) },
              notes: null,
              place: null,
              callLink: null,
              busy: true,
              private: false,
              repeat: null,
              invitees: [],
              alarms: [],
            },
          };
          const k1 = randomUUID();
          const posted = Date.now();
          const first = await post(k1, create);
          const again = await post(k1, create);
          say(
            `${side.label}: create ${first.status}, again under its key ${again.status}, one answer ${first.json?.write?.id === again.json?.write?.id}`,
          );
          expect([first.status, again.status, first.json?.write?.id === again.json?.write?.id]).toEqual([
            202,
            202,
            true,
          ]);
          const applied = await settled(k1);
          say(
            `${side.label}: rows under the key ${applied.length}, ${applied[0]!.state}, after ${Math.round((Date.now() - posted) / 1000)} s`,
          );
          expect(applied.map((r) => r.state)).toEqual(["applied"]);
          const atProvider = await side.marked(title);
          say(`${side.label}: events at the provider ${atProvider.length}`);
          expect(atProvider.length).toBe(1);
          const named = eventOf(eventId);
          expect([sameObject(named?.provider_id, atProvider[0]!.id), named?.version_tag != null]).toEqual([
            true,
            true,
          ]);

          // 2. The lost close: the provider took it and the store never heard. Sent again: still one.
          rig(
            "lost-close",
            applied[0]!.id,
            eventId,
            side.connectionId,
            JSON.stringify({ v: 1, act: create, after: null, part: null }),
          );
          const replayed = await settled(k1);
          const afterReplay = await side.marked(title);
          await readNow(side);
          const rowsTitled = rig<number>("count", side.calendarRowId, title);
          say(
            `${side.label}: the lost close sent again: ${replayed[0]!.state}, events at the provider ${afterReplay.length}, rows in the store ${rowsTitled}`,
          );
          expect([replayed[0]!.state, afterReplay.length, rowsTitled]).toEqual(["applied", 1, 1]);
          const kept = eventOf(eventId);
          expect(sameObject(kept?.provider_id, atProvider[0]!.id)).toBe(true);

          // 3. Unchanged: a change of an untouched event is applied; the next reading skips it at an equal version.
          const k2 = randomUUID();
          const changed = await post(k2, {
            kind: "calendar_event_update",
            eventId,
            base: kept!.updated_at,
            scope: { kind: "record" },
            change: { title: `${title} changed` },
          });
          expect(changed.status).toBe(202);
          const changedRow = await settled(k2);
          const afterChange = eventOf(eventId);
          await readNow(side, true);
          const afterReading = eventOf(eventId);
          const providerNow = await side.held(atProvider[0]!.id);
          say(
            `${side.label}: change ${changedRow[0]!.state}, the provider's title as written ${providerNow.title === `${title} changed`}, the store's version the provider's ${afterReading?.version_tag === providerNow.version}, the reading left the row as it was ${afterReading?.updated_at === afterChange?.updated_at}`,
          );
          expect([
            changedRow[0]!.state,
            providerNow.title,
            afterReading?.version_tag === providerNow.version,
            afterReading?.updated_at === afterChange?.updated_at,
          ]).toEqual(["applied", `${title} changed`, true, true]);

          // 4. Conflict: someone else changes it at the provider; a change made on the store's older copy is refused, and theirs stays.
          const base = eventOf(eventId)!.updated_at;
          await side.changeTheirs(atProvider[0]!.id, `${title} theirs`);
          const theirs = await side.held(atProvider[0]!.id);
          const k3 = randomUUID();
          const stale = await post(k3, {
            kind: "calendar_event_update",
            eventId,
            base,
            scope: { kind: "record" },
            change: { title: `${title} mine` },
          });
          expect(stale.status).toBe(202);
          const staleRow = await settled(k3);
          const providerAfter = await side.held(atProvider[0]!.id);
          await readNow(side, true);
          const storeAfter = eventOf(eventId);
          say(
            `${side.label}: stale change ${staleRow[0]!.state} ${staleRow[0]!.refusal ?? "-"} (${staleRow[0]!.attempts === 0 ? "at the door" : "at the provider"}), the provider's object as the test client left it ${providerAfter.bytes === theirs.bytes}, the store shows theirs ${storeAfter?.title === `${title} theirs`}`,
          );
          expect([
            staleRow[0]!.state,
            staleRow[0]!.refusal,
            providerAfter.bytes === theirs.bytes,
            storeAfter?.title,
          ]).toEqual(["refused", "version_stale", true, `${title} theirs`]);
          // A change refused for its copy is never sent again: "keep mine" is a new act on the copy the store holds.
          const retried = await api("POST", `/calendar/writes/${staleRow[0]!.id}/retry`, {
            key: randomUUID(),
          });
          say(
            `${side.label}: retry of the stale change ${retried.status} ${retried.json?.error?.code ?? "-"}`,
          );
          expect([retried.status, retried.json?.error?.code]).toEqual([409, "calendar_write_left"]);
          const dismissed = await api("DELETE", `/calendar/writes/${staleRow[0]!.id}`, { key: randomUUID() });
          expect(dismissed.status).toBe(200);

          // 5. A removal is gone at the provider; the same removal again answers applied.
          const k4 = randomUUID();
          const removal = {
            kind: "calendar_event_delete",
            eventId,
            base: eventOf(eventId)!.updated_at,
            scope: { kind: "record" },
          };
          expect((await post(k4, removal)).status).toBe(202);
          const removedRow = await settled(k4);
          const gone = await side.held(atProvider[0]!.id);
          const removedAgain = await post(k4, removal);
          say(
            `${side.label}: removal ${removedRow[0]!.state}, gone at the provider ${gone.gone}, the same removal again ${removedAgain.status} ${removedAgain.json?.write?.state ?? "-"}`,
          );
          expect([removedRow[0]!.state, gone.gone, removedAgain.json?.write?.state]).toEqual([
            "applied",
            true,
            "applied",
          ]);
          expect((await side.marked(title)).length).toBe(0);
        }

        // 6. The account's calendar off: an act is refused and recorded nowhere; then on again.
        const off = await api("PATCH", "/calendar/settings", { key: randomUUID(), body: { enabled: false } });
        switchedOff = off.status === 200;
        const k5 = randomUUID();
        const refused = await post(k5, {
          kind: "calendar_event_create",
          eventId: randomUUID(),
          calendarId: sides[0]!.calendarRowId,
          event: {
            title: `${mark} off`,
            start: { kind: "instant", value: at(11) },
            end: { kind: "instant", value: at(12) },
            notes: null,
            place: null,
            callLink: null,
            busy: true,
            private: false,
            repeat: null,
            invitees: [],
            alarms: [],
          },
        });
        const on = await api("PATCH", "/calendar/settings", { key: randomUUID(), body: { enabled: true } });
        switchedOff = switchedOff && on.status !== 200;
        say(
          `cal-write-preview: switch off ${off.status}, an act ${refused.status} ${refused.json?.error?.code ?? "-"}, rows under its key ${rowOf(k5).length}, switch on ${on.status}`,
        );
        expect([off.status, refused.status, refused.json?.error?.code, rowOf(k5).length, on.status]).toEqual([
          200,
          409,
          "calendar_off",
          0,
          200,
        ]);
      } finally {
        // What this run made and left goes, without mail; the bench's own set is judged by the dispatcher's `count`.
        if (switchedOff)
          say(
            `cal-write-preview: the calendar switched on again ${(await api("PATCH", "/calendar/settings", { key: randomUUID(), body: { enabled: true } })).status}`,
          );
        for (const side of sides) {
          const left = await side.marked(mark).catch(() => []);
          for (const e of left) say(`${side.label}: left over, removed ${await side.remove(e.id)}`);
        }
        const owedStill = (() => {
          try {
            return rig<number>("owed", mark);
          } catch {
            return -1;
          }
        })();
        if (owedStill !== 0)
          say(
            `cal-write-preview: writes of this run still owed ${owedStill} (dismiss them before the next count)`,
          );
      }
    },
  );
});
