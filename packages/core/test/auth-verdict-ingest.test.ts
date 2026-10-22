import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP, signaturesForCycle } from "../src/pipeline.js";
import { FakeRepo } from "./fakes.js";
import type { Change } from "../src/ports.js";
import type { AuthVerdict, Rule } from "../src/rules.js";
import { providerAuthservIds } from "../src/authserv-ids.js";
import { fakeKeys, letter, nodemailerSign, rsaKey } from "./fixtures/dkim-signed.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * THE VERDICT ON THE PATH THAT ROUTES — a critical review finding, at ingest.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS FILE EXISTS AND `auth-results.test.ts` WAS NOT ENOUGH ────────────────────────
 *
 * An earlier change landed `authVerdictFromHeaders` with 20-odd unit tests and a demote-only branch in
 * `evaluateRules` with its own. **Every one of them passed while the defect was live**, because
 * every one of them called the parser or the evaluator DIRECTLY. The production ingest path
 * called `evaluateRules({ …, auth: "unauthenticated" })` with a literal, so nothing the parser
 * concluded ever reached a routing decision — the finding's words: "the commit's demote-only
 * branch exists in isolation but does not protect any production routing path".
 *
 * A test that constructs the input to the unit under test cannot see a caller that never
 * supplies it. So every case here goes through the REAL `planChange` → `commitChange` pair
 * — the same two calls `apps/worker/src/sync.ts` makes — and asserts on `folder_state`, which
 * is where a routing decision actually lands.
 *
 * ── THE ASYMMETRY IS THE SUBJECT OF THIS FILE, NOT A CAVEAT IN IT ─────────────────────────
 *
 * `rules.ts#AuthVerdict` records the measured failure: gate the known-sender match on a positive
 * verdict and every row of a large backlog answers Screener. So the guarantee under
 * test is two-sided and the second side has more cases than the first:
 *
 *   DEMOTE  — a trusted position's explicit failure sends an otherwise-allowed message to the
 *             Screener.                                                          (§1)
 *   NEVER   — nothing else does. Not an absent header, not an unparseable one, not an untrusted
 *   REQUIRE   position's failure, and above all not an empty trusted set, which is the state of
 *             every deployment on the day this ships.                            (§2, §3)
 */

/** The authserv-id a host has decided to believe. `trustedAuthservIds`, populated. */
const PROVIDER: ReadonlySet<string> = new Set(["mx.google.com"]);

/**
 * THE DAY-ONE STATE, SPELLED OUT RATHER THAN OMITTED.
 *
 * `planChange` defaults to `NO_TRUSTED_AUTHSERV_IDS` when the dep is absent, and §3 asserts that
 * omission and this constant are the same thing. Writing it explicitly in the cases that need it
 * keeps "no host has named a position it believes" visible as a value being tested.
 */
const UNCONFIGURED: ReadonlySet<string> = new Set();

interface EmlOpts {
  from?: string;
  subject?: string;
  /** Raw `Authentication-Results` values, in header order (topmost first). */
  authResults?: readonly string[];
  /** Adds `List-Unsubscribe`, which sends a CONSENTED sender's mail to `ohmail/News`. */
  bulk?: boolean;
  messageId?: string;
}

