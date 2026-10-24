import { describe, expect, it } from "vitest";
import { memoryImapServer } from "./_metaworld.js";
import { greenmailConfig } from "./_imapenv.js";
import { ImapAdapter } from "../../src/adapters/imap.js";
import {
  decideLease, peekLease, parseClaim, formatClaim, makeLeaseIo, withServerClock,
  CLAIM_PROTOCOL, DEFAULT_STALE_AFTER_MS, MAX_FUTURE_SKEW_MS,
  type ClaimRecord, type LeaseSelf, type OrganizerClaim,
} from "../../src/adapters/organizer-lease.js";

/**
 * ═══ READERS AGE AND RANK BY THE SERVER'S CLOCK ════════════════════════════════════════════
 *
 * `LEASE-DEAD-CLOCK-WRITER-CLAIMS` read from the other side. The writer-side refusal
 * (`organizer-lease-clock.test.ts`) stops a machine with a wrong clock from CLAIMING; it cannot
 * help the readers of a record such a machine already wrote, and a build one release older will
 * go on writing them. `X-Ohmail-Heartbeat` is a statement about time by the machine whose clock
 * is in question — IMAP INTERNALDATE is the mail server's own stamp for the same record, one
 * clock both machines see, and it is what the decision layer ages and ranks by.
 *
 * THE FIXTURE'S OWN TRAP, and it is the reason these cases state their stamps: back-dating a
 * heartbeat against a REAL server forges a broken clock, because the server stamps the append with
 * ITS now. `memoryImapServer` models that by defaulting INTERNALDATE to the record's own
 * heartbeat — agreement, the ordinary case — so a case that wants divergence has to say so. The
 * control for that default is the last block here.
 */

const NOW = new Date("2026-09-12T12:00:00.000Z");
const WINDOW = 60_000;

const selfOf = (installId: string): LeaseSelf => ({
  installId, kind: "local", displayName: `${installId} machine`, lastNonce: null,
});

/** One claim, with its two times stated apart: what the writer said, and what the server said. */
function claim(o: {
  installId: string;
  heartbeat: Date;
  serverStamp: Date | null;
  ref?: unknown;
}): ClaimRecord {
  const raw = formatClaim({
    protocol: CLAIM_PROTOCOL,
    installId: o.installId,
    kind: "local",
    displayName: `${o.installId} machine`,
    claimedAt: o.heartbeat,
    heartbeat: o.heartbeat,
    nonce: `n-${o.installId}`,
    authorizedAt: null,
    capabilities: [],
  });
  const parsed = parseClaim(raw, o.ref ?? 1, o.serverStamp);
  expect(parsed, "the fixture built something that is not a claim").not.toBeNull();
  return parsed!;
}

const verdictOf = (claims: readonly ClaimRecord[], now = NOW): string =>
  decideLease({ self: selfOf("desktop"), claims, now, staleAfterMs: WINDOW }).verdict;

describe("a writer whose clock runs FAST keeps its mailbox", () => {
  /**
   * The row's own sequence: a laptop with a dead CMOS battery boots reading 2099 and renews with
   * 2099 heartbeats. Every reader excludes an unbelievable stamp from the renewal evidence — that
   * exclusion is the seventy-three-year lockout's cure and cannot be given up — so the folder read
   * as QUIET, the mailbox was offered as `available`, a press on a second computer took it, and
   * both installs then filed the same mailbox.
   */
  const heartbeat2099 = new Date("2099-01-01T00:00:00.000Z");

  it("is a live holder, not an empty folder — the server stamped the record half a minute ago", () => {
    const laptop = claim({
      installId: "laptop", heartbeat: heartbeat2099, serverStamp: new Date(NOW.getTime() - 30_000),
    });
    expect(verdictOf([laptop]), "a 2099 record still reads as residue and the mailbox is offered")
      .toBe("stand_down");
  });

  it("and the preview says the same thing, so the screen and the gate agree", () => {
    const laptop = claim({
      installId: "laptop", heartbeat: heartbeat2099, serverStamp: new Date(NOW.getTime() - 30_000),
    });
    const peek = peekLease({ claims: [laptop], now: NOW, staleAfterMs: WINDOW });
    expect(peek.state).toBe("held");
    expect(peek.holders[0]?.fresh, "the preview called a renewing organizer stopped").toBe(true);
  });

  it("cannot age an HONEST claim beside it — the substituted stamp is the server's, not 2099", () => {
    /* The other half of the same defect, and the direction that costs a reader its mailbox: a 2099
       stamp used to be the newest thing in the folder, and every honest record measured against it
       lapsed by seventy-three years. */
    const laptop = claim({
      installId: "laptop", heartbeat: heartbeat2099,
      serverStamp: new Date(NOW.getTime() - 30_000), ref: 1,
    });
    const ours = claim({
      installId: "desktop", heartbeat: new Date(NOW.getTime() - 1_000),
      serverStamp: new Date(NOW.getTime() - 1_000), ref: 2,
    });
    const v = decideLease({
      self: { ...selfOf("desktop"), lastNonce: "n-desktop" },
      claims: [laptop, ours], now: NOW, staleAfterMs: WINDOW,
    });
    expect(v.verdict, "our own live claim lapsed against a stamp dated 2099").toBe("organize");
  });
});

