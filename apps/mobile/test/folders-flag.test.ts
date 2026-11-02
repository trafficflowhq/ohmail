/**
 * THE "USE FOLDERS" FLAG COORDINATOR — a review's three findings against the
 * folders slice, held as behaviour rather than as prose:
 *
 *  1. a boot read that resolves AFTER a write must not overwrite the write (user-always-wins,
 *     the product's ordering rule);
 *  2. a confirmed write drains the connection, so the flip's own folder deltas land without a
 *     manual sync;
 *  3. another client's flip is picked up on this session's own next drain, not only at boot.
 *
 * Deferred promises stand in for the two requests, so the exact interleaving codex named is
 * driven directly rather than hoped for.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { describe, expect, it } from "vitest";
import { foldersFlag, freshestRead, signatureSequence, type FoldersFlagDeps } from "../src/state/folders-flag";
import { readFoldersEnabled, writeSignature } from "../src/net/consent";
import { signatureRows } from "../src/ui/signature-rows";

function harness() {
  const applied: boolean[] = [];
  let drainCount = 0;
  const reads: { resolve: (v: { on: boolean } | null) => void }[] = [];
  const writes: { resolve: (v: { on: boolean }) => void; reject: (e: unknown) => void }[] = [];
  const deps: FoldersFlagDeps = {
    read: () => new Promise((resolve) => reads.push({ resolve })),
    write: () => new Promise((resolve, reject) => writes.push({ resolve, reject })),
    apply: (on) => applied.push(on),
    drain: () => { drainCount += 1; },
  };
  return { deps, applied, drains: () => drainCount, reads, writes };
}

describe("a boot read resolving after a write never overwrites the write", () => {
  it("the write's epoch bump discards the earlier read's answer", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);

    const refreshDone = flag.refresh(); // read #1 in flight
    const setDone = flag.set(true); // bumps the epoch before writing
    // The write settles first — the server confirms on.
    h.writes[0]!.resolve({ on: true });
    await setDone;
    expect(h.applied).toEqual([true]);
    expect(h.drains()).toBe(1);

    // NOW the earlier read answers — off, the pre-write value.
    h.reads[0]!.resolve({ on: false });
    await refreshDone;
    // Discarded: applied still holds only the write's true.
    expect(h.applied).toEqual([true]);
  });

  it("a read started AFTER the write still applies normally", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);
    const setDone = flag.set(true);
    h.writes[0]!.resolve({ on: true });
    await setDone;
    const refreshDone = flag.refresh();
    h.reads[0]!.resolve({ on: true });
    await refreshDone;
    expect(h.applied).toEqual([true, true]);
  });
});

describe("a confirmed write drains the connection; a refusal drains nothing", () => {
  it("set(true) applies the server value and drains exactly once", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);
    const setDone = flag.set(true);
    h.writes[0]!.resolve({ on: true });
    expect(await setDone).toBe(true);
    expect(h.applied).toEqual([true]);
    expect(h.drains()).toBe(1);
  });

  it("a rejected write applies nothing and drains nothing", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);
    const setDone = flag.set(true);
    h.writes[0]!.reject(new Error("refused"));
    expect(await setDone).toBe(false);
    expect(h.applied).toEqual([]);
    expect(h.drains()).toBe(0);
  });
});

describe("refresh discards a could-not-ask answer, never reads it as off", () => {
  it("null applies nothing — the last known value stands", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);
    const setDone = flag.set(true);
    h.writes[0]!.resolve({ on: true });
    await setDone;
    const refreshDone = flag.refresh();
    h.reads[0]!.resolve(null);
    await refreshDone;
    expect(h.applied).toEqual([true]); // the null answer never landed
  });
});

describe("overlapping refreshes: only the NEWEST-issued read may apply", () => {
  it("an older read resolving AFTER a newer one is discarded, whatever it says", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);
    const older = flag.refresh(); // read #1 — the session's boot GET, still in the air
    const newer = flag.refresh(); // read #2 — the drain-completed re-ask
    // The newer response lands first (the flag was just turned on elsewhere)…
    h.reads[1]!.resolve({ on: true });
    await newer;
    expect(h.applied).toEqual([true]);
    // …then the older one arrives with the stale off. Reordered, not authoritative: discarded.
    h.reads[0]!.resolve({ on: false });
    await older;
    expect(h.applied).toEqual([true]);
  });

  it("a newer read that FAILS supersedes nothing — the older valid answer still applies", () => {
    // Round 3's finding: issuance alone must not invalidate. The boot GET validly answers
    // "on" while the post-drain GET dies on transport; discarding the boot answer left the
    // folders off until another drain, over a server that said on.
    const h = harness();
    const flag = foldersFlag(h.deps);
    const older = flag.refresh();
    const newer = flag.refresh();
    h.reads[1]!.resolve(null); // the newer read fails — not an answer
    h.reads[0]!.resolve({ on: true }); // the only valid response the session has
    return Promise.all([older, newer]).then(() => {
      expect(h.applied).toEqual([true]);
    });
  });

  it("a refresh asked for DURING the write waits — no read runs on the write's wire window", async () => {
    // Rounds 4 and 5, one contract: a read overlapping the write is ambiguous (it can carry
    // the pre-write value, or another client's even newer one), so it is not issued at all
    // until the write settles — and then its answer is post-write and authoritative.
    const h = harness();
    const flag = foldersFlag(h.deps);
    const setDone = flag.set(true); // PATCH in flight
    const queued = flag.refresh(); // asked for mid-write…
    await new Promise((r) => setTimeout(r, 0));
    expect(h.reads).toHaveLength(0); // …and NOT issued while the write is unsettled
    h.writes[0]!.resolve({ on: true });
    await setDone;
    expect(h.applied).toEqual([true]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.reads).toHaveLength(1); // issued now, post-write
    // Round 5's exact case: another client toggled off AFTER our commit; the queued read
    // sees it and it APPLIES — an authoritative later fact, never discarded.
    h.reads[0]!.resolve({ on: false });
    await queued;
    expect(h.applied).toEqual([true, false]);
  });

  it("after an older valid answer applied, a newer valid answer still wins", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);
    const older = flag.refresh();
    const newer = flag.refresh();
    h.reads[0]!.resolve({ on: true });
    await older;
    h.reads[1]!.resolve({ on: false }); // fresher fact — another client turned it off
    await newer;
    expect(h.applied).toEqual([true, false]);
  });
});

describe("a rejected write re-asks, so the authoritative value comes back", () => {
  it("the catch path issues a fresh read under the current epoch", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);
    // The account is already ON server-side; the boot read is still in flight when the user
    // toggles and the write is transiently refused.
    const boot = flag.refresh(); // read #1 (invalidated by the write below — deliberately)
    const setDone = flag.set(false);
    h.writes[0]!.reject(new Error("refused"));
    expect(await setDone).toBe(false);
    // The rejection asked again: read #2 exists and its answer applies.
    expect(h.reads).toHaveLength(2);
    h.reads[1]!.resolve({ on: true });
    h.reads[0]!.resolve({ on: false }); // the invalidated boot read stays discarded
    await boot;
    await new Promise((r) => setTimeout(r, 0)); // the catch's own read settles
    expect(h.applied).toEqual([true]);
    expect(h.drains()).toBe(0); // a refusal still drains nothing
  });
});

describe("overlapping writes serialize — dispatch order is commit order", () => {
  it("the second PATCH is not dispatched until the first settles; reads wait for both", async () => {
    // Review rounds 6–7: every per-case overlap guard left a corner (an older write clearing
    // a newer one's barrier; a read slipping between B settling and A still on the wire).
    // Serialized, none of those interleavings exist to arbitrate.
    const h = harness();
    const flag = foldersFlag(h.deps);
    const a = flag.set(true);
    const queued = flag.refresh();
    const b = flag.set(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.writes).toHaveLength(1); // B is QUEUED, not on the wire
    expect(h.reads).toHaveLength(0); // and no read runs under an unsettled write
    h.writes[0]!.resolve({ on: true });
    await a;
    expect(h.applied).toEqual([true]); // A's confirmed echo applies as it lands…
    expect(h.drains()).toBe(1); // …and drains its own flip's deltas
    await new Promise((r) => setTimeout(r, 0));
    expect(h.writes).toHaveLength(2); // B dispatches only now
    expect(h.reads).toHaveLength(0); // the read still waits: B is unsettled
    h.writes[1]!.resolve({ on: false });
    await b;
    expect(h.applied).toEqual([true, false]); // the last press is the last value
    expect(h.drains()).toBe(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.reads).toHaveLength(1); // the queued read runs post-queue
    h.reads[0]!.resolve({ on: false });
    await queued;
    expect(h.applied).toEqual([true, false, false]);
  });

  it("a surviving write is preserved when its successor fails — echo, drain, and re-ask", async () => {
    // Round 7's first finding: A succeeds, B rejects. A's echo and drain must stand (A is
    // the surviving server mutation), and B's re-ask brings A's value back as the truth.
    const h = harness();
    const flag = foldersFlag(h.deps);
    const a = flag.set(true);
    const b = flag.set(false);
    h.writes[0]!.resolve({ on: true });
    await a;
    expect(h.applied).toEqual([true]); // A applied and…
    expect(h.drains()).toBe(1); // …drained its folder deltas before B ever dispatched
    await new Promise((r) => setTimeout(r, 0));
    h.writes[1]!.reject(new Error("refused"));
    expect(await b).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.reads).toHaveLength(1); // the rejection re-asks…
    h.reads[0]!.resolve({ on: true }); // …and the server answers A's surviving value
    await new Promise((r) => setTimeout(r, 0));
    expect(h.applied).toEqual([true, true]);
    expect(h.drains()).toBe(1); // the failed write drained nothing
  });
});

describe("another client's flip is picked up on this session's own next refresh", () => {
  it("a later refresh (the drain-completed signal) reports the new value", async () => {
    const h = harness();
    const flag = foldersFlag(h.deps);
    let refreshDone = flag.refresh();
    h.reads[0]!.resolve({ on: false });
    await refreshDone;
    expect(h.applied).toEqual([false]);

    // Another client turns it on; this session's next drain re-asks.
    refreshDone = flag.refresh();
    h.reads[1]!.resolve({ on: true });
    await refreshDone;
    expect(h.applied).toEqual([false, true]);
  });
});

describe("freshestRead — the signatures map's ordering, read-only by construction", () => {
  /** One controllable read: the test resolves it whenever it likes. */
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("an older read settling LAST does not overwrite the newer one's answer", async () => {
    const applied: string[] = [];
    const track = freshestRead<{ v: string }>((ans) => applied.push(ans.v));
    const first = deferred<{ v: string } | null>();
    const second = deferred<{ v: string } | null>();
    const p1 = track(() => first.promise);
    const p2 = track(() => second.promise);
    // The NEWER read answers first…
    second.resolve({ v: "fresh" });
    await p2;
    // …and the older one landing afterwards applies nothing.
    first.resolve({ v: "stale" });
    await p1;
    expect(applied).toEqual(["fresh"]);
  });

  it("a could-not-ask (null) applies nothing and supersedes nothing", async () => {
    const applied: string[] = [];
    const track = freshestRead<{ v: string }>((ans) => applied.push(ans.v));
    const first = deferred<{ v: string } | null>();
    const second = deferred<{ v: string } | null>();
    const p1 = track(() => first.promise);
    const p2 = track(() => second.promise);
    // The newer read FAILS — issuance alone must not invalidate the older valid answer
    // (the flag machine's round-3 rule, held here too).
    second.resolve(null);
    await p2;
    first.resolve({ v: "only-valid-answer" });
    await p1;
    expect(applied).toEqual(["only-valid-answer"]);
  });

  it("in-order reads apply in order — the ordinary cadence is untouched", async () => {
    const applied: string[] = [];
    const track = freshestRead<{ v: string }>((ans) => applied.push(ans.v));
    await track(() => Promise.resolve({ v: "boot" }));
    await track(() => Promise.resolve({ v: "after-drain" }));
    expect(applied).toEqual(["boot", "after-drain"]);
  });

  /* EQUAL APPLIES NOTHING: every drain re-asks, and an apply hands the screens a fresh object that
     re-derives every list. Keys in another order are the same answer; a changed value is not. */
  it("an answer equal to the last applied one applies nothing; a changed one applies once", async () => {
    const applied: Array<Record<string, unknown>> = [];
    const track = freshestRead<Record<string, unknown>>((ans) => applied.push(ans));
    await track(() => Promise.resolve({ on: true, sig: { a: "x", b: "y" } }));
    await track(() => Promise.resolve({ sig: { b: "y", a: "x" }, on: true }));
    await track(() => Promise.resolve({ on: true, sig: { a: "x", b: "y" } }));
    expect(applied).toHaveLength(1);
    await track(() => Promise.resolve({ on: true, sig: { a: "x", b: "z" } }));
    expect(applied).toHaveLength(2);
    expect(applied[1]).toEqual({ on: true, sig: { a: "x", b: "z" } });
  });

  it("an equal answer still supersedes an older read in the air", async () => {
    const applied: string[] = [];
    const track = freshestRead<{ v: string }>((ans) => applied.push(ans.v));
    await track(() => Promise.resolve({ v: "same" }));
    const slow = deferred<{ v: string } | null>();
    const older = track(() => slow.promise);
    await track(() => Promise.resolve({ v: "same" }));
    slow.resolve({ v: "stale" });
    await older;
    expect(applied).toEqual(["same"]);
  });
});

