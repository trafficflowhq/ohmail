import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { availableParallelism, loadavg } from "node:os";
import { sql } from "drizzle-orm";
import { attachments, folderState, messageBodies, messages } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService } from "../src/index.js";
import { makeCtx } from "./helpers.js";
import { LOADED_CEILING, QUIET_RATIO, clockOf, isQuiet, verdicts, windowOf, type Round, type Verdict } from "./_budget-clock.js";

/**
 * SEARCH IS MILLISECONDS ON THE PHONE'S OWN STORE (SQLite, its FTS5 tables), through the phone's service
 * (no backfill fills its documents): 40,000 letters written as the pipeline writes them, one name in
 * nearly every To, a file name on about one letter in three. The queries a file name's words reach (a
 * part alone, beside a name or a word, excluded, a word's start, a fragment typed with its marks) answer
 * the first page inside 100 ms, each query the median of five passes, read under the budget clock: a
 * figure over the budget fails on a quiet round, and with no quiet round it warns, never red, unless it
 * reads past twice the budget. PRE-EXISTING over the budget, read and printed, never judged: `scan`,
 * `ledger` and `quarterly`, each in hundreds of subjects or bodies that this store's arms read whole, over
 * the budget on 0.30.16 too. The second store's run only: the server's and the desktop's budgets are
 * search-budget.pg and search-budget-local.
 */
const N = 40_000;
const BUDGET_MS = 100;
/** A file name's part alone, beside that name and a word, excluded, a word's start, fragments typed with their marks. */
const JUDGED = ["pdf", "image001", "scan pdf", "hartmann pdf", "hartmann -pdf", "ledg", "port-q3", "ger-773"] as const;
/**
 * Read and printed beside them: that name and its domain, a word in ten subjects, a word in one body of
 * 130, and `ines ledger`, whose `ines` this store's stemmed prefix reads as `in*` (a known difference).
 */
const CONTROLS = ["hartmann", "lichtgrat", "kestrel", "quillon", "ines ledger"] as const;
const PRE_EXISTING_OVER = ["scan", "ledger", "quarterly"] as const;
const PASSES = 5;
const ROUNDS = 3;
const QUIET_WAIT_MS = 45_000;
/** The reference: a fixed CPU-bound statement on this store, about 7 ms on a quiet workstation. */
const REF_ROWS = 100_000;

function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const FIRST = ["Lena", "Jonas", "Mara", "Piet", "Nora", "Ivo", "Greta", "Samu", "Anna", "Timo", "Elif", "Ruben", "Sanne", "Oskar", "Lia", "Matteo"];
const LAST = ["Berg", "Lindt", "Vogel", "Stein", "Kranz", "Moser", "Ebner", "Falke", "Graf", "Huber", "Keller", "Brunner", "Frei", "Wyss"];
const DOMAINS = ["atelier.example", "papierwerk.example", "nordpost.example", "buchbund.example", "harbourlab.example", "shop.example"];
const TOPICS = ["Q3 planning notes", "Invoice for July", "The kiln schedule", "Re: shelf measurements", "Newsletter new arrivals",
  "Your order has shipped", "Meeting moved to Thursday", "Draft chapter attached", "Studio rent adjustment", "Weekend workshop places",
  "Ledger for the month", "Scanned document", "Photos from the trip", "Contract renewal", "Board minutes"];
const FILLER = "please find the notes below and let me know what you think about the plan for next week thanks again for the help with the move".split(" ");
const FILES = ["scan-2025-03-12.pdf", "image001.png", "Invoice_4471.pdf", "harbour-ledger-7731.pdf", "minutes-2025.docx", "photo-0042.jpg",
  "scan_2025_11_02.pdf", "report-q3.xlsx"];