describe("a writer whose clock runs SLOW keeps its mailbox", () => {
  /**
   * The behind direction, at the supported one-minute window: a lag inside it, and a reader at
   * the same real instant finds nothing renewing, declares the record dead and takes the mailbox
   * with a live claim in `displace`. The server stamped that record one second ago.
   */
  it("is a live holder, not residue", () => {
    const laptop = claim({
      installId: "laptop",
      heartbeat: new Date(NOW.getTime() - 61_000),
      serverStamp: new Date(NOW.getTime() - 1_000),
    });
    expect(verdictOf([laptop]), "a slow clock's live record read as residue").toBe("stand_down");
  });

  it("but a record the server really did stamp an hour ago is still stale — the positive control", () => {
    /* The refusal has to be able to say no, or the fix is "nothing is ever stale" and a
       decommissioned install holds a mailbox for ever. Same fixture, same shape, one field moved. */
    const gone = claim({
      installId: "laptop",
      heartbeat: new Date(NOW.getTime() - 3_600_000),
      serverStamp: new Date(NOW.getTime() - 3_600_000),
    });
    expect(verdictOf([gone]), "the server's own stamp stopped being able to make a record stale")
      .toBe("available");
  });
});

describe("a record the server did not stamp reads exactly as it read before", () => {
  /**
   * Absence is not evidence. A read that could not ask the server — a connection that does not
   * report INTERNALDATE, a record parsed out of a source already in hand — knows nothing new about
   * the record, so it may not move its standing in either direction. Today's reading, with the
   * believability ceiling still over it.
   */
  it("stale by the writer's stamp, with no server stamp, is stale", () => {
    const old = claim({
      installId: "laptop", heartbeat: new Date(NOW.getTime() - 61_000), serverStamp: null,
    });
    expect(verdictOf([old])).toBe("available");
  });

  it("fresh by the writer's stamp, with no server stamp, is fresh", () => {
    const live = claim({
      installId: "laptop", heartbeat: new Date(NOW.getTime() - 1_000), serverStamp: null,
    });
    expect(verdictOf([live])).toBe("stand_down");
  });

  it("and the substitution hands back the very same array when nothing moved", () => {
    const claims = [claim({ installId: "laptop", heartbeat: NOW, serverStamp: null })];
    expect(withServerClock(claims), "an unstamped folder was rewritten for nothing").toBe(claims);
  });
});

describe("the preview and the gate cannot disagree across one millisecond", () => {
  /**
   * `LEASE-PREVIEW-BELIEVABILITY-BOUNDARY`. For a fixed heartbeat `H` and window `W`, a reader at
   * `now = H − W − 1 ms` found `H` beyond `now + MAX_FUTURE_SKEW_MS`, called it no evidence and
   * reported `stopped`; a reader one millisecond later found it believable and reported `held`.
   * Nothing renewed in between. The user-visible cost was a press that no-ops: the preview offered
   * a takeover, the gate refused it, and the caller's stand-down path then voided the person's
   * one-shot authorization.
   */
  const H = new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS + 1);

  it("reports one state on both sides of the boundary, because the server's stamp decides", () => {
    const stamped = claim({
      installId: "laptop", heartbeat: H, serverStamp: new Date(NOW.getTime() - 5_000),
    });
    const before = peekLease({ claims: [stamped], now: NOW, staleAfterMs: WINDOW });
    const after = peekLease({
      claims: [stamped], now: new Date(NOW.getTime() + 2), staleAfterMs: WINDOW,
    });
    expect(before.state).toBe(after.state);
    expect(before.state).toBe("held");
  });

  it("the boundary is still there for an UNSTAMPED record, and that is the honest answer", () => {
    /* Not a gap in the fix: with no server stamp there is nothing but the reader's clock and the
       ceiling, which is the state this row describes. Naming it keeps the case from being read as
       closed everywhere. */
    const unstamped = claim({ installId: "laptop", heartbeat: H, serverStamp: null });
    const before = peekLease({ claims: [unstamped], now: NOW, staleAfterMs: WINDOW });
    const after = peekLease({
      claims: [unstamped], now: new Date(NOW.getTime() + 2), staleAfterMs: WINDOW,
    });
    expect(before.state).toBe("stopped");
    expect(after.state).toBe("held");
  });
});

