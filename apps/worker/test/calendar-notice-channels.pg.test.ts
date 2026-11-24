/**
 * THE PROVIDER'S NOTICE CHANNELS, as the worker's pass keeps them, on a real Postgres. A provider
 * is a scripted double that keeps every ask whole, so the word a channel is opened with can be
 * looked for everywhere it must not be: in every column of every row of the account, and in every
 * line the pass logs.
 *
 * What is held: with no address nothing is asked and nothing written; a word is stored only as its
 * digest; the address is the deployment's own origin and the literal path; Google's row stands
 * before Google is asked, Microsoft's only after; a refusal leaves no row and is not asked again
 * for an hour; a channel in its last day gets a successor with a new id and a new word, and only
 * then is ended; ended rows go each turn; a turn spends eight requests at the most.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Answer, CalendarNotices, CalendarProvider, Connection, NoticeChannel, NoticeChannelAsk } from "@ohmail/cal-providers";
import { calCalendars } from "@trafficflow/db";
import { calPushChannels } from "@trafficflow/db/cloud";
import { calendarPool, passDb } from "@ohmail/organizer/calendar-sync";
import type { CalendarNoticeInput } from "@ohmail/organizer/calendar/types";
import {
  NOTICE_REFUSED_WAIT_MS, NOTICE_RENEW_BEFORE_MS, NOTICE_REQUESTS_PER_TURN, calendarNoticesPass, type CalendarNoticeDeps,
} from "../src/calendar-notices.js";
import { NOTICE_LIFE_MS, NOTICE_PROVISIONAL_MS } from "../src/calendar/notice-channels.js";
import { AVAILABLE, capturedLog, openWorld, seedConnection, silentHttp, type World } from "../../../packages/organizer/test/_calendar-world.js";

const ORIGIN = "https://api.notices.example.test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const digest = (word: string): string => createHash("sha256").update(word, "utf8").digest("hex");
const never = new AbortController().signal;

interface Opened { readonly calendar: string; readonly id: string; readonly address: string; readonly word: string; readonly untilMs: number }
interface ChannelRow {
  readonly channelId: string; readonly calendarId: string | null; readonly provider: string;
  readonly tokenHash: string; readonly resourceId: string | null; readonly expiresAt: Date;
}
/** What a script may look at while the provider is being asked: the connection's rows, and the pass's clock. */
interface Probe { rows(): Promise<ChannelRow[]>; readonly clock: { at: number } }
interface Script {
  /** What an open answers; `usual` is a channel of six days under the id asked (or an id of the provider's own). */
  readonly open?: (asked: Opened, n: number, usual: () => Answer<NoticeChannel>, probe: Probe) => Promise<Answer<NoticeChannel>> | Answer<NoticeChannel>;
  /** Run inside an open, before it answers: what the store holds while the provider is being asked. */
  readonly during?: (asked: Opened, probe: Probe) => Promise<void>;
}

/** A provider's notice half that keeps what it was asked, in order. */
function scripted(provider: "google" | "microsoft", probe: Probe, script: Script = {}) {
  const { clock } = probe;
  const opened: Opened[] = [];
  const events: string[] = [];
  const notices: CalendarNotices = {
    provider,
    names: provider === "google" ? "caller" : "provider",
    async open(_c: Connection, cal, ask: NoticeChannelAsk): Promise<Answer<NoticeChannel>> {
      const asked: Opened = { calendar: cal.id, id: ask.id, address: ask.address, word: ask.word(), untilMs: ask.untilMs };
      opened.push(asked);
      events.push(`open ${cal.id}`);
      await script.during?.(asked, probe);
      const usual = (): Answer<NoticeChannel> => ({
        ok: true,
        value: { id: provider === "google" ? ask.id : randomUUID(), resourceId: provider === "google" ? `res-${randomUUID()}` : null, expiresAtMs: clock.at + 6 * DAY },
      });
      return script.open === undefined ? usual() : script.open(asked, opened.length, usual, probe);
    },
    async close(_c: Connection, channel): Promise<Answer<null>> {
      events.push(`close ${channel.id} ${channel.resourceId ?? "-"}`);
      return { ok: true, value: null };
    },
  };
  return { notices, opened, events };
}

