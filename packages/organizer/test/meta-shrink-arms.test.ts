import { describe, expect, it } from "vitest";
import {
  LeaseClockSkewError, LeaseUnavailableError, type MetaRecordsList, type RequestOrganizerIo,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests, shrinkMetaOnRefusal } from "../src/request-drain.js";

/**
 * WHO SHRINKS `ohmail/_meta`, AND ON WHICH ARM (META-SHRINK-AHEAD-OF-THE-GATE). The sweep and the
 * compaction run keyless on the organizing arm, ahead of the request read and its key; on the
 * lease-refused arm they run only for a folder too full to read. A dead socket, a wrong clock and
 * a folder that takes no delete are not cured by sweeping, so those arms run nothing.
 */
const NOW = new Date("2026-10-04T10:00:00.000Z");
const NO_DB = {} as never;

function fakeIo(): { io: RequestOrganizerIo; order: string[] } {
  const order: string[] = [];
  const io: RequestOrganizerIo = {
    async listMetaRecords(): Promise<MetaRecordsList> { order.push("list"); return { records: [], count: 0, bytes: 0 }; },
    uidValidity(): number { return 1_000; },
    async ack(): Promise<void> {},
    async remove(): Promise<void> {},
    async sweepStaleAcks(): Promise<number> { order.push("sweep"); return 7; },
    async compactMeta(): Promise<number> { order.push("compact"); return 0; },
  };
  return { io, order };
}

const rt = (io: RequestOrganizerIo, requestKey: string | null) => ({
  mailboxId: "mb", accountId: "acct", installId: "cloud-test",
  adapter: { requestOrganizerIo: () => io } as unknown as MailboxAdapter, requestKey,
});

describe("the organizing arm shrinks with no request key", () => {
  it("an OAuth mailbox sweeps and compacts, and still reads no request", async () => {
    const f = fakeIo();
    const res = await applyMetaRequests(NO_DB, rt(f.io, null), NOW, () => {});
    expect(f.order, "a keyless organizer never shrank its folder").toEqual(["sweep", "compact"]);
    expect(res).toEqual({ applied: 0, refused: 0, deferred: 0, standing: 0 });
  });

  it("CONTROL: a keyed mailbox shrinks, then reads", async () => {
    const f = fakeIo();
    await applyMetaRequests(NO_DB, rt(f.io, "k".repeat(43)), NOW, () => {});
    expect(f.order).toEqual(["sweep", "compact", "list"]);
  });
});

describe("the lease-refused arm shrinks only a folder too full to read", () => {
  it("meta_folder_full: the sweep runs keyless and says so", async () => {
    const f = fakeIo();
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const ran = await shrinkMetaOnRefusal(
      new LeaseUnavailableError("full", { op: "meta_folder_full" }), rt(f.io, null), NOW,
      (event, detail) => { lines.push({ event, detail }); },
    );
    expect(ran).toBe(true);
    expect(f.order).toEqual(["sweep", "compact"]);
    expect(lines.find((l) => l.event === "meta_shrink")?.detail)
      .toMatchObject({ mailboxId: "mb", phase: "lease_refused", ran: true, swept: 7, moved: 0 });
  });

  it.each([
    ["list_claims", new LeaseUnavailableError("socket", { op: "list_claims" })],
    ["meta_undeletable", new LeaseUnavailableError("no delete", { op: "meta_undeletable" })],
    ["clock_skew", new LeaseClockSkewError("clock", { skewMs: 3_600_000, bound: "ahead", boundMs: 600_000 })],
    ["an ordinary fault", new Error("ECONNRESET")],
  ] as const)("%s: nothing runs", async (_name, err) => {
    const f = fakeIo();
    expect(await shrinkMetaOnRefusal(err, rt(f.io, null), NOW, () => {})).toBe(false);
    expect(f.order).toEqual([]);
  });
});