function eml(opts: EmlOpts = {}): Buffer {
  const {
    from = "anna@example.com",
    subject = "Notes from Tuesday",
    authResults = [],
    bulk = false,
    messageId = "<m-auth-1@example.com>",
  } = opts;
  const lines = [
    `Message-ID: ${messageId}`,
    ...authResults.map((v) => `Authentication-Results: ${v}`),
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    `Subject: ${subject}`,
    ...(bulk ? ["List-Unsubscribe: <https://list.example/u/1>"] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The minutes are attached to the next one. Nothing urgent.",
  ];
  return Buffer.from(lines.join("\r\n"));
}

/**
 * A `dkim=fail` for the claimed author, reported by the position the host believes.
 *
 * `header.d` MUST align with the author's domain, or the verdict is not "fail": an unaligned
 * third-party signature failing says nothing about the claimed author (`rules.ts#dkimAligned`).
 * Each fixture below is built for the sender that carries it — a bank.example fail on an
 * example.com message would be no evidence, not a failure.
 */
const trustedDkimFail = (authorDomain: string): string =>
  `mx.google.com; dkim=fail header.d=${authorDomain}; spf=fail`;
const TRUSTED_DKIM_FAIL = trustedDkimFail("bank.example");
/** The same failure, reported by a position the host has NOT named. A sender can write this. */
const FORGED_DKIM_FAIL = "attacker.example; dkim=fail header.d=bank.example";

interface Ingested {
  messageId: string;
  /** Where routing put it — `folder_state.desired_folder`, the answer the reconciler acts on. */
  desired: string;
  /** What landed on `messages.auth_verdict`, as the repo was asked to write it. */
  persisted: AuthVerdict | undefined;
}

/**
 * ONE INGEST, THROUGH THE REAL TWO-PHASE PIPELINE.
 *
 * `planChange` then `commitChange`, in that order, with the deps `sync.ts` builds — no
 * classifier and no routing port, so the decision is the deterministic one. The `trusted`
 * argument is threaded exactly where a composition root would thread it.
 */
async function ingest(
  repo: FakeRepo, raw: Buffer, trusted?: ReadonlySet<string>, folder = "INBOX",
): Promise<Ingested> {
  const change: Change = { type: "create", locator: { folder, ref: "1:10" }, raw };
  const plan = await planChange(change, {
    repo, accountId: "acct-1", mailboxId: "mb-1", trustedAuthservIds: trusted,
  });
  const res = await commitChange(plan, { repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP });
  const state = await repo.getFolderState(res.messageId);
  return {
    messageId: res.messageId,
    desired: state!.desiredFolder,
    persisted: repo.rows.get(res.messageId)!.input.authVerdict,
  };
}

/** The user let this sender through to a real folder. `effect: "allow"`. */
const allowRule = (match: string): Rule => ({
  id: "r-allow", kind: "sender", match, destination: "ohmail/News",
  effect: "allow", priority: 10, provenance: "manual", enabled: true,
});

/** The user said NO to this sender, in the strongest way the product offers. */
const quarantineRule = (match: string): Rule => ({
  id: "r-deny", kind: "sender", match, destination: "ohmail/Quarantine",
  effect: "deny", priority: 10, provenance: "manual", enabled: true,
});

describe("§1 — a trusted position's failure DEMOTES, through the real ingest path", () => {
  /**
   * THE FINDING, REPRODUCED AS A ROUTING OUTCOME.
   *
   * "An unauthenticated sender forges a `From` address already known/allowed by the account and
   * sends mail whose provider `Authentication-Results` reports DKIM/DMARC failure; ingest still
   * calls `evaluateRules(… auth: "unauthenticated")`, so the matching allow rule or known-sender
   * branch promotes/routes it normally."
   *
   * TO WATCH IT FAIL: put `auth: "unauthenticated"` back at the `evaluateRules` call in
   * `packages/core/src/pipeline.ts#planChange`.
   */
  it("an ALLOW rule does not carry a message its own provider says is forged", async () => {
    const repo = new FakeRepo();
    repo.rules = [allowRule("partner@bank.example")];

    const out = await ingest(
      repo,
      eml({ from: "partner@bank.example", authResults: [TRUSTED_DKIM_FAIL] }),
      PROVIDER,
    );

    expect(out.desired).toBe("ohmail/Screener");
    // The verdict that decided it is ON THE ROW, not only in a log line.
    expect(out.persisted).toBe("fail");
  });

  it("the KNOWN-SENDER branch does not either — a contact's name is not authentication", async () => {
    const repo = new FakeRepo();
    // No rule at all. `contacts` is the only thing saying this sender is welcome, and a forged
    // `From` is precisely how a stranger claims to be them.
    repo.senders.add("anna@example.com");

    const out = await ingest(
      repo,
      eml({ from: "anna@example.com", bulk: true, authResults: [trustedDkimFail("example.com")] }),
      PROVIDER,
    );

    // `List-Unsubscribe` would have refined this to `ohmail/News` for a sender past the gate.
    // The gate is what the failure closes, so the heuristic never runs.
    expect(out.desired).toBe("ohmail/Screener");
    expect(out.persisted).toBe("fail");
  });

  it("a DENY rule is NOT weakened into a demotion — Quarantine is stricter than the Screener", async () => {
    const repo = new FakeRepo();
    repo.rules = [quarantineRule("spammer@bank.example")];

    const out = await ingest(
      repo,
      eml({ from: "spammer@bank.example", authResults: [TRUSTED_DKIM_FAIL] }),
      PROVIDER,
    );

    // Moving this to the Screener would be a PROMOTION wearing the word "demote". The user's own
    // "no" outranks our evidence in the direction that matters.
    expect(out.desired).toBe("ohmail/Quarantine");
    expect(out.persisted).toBe("fail");
  });
});

describe("§2 — and NOTHING else changes a routing answer", () => {
  /**
   * THE OTHER HALF OF EVERY §1 CASE. Same sender, same rules, same code path — the failure
   * header removed. If these move, the change is not demote-only and the large-backlog
   * case in `rules.ts#AuthVerdict` is back.
   */
  it("the same allowed sender with NO Authentication-Results routes exactly as before", async () => {
    const repo = new FakeRepo();
    repo.rules = [allowRule("partner@bank.example")];

    const out = await ingest(repo, eml({ from: "partner@bank.example" }), PROVIDER);

    expect(out.desired).toBe("ohmail/News");
    // "The caller looked and found nothing it is entitled to believe" — NOT `"unauthenticated"`,
    // which now means only "nobody looked", and NOT `null`, which would lose that distinction.
    expect(out.persisted).toBe("unavailable");
  });

  it("a known sender with no headers at all is still promoted — a verdict is never REQUIRED", async () => {
    const repo = new FakeRepo();
    repo.senders.add("anna@example.com");

    const out = await ingest(repo, eml({ from: "anna@example.com", bulk: true }), PROVIDER);

    // This is the single most important negative in the file. An `auth !== "pass"` gate here
    // would answer Screener, and `kickstart.ts`'s re-route pass would then reroute nothing.
    expect(out.desired).toBe("ohmail/News");
    expect(out.persisted).toBe("unavailable");
  });

  it("a failure from an UNTRUSTED position cannot screen the user's own correspondent", async () => {
    const repo = new FakeRepo();
    repo.rules = [allowRule("partner@bank.example")];

    // Any hop — including the sender — can prepend an `Authentication-Results`. If an untrusted
    // one were read, a third party could bury a correspondent in the Screener by asserting a
    // failure about them. A sender-inserted header must be indistinguishable from no header.
    const out = await ingest(
      repo,
      eml({ from: "partner@bank.example", authResults: [FORGED_DKIM_FAIL] }),
      PROVIDER,
    );

    expect(out.desired).toBe("ohmail/News");
    expect(out.persisted).toBe("unavailable");
  });

  it("a trusted position's PASS routes identically to no header — routing does not read it", async () => {
    const repo = new FakeRepo();
    repo.rules = [allowRule("partner@bank.example")];

    const out = await ingest(
      repo,
      eml({
        from: "partner@bank.example",
        authResults: ["mx.google.com; dkim=pass header.d=bank.example; dmarc=pass"],
      }),
      PROVIDER,
    );

    // `"pass"` exists to be persisted and shown. It buys no placement a message without it
    // would not have had — otherwise absence of evidence would be doing work by contrast.
    expect(out.desired).toBe("ohmail/News");
    expect(out.persisted).toBe("pass");
  });

  it("mail the USER wrote is never demoted by its own provider's report", async () => {
    const repo = new FakeRepo();
    const raw = eml({ from: "mila@lichtgrat.example", authResults: [trustedDkimFail("lichtgrat.example")] });
    const change: Change = {
      type: "create", locator: { folder: "Sent", ref: "1:10" }, raw, ownAuthored: true,
    };
    const plan = await planChange(change, {
      repo, accountId: "acct-1", mailboxId: "mb-1", trustedAuthservIds: PROVIDER,
    });
    const res = await commitChange(plan, { repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP });

    // The `ownAuthored` early return reaches no `evaluateRules` call, so this holds structurally
    // rather than by the verdict being benign. Organize-in-place: it stays in Sent.
    expect((await repo.getFolderState(res.messageId))!.desiredFolder).toBe("Sent");
    // Recorded all the same — the row states what the provider said even where nothing read it.
    expect(repo.rows.get(res.messageId)!.input.authVerdict).toBe("fail");
  });
});

describe("§3 — with no trusted set, THE DAY THIS SHIPS CHANGES NO ROUTING", () => {
  /**
   * `trustedAuthservIds` defaults to empty, `authVerdictFromHeaders` answers `"unavailable"` for
   * every message on its first line, and `evaluateRules` reads neither that nor the
   * `"unauthenticated"` literal it replaced. The two cases below are the same forged message
   * that §1 screens — proving the demotion is gated on a DEPLOYMENT DECISION and not on the code
   * having landed.
   */
  it("an explicitly empty trusted set routes the forged message exactly as today", async () => {
    const repo = new FakeRepo();
    repo.rules = [allowRule("partner@bank.example")];

    const out = await ingest(
      repo,
      eml({ from: "partner@bank.example", authResults: [TRUSTED_DKIM_FAIL] }),
      UNCONFIGURED,
    );

    expect(out.desired).toBe("ohmail/News");
    expect(out.persisted).toBe("unavailable");
  });

  it("and an ABSENT dep is the same thing — the default is not a different code path", async () => {
    const repo = new FakeRepo();
    repo.rules = [allowRule("partner@bank.example")];

    // No `trustedAuthservIds` key at all: what `apps/worker/src/sync.ts` passes today.
    const out = await ingest(
      repo, eml({ from: "partner@bank.example", authResults: [TRUSTED_DKIM_FAIL] }), undefined,
    );

    expect(out.desired).toBe("ohmail/News");
    expect(out.persisted).toBe("unavailable");
  });

  it("an unknown sender is screened with or without a verdict — the gate is unmoved", async () => {
    const forged = new FakeRepo();
    const plain = new FakeRepo();

    const a = await ingest(
      forged, eml({ from: "stranger@nowhere.example", authResults: [trustedDkimFail("nowhere.example")] }), PROVIDER,
    );
    const b = await ingest(plain, eml({ from: "stranger@nowhere.example" }), PROVIDER);

    // The demotion branch is UNREACHABLE for a stranger: they are already behind the gate. This
    // is what makes "demote-only" a statement with no blast radius on first contact.
    expect(a.desired).toBe("ohmail/Screener");
    expect(b.desired).toBe("ohmail/Screener");
    expect(a.persisted).toBe("fail");
    expect(b.persisted).toBe("unavailable");
  });
});

describe("§4 — the verdict that routed is the verdict on the row", () => {
  it("persists at commit, in the ingest transaction, without a second parse", async () => {
    const repo = new FakeRepo();
    repo.rules = [allowRule("partner@bank.example")];
    const raw = eml({ from: "partner@bank.example", authResults: [TRUSTED_DKIM_FAIL] });

    const plan = await planChange({ type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw }, {
      repo, accountId: "acct-1", mailboxId: "mb-1", trustedAuthservIds: PROVIDER,
    });

    // The PLAN carries it, so the value handed to `evaluateRules` and the value written to
    // `messages.auth_verdict` are one object field and cannot drift apart.
    expect(plan.new!.authVerdict).toBe("fail");

    const res = await commitChange(plan, { repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP });
    expect(repo.rows.get(res.messageId)!.input.authVerdict).toBe(plan.new!.authVerdict);
  });

  it("a racing loser writes no verdict — the winner's row is the one that stands", async () => {
    const repo = new FakeRepo();
    repo.senders.add("anna@example.com");
    const raw = eml({ from: "anna@example.com", bulk: true, authResults: [trustedDkimFail("example.com")] });
    const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw };
    const deps = { repo, accountId: "acct-1", mailboxId: "mb-1", trustedAuthservIds: PROVIDER };

    // BOTH cycles plan before either commits — `InsertedMessage.created` is what tells the loser
    // it lost, and the loser must not touch the tail. Real Postgres proves the SQL half of this
    // (`packages/core/test/adapters/auth-verdict-ingest.pg.test.ts`); this pins the plan shape.
    const first = await planChange(change, deps);
    const second = await planChange(change, deps);

    const a = await commitChange(first, { repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP });
    const b = await commitChange(second, { repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP });

    expect(a.messageId).toBe(b.messageId);
    expect(b.outcome).toBe("duplicate");
    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get(a.messageId)!.input.authVerdict).toBe("fail");
    expect((await repo.getFolderState(a.messageId))!.desiredFolder).toBe("ohmail/Screener");
  });
});

