/**
 * THE PHONE'S SENDER SHEET SAYS WHY A MESSAGE STAYED — the web sheet's lines, on the same route.
 *
 * After a press with "also move" on, the server's pass leaves alone mail the person replied to,
 * set aside or filed in another mail app, and mail that failed the sender's sign-in checks. The
 * sheet asks `GET /screener/stayed` about the rows the lists still show elsewhere, once that pass
 * has finished, and names one line per place and reason with "Move it too" (none for a failed
 * check). Driven through `bootEngine`, the composition the app runs: a forward missing from the
 * account guard reads as "no reason" on the live path only, which is how the phone shipped it.
 */
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions } from "../src/state/live";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { stayedRows } from "../src/ui/sender-stayed-lines";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})() };
const FROM = { name: "Shop", address: "news@shop.test" };
const DONE = { requestedAt: "2026-09-30T08:00:00Z", doneAt: "2026-09-30T08:05:00Z" };
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 8, 0)).toISOString();
/** A message id the route admits (the service refuses anything but a uuid). */
const mid = (n: number) => `11111111-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const [a1, a2, a3, n1, n2, n3, c1] = [1, 2, 3, 4, 5, 6, 7].map(mid) as [string, string, string, string, string, string, string];

afterEach(() => { resetLocaleRegisterForTests(); });

/**
 * Three in the Ohbox where the rule files them; two in News (replied, failed checks), one in
 * Receipts filed in another mail app, and one in News the server names no reason for.
 */
async function scene(
  retro: RuleDTO["retro"] = DONE, rule: RuleDTO = ruleDto("r1", "sender", FROM.address, "INBOX"), bulk = 0,
) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule({ ...rule, provenance: "manual", retro });
  for (const [id, folder, day] of [
    [a1, "INBOX", 20], [a2, "INBOX", 19], [a3, "INBOX", 18],
    [n1, "ohmail/News", 17], [n2, "ohmail/News", 16], [n3, "ohmail/News", 15],
    [c1, "ohmail/Receipts", 14],
  ] as const) fake.addMessage(dto(id, { from: FROM, folder, date: at(day) }));
  fake.setStayed(n1, "replied");
  fake.setStayed(n2, "failed-checks");
  fake.setStayed(c1, "filed-elsewhere");
  // Older mail left in Receipts by the same pass, past the route's 100-id page.
  for (let i = 0; i < bulk; i++) {
    const id = mid(0x1000 + i);
    fake.addMessage(dto(id, { from: FROM, folder: "ohmail/Receipts", date: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString() }));
    fake.setStayed(id, "filed-elsewhere");
  }
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const said: string[] = [];
  const actions = liveActions({ engine: boot.engine, uuid: deps.uuid, zone: "UTC", toast: (m) => said.push(sayArg(m)) });
  const asked = () => fake.seen.filter((r) => r.method === "GET" && r.url.startsWith("/screener/stayed"));
  const close = () => { boot.store.close(); fake.server.close(); };
  return { ...boot, fake, actions, said, asked, close };
}

/** The sheet's rows for the sender of `seed`, as the sheet builds them. */
async function rowsOf(s: Awaited<ReturnType<typeof scene>>, seed: string, scope: "sender" | "domain" = "sender") {
  const ask = s.actions.screeningStayed(seed, scope);
  const why = ask ? await s.actions.stayedWhy(ask.elsewhere.map((e) => e.id)) : null;
  return { ask, rows: stayedRows(ask, why) };
}

describe("the phone's engine asks the server why", () => {
  it("whyStayed reaches GET /screener/stayed through the app's own composition", async () => {
    const s = await scene();
    const why = await s.engine.whyStayed([n1, n2, n3, c1]);
    expect(s.asked()).toHaveLength(1);
    expect([...why.entries()].sort()).toEqual([[n1, "replied"], [n2, "failed-checks"], [c1, "filed-elsewhere"]]);
    s.close();
  });
});

describe("the sheet names one line per place and reason once the pass has finished", () => {
  it("asks about exactly the rows the lists show away from the rule's place, newest first", async () => {
    const s = await scene();
    const ask = s.actions.screeningStayed(a1, "sender");
    expect(ask?.ruled).toBe("ohbox");
    expect(ask?.elsewhere).toEqual([
      { id: n1, place: "reads" }, { id: n2, place: "reads" }, { id: n3, place: "reads" }, { id: c1, place: "receipts" },
    ]);
    s.close();
  });

  it("each line counts the rows of its place and reason, and a failed check offers no move", async () => {
    const s = await scene();
    const { rows } = await rowsOf(s, a1);
    expect(rows.map((r) => [r.text, r.move?.label ?? null, r.move?.ids ?? null, r.move?.dest ?? null])).toEqual([
      ["1 stays in News: you replied to it.", "Move it too", [n1], "ohbox"],
      ["1 stays in News: it failed the sender's sign-in checks.", null, null, null],
      ["1 stays in Receipts: filed in another mail app.", "Move it too", [c1], "ohbox"],
    ]);
    // The counts equal where the mail is: every line's rows sit, on the server, where it says.
    const folderOf = { reads: "ohmail/News", receipts: "ohmail/Receipts" } as const;
    const ask = s.actions.screeningStayed(a1, "sender")!;
    for (const e of ask.elsewhere) expect(s.fake.message(e.id)?.folder).toBe(folderOf[e.place as keyof typeof folderOf]);
    s.close();
  });

  it("several rows of one reason are one line with their count, in German too", async () => {
    const s = await scene();
    s.fake.setStayed(n3, "replied");
    setActiveLocale("de");
    const { rows } = await rowsOf(s, a2);
    expect(rows.map((r) => [r.text, r.move?.label ?? null, r.move?.ids ?? null])).toEqual([
      ["2 bleiben in News: Du hast darauf geantwortet.", "Die Nachrichten auch verschieben", [n1, n3]],
      ["1 bleibt in News: Die Anmeldeprüfung des Absenders ist fehlgeschlagen.", null, null],
      ["1 bleibt in Belege: in einem anderen Mailprogramm einsortiert.", "Die Nachricht auch verschieben", [c1]],
    ]);
    s.close();
  });

  it("a domain rule's pass is asked about the domain's rows", async () => {
    const s = await scene(DONE, ruleDto("r1", "domain", "shop.test", "INBOX"));
    const { ask, rows } = await rowsOf(s, a1, "domain");
    expect(ask?.ruled).toBe("ohbox");
    expect(rows.map((r) => r.text)).toEqual([
      "1 stays in News: you replied to it.",
      "1 stays in News: it failed the sender's sign-in checks.",
      "1 stays in Receipts: filed in another mail app.",
    ]);
    s.close();
  });
});

describe("past the route's 100-id page every row is asked", () => {
  it("151 left in Receipts read 151, equal to the server, and Move them too moves 151", async () => {
    const s = await scene(DONE, undefined, 150);
    const { ask, rows } = await rowsOf(s, a1);
    const onServer = [...ask!.elsewhere].filter((e) => s.fake.message(e.id)?.folder === "ohmail/Receipts").length;
    expect(onServer).toBe(151);
    expect(rows.map((r) => r.text)).toEqual([
      "1 stays in News: you replied to it.",
      "1 stays in News: it failed the sender's sign-in checks.",
      "151 stay in Receipts: filed in another mail app.",
    ]);
    expect(s.asked()).toHaveLength(2);
    const receipts = rows[2]!.move!;
    expect([receipts.label, receipts.ids.length]).toEqual(["Move them too", 151]);
    expect(await s.actions.moveStayed(receipts.ids, receipts.dest)).toBe(true);
    const moved = s.fake.seen.filter((r) => r.method === "POST" && /^\/messages\/[^/]+\/move$/.test(r.url));
    expect(moved).toHaveLength(151);
    expect(s.said.at(-1)).toBe("Ohbox — 151" + " messages moved.");
    s.close();
  });
});

describe("no line while there is nothing a finished pass left", () => {
  it("a pass still running is not asked about: those rows are on their way", async () => {
    const s = await scene({ requestedAt: DONE.requestedAt, doneAt: null });
    expect(s.actions.screeningStayed(a1, "sender")).toBeNull();
    s.close();
  });

  it("a rule whose past mail was never asked for is not asked about", async () => {
    const s = await scene({ requestedAt: null, doneAt: null });
    expect(s.actions.screeningStayed(a1, "sender")).toBeNull();
    expect(s.asked()).toHaveLength(0);
    s.close();
  });
});

describe("Move it too goes through the web's door", () => {
  it("one move per row to the rule's place, the sentence from the answer, and the line leaves", async () => {
    const s = await scene();
    const { rows } = await rowsOf(s, a1);
    const replied = rows.find((r) => r.move?.ids.includes(n1))!.move!;
    expect(await s.actions.moveStayed(replied.ids, replied.dest)).toBe(true);
    const moves = s.fake.seen.filter((r) => r.method === "POST" && /^\/messages\/[^/]+\/move$/.test(r.url));
    expect(moves.map((r) => [r.url, (JSON.parse(r.body) as { folder?: string }).folder])).toEqual([[`/messages/${n1}/move`, "INBOX"]]);
    expect(s.said.at(-1)).toBe("Ohbox — 1 message moved.");
    expect(s.fake.message(n1)?.folder).toBe("INBOX");
    await s.engine.syncOnce();
    expect(s.actions.screeningStayed(a1, "sender")?.elsewhere.map((e) => e.id)).toEqual([n2, n3, c1]);
    s.close();
  });

  it("a refused move is said, never counted moved", async () => {
    const s = await scene();
    s.fake.failNext("POST", `/messages/${c1}/move`);
    expect(await s.actions.moveStayed([c1], "ohbox")).toBe(false);
    expect(s.said.at(-1)).toBe("1 message did not change.");
    s.close();
  });
});
