import { describe, expect, it } from "vitest";
import { planChange } from "../src/pipeline.js";
import { createLogger } from "../src/log.js";
import type { Change, RepoPort } from "../src/ports.js";
import type { ClassifierPort } from "../src/ai/classify.js";
import { FakeRepo } from "./fakes.js";

/**
 * AN EMPTY SOURCE IS NO MESSAGE (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS), the pipeline's own
 * refusal behind the adapter's. A create whose raw is an empty Buffer passed `if (!change.raw)` — an
 * empty Buffer is truthy — and parsed into a message with no Message-ID, From or Subject that took the
 * letter's place and moved its server copy to the Screener. It is now refused before the parse: no
 * store read or write, no classifier call, one log line naming the UID and nothing else.
 */

function recorded(): { repo: RepoPort; asked: string[] } {
  const asked: string[] = [];
  const repo = new Proxy(new FakeRepo(), {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => { asked.push(String(key)); return (v as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
  return { repo: repo as unknown as RepoPort, asked };
}

const classifier = (calls: string[]): ClassifierPort => ({
  classify: async () => { calls.push("classify"); throw new Error("the classifier was asked about nothing"); },
}) as unknown as ClassifierPort;

const create = (raw: Buffer): Change => ({ type: "create", locator: { folder: "INBOX", ref: "1788537505:42" }, raw });

describe("planChange refuses a create whose source is empty", () => {
  it("throws EmptySourceError, asks the store and the classifier nothing, and logs the UID alone", async () => {
    const { repo, asked } = recorded();
    const lines: string[] = [];
    const log = createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) });
    await expect(planChange(create(Buffer.alloc(0)), {
      repo, accountId: "acct", mailboxId: "mb", readerMode: false, classifier: classifier(asked), log,
    })).rejects.toMatchObject({ name: "EmptySourceError" });
    expect(asked, "touched before the refusal").toEqual([]);
    const said = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(said.map((l) => l.event)).toEqual(["ingest_empty_source_refused"]);
    const { event: _e, level: _l, service: _s, time: _t, ts: _ts, msg: _m, ...fields } = said[0]!;
    expect(fields).toEqual({ uid: 42 });
  });

  it("CONTROL: a letter with no content but one blank line is a message, not a refusal", async () => {
    const plan = await planChange(create(Buffer.from("\r\n")), {
      repo: new FakeRepo(), accountId: "acct", mailboxId: "mb", readerMode: false,
    });
    expect(plan.outcome).toBe("new");
  });
});