describe("a renew's two appends land in one second, and still order", () => {
  /**
   * IMAP INTERNALDATE has SECOND resolution, and a renew is append-then-expunge — two appends in
   * quick succession, which on a busy moment share a stamp. Ordering our own two records by the
   * nonce there is a coin toss: the fold keeps the SUPERSEDED claim half the time, the clone
   * defence reads it as a live clone of us (its nonce is not the one just written), and the gate
   * answers `available` about a mailbox it has just renewed. MEASURED against a real mail server
   * at one run in three before the writer's stamp broke the tie.
   *
   * Both nonce orderings are driven, because ONE of them passes by luck under the defect.
   */
  const SAME_SECOND = new Date(NOW.getTime() - 2_000);
  const older = (nonceHigh: boolean): ClaimRecord => ({
    ...(claim({
      installId: "us", heartbeat: new Date(NOW.getTime() - 60_000),
      serverStamp: SAME_SECOND, ref: 1,
    }) as OrganizerClaim),
    nonce: nonceHigh ? "zzz-old" : "aaa-old",
  });
  const newer = (nonceHigh: boolean): ClaimRecord => ({
    ...(claim({ installId: "us", heartbeat: NOW, serverStamp: SAME_SECOND, ref: 2 }) as OrganizerClaim),
    nonce: nonceHigh ? "zzz-new" : "aaa-new",
  });

  for (const oldWins of [true, false]) {
    it(`keeps the record this install wrote LAST (nonce order ${oldWins ? "against" : "for"} it)`, () => {
      const claims = [older(oldWins), newer(!oldWins)];
      const v = decideLease({
        self: { ...selfOf("us"), lastNonce: oldWins ? "aaa-new" : "zzz-new" },
        claims, now: NOW, staleAfterMs: WINDOW,
      });
      expect(v.verdict, "the fold kept a superseded claim and the clone defence disowned us")
        .toBe("organize");
    });
  }

  it("and a writer's stamp the clock cannot vouch for loses to the server's", () => {
    /*
     * WHAT THIS CASE DEFENDS, restated when the rule moved under it. The writer's clock now
     * DECIDES the order of one install's own records rather than breaking ties in it, because
     * INTERNALDATE answers a different question — arrival, not authorship — and a renew's residue
     * re-appended after the claim that superseded it was standing installs down against their own
     * previous run (`organizer-lease.test.ts`, "a renew's residue is not a stranger"). That is the
     * new consumer, and it does not license this one: a clock that JUMPED is not evidence about
     * the order of anything, so a writer stamp past the skew ceiling is disbelieved by name
     * (`isBelievableHeartbeat`) and arrival decides after all. The subject is unchanged — a
     * machine with a fast clock must not order the folder by its own reading — and it is now
     * refused explicitly instead of by where the term sat in a comparison.
     */
    const fastButOld = claim({
      installId: "us", heartbeat: new Date("2099-01-01T00:00:00.000Z"),
      serverStamp: new Date(NOW.getTime() - 120_000), ref: 1,
    }) as OrganizerClaim;
    const slowButNew = {
      ...(claim({
        installId: "us", heartbeat: new Date(NOW.getTime() - 300_000),
        serverStamp: new Date(NOW.getTime() - 1_000), ref: 2,
      }) as OrganizerClaim),
      nonce: "n-new",
    };
    const v = decideLease({
      self: { ...selfOf("us"), lastNonce: "n-new" },
      claims: [fastButOld, slowButNew], now: NOW, staleAfterMs: WINDOW,
    });
    expect(v.verdict, "the writer's clock decided the fold instead of breaking a tie in it")
      .toBe("organize");
  });
});

