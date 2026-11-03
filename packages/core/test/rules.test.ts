import { describe, it, expect } from "vitest";
import {
  compareRules, effectForDestination, evaluateRules,
  type AuthVerdict, type OhboxPolicy, type Rule,
} from "../src/rules.js";
import type { NormalizedMessage } from "../src/types.js";
import { claimedIdentity, ownedBrand } from "../src/sender-check.js";
import { personalAt } from "../../../test/support/fixture-credentials.js";

/* Senders at a shared provider, where the provider is what the rules read: assembled, fixture locals. */
const GMAIL = "gmail.com";
const PHISHER = personalAt("fixture.mila", GMAIL);
const STRANGER = personalAt("fixture.reto", GMAIL);

/**
 * `auth` is REQUIRED on the input, and since that change the evaluator reads it — for exactly one value,
 * `"fail"`. See `rules.ts#AuthVerdict`. Every call in this file names it, because that is the
 * whole point of the field: no default, so no call site can be silently on the wrong side of a
 * branch.
 *
 * Every case below states `"unauthenticated"`, which is the pre-W7 value and the value a NULL
 * `messages.auth_verdict` resolves to — so this whole file is also the assertion that adding the
 * verdict changed NOTHING about how a message with no evidence routes. The demotion itself, and
 * the two shapes of absent evidence, are in `auth-results.test.ts`.
 */
const UNAUTHENTICATED: AuthVerdict = "unauthenticated";

interface MsgOpts {
  headers?: Record<string, string[]>;
  subject?: string;
  /** The RAW `From` header line(s), when a test needs to say something `from.address` cannot. */
  rawFrom?: string[];
}

