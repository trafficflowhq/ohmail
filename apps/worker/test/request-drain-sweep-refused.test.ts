import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { fileURLToPath } from "node:url";
/* The REAL logger, from the barrel the worker's own `cron-log.ts` reaches it through: `log.ts`
 * has no leaf export, and this is a test rather than a published bundle. */
import { createLogger } from "@trafficflow/core";
import {
  RequestUnavailableError, type MetaRecordsList, type RequestOrganizerIo,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests } from "../src/request-drain.js";
import { readSource } from "./_start-function.js";

/**
 * A REFUSED ACK SWEEP IS LOGGED BY ITS CLASS. The drain asks the sweep once per cycle, AHEAD of the
 * read; a refusal is logged and swallowed, and the read goes on. (The drain once retried the sweep
 * when its paged read met the record window; the one door reads past the window now, so that
 * retry and its page walk are gone.)
 */
const ACCT = "00000000-0000-0000-0000-0000000000f1";
const MAILBOX = "00000000-0000-0000-0000-0000000000a1";
const KEY = "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
const NOW = new Date("2026-09-16T09:00:00.000Z");

type Line = { event: string; detail: Record<string, unknown> };

/** The drain reaches no database on any path these cases take — no envelope is ever settled. */
const NO_DB = {} as never;

function runtime(io: RequestOrganizerIo): {
  mailboxId: string; accountId: string; installId: string;
  adapter: MailboxAdapter; requestKey: string;
} {
  return {
    mailboxId: MAILBOX, accountId: ACCT, installId: "test-install",
    adapter: { requestOrganizerIo: () => io } as unknown as MailboxAdapter,
    requestKey: KEY,
  };
}

/** An empty folder whose sweep refuses `refusals` times — the iCloud shape. */
function refusingSweep(opts: { refusals: number }): {
  io: RequestOrganizerIo; sweeps: number[]; lines: Line[];
} {
  const sweeps: number[] = [];
  const lines: Line[] = [];
  const io: RequestOrganizerIo = {
    async listMetaRecords(): Promise<MetaRecordsList> { return { records: [], count: 0, bytes: 0 }; },
    uidValidity(): number { return 1_000; },
    async ack(): Promise<void> { /* nothing is settled here */ },
    async remove(): Promise<void> { /* nothing is settled here */ },
    async sweepStaleAcks(): Promise<number> {
      sweeps.push(sweeps.length + 1);
      if (sweeps.length <= opts.refusals) {
        throw new RequestUnavailableError("the search for stale acknowledgements was refused", {
          op: "sweep_acks", code: "sweep_search_refused_no_fetch",
        });
      }
      return 0;
    },
  };
  return { io, sweeps, lines };
}

describe("the drain's ack sweep, ahead of the read", () => {
  it("asks the sweep once per drain, refused or not", async () => {
    const f = refusingSweep({ refusals: 99 });
    await applyMetaRequests(NO_DB, runtime(f.io), NOW, (event, detail) => { f.lines.push({ event, detail }); });
    expect(f.sweeps.length).toBe(1);
  });

  /**
   * ── THE LINE NAMES THE CLASS THE CODE THREW ───────────────────────────────────────────────
   *
   * Through the REAL logger, because that is where the slot is owned: `err` takes the thrown VALUE
   * and `describeError` derives the class and code from it. Eleven sites in this file handed it
   * `err.message` instead, so every line read `errorClass="String"` — asserting a thrown string
   * that never existed, while the class that names the fault was thrown away. Measured: a production
   * morning's worth of such lines, all of them blaming a String for a `RequestUnavailableError`.
   */
  it("reports the sweep's refusal by its class, its code and its operation", async () => {
    const f = refusingSweep({ refusals: 99 });
    const emitted: string[] = [];
    const logger = createLogger({ service: "worker", sink: (line) => { emitted.push(line); } });

    await applyMetaRequests(NO_DB, runtime(f.io), NOW, (event, detail) => {
      logger.warn(event, detail);
    });

    const failed = emitted
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === "meta_ack_sweep_failed");
    expect(failed.length, "the refusal was never logged at all").toBeGreaterThan(0);
    expect(failed[0]?.errorClass, "the line still blames a String for an Error somebody threw")
      .toBe("RequestUnavailableError");
    expect(failed[0]?.errorCode).toBe("sweep_search_refused_no_fetch");
    expect(failed[0]?.op, "the line does not say which operation was refused").toBe("sweep_acks");
    expect(failed[0]?.droppedFields, "the census refused a field this line passed").toBeUndefined();
  });
});

/**
 * THE CENSUS: NOTHING IN THE WORKER PRE-STRINGIFIES INTO THE LOGGER'S OWN SLOT.
 *
 * `err` is a slot the logger owns by design (`log.ts`'s header: CLASS + CODE, never message +
 * stack). A site handing it a string does not add the message — the logger already keeps a thrown
 * primitive's text — it REPLACES the class with `String` and loses the code with it. Measured
 * against the corpus first: twelve sites in `apps/worker/src` spelled it that way and nothing
 * else did, so this refuses only what this change fixed.
 */
describe("the census: the worker hands the logger thrown values, not their text", () => {
  it("no `err:` field in apps/worker/src is a string expression", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length, "the census read no source at all").toBeGreaterThan(10);
    const offenders: string[] = [];
    /* THE VALUE'S OWN END, not a fixed slice: the first cut read 160 characters forward and read
     * four PARAMETER DECLARATIONS (`err: unknown`) as offenders, because a `String(` further down
     * the function landed inside the window. Measured against the corpus before this refusal was
     * written: twelve call sites in this directory spelled the idiom and nothing else did. */
    const valueAt = (src: string, from: number): string => {
      let depth = 0;
      for (let i = from; i < src.length; i++) {
        const c = src[i]!;
        if ("([{".includes(c)) depth += 1;
        else if (")]}".includes(c)) { if (depth === 0) return src.slice(from, i); depth -= 1; }
        else if (depth === 0 && (c === "," || c === ";")) return src.slice(from, i);
      }
      return src.slice(from);
    };
    for (const name of files) {
      /* Comments and string literals are BLANKED rather than deleted, so `file:line` stays true
       * and a comment quoting the old idiom cannot be read as a call site. */
      const src = withoutCommentsAndLiterals(readSource(`${dir}${name}`));
      for (let at = src.indexOf("err:"); at !== -1; at = src.indexOf("err:", at + 1)) {
        const value = valueAt(src, at + 4);
        /* The three spellings that put a STRING where the thrown value goes. A declaration
         * (`err: unknown`) and a pass-through (`err,` / `err: err`) are not among them. */
        if (/\berr\s*\.message\b/.test(value) || /\bString\(/.test(value) || value.includes("`")) {
          offenders.push(`${name}:${src.slice(0, at).split("\n").length}`);
        }
      }
    }
    expect(offenders, "a log site hands the logger a message where the thrown value goes")
      .toEqual([]);
  });
});