const OWNER = { name: "Mila Hartmann", address: "mila.hartmann@lichtgrat.example" };

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe.runIf(process.env.OHMAIL_TEST_DIALECT === "sqlite")(`the phone's search is milliseconds (SQLite, ${N} letters)`, () => {
  it(`the queries a file name's words reach answer the first page inside ${BUDGET_MS} ms`, async () => {
    const { db, ctx, accountId, mailboxId } = await makeCtx(new Date("2026-07-28T12:00:00Z"));
    expect(dialect(db).name).toBe("sqlite");
    const r = prng(42);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
    const person = () => {
      const f = pick(FIRST);
      const l = pick(LAST);
      return { name: `${f} ${l}`, address: `${f.toLowerCase()}.${l.toLowerCase()}@${pick(DOMAINS)}` };
    };
    for (let at = 0; at < N; at += 200) {
      const rows: Array<Record<string, unknown>> = [];
      const bodies: Array<Record<string, unknown>> = [];
      const states: Array<Record<string, unknown>> = [];
      const files: Array<Record<string, unknown>> = [];
      for (let i = at; i < Math.min(N, at + 200); i++) {
        const id = randomUUID();
        const from = person();
        const to = r() < 0.95 ? [OWNER, ...(r() < 0.3 ? [person()] : [])] : [person()];
        const cc = r() < 0.2 ? [person(), person()] : [];
        const subject = `${pick(TOPICS)} ${i % 97}${i % 6 === 0 ? " quarterly" : ""}${i % 4000 === 7 ? " kestrel" : ""}`;
        const words = Array.from({ length: 40 }, () => pick(FILLER));
        if (i % 130 === 5) words.push("quillon");
        if (i % 50 === 3) words.push("ledger");
        const n = r() < 0.3 ? 1 + Math.floor(r() * 2) : 0;
        rows.push({
          id, accountId, mailboxId, messageIdHeader: `mid:${id}`, bodyHash: id, dedupKey: `mid:${id}`, subject,
          fromAddress: from.address, fromName: from.name, toAddresses: to, ccAddresses: cc,
          date: new Date(Date.parse("2026-07-28T09:00:00Z") - i * 600_000), nativeLocator: { folder: "INBOX", ref: `1:${i}` },
          snippet: words.slice(0, 12).join(" "), unread: false, hasAttachments: n > 0,
        });
        bodies.push({ messageId: id, text: words.join(" ") });
        states.push({ messageId: id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
        for (let f = 0; f < n; f++) files.push({ accountId, messageId: id, filename: pick(FILES), contentType: "application/pdf" });
      }
      await db.transaction(async (tx) => {
        await tx.insert(messages).values(rows as never);
        await tx.insert(messageBodies).values(bodies as never);
        await tx.insert(folderState).values(states as never);
        for (let f = 0; f < files.length; f += 200) await tx.insert(attachments).values(files.slice(f, f + 200) as never);
      });
    }
    // Every document as the pipeline's writer writes it (the backfill reads the store through the same writer).
    let marked = false;
    for (let round = 0; round < 400 && !marked; round++) marked = (await searchIndexBackfillPass({ db: db as never, accountId, batch: 1_000, rounds: 5 })).marked;
    expect(marked).toBe(true);

    const svc = new SearchService({ indexFills: false });
    const page = async (q: string): Promise<number> => {
      const t = performance.now();
      const res = await svc.search(ctx, { q, limit: 50, parts: "page" });
      expect({ q, tier: res.tier, found: res.items.length > 0 }).toEqual({ q, tier: "exact", found: true });
      return performance.now() - t;
    };
    // The clock's reference, on this store.
    let quietest = Infinity;
    const refSample = async (): Promise<number> => {
      const t = performance.now();
      await dialect(db).exec(db, sql`with recursive c(x) as (select 1 union all select x + 1 from c where x < ${REF_ROWS}) select count(*) from c`);
      return performance.now() - t;
    };
    const noted = (xs: number[]) => { const w = windowOf(xs); quietest = Math.min(quietest, w.median); return w; };
    const referenceMs = async (): Promise<number> => { const xs: number[] = []; for (let i = 0; i < 5; i++) xs.push(await refSample()); return noted(xs).median; };
    for (let i = 0; i < 5; i++) await referenceMs();
    const CPUS = availableParallelism();
    /** `rounds` of the queries' figures, each round after a wait for a quiet reference when `judge`; their verdicts. */
    const read = async (queries: readonly string[], label: string, judge: boolean): Promise<Record<string, Verdict>> => {
      for (const q of queries) await page(q);
      const rounds: Round[] = [];
      for (let i = 1; i <= (judge ? ROUNDS : 1); i++) {
        const t0 = Date.now();
        let before = await referenceMs();
        while (judge && before > quietest * QUIET_RATIO && Date.now() - t0 < QUIET_WAIT_MS) {
          await new Promise((ok) => setTimeout(ok, 1_000));
          before = await referenceMs();
        }
        const loadBefore = loadavg()[0]!;
        const inside: number[] = [];
        const passes = new Map<string, number[]>();
        for (let p = 0; p < PASSES; p++) {
          for (const q of queries) {
            passes.set(q, [...(passes.get(q) ?? []), await page(q)]);
            inside.push(await refSample());
          }
        }
        const figures = Object.fromEntries(queries.map((q) => [q, Math.round(median(passes.get(q)!) * 10) / 10]));
        const round: Round = { before, after: await referenceMs(), during: noted(inside), load: Math.max(loadBefore, loadavg()[0]!), figures };
        rounds.push(round);
        const clock = clockOf(quietest, CPUS);
        console.log(`search-budget-phone ${label} round ${i}/${judge ? ROUNDS : 1} ${isQuiet(round, clock) ? "quiet" : "loaded"} ref ${before.toFixed(1)}/${round.after.toFixed(1)} ms, `
          + `inside median ${round.during.median.toFixed(1)} p95 ${round.during.p95.toFixed(1)} (limit ${clock.limit.toFixed(1)}, spike ${clock.spike.toFixed(1)}), `
          + `load ${round.load.toFixed(2)} (limit ${clock.load} on ${CPUS} CPUs): ${queries.map((q) => `${q} ${figures[q]} ms`).join(", ")}`);
        if (Object.values(verdicts(rounds, BUDGET_MS, clock)).every((v) => v.kind === "within")) break;
      }
      return verdicts(rounds, BUDGET_MS, clockOf(quietest, CPUS));
    };

    const judged = await read(JUDGED, "judged", true);
    const controls = await read(CONTROLS, "controls", false);
    const over = await read(PRE_EXISTING_OVER, "pre-existing", false);
    console.log(`search-budget-phone controls, not judged: ${CONTROLS.map((q) => `${q} ${controls[q]!.ms} ms`).join(", ")}; `
      + `pre-existing over the budget, not judged: ${PRE_EXISTING_OVER.map((q) => `${q} ${over[q]!.ms} ms`).join(", ")}`);
    for (const q of JUDGED) {
      const v = judged[q]!;
      if (v.kind === "unjudged") {
        console.log(`::warning title=phone search budget SKIPPED-LOADED::${q} median ${v.ms} ms over ${BUDGET_MS} ms with no quiet round: not judged on this host`);
        continue;
      }
      const how = v.kind === "within" ? "the best of the rounds" : v.round ? "on a quiet round: search over budget" : `past ${LOADED_CEILING * BUDGET_MS} ms with no quiet round: search over budget`;
      expect(v.ms, `${q} page median, ${how}`).toBeLessThanOrEqual(BUDGET_MS);
    }
  }, 900_000);
});