describe("§5 — where the provider writes nothing ohmail believes, the sender's own signature", () => {
  /**
   * `authserv-ids.ts` names no host but Gmail's and Microsoft's, so at every other mailbox a header
   * says nothing and the verdict was `unavailable` for everything. The plan step now checks the
   * sender's own DKIM signature there (`adapters/dkim.ts`), for the letters an automatic act or the
   * identity line reads — a company's own domain, or a one-click letter while the account lets a
   * screen-out unsubscribe. It answers `pass` or `unavailable`, never `fail`, so routing (which
   * reads `fail` alone) is what it was.
   */
  const FASTMAIL = providerAuthservIds("imap.fastmail.com");
  const GMAIL_HOST = providerAuthservIds("imap.gmail.com");
  const KEY = rsaKey();
  const BANK = rsaKey();
  const LIST = rsaKey();
  const TABLE = {
    "s1._domainkey.paypal.com": KEY.record, "s1._domainkey.bank.example": BANK.record,
    "s1._domainkey.list.example": LIST.record, "s1._domainkey.friends.example": LIST.record,
  };
  const ONE_CLICK = ["List-Unsubscribe: <https://list.example/u/1>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"];
  const FORGED = "mx.google.com; dkim=pass header.d=paypal.com; dmarc=pass header.from=paypal.com";

  /** The check, loaded when asked: the plan step takes it injected, never by import; one cycle's view. */
  async function signatures(keys: ReturnType<typeof fakeKeys>, listLetters = true) {
    const { makeSignatureCheck } = await import("../src/adapters/dkim.js");
    return signaturesForCycle({ ...makeSignatureCheck({ keys }), listLetters });
  }

  async function ingestWith(
    repo: FakeRepo, raw: string, trusted: ReadonlySet<string>, keys: ReturnType<typeof fakeKeys>,
    o: { listLetters?: boolean; change?: Partial<Change> } = {},
  ): Promise<Ingested> {
    const change: Change = {
      type: "create", locator: { folder: "INBOX", ref: "1:10" }, raw: Buffer.from(raw, "latin1"), ...o.change,
    };
    const plan = await planChange(change, {
      repo, accountId: "acct-1", mailboxId: "mb-1", readerMode: false, trustedAuthservIds: trusted,
      signatures: await signatures(keys, o.listLetters ?? true),
    });
    const res = await commitChange(plan, { repo, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP });
    const state = await repo.getFolderState(res.messageId);
    return { messageId: res.messageId, desired: state!.desiredFolder, persisted: repo.rows.get(res.messageId)!.input.authVerdict };
  }

  it("a company's signed letter at a provider nobody names reads pass, and routes as before", async () => {
    const keys = fakeKeys(TABLE);
    const out = await ingestWith(new FakeRepo(), await nodemailerSign(letter(), "paypal.com", "s1", KEY), FASTMAIL, keys);
    expect(out.persisted).toBe("pass");
    expect(keys.calls).toEqual(["s1._domainkey.paypal.com"]);
    // A stranger is a stranger: `pass` is persisted and shown, never read by routing.
    expect(out.desired).toBe("ohmail/Screener");
  });

  it("an unsigned letter wearing a forged provider header stays unavailable", async () => {
    const keys = fakeKeys(TABLE);
    const out = await ingestWith(new FakeRepo(), letter({ top: [`Authentication-Results: ${FORGED}`] }), FASTMAIL, keys);
    expect(out.persisted).toBe("unavailable");
    expect(keys.calls).toEqual([]);
  });

  it("a broken aligned signature under an allow rule is admitted exactly as before", async () => {
    const raw = (await nodemailerSign(letter({ from: "Partner <partner@bank.example>", extra: ONE_CLICK }), "bank.example", "s1", BANK))
      .replace("Thank you", "Please pay");
    const checked = new FakeRepo();
    checked.rules = [allowRule("partner@bank.example")];
    const keys = fakeKeys(TABLE);
    const out = await ingestWith(checked, raw, FASTMAIL, keys);
    const plain = new FakeRepo();
    plain.rules = [allowRule("partner@bank.example")];
    const before = await ingest(plain, Buffer.from(raw, "latin1"), FASTMAIL);
    expect(out).toMatchObject({ desired: before.desired, persisted: "unavailable" });
    expect(before).toMatchObject({ desired: "ohmail/News", persisted: "unavailable" });
  });

  it("at Gmail and at Microsoft the same signed letter is read from the provider's header alone, with no lookup", async () => {
    const signed = await nodemailerSign(letter(), "paypal.com", "s1", KEY);
    for (const host of ["imap.gmail.com", "outlook.office365.com"]) {
      const keys = fakeKeys(TABLE);
      const out = await ingestWith(new FakeRepo(), signed, providerAuthservIds(host), keys);
      expect(out.persisted, host).toBe("unavailable");
      expect(keys.calls, host).toEqual([]);
    }
    // And the provider's own word still reads as it did: a header Gmail wrote, above the signature.
    const confirmed = `Authentication-Results: mx.google.com; dkim=pass header.d=paypal.com; dmarc=pass\r\n${signed}`;
    const keys = fakeKeys(TABLE);
    expect((await ingestWith(new FakeRepo(), confirmed, GMAIL_HOST, keys)).persisted).toBe("pass");
    expect(keys.calls).toEqual([]);
  });

  it("no lookup for a letter nothing automatic reads, own mail, oversize mail or old mail", async () => {
    // Each signed by its own domain, so a lookup it skips is skipped for the reason named.
    const signedPerson = await nodemailerSign(letter({ from: "Anna <anna@friends.example>" }), "friends.example", "s1", LIST);
    const signedList = await nodemailerSign(letter({ from: "News <news@list.example>", extra: ONE_CLICK }), "list.example", "s1", LIST);
    const signed = await nodemailerSign(letter(), "paypal.com", "s1", KEY);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const cases: [string, string, Parameters<typeof ingestWith>[4]][] = [
      ["a person's letter", signedPerson, {}],
      ["a one-click letter while the account keeps its lists", signedList, { listLetters: false }],
      ["the person's own mail", signed, { change: { ownAuthored: true, locator: { folder: "Sent", ref: "1:10" } } }],
      ["a letter over the size ceiling", signed, { change: { oversizeBytes: 70 * 1024 * 1024 } }],
      ["a letter forty days old", signed, { change: { internalDate: old } }],
    ];
    for (const [what, raw, o] of cases) {
      const keys = fakeKeys(TABLE);
      const out = await ingestWith(new FakeRepo(), raw, FASTMAIL, keys, o);
      expect(keys.calls, what).toEqual([]);
      expect(out.persisted, what).not.toBe("pass");
    }
    // CONTROL: the same one-click letter with the account's lists on is looked up, and passes.
    const keys = fakeKeys(TABLE);
    expect((await ingestWith(new FakeRepo(), signedList, FASTMAIL, keys)).persisted).toBe("pass");
    expect(keys.calls).toEqual(["s1._domainkey.list.example"]);
  });
});