function msg(from: string, o: MsgOpts = {}): NormalizedMessage {
  const headers: Record<string, string[]> = { ...(o.headers ?? {}) };
  if (o.rawFrom !== undefined) headers["from"] = o.rawFrom;
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: o.subject ?? "s", from: { name: null, address: from }, to: [],
    date: null, headers, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

/** `effect` defaults from the destination exactly as `drizzle-repo.ts#listRules` derives it. */
const rule = (over: Partial<Rule>): Rule => {
  const destination = over.destination ?? "INBOX";
  return {
    id: "r", kind: "sender", match: "", destination,
    effect: effectForDestination(destination),
    priority: 0, provenance: "manual", enabled: true, ...over,
  };
};

const decide = (
  m: NormalizedMessage, rules: Rule[] = [], known: Set<string> = new Set(),
  ohboxPolicy: OhboxPolicy = "people_and_replied",
) => evaluateRules({ msg: m, rules, ownAddresses: new Set<string>(), knownSenders: { addresses: known, inferred: new Set<string>(), lists: new Map() }, auth: UNAUTHENTICATED, ohboxPolicy, identity: null });

describe("evaluateRules", () => {
  it("routes a matched sender rule (highest priority wins)", () => {
    const rules = [
      rule({ id: "lo", kind: "domain", match: "example.com", destination: "ohmail/News", priority: 1 }),
      rule({ id: "hi", kind: "sender", match: "anna@example.com", destination: "INBOX", priority: 10 }),
    ];
    const d = decide(msg("anna@example.com"), rules, new Set(["anna@example.com"]));
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "hi", source: "rule" });
  });
  it("routes List-Unsubscribe mail to the Feed via header heuristic", () => {
    const d = decide(
      msg("news@x.example", { headers: { "list-unsubscribe": ["<mailto:u@x.example>"] } }),
      [], new Set(["news@x.example"]),
    );
    expect(d.destination).toBe("ohmail/News");
    expect(d.source).toBe("header");
  });
  it("sends an unknown sender to the Screener", () => {
    const d = decide(msg("stranger@nowhere-com.example"));
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.source).toBe("screener");
  });
  it("returns unclear when a known sender matches no rule", () => {
    const d = decide(msg("known@x.example"), [], new Set(["known@x.example"]));
    expect(d).toEqual({ destination: null, matchedRuleId: null, source: "unclear" });
  });

  /**
   * THE KNOWN-SENDER FALLTHROUGH, stated as the routing outcome rather than as a decision shape.
   *
   * The test above pins `evaluateRules`'s return value; this one pins what that value MEANS,
   * because the whole of slice the kickstart rests on it: a sender in `contacts` must not be
   * screened. Before the Sent-folder import there was nothing in `contacts`, so most of the
   * seeded messages — every thread reply and every existing correspondent — sat in
   * `ohmail/Screener`. Delete the `knownSenders` check from `isKnownAuthor` and both this and the
   * "unknown sender" case above collapse into one answer.
   *
   * The first half did NOT change this. `auth: "unauthenticated"` is the only verdict any caller can
   * state and the evaluator does not read it, so a known sender is still known — gating that on
   * an auth verdict is what would empty the re-route pass (`kickstart.ts:167`).
   */
  it("a sender in contacts is NOT screened, and one outside it is", () => {
    const contacts = new Set(["anna@work.example"]);
    expect(decide(msg("anna@work.example"), [], contacts).destination).not.toBe("ohmail/Screener");
    expect(decide(msg("nobody@work.example"), [], contacts).destination).toBe("ohmail/Screener");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE CONSENT GATE RUNS BEFORE THE HEURISTIC — a critical review finding
   ══════════════════════════════════════════════════════════════════════════════════════════

   Every signal the heuristic reads is chosen by the SENDER. `headerHeuristic` used to run before
   the Screener check, so an unknown address that wrote `Precedence: bulk` — or shaped its local
   part like `no-reply@` and its subject like an invoice — selected its own folder. Remote,
   unauthenticated, no user action, no knowledge of the user's contacts.

   MUTATION for every case below: move the `headerHeuristic` call in `evaluateRules` back above
   the `isKnownAuthor` gate.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("an unknown sender cannot choose their own folder", () => {
  const unsub = { "list-unsubscribe": ["<mailto:u@attacker.example>"] };

  it.each([
    ["List-Unsubscribe", "stranger@attacker.example", { headers: unsub }],
    ["Precedence: bulk", "stranger@attacker.example", { headers: { precedence: ["bulk"] } }],
    ["Auto-Submitted", "stranger@attacker.example", { headers: { "auto-submitted": ["auto-generated"] } }],
    ["a no-reply local part + an invoice subject", "no-reply@attacker.example", { subject: "Invoice 2026-114" }],
    ["a no-reply local part + a receipt subject, with unsub", "noreply@attacker.example", { headers: unsub, subject: "Your receipt from Shop" }],
    ["bulk + a transactional order subject", "billing@attacker.example", { headers: { precedence: ["bulk"] }, subject: "Order #4471 confirmed" }],
  ])("%s does not get a stranger past the gate", (_label, from, o: MsgOpts) => {
    const d = decide(msg(from, o));
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.source).toBe("screener");
  });

  /**
   * …and the same six signals still WORK, for a sender the account already knows. The gate is a
   * gate, not a deletion of the deterministic layer: without this pair the fix above could be
   * satisfied by making `headerHeuristic` unreachable.
   */
  it("…while the same message from a known sender is still refined by the heuristic", () => {
    const known = new Set(["shop@known.example", "no-reply@known.example"]);
    expect(decide(msg("shop@known.example", { headers: unsub }), [], known).destination)
      .toBe("ohmail/News");
    // The receipts branch needs BOTH halves; `no-reply@` is the machine half here.
    expect(
      decide(msg("no-reply@known.example", { headers: unsub, subject: "Your receipt" }), [], known)
        .destination,
    ).toBe("ohmail/Receipts");
  });

  /**
   * A USER-AUTHORED rule is the one thing that outranks the gate, because it IS the user's
   * consent. A header rule is included deliberately: the user said "anything carrying this header
   * goes to Reads", and that is a decision about their own mail, not a sender's self-assertion.
   */
  it("an explicit user rule still lets a stranger through — that is what consent means", () => {
    const rules = [rule({ id: "u", kind: "header", match: "list-unsubscribe", destination: "ohmail/News" })];
    const d = decide(msg("stranger@attacker.example", { headers: unsub }), rules);
    expect(d).toEqual({ destination: "ohmail/News", matchedRuleId: "u", source: "rule" });
  });

  /**
   * `message_bodies.headers` comes back through `JSON.parse`, so the map inherits from
   * `Object.prototype` (residue). Under the old `Boolean(msg.headers[name])` test a header
   * rule whose `match` was `constructor` fired on EVERY message — a one-rule blanket bypass of
   * the gate for the whole account.
   *
   * MUTATION: swap the `hasOwnProperty` check in `matches` back to `Boolean(msg.headers[name])`
   * and this goes red on `'ohmail/News'`.
   */
  it("a header rule named after an Object.prototype member matches nothing", () => {
    const inherited = JSON.parse("{}") as Record<string, string[]>;
    const rules = [rule({ id: "proto", kind: "header", match: "constructor", destination: "ohmail/News" })];
    const d = evaluateRules({
      msg: { ...msg("stranger@attacker.example"), headers: inherited },
      rules, ownAddresses: new Set<string>(), knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, auth: UNAUTHENTICATED, identity: null,
    });
    expect(d.destination).toBe("ohmail/Screener");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   A MALFORMED `From` FAILS CLOSED — a high review finding
   ══════════════════════════════════════════════════════════════════════════════════════════

   The old gate was `if (from && !knownSenders.has(from))`. `mime.ts:381` leaves
   `msg.from.address` as `""` when mailparser resolves no author mailbox, so the guard was false
   ON TRUTHINESS ALONE and the message answered `unclear` — past the gate with no address to spoof.

   MUTATION for every case below: replace the body of `isKnownAuthor` with
   `return author !== "" && knownSenders.has(author ?? "")`, or make `isSingleUsableAddress`
   return `addr.length > 0`.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("a message with no usable author is screened, never unclear", () => {
  it.each([
    ["an absent From header (mailparser yields the empty address)", msg("")],
    ["an empty group — `From: undisclosed-recipients:;`", msg("", { rawFrom: ["undisclosed-recipients:;"] })],
    ["unparseable syntax with no @", msg("not-an-address")],
    ["a fragment of a header rather than a mailbox", msg("<garbage")],
    ["two @ signs — not one addr-spec", msg("a@b@c.example")],
    ["a local part but no domain", msg("nobody@")],
    ["a domain but no local part", msg("@nowhere-com.example")],
    ["whitespace inside the address", msg("two words@x.example")],
    ["two author mailboxes in one From line", msg("first@x.example", { rawFrom: ["first@x.example, second@y.example"] })],
    ["two From header lines", msg("first@x.example", { rawFrom: ["first@x.example", "second@y.example"] })],
  ])("%s ⇒ Screener", (_label, m) => {
    const d = decide(m);
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.source).toBe("screener");
  });

  /**
   * The empty string is not a skeleton key. `contacts.address` is `NOT NULL` but not non-empty,
   * so a `""` row would otherwise make EVERY malformed `From` a known sender — which is why the
   * replacement had to be a positive predicate rather than a fixed truthiness test.
   */
  it("a `\"\"` row in contacts does not admit a message with no author", () => {
    const d = decide(msg(""), [], new Set([""]));
    expect(d.destination).toBe("ohmail/Screener");
  });

  /* ── EACH SYNTAX CLAUSE, MADE OBSERVABLE ──────────────────────────────────────────────────
   *
   * Every case in the table at the top of this block is an UNKNOWN sender, so it reaches the
   * Screener whether or not the syntax check fires — which means those cases pin the OUTCOME but
   * not the reason, and a mutation to any single clause of `isSingleUsableAddress` survives them.
   *
   * These put the malformed string in `contacts` as well. `contacts.address` is bare `text`, so a
   * row like this is representable, and if it existed the old code would treat the malformed
   * claim as a known correspondent. Each row now fails one specific clause, so deleting that
   * clause turns exactly this test red.
   */
  it.each([
    ["the empty string", ""],
    ["no `@` at all", "not-an-address"],
    ["no local part", "@nowhere-com.example"],
    ["no domain", "nobody@"],
    ["two `@`", "a@b@c.example"],
    ["an embedded space", "two words@x.example"],
    ["an angle bracket", "<john@x.example>"],
    ["a trailing semicolon", "john@x.example;"],
    ["an embedded comma", "a@x.example,b@y.example"],
    ["an ASCII control character", `john${String.fromCharCode(1)}doe@x.example`],
    ["a backslash", "jo\\hn@x.example"],
  ])("%s is screened even when that exact string is in contacts", (_label, address) => {
    const d = decide(msg(address), [], new Set([address]));
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.source).toBe("screener");
  });

  /** …and the same string cannot satisfy a sender rule the user wrote for it either. */
  it.each(["", "a@b@c.example", "nobody@", "two words@x.example"])(
    "a sender rule matching the malformed string `%s` still does not fire",
    (address) => {
      const rules = [rule({ id: "m", kind: "sender", match: address, destination: "INBOX" })];
      expect(decide(msg(address), rules, new Set([address])).destination).toBe("ohmail/Screener");
    },
  );

  /** …and neither can a rule be matched by one. */
  it("a sender rule whose match is empty does not fire on an absent From", () => {
    const rules = [rule({ id: "empty", kind: "sender", match: "", destination: "INBOX" })];
    expect(decide(msg(""), rules).destination).toBe("ohmail/Screener");
  });

  it("a domain rule does not fire on an absent From either", () => {
    const rules = [rule({ id: "d", kind: "domain", match: "", destination: "INBOX" })];
    expect(decide(msg(""), rules).destination).toBe("ohmail/Screener");
  });

  it("…and neither does a domain rule on a two-author From that names its domain", () => {
    const rules = [rule({ id: "d", kind: "domain", match: "x.example", destination: "INBOX" })];
    const m = msg("first@x.example", { rawFrom: ["first@x.example, second@x.example"] });
    expect(decide(m, rules).destination).toBe("ohmail/Screener");
  });

  /* ── THE OTHER DIRECTION, WHICH IS THE ONE THAT WOULD HURT USERS ──────────────────────────
   *
   * Screening a real correspondent is the regression this slice must not cause. A comma inside a
   * quoted display name, a parenthesised comment, or an angle-addr is ORDINARY mail from one
   * person, and the naive "does the From header contain a comma" check screens all three.
   *
   * MUTATION: make `countMailboxSeparators` return `value.split(",").length - 1` and every case
   * here goes red.
   */
  it.each([
    ['a quoted display name containing a comma', ['"Doe, John" <john@x.example>']],
    ['a parenthesised comment containing a comma', ['john@x.example (Doe, John)']],
    ['an escaped quote inside the display name', ['"Doe \\" , John" <john@x.example>']],
    ['a plain angle-addr', ['John Doe <john@x.example>']],
    ['a bare addr-spec', ['john@x.example']],
  ])("a known contact whose From header has %s is NOT screened", (_label, rawFrom) => {
    const d = decide(msg("john@x.example", { rawFrom }), [], new Set(["john@x.example"]));
    expect(d.destination).not.toBe("ohmail/Screener");
    expect(d.source).toBe("unclear");
  });

  /**
   * An address the account knows and an address shape this file rejects must not overlap, or the
   * predicate is screening real people. `+`, `-`, `_`, `.` and `'` all appear in real local parts.
   */
  it.each([
    "first-name@example.com",
    "first.last+tag@example.org",
    "under_score@example.com",
    "o'brien@example.com",
    "a@localhost",
    "user@[192.0.2.1]",
  ])("%s is a usable author and is not screened when known", (address) => {
    expect(decide(msg(address), [], new Set([address])).destination).not.toBe("ohmail/Screener");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE TOTAL ORDER — a high review finding
   ══════════════════════════════════════════════════════════════════════════════════════════

   The reported defect was that equal-priority ties fell back to array position. The real input
   order was PostgreSQL's physical row order (`drizzle-repo.ts#listRules` had no `ORDER BY`), so
   the same message routed differently on different days. `rules.pg.test.ts` is the half of this
   that PGlite cannot show; these are the properties of the order itself.

   MUTATION for the permutation cases: delete any one comparison from `compareRules` after the
   priority clause. Each deletion turns a different `expected` below red.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Every ordering of the input. 4 rules ⇒ 24 orderings. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

describe("equal-priority rule ties are resolved by a total order, not by input order", () => {
  it("permutations() itself is not vacuous — 4 items give 24 distinct orderings", () => {
    const perms = permutations([1, 2, 3, 4]);
    expect(perms).toHaveLength(24);
    expect(new Set(perms.map((p) => p.join(""))).size).toBe(24);
  });

  const cases: Array<{ label: string; rules: Rule[]; from: string; expected: string }> = [
    {
      label: "a sender-specific DENY beats a broad domain ALLOW",
      from: "bad@vendor.example",
      expected: "sender-deny",
      rules: [
        rule({ id: "domain-allow", kind: "domain", match: "vendor.example", destination: "INBOX" }),
        rule({ id: "sender-deny", kind: "sender", match: "bad@vendor.example", destination: "ohmail/Screened" }),
        rule({ id: "header-allow", kind: "header", match: "list-unsubscribe", destination: "ohmail/News" }),
        rule({ id: "domain-deny", kind: "domain", match: "vendor.example", destination: "ohmail/Screener" }),
      ],
    },
    {
      label: "…and with no sender rule in play, the domain DENY beats the domain ALLOW",
      from: "bad@vendor.example",
      expected: "domain-deny",
      rules: [
        rule({ id: "domain-allow", kind: "domain", match: "vendor.example", destination: "INBOX" }),
        rule({ id: "header-allow", kind: "header", match: "list-unsubscribe", destination: "ohmail/News" }),
        rule({ id: "domain-deny", kind: "domain", match: "vendor.example", destination: "ohmail/Screener" }),
        rule({ id: "zzz-header-deny", kind: "header", match: "list-unsubscribe", destination: "ohmail/Quarantine" }),
      ],
    },
    {
      label: "a sender ALLOW beats a domain ALLOW (specificity, with no deny anywhere)",
      from: "ok@vendor.example",
      expected: "sender-allow",
      rules: [
        rule({ id: "domain-allow", kind: "domain", match: "vendor.example", destination: "ohmail/News" }),
        rule({ id: "sender-allow", kind: "sender", match: "ok@vendor.example", destination: "INBOX" }),
        rule({ id: "header-allow", kind: "header", match: "list-unsubscribe", destination: "ohmail/Receipts" }),
        rule({ id: "domain-allow-2", kind: "domain", match: "vendor.example", destination: "ohmail/Receipts" }),
      ],
    },
    {
      label: "manual beats migrated beats promoted at equal effect and kind",
      from: "ok@vendor.example",
      expected: "the-manual-one",
      rules: [
        rule({ id: "aaa-promoted", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News", provenance: "promoted" }),
        rule({ id: "bbb-migrated", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News", provenance: "migrated" }),
        rule({ id: "the-manual-one", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News", provenance: "manual" }),
        rule({ id: "ccc-promoted", kind: "domain", match: "vendor.example", destination: "ohmail/News", provenance: "manual" }),
      ],
    },
    {
      label: "the id is the last resort, and it is the LOW id",
      from: "ok@vendor.example",
      expected: "aaa",
      rules: [
        rule({ id: "ddd", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News" }),
        rule({ id: "aaa", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News" }),
        rule({ id: "ccc", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News" }),
        rule({ id: "bbb", kind: "sender", match: "ok@vendor.example", destination: "ohmail/News" }),
      ],
    },
    {
      label: "numeric priority still dominates every specificity clause",
      from: "bad@vendor.example",
      expected: "loud-allow",
      rules: [
        rule({ id: "sender-deny", kind: "sender", match: "bad@vendor.example", destination: "ohmail/Screened" }),
        rule({ id: "loud-allow", kind: "domain", match: "vendor.example", destination: "INBOX", priority: 9 }),
        rule({ id: "header-allow", kind: "header", match: "list-unsubscribe", destination: "ohmail/News" }),
        rule({ id: "domain-deny", kind: "domain", match: "vendor.example", destination: "ohmail/Screener" }),
      ],
    },
  ];

  for (const c of cases) {
    it(`${c.label} — in all 24 orderings`, () => {
      const seen = new Set<string>();
      for (const ordering of permutations(c.rules)) {
        const d = decide(
          msg(c.from, { headers: { "list-unsubscribe": ["<mailto:u@vendor.example>"] } }),
          ordering,
        );
        seen.add(`${d.matchedRuleId}`);
      }
      expect([...seen]).toEqual([c.expected]);
    });
  }

  it("a disabled rule never wins a tie, however specific", () => {
    const rules = [
      rule({ id: "sender-deny", kind: "sender", match: "bad@vendor.example", destination: "ohmail/Screened", enabled: false }),
      rule({ id: "domain-allow", kind: "domain", match: "vendor.example", destination: "INBOX" }),
    ];
    for (const ordering of permutations(rules)) {
      expect(decide(msg("bad@vendor.example"), ordering).matchedRuleId).toBe("domain-allow");
    }
  });

  /**
   * `kind`, `provenance` and `destination` are `text` columns read through an `as` cast, so a
   * value outside the union is representable. `undefined - undefined` is `NaN`, and a comparator
   * that returns `NaN` is not an order — which is the very failure this slice closes.
   *
   * MUTATION: drop the `?? Number.MAX_SAFE_INTEGER` from `rank` and this goes red or flaps.
   */
  it("a rule carrying an out-of-union enum value loses every tie instead of poisoning the order", () => {
    const garbage = {
      ...rule({ id: "aaa-garbage", kind: "sender", match: "bad@vendor.example", destination: "INBOX" }),
      provenance: "who-knows" as Rule["provenance"],
      effect: "maybe" as Rule["effect"],
    };
    const sane = rule({ id: "zzz-sane", kind: "sender", match: "bad@vendor.example", destination: "ohmail/Screened" });
    for (const ordering of permutations([garbage, sane])) {
      expect(decide(msg("bad@vendor.example"), ordering).matchedRuleId).toBe("zzz-sane");
    }
  });

  /**
   * `priority` is `integer NOT NULL`, so Postgres cannot hand us `NaN` — but `finitePriority`
   * exists, and a defensive line nobody has watched work is not a guard. `NaN - 0` is `NaN`, and
   * a comparator that returns `NaN` makes `Array.prototype.sort` implementation-defined: the
   * winner would depend on the input order again, which is the whole finding.
   *
   * MUTATION: make `finitePriority` return `p` and this goes red or flaps.
   */
  it("a rule with a non-finite priority loses every tie instead of destroying the order", () => {
    const poison = { ...rule({ id: "aaa-poison", kind: "sender", match: "bad@vendor.example", destination: "INBOX" }), priority: Number.NaN };
    const sane = rule({ id: "zzz-sane", kind: "sender", match: "bad@vendor.example", destination: "ohmail/Screened" });
    expect(Number.isNaN(compareRules(poison, sane))).toBe(false);
    for (const ordering of permutations([poison, sane])) {
      expect(decide(msg("bad@vendor.example"), ordering).matchedRuleId).toBe("zzz-sane");
    }
  });

  it("compareRules is antisymmetric and never returns NaN over the whole fixture set", () => {
    const all = cases.flatMap((c) => c.rules);
    for (const a of all) {
      for (const b of all) {
        const ab = compareRules(a, b);
        const ba = compareRules(b, a);
        expect(Number.isNaN(ab)).toBe(false);
        // `Math.sign(0)` is `+0` and `-Math.sign(0)` is `-0`, which `toBe` (Object.is) separates —
        // so the antisymmetry is asserted as a SUM rather than as an equality of signs.
        expect(Math.sign(ab) + Math.sign(ba)).toBe(0);
        if (a.id !== b.id) expect(ab).not.toBe(0);
      }
    }
  });
});

describe("effectForDestination", () => {
  it.each([
    ["ohmail/Screener", "deny"],
    ["ohmail/Screened", "deny"],
    ["ohmail/Quarantine", "deny"],
    ["INBOX", "allow"],
    ["ohmail/News", "allow"],
    ["ohmail/Receipts", "allow"],
  ] as const)("%s ⇒ %s", (destination, effect) => {
    expect(effectForDestination(destination)).toBe(effect);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE RECEIPTS HEURISTIC — and the ORDER it is evaluated in
   ══════════════════════════════════════════════════════════════════════════════════════════

   Every case in this block used to run with an EMPTY `knownSenders`, which is what made the
   finding-1 bypass invisible: the suite asserted that a stranger's `Precedence: bulk` reached
   `ohmail/News` and called that correct. The assertions are unchanged; the senders are now in
   `contacts`, because the heuristic's job is to REFINE placement for somebody already past the
   gate. The unknown-sender half of each case is asserted in "an unknown sender cannot choose
   their own folder" above.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("headerHeuristic: receipts", () => {
  const unsub = { "list-unsubscribe": ["<mailto:u@shop.example>"] };
  const SHOP = new Set(["no-reply@shop.example"]);
  const NEWS = new Set(["news@x.example", "news@shop.example"]);

  /**
   * ── THE ORDERING GUARD. THIS IS THE ONE THE SLICE EXISTS FOR. ─────────────────────────
   *
   * A receipt routinely carries an unsubscribe footer — the same ESP sends a shop's order
   * confirmations and its marketing, and the compliance header goes on both. So the Reads
   * branch matches nearly every receipt, and whichever branch runs FIRST wins the message.
   *
   * Measured on the hosted service before that change: `ohmail/Receipts` = 0 with 42 seeded receipts.
   *
   * MUTATION: move the receipts block in `rules.ts#headerHeuristic` below the
   * list-unsubscribe → Reads block and this goes red on `'ohmail/News'`.
   */
  it("a receipt that carries List-Unsubscribe lands in Receipts, not Reads", () => {
    const d = decide(msg("no-reply@shop.example", { headers: unsub, subject: "Your receipt from Shop" }), [], SHOP);
    expect(d.destination).toBe("ohmail/Receipts");
    expect(d.source).toBe("header");
  });

  /**
   * ── THE CONSERVATISM GUARD. Both signals, or neither. ───────────────────────────────────
   *
   * MUTATION: turn the `&&` in `headerHeuristic`'s receipts condition into `||` and this goes
   * red — a colleague asking about an invoice is filed as a receipt.
   */
  it("a plain personal email mentioning an invoice is NOT a receipt", () => {
    const known = new Set(["colleague@work.example"]);
    const d = decide(msg("colleague@work.example", { subject: "quick question about the invoice you sent" }), [], known);
    expect(d.destination).toBeNull();
    expect(d.source).toBe("unclear");
  });

  it("…and an unknown human mentioning an invoice is screened, not filed", () => {
    const d = decide(msg("stranger@work.example", { subject: "about that invoice" }));
    expect(d.destination).toBe("ohmail/Screener");
  });

  it("machine-sent alone is not a receipt — a bulk newsletter still goes to Reads", () => {
    const d = decide(msg("news@x.example", { headers: { precedence: ["bulk"] }, subject: "This week in email" }), [], NEWS);
    expect(d.destination).toBe("ohmail/News");
  });

  it.each([
    ["Auto-Submitted", { "auto-submitted": ["auto-generated"] }, "Invoice 2026-114"],
    ["Precedence: bulk", { precedence: ["bulk"] }, "Your statement is ready"],
    ["a noreply sender", {}, "Refund processed"],
  ])("%s + a money subject ⇒ Receipts", (_label, headers, subject) => {
    const d = decide(msg("no-reply@shop.example", { headers, subject }), [], SHOP);
    expect(d.destination).toBe("ohmail/Receipts");
  });

  /**
   * RFC 3834 gives `Auto-Submitted: no` an explicit meaning — a human wrote this — so presence
   * alone is the wrong test. Without this the header is worse than useless: some clients set it
   * on ordinary outgoing mail.
   */
  it("`Auto-Submitted: no` is not machine-sent", () => {
    const d = decide(
      msg("anna@work.example", { headers: { "auto-submitted": ["no"] }, subject: "invoice attached" }),
      [], new Set(["anna@work.example"]),
    );
    expect(d.destination).toBeNull();
  });

  /**
   * `order` and `payment` do NOT stand alone. Every newsletter sets `Precedence: bulk`, so the
   * machine half says nothing about which of the two a bulk message is, and "Order now" is a
   * marketing subject. Without the transactional-companion requirement this lands in Receipts —
   * which is the ordering fix causing a new mis-file rather than fixing one.
   */
  it("a bulk blast saying `Order now and save 50%` is a Read, not a receipt", () => {
    const d = decide(
      msg("news@shop.example", { headers: { precedence: ["bulk"], ...unsub }, subject: "Order now and save 50%" }),
      [], NEWS,
    );
    expect(d.destination).toBe("ohmail/News");
  });

  it("…while `Order #4471 confirmed` from the same sender is a receipt", () => {
    const d = decide(
      msg("news@shop.example", { headers: { precedence: ["bulk"], ...unsub }, subject: "Order #4471 confirmed" }),
      [], NEWS,
    );
    expect(d.destination).toBe("ohmail/Receipts");
  });

  /**
   * A RULE STILL OUTRANKS THE HEURISTIC. `evaluateRules` tries rules before headers, and that
   * order is the user's decision beating ours — a receipt the user explicitly routed to the
   * Ohbox must keep going there.
   */
  it("an explicit rule beats the receipts heuristic", () => {
    const rules = [rule({ id: "keep", kind: "sender", match: "no-reply@shop.example", destination: "INBOX", priority: 1 })];
    const d = decide(msg("no-reply@shop.example", { headers: unsub, subject: "Your receipt from Shop" }), rules, SHOP);
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "keep", source: "rule" });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   AXIS A — BULK / LIST / ESP HEADERS (SCR-SPAM), post-gate, demote-only.

   The heuristic used to key only on `List-Unsubscribe` and `Precedence: bulk`. It now also reads
   `Feedback-ID`, `List-Id` and `List-Unsubscribe-Post` — the markers a measurement found in the
   Ohbox that the router ignored. Every case is a KNOWN sender (past the gate); the unknown-sender
   half stays screened, which "an unknown sender cannot choose their own folder" already pins.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("Axis A: additional bulk/ESP headers demote a known sender to Reads", () => {
  const KNOWN = new Set(["contact@vendor.example"]);
  it.each([
    ["Feedback-ID", { "feedback-id": ["12345:campaign:vendor"] }],
    ["List-Id", { "list-id": ["<news.vendor.example>"] }],
    ["List-Unsubscribe-Post (one-click)", { "list-unsubscribe-post": ["List-Unsubscribe=One-Click"] }],
  ])("%s ⇒ Reads (source header)", (_label, headers) => {
    const d = decide(msg("contact@vendor.example", { headers }), [], KNOWN);
    expect(d.destination).toBe("ohmail/News");
    expect(d.source).toBe("header");
  });

  /**
   * BEFORE/AFTER, stated as the demotion this slice ships: a known sender whose ONLY automated
   * marker is `Feedback-ID` used to be `unclear` (null → the message stays in whatever folder it
   * arrived in, i.e. the Ohbox). It is now `ohmail/News`.
   *
   * MUTATION: delete the `feedback-id` line in `rules.ts#isBulkSend` and this goes red on `null`.
   */
  it("a Feedback-ID-only message is no longer left unclear (the Ohbox)", () => {
    const d = decide(msg("contact@vendor.example", { headers: { "feedback-id": ["x:y:z"] } }), [], KNOWN);
    expect(d.destination).toBe("ohmail/News");
  });

  it("a Feedback-ID from an UNKNOWN sender is still screened, never Reads", () => {
    const d = decide(msg("stranger@vendor.example", { headers: { "feedback-id": ["x:y:z"] } }));
    expect(d.destination).toBe("ohmail/Screener");
  });

  it("a Feedback-ID + a money subject files under Receipts, not Reads (order preserved)", () => {
    const d = decide(
      msg("contact@vendor.example", { headers: { "feedback-id": ["x:y:z"] }, subject: "Your receipt" }),
      [], KNOWN,
    );
    expect(d.destination).toBe("ohmail/Receipts");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   SERVICE-SHAPED SENDER — a MACHINE-GENERATED signal, NOT a "demote this" signal.

   The refinement (owner, 2026-08-06): the Ohbox is for real people AND genuinely relevant service
   mail. A `no-reply@`/`notifications@` sender delivers relevant transactional mail — a security
   alert, an account action — as often as marketing, so a service-shaped local part alone must NOT
   file mail out of the Ohbox. It only ever feeds the machine-sent test, whose one consumer is the
   Receipts conjunction (machine-sent AND a money subject). Obvious bulk is `isBulkSend`'s job.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("a service-shaped sender is not demoted on shape alone", () => {
  /**
   * THE RELEVANCE GUARD. A relevant service message from a known sender — a security alert with no
   * bulk marker and no money subject — stays `unclear` (i.e. in the Ohbox), never filed to Reads.
   *
   * MUTATION: add `|| isServiceSender(msg.from.address)` back to the Reads branch of
   * `headerHeuristic` and every case here goes red on `'ohmail/News'`.
   */
  it.each([
    ["notifications@corp.example", "New sign-in to your account"],
    ["no-reply@corp.example", "Your password was changed"],
    ["mailer@corp.example", "Action required on your account"],
  ])("%s with a relevant, non-bulk subject stays in the Ohbox (unclear)", (from, subject) => {
    const d = decide(msg(from, { subject }), [], new Set([from]));
    expect(d.destination).toBeNull();
    expect(d.source).toBe("unclear");
  });

  it("…but a service sender WITH a money subject is a receipt ⇒ Receipts", () => {
    const d = decide(msg("no-reply@corp.example", { subject: "Your receipt" }), [], new Set(["no-reply@corp.example"]));
    expect(d.destination).toBe("ohmail/Receipts");
  });

  it("…and a service sender WITH a bulk marker is a newsletter ⇒ Reads", () => {
    const d = decide(
      msg("newsletter@corp.example", { headers: { "list-id": ["<n.corp.example>"] } }),
      [], new Set(["newsletter@corp.example"]),
    );
    expect(d.destination).toBe("ohmail/News");
  });

  it("a service-shaped UNKNOWN sender is still screened — the gate is unchanged", () => {
    const d = decide(msg("notifications@corp.example"));
    expect(d.destination).toBe("ohmail/Screener");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE `people_only` PLACEMENT DEMOTION (SCR-PROMPT) — the ruling's allowlist, demote-only,
   manual/migrated exempt, source "policy" carrying `overriddenRuleId` not `matchedRuleId`.
   ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("people_only demotes an inferred-admission INBOX rule for automated mail", () => {
  const SENDER = "shop@vendor.example";
  const KNOWN = new Set([SENDER]);
  const bulk = { headers: { "list-id": ["<news.vendor.example>"] } };
  const seededInbox = (id = "seed") =>
    rule({ id, kind: "sender", match: SENDER, destination: "INBOX", provenance: "seeded-from-sent" });
  const promotedInbox = (id = "promo") =>
    rule({ id, kind: "sender", match: SENDER, destination: "INBOX", provenance: "promoted" });

  it("seeded INBOX rule + bulk message + people_only ⇒ Reads, source 'policy', overriddenRuleId set", () => {
    const d = decide(msg(SENDER, bulk), [seededInbox("seed1")], KNOWN, "people_only");
    expect(d.destination).toBe("ohmail/News");
    expect(d.source).toBe("policy");
    expect(d.overriddenRuleId).toBe("seed1");
    expect(d.matchedRuleId).toBeNull();
  });

  it("a `promoted` INBOX rule is demotable too (the ruling groups it with seeded)", () => {
    const d = decide(msg(SENDER, bulk), [promotedInbox("promo1")], KNOWN, "people_only");
    expect(d.destination).toBe("ohmail/News");
    expect(d.source).toBe("policy");
    expect(d.overriddenRuleId).toBe("promo1");
  });

  it("a money-subject bulk message from a seeded sender demotes to Receipts, not Reads", () => {
    const d = decide(
      msg(SENDER, { headers: { "list-id": ["<x>"] }, subject: "Your statement is ready" }),
      [seededInbox()], KNOWN, "people_only",
    );
    expect(d.destination).toBe("ohmail/Receipts");
    expect(d.source).toBe("policy");
  });

  it("DAY-ONE PARITY: the SAME seeded rule + bulk message under people_and_replied stays INBOX by rule", () => {
    const d = decide(msg(SENDER, bulk), [seededInbox("seed1")], KNOWN, "people_and_replied");
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "seed1", source: "rule" });
  });

  /**
   * MANUAL IS ABSOLUTE. A rule the user AUTHORED (`provenance: "manual"`) is never demoted, even by
   * a maximally-bulk message under people_only — that is what "user always wins" governs.
   *
   * MUTATION: widen `DEMOTABLE_PROVENANCE` to include "manual" and this goes red.
   */
  it("a MANUAL INBOX rule + maximally-bulk message + people_only ⇒ INBOX, matchedRuleId = the manual rule", () => {
    const manual = rule({
      id: "mine", kind: "sender", match: SENDER, destination: "INBOX", provenance: "manual",
    });
    const maxBulk = {
      headers: {
        "list-id": ["<x>"], "feedback-id": ["a:b:c"], "list-unsubscribe": ["<https://u.example>"],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"], precedence: ["bulk"],
      },
    };
    const d = decide(msg("notifications@vendor.example", maxBulk),
      [{ ...manual, match: "notifications@vendor.example" }], new Set(["notifications@vendor.example"]), "people_only");
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "mine", source: "rule" });
  });

  it("a MIGRATED INBOX rule is exempt (user authored it elsewhere)", () => {
    const migrated = rule({ id: "mig", kind: "sender", match: SENDER, destination: "INBOX", provenance: "migrated" });
    const d = decide(msg(SENDER, bulk), [migrated], KNOWN, "people_only");
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "mig", source: "rule" });
  });

  /**
   * ALLOWLIST, NEVER NEGATION. `provenance` is an unvalidated `text` cast, so a value outside the
   * union is representable. An allowlist makes that garbage EXEMPT (fails toward the user's rule);
   * a `!== "manual"` negation would make it DEMOTABLE. This pins the safe direction.
   *
   * MUTATION: change `DEMOTABLE_PROVENANCE.has(...)` to `winner.provenance !== "manual"` → red.
   */
  it("an UNKNOWN provenance is NOT demotable — the rule's INBOX stands", () => {
    const weird = { ...seededInbox("weird"), provenance: "not-a-real-value" as Rule["provenance"] };
    const d = decide(msg(SENDER, bulk), [weird], KNOWN, "people_only");
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "weird", source: "rule" });
  });

  it("a PERSONAL (non-automated) message from a seeded sender is NOT demoted", () => {
    const d = decide(msg(SENDER, { subject: "lunch on friday?" }), [seededInbox("seed1")], KNOWN, "people_only");
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "seed1", source: "rule" });
  });

  it("a seeded rule that already names Reads is NOT reshuffled (destination !== INBOX)", () => {
    const seededReads = rule({ id: "sr", kind: "sender", match: SENDER, destination: "ohmail/News", provenance: "seeded-from-sent" });
    const d = decide(msg(SENDER, bulk), [seededReads], KNOWN, "people_only");
    expect(d).toEqual({ destination: "ohmail/News", matchedRuleId: "sr", source: "rule" });
  });

  /**
   * DEMOTION OUTPUT ∈ {Reads, Receipts} ONLY — never the Screener, never Quarantine, never a
   * promotion. `policyDemotion` delegates to `headerHeuristic`, which returns only those two.
   *
   * MUTATION: make `policyDemotion` return the Screener and this goes red.
   */
  it("a policy demotion is only ever to Reads or Receipts", () => {
    for (const subj of ["a newsletter", "Your receipt", "invoice #99", "hello"]) {
      const d = decide(msg(SENDER, { ...bulk, subject: subj }), [seededInbox()], KNOWN, "people_only");
      if (d.source === "policy") {
        expect(["ohmail/News", "ohmail/Receipts"]).toContain(d.destination);
      }
    }
  });

  it("people_only NEVER weakens a DENY rule — a deny rule keeps its own destination", () => {
    const deny = rule({ id: "no", kind: "sender", match: SENDER, destination: "ohmail/Screened", provenance: "promoted" });
    const d = decide(msg(SENDER, bulk), [deny], KNOWN, "people_only");
    expect(d).toEqual({ destination: "ohmail/Screened", matchedRuleId: "no", source: "rule" });
  });

  it("auth=fail still screens under people_only, BEFORE any demotion (a demotion is not a screen)", () => {
    const d = evaluateRules({
      msg: msg(SENDER, bulk), rules: [seededInbox()], ownAddresses: new Set<string>(), knownSenders: { addresses: KNOWN, inferred: new Set<string>(), lists: new Map() },
      auth: "fail", ohboxPolicy: "people_only", identity: null,
    });
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.source).toBe("screener");
  });
});

/**
 * A COLD LETTER THAT LOOKS LIKE A NEWSLETTER (owner report 2026-11-02): every header below is the
 * sender's to write, and a mailing service puts the one-click pair on cold outreach too. Nothing in
 * them lets a stranger in: an author nobody chose waits at the Screener; the same letter from a
 * person's contact is filed to News, as before.
 */
describe("a cold letter with every bulk header the sender can write", () => {
  const COLD = {
    "list-unsubscribe": ["<https://hire-outreach.example/u/1>, <mailto:unsub@hire-outreach.example>"],
    "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
    "feedback-id": ["1:campaign:hire-outreach"],
    "list-id": ["<talent.hire-outreach.example>"],
  };
  const cold = msg("talent@hire-outreach.example", { headers: COLD, subject: "Quick question about your next role" });

  it("waits at the Screener when nobody chose its author", () => {
    expect(decide(cold)).toMatchObject({ destination: "ohmail/Screener", source: "screener" });
  });

  it("is filed to News from a person's contact (the control)", () => {
    expect(decide(cold, [], new Set(["talent@hire-outreach.example"])))
      .toMatchObject({ destination: "ohmail/News", source: "header" });
  });
});

/* ══ THE IDENTITY FACT AT THE GATE (mail 0148) — acceptance 1-4 of the impersonation ruling ══
   The fact comes from the real function over the real message, so each case is the fact and the
   gate together; a pass hands the gate the stored column instead (`identityOfRow`). */
describe("the identity fact holds what only inference admitted", () => {
  const named = (name: string | null, from: string, o: MsgOpts = {}): NormalizedMessage => ({
    ...msg(from, o), from: { name, address: from },
  });
  const gate = (m: NormalizedMessage, o: {
    rules?: Rule[]; person?: string[]; inferred?: string[]; own?: string[]; auth?: AuthVerdict;
    policy?: OhboxPolicy;
  } = {}) => evaluateRules({
    msg: m, rules: o.rules ?? [],
    knownSenders: {
      addresses: new Set([...(o.person ?? []), ...(o.inferred ?? [])]), inferred: new Set(o.inferred ?? []), lists: new Map(),
    },
    auth: o.auth ?? UNAUTHENTICATED, ohboxPolicy: o.policy ?? "people_and_replied",
    ownAddresses: new Set(o.own ?? []),
    identity: claimedIdentity({ fromName: m.from.name, fromAddress: m.from.address, subject: m.subject }) ?? null,
  });
  const gmailInbox = rule({ id: "gmail", kind: "domain", match: "gmail.com", destination: "INBOX" });

  it("1: a domain rule admits nobody whose name claims a brand from another address", () => {
    const d = gate(named("PostFinance", PHISHER, {
      subject: "Bitte bestätigen: Reaktivierung Ihrer PostFinance Karte erforderlich",
    }), { rules: [gmailInbox] });
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.source).toBe("screener");
    expect(d.matchedRuleId).toBeNull();
    expect(d.identity?.brand).toBe("PostFinance");
  });

  it("1 CONTROL: a person at their own domain rule is admitted and carries no fact", () => {
    const d = gate(named("Anna Brunner", "anna@firma.example"), {
      rules: [rule({ id: "firma", kind: "domain", match: "firma.example", destination: "INBOX" })],
    });
    expect(d).toEqual({ destination: "INBOX", matchedRuleId: "firma", source: "rule" });
  });

  it("1 (a firm's domain): an allow rule on a domain that is no shared provider's admits no brand claim from it", () => {
    const d = gate(named("PostFinance", "info@kundendienst-portal.example"), {
      rules: [rule({ id: "portal", kind: "domain", match: "kundendienst-portal.example", destination: "INBOX" })],
    });
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.source).toBe("screener");
    expect(d.identity?.brand).toBe("PostFinance");
  });

  it("2 (a firm's domain): the hold sits above the people_only demotion where the rule does win", () => {
    const promoted = rule({ id: "p2", kind: "domain", match: "news-versand.example", destination: "INBOX", provenance: "promoted" });
    const bulk = { headers: { "list-unsubscribe": ["<mailto:u@news-versand.example>"], "list-id": ["<x.news-versand.example>"] } };
    const d = gate(named("PostFinance", "info@news-versand.example", bulk), { rules: [promoted], policy: "people_only" });
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.identity?.brand).toBe("PostFinance");
    // CONTROL: the same bulk mail with no claim is demoted, so the order is what the case measures.
    expect(gate(named("Versand", "info@news-versand.example", bulk), { rules: [promoted], policy: "people_only" }).source).toBe("policy");
  });

  it("2: the hold sits above the people_only demotion — a bulk-shaped phish is held, not filed to News", () => {
    const promoted = rule({ id: "p", kind: "domain", match: "gmail.com", destination: "INBOX", provenance: "promoted" });
    const d = gate(named("PostFinance", STRANGER, {
      headers: { "list-unsubscribe": [`<mailto:${personalAt("fixture.lena", GMAIL)}>`], "list-id": ["<x.gmail.com>"] },
    }), { rules: [promoted], policy: "people_only" });
    expect(d.destination).toBe("ohmail/Screener");
    expect(d.identity?.brand).toBe("PostFinance");
  });

  it("3: a person's contact is address-level consent; an inferred one is not", () => {
    const m = named("PostFinance Beratung", "berater@vermoegensberatung.example");
    const rules = [rule({ id: "vb", kind: "domain", match: "vermoegensberatung.example", destination: "INBOX" })];
    const person = gate(m, { rules, person: ["berater@vermoegensberatung.example"] });
    expect(person.destination).toBe("INBOX");
    expect(person.identity?.brand).toBe("PostFinance");
    const inferred = gate(m, { rules, inferred: ["berater@vermoegensberatung.example"] });
    expect(inferred.destination).toBe("ohmail/Screener");
    expect(inferred.identity?.brand).toBe("PostFinance");
  });

  it("3: a person's sender rule admits the claim, which rides along", () => {
    const d = gate(named("PostFinance", PHISHER), {
      rules: [gmailInbox, rule({ id: "s", kind: "sender", match: PHISHER, destination: "INBOX" })],
    });
    expect(d).toEqual({
      destination: "INBOX", matchedRuleId: "s", source: "rule", identity: { brand: "PostFinance", via: "name" },
    });
  });

  it("3 (narrowed): a promoted sender rule — the act's or learning's — is no consent; a person-written one is", () => {
    const who = "kundendienst@karten-service.test";
    const m = named("PostFinance", who);
    const promoted = rule({ id: "act", kind: "sender", match: who, destination: "INBOX", provenance: "promoted" });
    // The act admitted a benign first mail: its promoted rule and its inferred contact stand.
    const held = gate(m, { rules: [promoted], inferred: [who] });
    expect(held).toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener", identity: { brand: "PostFinance", via: "name" } });
    // CONTROLS: every rule a person wrote admits, the claim riding along.
    for (const provenance of ["manual", "migrated", "seeded-from-sent"] as const) {
      const d = gate(m, { rules: [{ ...promoted, provenance }] });
      expect(d.destination, provenance).toBe("INBOX");
      expect(d.identity?.brand, provenance).toBe("PostFinance");
    }
    // A person's own Screener press consents through the person contact it writes.
    expect(gate(m, { rules: [promoted], person: [who] }).destination).toBe("INBOX");
  });

  it("3: an inferred contact alone (no rule) is held as well; a person's contact admits", () => {
    const at = personalAt("fixture.alerts", GMAIL);
    const m = named("UBS Sicherheit", at);
    expect(gate(m, { inferred: [at] }).destination).toBe("ohmail/Screener");
    expect(gate(m, { person: [at] }).source).toBe("unclear");
  });

  it("4: your own mail claiming a brand keeps its place with the fact; a forged own From that fails is held", () => {
    // REVIEW-02518 HIGH-1, ruled 2026-10-08: the fact never holds own mail that passed authentication.
    const fact = { brand: "PostFinance", via: "name" };
    expect(gate(named("PostFinance", "me@mydomain.example"), { own: ["me@mydomain.example"], auth: "unavailable" }))
      .toEqual({ destination: null, matchedRuleId: null, source: "own", identity: fact });
    // A contacts row for your own address takes the known-author path, in place, the fact riding.
    const known = gate(named("PostFinance", "me@mydomain.example"), {
      own: ["me@mydomain.example"], person: ["me@mydomain.example"], auth: "unavailable",
    });
    expect([known.destination, known.identity]).toEqual([null, fact]);
    expect(gate(named("PostFinance", "me@mydomain.example"), { own: ["me@mydomain.example"], auth: "fail" }))
      .toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener", identity: fact });
    expect(gate(named("Mila", "me@mydomain.example"), { own: ["me@mydomain.example"], auth: "unavailable" }))
      .toEqual({ destination: null, matchedRuleId: null, source: "own" });
  });

  it("a denial stands above the fact, and a failed authentication screens without it", () => {
    const deny = gate(named("PostFinance", STRANGER), {
      rules: [rule({ id: "q", kind: "sender", match: STRANGER, destination: "ohmail/Quarantine" })],
    });
    expect(deny).toEqual({ destination: "ohmail/Quarantine", matchedRuleId: "q", source: "rule" });
    // On a firm's domain, where the allow rule does win: an allow rule at gmail.com admits nobody.
    const portal = rule({ id: "portal", kind: "domain", match: "kundendienst-portal.example", destination: "INBOX" });
    const fail = gate(named("PostFinance", "x@kundendienst-portal.example"), { rules: [portal], auth: "fail" });
    expect(fail).toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener" });
  });

  it("a standing allow (a narrowed rule naming the domain) does not admit the claim", () => {
    const narrowed = rule({
      id: "n", kind: "domain", match: "kundendienst-portal.example", destination: "INBOX", subjectContains: "rechnung",
    });
    expect(gate(named("PostFinance", "x@kundendienst-portal.example"), { rules: [narrowed] }).destination).toBe("ohmail/Screener");
    expect(gate(named("Hans", "x@kundendienst-portal.example"), { rules: [narrowed] }).source).toBe("unclear");
  });
});

/* ══ A COMPANY'S OWN ADDRESS NOTHING CONFIRMED (mail 0176) — the hold beside the identity fact ══
   The flag is computed as the ingest computes it (`ownedBrand` and the verdict after the signature
   check), so each case is the arrival door's fact and the gate together. */
describe("a company's own address nothing confirmed is held where only inference admitted it", () => {
  const BRAND = "service@paypal.com";
  const PLAIN = "anna@firma.example";
  const gate = (from: string, o: {
    rules?: Rule[]; person?: string[]; inferred?: string[]; own?: string[]; auth?: AuthVerdict;
    lists?: string[]; arrival?: boolean;
  } = {}) => {
    const auth = o.auth ?? "unavailable";
    return evaluateRules({
      msg: msg(from), rules: o.rules ?? [],
      knownSenders: {
        addresses: new Set([...(o.person ?? []), ...(o.inferred ?? [])]), inferred: new Set(o.inferred ?? []),
        lists: new Map((o.lists ?? []).map((a) => [a, new Set<string>()])),
      },
      auth, ohboxPolicy: "people_and_replied", ownAddresses: new Set(o.own ?? []), identity: null,
      ...(o.arrival === false ? {} : { ownedUnconfirmed: ownedBrand(from) !== undefined && auth !== "pass" }),
    });
  };
  const HELD = { destination: "ohmail/Screener", matchedRuleId: null, source: "screener", unconfirmed: true };
  const actRule = (match: string) => rule({ id: "act", kind: "sender", match, destination: "INBOX", provenance: "promoted" });
  const domainRule = (match: string) => rule({ id: "dom", kind: "domain", match, destination: "INBOX" });

  it("every inference is held at a company's own address unless it is confirmed", () => {
    const inferences: Array<[string, Parameters<typeof gate>[1]]> = [
      ["the act's rule and its inferred contact", { rules: [actRule(BRAND)], inferred: [BRAND] }],
      ["an inferred contact alone", { inferred: [BRAND] }],
      ["a promoted domain rule no person decided (the act's, the AI's, a press before mail 0128)",
        { rules: [{ ...domainRule("paypal.com"), provenance: "promoted" as const }] }],
      ["a narrowed promoted rule that stands for the sender",
        { rules: [{ ...domainRule("paypal.com"), provenance: "promoted" as const, subjectContains: "rechnung" }] }],
      ["nothing: a stranger", {}],
    ];
    for (const [what, o] of inferences) {
      for (const auth of ["unavailable", "unauthenticated"] as const) {
        expect(gate(BRAND, { ...o, auth }), `${what}, ${auth}`).toEqual(HELD);
      }
      // A verdict of pass is confirmed: the inference admits as before, and nothing is marked.
      expect(gate(BRAND, { ...o, auth: "pass" }).unconfirmed, `${what}, pass`).toBeUndefined();
      // An address at no company's domain is no such case, whatever the verdict.
      const plain = gate(PLAIN, { ...o, rules: (o?.rules ?? []).map((r) => ({ ...r, match: r.kind === "domain" ? "firma.example" : PLAIN })),
        inferred: o?.inferred === undefined ? undefined : [PLAIN] });
      expect(plain.unconfirmed, `${what}, plain address`).toBeUndefined();
    }
    expect(gate(BRAND, { rules: [actRule(BRAND)], inferred: [BRAND], auth: "pass" }))
      .toEqual({ destination: "INBOX", matchedRuleId: "act", source: "rule" });
  });

  it("a person's consent at the address is honoured as before", () => {
    // A person-written sender rule, and a person's contact (a press, or the person writing to them).
    for (const provenance of ["manual", "migrated", "seeded-from-sent"] as const) {
      expect(gate(BRAND, { rules: [{ ...actRule(BRAND), provenance }] }), provenance)
        .toEqual({ destination: "INBOX", matchedRuleId: "act", source: "rule" });
    }
    expect(gate(BRAND, { rules: [actRule(BRAND)], person: [BRAND] }))
      .toEqual({ destination: "INBOX", matchedRuleId: "act", source: "rule" });
    expect(gate(BRAND, { person: [BRAND] }).source).toBe("unclear");
    // A list address answers alone, and no brand is claimed for a press there to have consented.
    expect(gate(BRAND, { rules: [{ ...actRule(BRAND), provenance: "manual" }], person: [BRAND], lists: [BRAND] })).toEqual(HELD);
  });

  it("a domain rule a person wrote is consent to this hold, and never to a claim", () => {
    for (const provenance of ["manual", "migrated"] as const) {
      expect(gate(BRAND, { rules: [{ ...domainRule("paypal.com"), provenance }] }), provenance)
        .toEqual({ destination: "INBOX", matchedRuleId: "dom", source: "rule" });
    }
    // The person's own Screener press on the domain, stamped as theirs (`rules.person_decided_at`).
    const pressed = { ...domainRule("paypal.com"), provenance: "promoted" as const, personDecided: true };
    expect(gate(BRAND, { rules: [pressed] })).toEqual({ destination: "INBOX", matchedRuleId: "dom", source: "rule" });
    expect(gate(BRAND, { rules: [{ ...pressed, personDecided: false }] })).toEqual(HELD);
    // Narrowed, it still stands for the sender: admitted past the gate, placed by nothing.
    expect(gate(BRAND, { rules: [{ ...domainRule("paypal.com"), subjectContains: "rechnung" }] }).source).toBe("unclear");
    // A list address answers alone, as for an address rule.
    expect(gate(BRAND, { rules: [domainRule("paypal.com")], lists: [BRAND] })).toEqual(HELD);
    // The identity fact never reads it: a company named from that domain still waits, unmarked.
    const claim = evaluateRules({
      msg: { ...msg(BRAND), from: { name: "PostFinance", address: BRAND } }, rules: [domainRule("paypal.com")],
      knownSenders: { addresses: new Set(), inferred: new Set(), lists: new Map() }, auth: "unavailable",
      ohboxPolicy: "people_and_replied", ownAddresses: new Set(), identity: { brand: "PostFinance", via: "name" },
      ownedUnconfirmed: true,
    });
    expect(claim).toEqual({
      destination: "ohmail/Screener", matchedRuleId: null, source: "screener", identity: { brand: "PostFinance", via: "name" },
    });
  });

  it("re-evaluation passes never pass the fact, so a walk decides as before", () => {
    expect(gate(BRAND, { rules: [actRule(BRAND)], inferred: [BRAND], arrival: false }))
      .toEqual({ destination: "INBOX", matchedRuleId: "act", source: "rule" });
  });

  it("every denial and a failed authentication stand above it; own mail is never held", () => {
    const deny = rule({ id: "no", kind: "sender", match: BRAND, destination: "ohmail/Screened" });
    expect(gate(BRAND, { rules: [deny] })).toEqual({ destination: "ohmail/Screened", matchedRuleId: "no", source: "rule" });
    const standingDeny = rule({ id: "sd", kind: "domain", match: "paypal.com", destination: "ohmail/Quarantine", subjectContains: "x" });
    expect(gate(BRAND, { rules: [standingDeny], inferred: [BRAND] }))
      .toEqual({ destination: "ohmail/Quarantine", matchedRuleId: "sd", source: "rule" });
    // `fail` screens, unmarked: the provider's evidence against is its own reason.
    expect(gate(BRAND, { rules: [actRule(BRAND)], inferred: [BRAND], auth: "fail" }))
      .toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener" });
    expect(gate(BRAND, { inferred: [BRAND], auth: "fail" }))
      .toEqual({ destination: "ohmail/Screener", matchedRuleId: null, source: "screener" });
    expect(gate(BRAND, { own: [BRAND] })).toEqual({ destination: null, matchedRuleId: null, source: "own" });
  });
});