describe.skipIf(!AVAILABLE)("the worker's notice channel pass", () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });

  /** A connection with `n` calendars, and one turn of the pass over it. */
  async function rig(provider: "google" | "microsoft", n: number, script: Script = {}, origin: string | null = ORIGIN) {
    const seeded = await seedConnection(w, { provider, credential: null });
    const calendars: { id: string; providerId: string }[] = [];
    for (let i = 0; i < n; i++) {
      const providerId = `cal-${i}-${randomUUID()}@group.calendar.example.test`;
      const [row] = await w.db.insert(calCalendars).values({ accountId: seeded.accountId, connectionId: seeded.connectionId, providerId }).returning({ id: calCalendars.id });
      calendars.push({ id: row!.id, providerId });
    }
    const clock = { at: Date.now() };
    const rows = (): Promise<ChannelRow[]> => w.db.select({
      channelId: calPushChannels.channelId, calendarId: calPushChannels.calendarId, provider: calPushChannels.provider,
      tokenHash: calPushChannels.tokenHash, resourceId: calPushChannels.resourceId, expiresAt: calPushChannels.expiresAt,
    }).from(calPushChannels).where(and(eq(calPushChannels.accountId, seeded.accountId), eq(calPushChannels.connectionId, seeded.connectionId)));
    const double = scripted(provider, { rows, clock }, script);
    const log = capturedLog();
    const deps: CalendarNoticeDeps = { origin, log: log.log, clock: { now: () => clock.at }, refused: new Map() };
    const made: CalendarProvider = { reader: null as never, writer: null, notices: double.notices, http: silentHttp() };
    const input = (over: Partial<CalendarNoticeInput> = {}): CalendarNoticeInput => ({
      db: passDb(calendarPool(w.db), seeded.accountId), key: { accountId: seeded.accountId, id: seeded.connectionId }, provider: made,
      connection: { provider, start: null, credential: { kind: "bearer", accessToken: async () => ({ ok: true, token: "short-lived" }) } },
      calendars, signal: never, ...over,
    });
    const turn = (over: Partial<CalendarNoticeInput> = {}) => calendarNoticesPass(deps, input(over));
    /** Every row of the account in the tables a channel's opening could write to, as text. */
    const everything = async (): Promise<string> => {
      const out = await w.db.execute(sql`
        select coalesce(string_agg(row_to_json(t)::text, ' '), '') as text from (
          select to_jsonb(c) as j from cal_push_channels c where c.account_id = ${seeded.accountId}
          union all select to_jsonb(c) from cal_connections c where c.account_id = ${seeded.accountId}
          union all select to_jsonb(c) from cal_calendars c where c.account_id = ${seeded.accountId}
          union all select to_jsonb(c) from cal_credentials c where c.account_id = ${seeded.accountId}
          union all select to_jsonb(c) from change_log c where c.account_id = ${seeded.accountId}
        ) t`) as unknown as Array<{ text: string }>;
      return out[0]!.text;
    };
    return { ...seeded, calendars, clock, double, log, deps, turn, rows, everything };
  }

  it("with no address, or a provider that has no notices, asks nothing and writes no row", async () => {
    const none = await rig("google", 2, {}, null);
    expect(await none.turn()).toEqual({ live: false });
    const caldav = await rig("google", 2);
    expect(await caldav.turn({ provider: { reader: null as never, writer: null, notices: null, http: silentHttp() } })).toEqual({ live: false });
    expect([none.double.events, await none.rows(), caldav.double.events, await caldav.rows(), none.log.lines, caldav.log.lines]).toEqual([[], [], [], [], [], []]);
  });

  it("opens a channel for each calendar at the deployment's own address, and stores the word as its digest alone", async () => {
    const r = await rig("google", 2);
    expect(await r.turn()).toEqual({ live: true });
    expect(r.double.opened.map((o) => [o.calendar, o.address, o.untilMs])).toEqual(
      r.calendars.map((c) => [c.providerId, `${ORIGIN}/calendar/notices/google`, r.clock.at + NOTICE_LIFE_MS]),
    );
    const words = r.double.opened.map((o) => o.word);
    for (const word of words) expect(word).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(words).size).toBe(2);
    const rows = await r.rows();
    expect(rows.map((row) => [row.calendarId, row.channelId, row.tokenHash, row.provider]).sort()).toEqual(
      r.double.opened.map((o, i) => [r.calendars[i]!.id, o.id, digest(o.word), "google"]).sort(),
    );
    for (const row of rows) expect([row.resourceId?.startsWith("res-"), row.expiresAt.getTime()]).toEqual([true, r.clock.at + 6 * DAY]);
    // The word is in no column of any row of the account, and in no line of the log; neither is a channel's id in a line.
    const store = await r.everything();
    const said = r.log.lines.join("\n");
    expect(words.filter((word) => store.includes(word) || said.includes(word))).toEqual([]);
    expect(r.double.opened.filter((o) => said.includes(o.id) || said.includes(digest(o.word)) || said.includes(o.address))).toEqual([]);
    expect(r.log.lines.map((l) => JSON.parse(l) as Record<string, unknown>).map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { level: "info", service: "worker", event: "calendar_notices", accountId: r.accountId, kind: "google", count: 2, applied: 2, closed: 0, refused: 0, state: "live" },
    ]);
    // A turn with nothing to do asks nothing and says nothing.
    r.log.lines.length = 0;
    expect(await r.turn()).toEqual({ live: true });
    expect([r.double.opened.length, r.log.lines]).toEqual([2, []]);
  });

  it("Google: the row stands before Google is asked, short-lived until it answers, and a refusal removes it", async () => {
    const seen: unknown[] = [];
    const r = await rig("google", 1, {
      during: async (asked, probe) => {
        const rows = await probe.rows();
        seen.push(rows.map((row) => [row.channelId === asked.id, row.tokenHash === digest(asked.word), row.resourceId, row.expiresAt.getTime() - probe.clock.at]));
      },
      open: (_asked, n) => (n === 1 ? { ok: false, reason: "unsupported", retryAfterMs: null } : { ok: false, reason: "throttled", retryAfterMs: 2 * HOUR }),
    });
    expect(await r.turn()).toEqual({ live: false });
    expect(seen).toEqual([[[true, true, null, NOTICE_PROVISIONAL_MS]]]);
    expect(await r.rows()).toEqual([]);
    // Not asked again inside the hour; asked again after it; and then the provider's own longer wait is kept.
    r.clock.at += NOTICE_REFUSED_WAIT_MS - 1;
    await r.turn();
    expect(r.double.opened.length).toBe(1);
    r.clock.at += 1;
    await r.turn();
    expect(r.double.opened.length).toBe(2);
    r.clock.at += 2 * HOUR - 1;
    await r.turn();
    expect(r.double.opened.length).toBe(2);
    r.clock.at += 1;
    await r.turn();
    expect([r.double.opened.length, await r.rows()]).toEqual([3, []]);
    expect(new Set(r.double.opened.map((o) => o.id)).size).toBe(3);
  });

  it("Microsoft: the subscription first, then the row under the id Microsoft named; an id the door could not be asked by is ended again", async () => {
    const seen: unknown[] = [];
    const named = [randomUUID(), randomUUID().toUpperCase()];
    const r = await rig("microsoft", 2, {
      during: async (_asked, probe) => { seen.push((await probe.rows()).length); },
      open: (_asked, n, _usual, probe) => ({ ok: true, value: { id: named[n - 1]!, resourceId: null, expiresAtMs: probe.clock.at + 2 * DAY } }),
    });
    expect(await r.turn()).toEqual({ live: false });
    // No row stood while the first was asked; the first's row stood while the second was.
    expect(seen).toEqual([0, 1]);
    expect(r.double.opened.map((o) => o.address)).toEqual([`${ORIGIN}/calendar/notices/microsoft`, `${ORIGIN}/calendar/notices/microsoft`]);
    const rows = await r.rows();
    expect(rows.map((row) => [row.channelId, row.calendarId, row.tokenHash, row.resourceId, row.expiresAt.getTime()])).toEqual([
      [named[0], r.calendars[0]!.id, digest(r.double.opened[0]!.word), null, r.clock.at + 2 * DAY],
    ]);
    expect(r.double.events.filter((e) => e.startsWith("close"))).toEqual([`close ${named[1]} -`]);
  });

  it("Microsoft: a row that cannot be written ends the subscription it was for, and the pass says a failure and nothing of it", async () => {
    const taken = randomUUID();
    const other = await rig("microsoft", 1, { open: () => ({ ok: true, value: { id: taken, resourceId: null, expiresAtMs: Date.now() + 2 * DAY } }) });
    expect(await other.turn()).toEqual({ live: true });
    // The same id again, for another account's connection: the store refuses the second row.
    const r = await rig("microsoft", 1, { open: () => ({ ok: true, value: { id: taken, resourceId: null, expiresAtMs: Date.now() + 2 * DAY } }) });
    expect(await r.turn()).toEqual({ live: false });
    expect([await r.rows(), r.double.events]).toEqual([[], [`open ${r.calendars[0]!.providerId}`, `close ${taken} -`]]);
    const lines = r.log.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.level, l.event, l.kind])).toEqual([["warn", "calendar_notices_failed", "microsoft"]]);
    expect(r.log.lines.join("\n").includes(taken) || r.log.lines.join("\n").includes(r.double.opened[0]!.word)).toBe(false);
    // The other account's row is as it was.
    expect((await other.rows()).map((row) => row.channelId)).toEqual([taken]);
  });

  it("a channel in its last day gets a successor with a new id and a new word, made first; then the old one is ended and its row removed", async () => {
    const standing: unknown[] = [];
    const r = await rig("google", 1, { during: async (_asked, probe) => { standing.push((await probe.rows()).map((row) => row.resourceId !== null)); } });
    await r.turn();
    const [first] = await r.rows();
    // More than a day left: nothing is asked.
    r.clock.at += 6 * DAY - NOTICE_RENEW_BEFORE_MS - 1;
    await r.turn();
    expect(r.double.opened.length).toBe(1);
    // Inside its last day: the successor.
    r.clock.at += 2;
    r.log.lines.length = 0;
    expect(await r.turn()).toEqual({ live: true });
    const [old, next] = r.double.opened;
    expect([next!.id === old!.id, next!.word === old!.word, next!.calendar]).toEqual([false, false, old!.calendar]);
    // While the successor was asked for, the old channel's row still stood beside the new one's.
    expect(standing[1]).toEqual(expect.arrayContaining([true, false]));
    expect(r.double.events).toEqual([`open ${old!.calendar}`, `open ${old!.calendar}`, `close ${first!.channelId} ${first!.resourceId}`]);
    const rows = await r.rows();
    expect(rows.map((row) => [row.channelId, row.tokenHash])).toEqual([[next!.id, digest(next!.word)]]);
    expect(r.log.lines.map((l) => JSON.parse(l) as Record<string, unknown>).map((l) => [l.event, l.applied, l.closed, l.state])).toEqual([["calendar_notices", 1, 1, "live"]]);
  });

  it("a successor that is refused leaves the old channel standing until its own end", async () => {
    const r = await rig("google", 1, { open: (_asked, n, usual) => (n === 1 ? usual() : { ok: false, reason: "unavailable", retryAfterMs: null }) });
    await r.turn();
    const [first] = await r.rows();
    r.clock.at += 6 * DAY - HOUR;
    expect(await r.turn()).toEqual({ live: true });
    expect((await r.rows()).map((row) => row.channelId)).toEqual([first!.channelId]);
    expect(r.double.events.filter((e) => e.startsWith("close"))).toEqual([]);
  });

  it("removes the rows that ended, and ends the channel of a calendar that is no longer read", async () => {
    const r = await rig("google", 2);
    await r.turn();
    const before = await r.rows();
    const gone = before.find((row) => row.calendarId === r.calendars[1]!.id)!;
    // One calendar leaves the reading; the other's channel is past its end in the store.
    await w.db.update(calPushChannels).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(and(eq(calPushChannels.accountId, r.accountId), eq(calPushChannels.calendarId, r.calendars[0]!.id)));
    r.double.events.length = 0;
    expect(await r.turn({ calendars: [r.calendars[0]!] })).toEqual({ live: true });
    expect(r.double.events).toEqual([`close ${gone.channelId} ${gone.resourceId}`, `open ${r.calendars[0]!.providerId}`]);
    const after = await r.rows();
    expect(after.map((row) => row.calendarId)).toEqual([r.calendars[0]!.id]);
    expect(before.map((row) => row.channelId)).not.toContain(after[0]!.channelId);
  });

  it("spends eight requests a turn at the most: the rest wait for the next", async () => {
    const r = await rig("google", NOTICE_REQUESTS_PER_TURN + 4);
    expect(await r.turn()).toEqual({ live: false });
    expect([r.double.opened.length, (await r.rows()).length]).toEqual([NOTICE_REQUESTS_PER_TURN, NOTICE_REQUESTS_PER_TURN]);
    expect(await r.turn()).toEqual({ live: true });
    expect([r.double.opened.length, (await r.rows()).length]).toEqual([NOTICE_REQUESTS_PER_TURN + 4, NOTICE_REQUESTS_PER_TURN + 4]);
  });

  it("Microsoft: the request that ends a subscription which cannot be kept is counted among the eight", async () => {
    // Every answered id is one the door could not be asked by: each open costs its own request and the one that ends it again.
    const bad = await rig("microsoft", NOTICE_REQUESTS_PER_TURN, {
      open: (_asked, _n, _usual, probe) => ({ ok: true, value: { id: randomUUID().toUpperCase(), resourceId: null, expiresAtMs: probe.clock.at + 2 * DAY } }),
    });
    expect(await bad.turn()).toEqual({ live: false });
    expect([bad.double.opened.length, bad.double.events.filter((e) => e.startsWith("close")).length, await bad.rows()])
      .toEqual([NOTICE_REQUESTS_PER_TURN / 2, NOTICE_REQUESTS_PER_TURN / 2, []]);
    // Where every subscription is kept, an open is begun only while the request to end it again is still left.
    const good = await rig("microsoft", NOTICE_REQUESTS_PER_TURN + 1);
    expect(await good.turn()).toEqual({ live: false });
    expect([good.double.opened.length, good.double.events.filter((e) => e.startsWith("close")).length]).toEqual([NOTICE_REQUESTS_PER_TURN - 1, 0]);
    expect(await good.turn()).toEqual({ live: true });
    expect((await good.rows()).length).toBe(NOTICE_REQUESTS_PER_TURN + 1);
  });

  it("a provider that throws leaves no row behind, and the turn that ran before it is not failed", async () => {
    const r = await rig("google", 1, { open: () => { throw new Error("a provider's double threw"); } });
    await expect(r.turn()).resolves.toEqual({ live: false });
    expect(await r.rows()).toEqual([]);
    expect(r.log.lines.map((l) => (JSON.parse(l) as Record<string, unknown>).event)).toEqual(["calendar_notices_failed"]);
  });
});