describe("a local write makes the next answer count", () => {
  it("an answer equal to the last applied one applies after this device wrote the state", async () => {
    let state: { on: boolean } | null = null;
    const read = freshestRead<{ on: boolean }>((a) => { state = a; });
    await read(async () => ({ on: false }));
    // This phone turns auto-act on: the echo lands outside the read, and the read is told.
    state = { on: true };
    read.localWrite();
    // Another device turned it off again before the phone's next read.
    await read(async () => ({ on: false }));
    expect(state, "the phone keeps saying on while the server says off").toEqual({ on: false });
  });

  it("without a local write an equal answer still applies nothing", async () => {
    const applied: boolean[] = [];
    const read = freshestRead<{ on: boolean }>((a) => { applied.push(a.on); });
    await read(async () => ({ on: false }));
    await read(async () => ({ on: false }));
    expect(applied).toEqual([false]);
  });

  it("every local writer of a read's state tells that read", () => {
    const world = withoutComments(readFileSync(fileURLToPath(new URL("../src/state/world.tsx", import.meta.url)), "utf8"));
    const told = (writer: RegExp, read: string) => {
      const at = world.search(writer);
      expect(at, `no writer ${writer}`).toBeGreaterThan(-1);
      expect(world.slice(at, at + 900)).toContain(`${read}.current?.localWrite()`);
    };
    told(/const res = await writeAutoAct\(session, on\);/, "consentReadNow");
    told(/const rememberResurfaceTime = useCallback\(/, "consentReadNow");
    told(/relayedHere: \(decided\) =>/, "relayReadNow");
    // A decide drops the sender from the queue here; the queue read is told, so a server that lists
    // them again with the answer it gave before is shown.
    told(/forgetWaiting: \(decided\) =>/, "queueReadNow");
  });
});

/* The phone writes a mailbox's signature where web and desktop read it. */
describe("a signature written on the phone", () => {
  const asked: string[] = [];
  const session = (status: number, body: unknown) => ({
    profile: { origin: "https://srv.test", accountId: "a" },
    fetch: async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${url} ${typeof init?.body === "string" ? init.body : ""}`.trim());
      if (status === 0) throw new Error("offline");
      return { status, json: async () => body } as unknown as Response;
    },
  }) as unknown as Parameters<typeof readFoldersEnabled>[0];

  it("a read issued before a write never lands over the write's echo", async () => {
    const applied: string[] = [];
    const sigs = freshestRead<{ sig: string }>((a) => applied.push(a.sig));
    let answerRead!: (v: { sig: string }) => void;
    const read = sigs(() => new Promise((r) => { answerRead = r; }));
    await sigs(async () => ({ sig: "the echo" }));
    answerRead({ sig: "what the server held before" });
    await read;
    expect(applied).toEqual(["the echo"]);
  });

  it("the pane's sequence: a write's echo outranks a read issued before it; a refusal applies nothing", async () => {
    const applied: Array<Record<string, unknown>> = [];
    const track = signatureSequence((f) => applied.push(f));
    const facts = (sig: string) => ({ signatures: { m1: sig }, signaturesHtml: {}, signatureSources: {}, signatureChanges: {} });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    let answerRead!: (v: ReturnType<typeof facts> & { themeFace: string }) => void;
    track.read(new Promise((r) => { answerRead = r; }));
    expect(await track.write(async () => facts("the echo"))).toBe(true);
    answerRead({ ...facts("what the server held before"), themeFace: "paper" });
    await settle();
    expect(applied).toEqual([facts("the echo")]);
    expect(await track.write(async () => { throw new Error("refused (403)"); })).toBe(false);
    track.read(Promise.resolve(null));
    await settle();
    expect(applied, "a refusal and a read that could not ask apply nothing").toHaveLength(1);
    // A read issued after the write lands, and carries only the signature fields.
    track.read(Promise.resolve({ ...facts("later"), themeFace: "paper" }));
    await settle();
    expect(applied.at(-1)).toEqual(facts("later"));
  });

  it("the read carries the markup, whose signature each is, and where a change went", async () => {
    const ans = await readFoldersEnabled(session(200, {
      foldersEnabledAt: null,
      signatures: { m1: "Ada", m2: "Bold Ada" },
      signaturesHtml: { m2: "<p><b>Bold</b> Ada</p>", m3: 7 },
      signatureSources: { m1: "local", m2: "organizer", m3: "elsewhere" },
      signatureChanges: { m1: { state: "refused", holder: "Laptop", refusal: "unreadable" }, m2: { state: "nonsense" } },
    }));
    expect(ans!.signaturesHtml).toEqual({ m2: "<p><b>Bold</b> Ada</p>" });
    expect(ans!.signatureSources).toEqual({ m1: "local", m2: "organizer" });
    expect(ans!.signatureChanges).toEqual({ m1: { state: "refused", holder: "Laptop", refusal: "unreadable" } });
  });

  it("writes text alone for one mailbox, blank as none, and answers the echo", async () => {
    asked.length = 0;
    const echo = { signatures: { m1: "Ada" }, signaturesHtml: {}, signatureSources: { m1: "local" }, signatureChanges: { m1: { state: "asked", holder: null, refusal: null } } };
    expect(await writeSignature(session(200, echo), "m1", "Ada")).toEqual({
      signatures: { m1: "Ada" }, signaturesHtml: {}, signatureSources: { m1: "local" },
      signatureChanges: { m1: { state: "asked", holder: null, refusal: null } },
    });
    await writeSignature(session(200, { ...echo, signatures: {} }), "m1", "   ");
    expect(asked).toEqual([
      `PATCH https://srv.test/consent/settings {"signatures":{"m1":"Ada"}}`,
      `PATCH https://srv.test/consent/settings {"signatures":{"m1":null}}`,
    ]);
    await expect(writeSignature(session(403, {}), "m1", "x")).rejects.toThrow();
    // An echo without the map stored nothing this phone can show.
    await expect(writeSignature(session(200, {}), "m1", "x")).rejects.toThrow();
  });

  it("a row is read only where the organizer's signature is in force or the stored one has formatting", () => {
    const rows = signatureRows({
      mailboxes: [
        { id: "own", address: "own@x.test", status: "connected", organizerRole: "organizer" },
        { id: "read", address: "read@x.test", status: "connected", organizerRole: "reader" },
        { id: "readLocal", address: "rl@x.test", status: "connected", organizerRole: "reader" },
        { id: "rich", address: "rich@x.test", status: null, organizerRole: null },
        { id: "gone", address: "gone@x.test", status: "disabled", organizerRole: null },
      ],
      signatures: { own: "Own", read: "Theirs", rich: "Rich" },
      signaturesHtml: { rich: "<p><i>Rich</i></p>" },
      sources: { own: "organizer", read: "organizer", readLocal: "local" },
      changes: { readLocal: { state: "applied", holder: null, refusal: null }, read: { state: "asked", holder: null, refusal: null } },
    });
    expect(rows.map((r) => [r.id, r.text, r.readOnly, r.why, r.change?.state ?? null])).toEqual([
      ["own", "Own", false, null, null],
      ["read", "Theirs", true, "organizer", "asked"],
      ["readLocal", "", false, null, null],
      ["rich", "Rich", true, "markup", null],
    ]);
  });
});