describe("the stamp survives every read that builds a claim", () => {
  const SERVER_PATH = "ohmail._meta";
  const toServerPath = (c: string): string => c.split("/").join(".");

  /**
   * THE PATH BESIDE THE ONE THE STAMP WAS ADDED TO. `readMetaFolderWindow` asks for INTERNALDATE;
   * a read past the window that dropped it would build claims with no server stamp, silently, on
   * exactly the busy folders that path serves. The enumeration carries it (was: the SEARCH path).
   */
  it("including the ENUMERATION a folder past the window is read by", async () => {
    const server = memoryImapServer({ folders: [SERVER_PATH] });
    const stamp = new Date(NOW.getTime() - 30_000);
    server.seed(SERVER_PATH, formatClaim({
      protocol: CLAIM_PROTOCOL, installId: "laptop", kind: "local", displayName: "laptop machine",
      claimedAt: new Date("2099-01-01T00:00:00.000Z"),
      heartbeat: new Date("2099-01-01T00:00:00.000Z"),
      nonce: "n-laptop", authorizedAt: null, capabilities: [],
    }), stamp);
    for (let i = 0; i < 520; i++) server.seed(SERVER_PATH, `Subject: filler ${i}\r\n\r\nbody`);
    const io = makeLeaseIo(server, toServerPath, { installId: "desktop", mailboxId: "mbx" });
    const records = await io.listClaims();
    expect(io.lastEnumeration?.(), "the folder was read by the window, not past it").toMatchObject({ claims: 1, total: 521 });
    expect(records).toHaveLength(1);
    expect(records![0]!.internalDate?.getTime(),
      "a record read by header arrived with no server stamp").toBe(stamp.getTime());
    const parsed = parseClaim(records![0]!.raw, records![0]!.ref, records![0]!.internalDate);
    expect((parsed as OrganizerClaim).serverStamp?.getTime()).toBe(stamp.getTime());
  });

  /**
   * THE FIXTURE'S DEFAULT, stated as a fact rather than trusted as one. A fake that stamped
   * INTERNALDATE with the process's wall clock would make every back-dated fixture in this suite
   * look like a writer days out of step with its server — and the writer-side refusal would fire
   * on all of them. The default is AGREEMENT, which is what a real server gives an honest writer,
   * and a case wanting divergence states the stamp.
   */
  it("and a fixture that back-dates a heartbeat forges no skew unless it says so", () => {
    const server = memoryImapServer({ folders: [SERVER_PATH] });
    const backDated = new Date(NOW.getTime() - 3_600_000);
    const raw = formatClaim({
      protocol: CLAIM_PROTOCOL, installId: "laptop", kind: "local", displayName: "laptop machine",
      claimedAt: backDated, heartbeat: backDated, nonce: "n-laptop",
      authorizedAt: null, capabilities: [],
    });
    server.seed(SERVER_PATH, raw);
    const [defaulted] = server.tree.get(SERVER_PATH)!.messages;
    expect(defaulted!.internalDate.getTime(),
      "the fake stamped its own wall clock and forged an hour of skew").toBe(backDated.getTime());

    server.seed(SERVER_PATH, raw, NOW);
    const stated = server.tree.get(SERVER_PATH)!.messages[1];
    expect(stated!.internalDate.getTime(), "a stated stamp was ignored").toBe(NOW.getTime());
  });
});

describe("a phone reads the server's stamp too", () => {
  /** INTERNALDATE as imapflow hands it back when the runtime's Date refuses the RFC 3501 form. */
  const rfc3501 = (d: Date): string => {
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]!;
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${String(d.getUTCDate()).padStart(2, " ")}-${mon}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
  };

  it("through the adapter's own connection, the claim carries the server's stamp", async () => {
    const server = memoryImapServer({ folders: ["ohmail._meta"] });
    const stamp = new Date(Date.UTC(2026, 9, 4, 6, 29, 8));
    server.seed("ohmail._meta", formatClaim({
      protocol: CLAIM_PROTOCOL, installId: "laptop", kind: "local", displayName: "laptop machine",
      claimedAt: stamp, heartbeat: stamp, nonce: "n-laptop", authorizedAt: null, capabilities: [],
    }), stamp);
    const fetch = server.fetch.bind(server);
    const client = Object.assign(Object.create(server) as object, {
      capabilities: new Map<string, boolean>(),
      async logout() { /* noop */ },
      close() { /* noop */ },
      async *fetch(...args: Parameters<typeof fetch>) {
        for await (const m of fetch(...args)) {
          yield m.internalDate instanceof Date ? { ...m, internalDate: rfc3501(m.internalDate) } : m;
        }
      },
    });
    const adapter = new ImapAdapter(greenmailConfig(), { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const records = await adapter.leasePeekIo().listClaims();
    expect(records).toHaveLength(1);
    expect(records[0]!.internalDate?.getTime(), "the phone read the claim with no server stamp").toBe(stamp.getTime());
  });
});

describe("the default window is what the clamp was written for", () => {
  it("and a 2099 stamp is still clamped when nothing else says otherwise", () => {
    const unstamped = claim({
      installId: "laptop", heartbeat: new Date("2099-01-01T00:00:00.000Z"), serverStamp: null,
    });
    const peek = peekLease({ claims: [unstamped], now: NOW, staleAfterMs: DEFAULT_STALE_AFTER_MS });
    expect(peek.state, "the ceiling stopped applying to a record with no server stamp")
      .toBe("stopped");
  });
});
