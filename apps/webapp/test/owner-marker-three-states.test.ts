/** @vitest-environment jsdom */
/**
 * ═══ ONE COOKIE, ONE MEANING, THREE SENTENCES ════════════════════════════════════════════
 *
 * `tf_owner` is read by three doors and each asked a different question: the API gate refused an
 * absent marker, the sync gate admitted one, and the storage owner quietly swapped four
 * `localStorage` key spaces to `local`, where a browser's own send records went invisible. Three
 * verdicts is fine; three READINGS is not. One resolver, one enum, each door stating its answer.
 */

/**
 * The other half is the sentence. One boolean answered three states with the rarest one's words,
 * so a person with ONE account was told about a second and nothing named the way out. Three
 * states, three codes, three sentences — and the absent one heals on the next page load, from the
 * session check's answer (`healOwner`, below).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import de from "../messages/de.json";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const A = "acct_A";
const B = "acct_B";

/** The three shapes the marker can be in, written the way a browser holds them. */
const SHAPES = {
  account: `tf_owner=${A}`,
  "signed-out": "tf_owner=signed_out_pending",
  absent: null,
} as const;

function setJar(shape: keyof typeof SHAPES): void {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  const line = SHAPES[shape];
  if (line !== null) document.cookie = `${line}; Path=/`;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  setJar("absent");
  const { resetStorageOwnerForTest } = await import("@ohmail/app-logic/storage/storage-owner");
  resetStorageOwnerForTest();
  originalFetch = globalThis.fetch;
  // A server that answers everything. Any request reaching it is a request the gate LET THROUGH,
  // which is what makes "the call never went out" an assertion rather than a coincidence.
  globalThis.fetch = vi.fn(async () => new Response("{}", {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(null);
  setJar("absent");
  vi.restoreAllMocks();
});

describe("the refusal names the state it is in", () => {
  it("ABSENT: a browser that cannot name any account is told so, and how to get it back", async () => {
    const { api, bindApiOwner, ApiError } = await import("../app/api-client.js");
    bindApiOwner(A);
    setJar("absent");

    const err = await api("/mailboxes").then(() => null, (e: unknown) => e as InstanceType<typeof ApiError>);
    expect(err, "a bound client with no marker made the request").not.toBeNull();
    expect(err!.code).toBe("owner_absent");
    expect(err!.message).toContain("lost the name of the account");
    // The one thing the old sentence got wrong, and the reason this row is HIGH: nobody with one
    // account is signed in to a different one.
    expect(err!.message).not.toContain("different account");
    // Reloading is the recovery, and it is named rather than left to be guessed.
    expect(err!.message.toLowerCase()).toContain("reload");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("SIGN-OUT PENDING: a sign-out the server did not confirm says that, not 'another account'", async () => {
    const { api, bindApiOwner, ApiError } = await import("../app/api-client.js");
    bindApiOwner(A);
    setJar("signed-out");

    const err = await api("/mailboxes").then(() => null, (e: unknown) => e as InstanceType<typeof ApiError>);
    expect(err!.code).toBe("owner_signed_out");
    expect(err!.message).toContain("sign-out");
    expect(err!.message).not.toContain("different account");
  });

  it("MISMATCH: a marker naming somebody else keeps the sentence it always had", async () => {
    const { api, bindApiOwner, ApiError } = await import("../app/api-client.js");
    bindApiOwner(B);
    setJar("account");

    const err = await api("/mailboxes").then(() => null, (e: unknown) => e as InstanceType<typeof ApiError>);
    expect(err!.code).toBe("owner_mismatch");
    expect(err!.message).toContain("different account");
  });

  it("A BLOCKED client — a failed sign-out — is the sign-out state, not the mismatch one", async () => {
    const { api, bindApiOwner, blockApiOwner, ApiError } = await import("../app/api-client.js");
    bindApiOwner(A);
    setJar("account");
    blockApiOwner();

    const err = await api("/mailboxes").then(() => null, (e: unknown) => e as InstanceType<typeof ApiError>);
    expect(err!.code).toBe("owner_signed_out");
  });

  it("THE CONTROL: a bound client whose marker agrees makes the request", async () => {
    const { api, bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    setJar("account");
    await expect(api("/mailboxes")).resolves.toBeDefined();
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("THE FRONT DOOR still goes out, which is what makes the recovery reachable", async () => {
    // `GET /auth/session` names the account an absent marker is healed from, so a browser in the
    // `absent` state must be able to reach it while every other call refuses. It can: the front
    // door's call carries `ceremony: true` (`(product)/session-outcome.ts`), which is the first
    // arm of the verdict. Without this the recovery is a route nobody in that state can ask for.
    const { api, apiOwnerVerdict, bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    setJar("absent");

    expect(apiOwnerVerdict("/auth/session")).toBe("absent");
    expect(apiOwnerVerdict("/auth/session", { ceremony: true })).toBe("holds");
    await expect(api("/auth/session", { ceremony: true })).resolves.toBeDefined();
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("THE HEAL writes the pending word's line with the id, and only into a silent jar", async () => {
    const { healOwner, markSignedOutPending, readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
    let pending = "";
    markSignedOutPending((c) => { pending = c; });
    const lines: string[] = [];
    expect(healOwner(A, (c) => lines.push(c))).toBe(true);
    expect(lines).toEqual([pending.replace("=signed_out_pending;", `=${A};`)]);
    expect(healOwner(A)).toBe(true);
    expect(readOwnerMarker()).toEqual({ kind: "account", id: A });
    // Never over the reserved word, never over another account, never a value no id can be.
    for (const [shape, id] of [["signed-out", A], ["account", B], ["absent", "not an id"]] as const) {
      setJar(shape);
      expect(healOwner(id, (c) => lines.push(c)), `the heal wrote over a ${shape} jar`).toBe(false);
    }
    expect(lines).toHaveLength(1);
  });

  it("A SIGN-IN'S NAME is written with the pending word's ninety days, and never over the server's cookie naming it", async () => {
    const { markSignedOutPending, rememberOwner } = await import("@ohmail/app-logic/storage/owner-cookie");
    let pending = "";
    markSignedOutPending((c) => { pending = c; });
    const lines: string[] = [];
    rememberOwner(B, (c) => lines.push(c));
    expect(lines, "a session cookie: a browser closed without restore forgets the name").toEqual([pending.replace("=signed_out_pending;", `=${B};`)]);
    setJar("account");
    rememberOwner(A, (c) => lines.push(c));
    expect(lines, "the sign-in's own ninety-day cookie was rewritten by script").toHaveLength(1);
    rememberOwner(B, (c) => lines.push(c));
    expect(lines.at(-1), "another account's sign-in left the previous name").toBe(lines[0]);
  });

  it("THE WORD is written over a name or silence, and never again over itself: the edge's copy outlives Safari's cap", async () => {
    const { markSignedOutPending } = await import("@ohmail/app-logic/storage/owner-cookie");
    const writes = (shape: keyof typeof SHAPES): number => {
      setJar(shape);
      let n = 0;
      markSignedOutPending(() => { n += 1; });
      return n;
    };
    expect({ account: writes("account"), absent: writes("absent"), "signed-out": writes("signed-out") })
      .toEqual({ account: 1, absent: 1, "signed-out": 0 });
  });

  it("the three codes are distinct — a surface that classifies one can tell them apart", async () => {
    const { ownerRefusalCodes } = await import("../app/api-client.js");
    const codes = ownerRefusalCodes();
    expect(codes).toHaveLength(3);
    expect(new Set(codes).size).toBe(3);
  });
});

describe("ONE resolver: the three doors read the same enum", () => {
  /**
   * Each row is one marker shape and what every door makes of it. The doors DISAGREE on policy
   * and must — the API gate asks "may I speak for this account", the sync gate asks "may this
   * mirror still be trusted", the storage owner asks "whose scratch space is this" — but they
   * read ONE value, through `readOwnerMarker`, and this table is what goes red when a second
   * reading appears.
   */
  const TABLE = [
    {
      shape: "account" as const,
      verdict: "holds",
      // `unconfirmed`, not `holds`: the marker naming this mirror is necessary and not
      // sufficient — the server's own confirm opens the gate.
      identity: "unconfirmed",
      storage: { owner: A, source: "cookie" },
      lockKey: `ohmail.send.locks.${A}`,
    },
    {
      shape: "signed-out" as const,
      verdict: "signed-out",
      identity: "contradicted",
      storage: { owner: null, source: "unowned" },
      lockKey: "ohmail.send.locks.local",
    },
    {
      shape: "absent" as const,
      verdict: "absent",
      identity: "unconfirmed",
      storage: { owner: null, source: "unowned" },
      lockKey: "ohmail.send.locks.local",
    },
  ];

  for (const row of TABLE) {
    it(`a ${row.shape} marker: gate ${row.verdict} · sync ${row.identity} · storage ${row.storage.source}`, async () => {
      const { apiOwnerVerdict, bindApiOwner } = await import("../app/api-client.js");
      const { createSyncGate } = await import("@ohmail/app-logic/session/sync-scheduler");
      const { storageOwnerState, resetStorageOwnerForTest } = await import("@ohmail/app-logic/storage/storage-owner");
      const { sendLocksKey } = await import("../app/shell/send-lock.js");
      const { readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");

      resetStorageOwnerForTest();
      bindApiOwner(A);
      setJar(row.shape);

      // The one reader, first — every assertion below is a claim about what a door does with THIS.
      expect(readOwnerMarker().kind).toBe(row.shape);
      expect(apiOwnerVerdict("/mailboxes")).toBe(row.verdict);
      expect(createSyncGate(A).identity()).toBe(row.identity);
      const state = storageOwnerState();
      expect({ owner: state.owner, source: state.source }).toEqual(row.storage);
      // NAMED rather than inferred: `unowned` used to be indistinguishable from "this surface
      // has no account", which is how a signed-in window's send records went missing.
      expect(state.marker).toBe(row.shape);
      // The KEY BYTES do not move — records already written under either suffix stay findable.
      expect(sendLocksKey()).toBe(row.lockKey);
    });
  }

  it("`readOwner` is a projection of the marker, never a second parse of the cookie", async () => {
    const { readOwner, readOwnerMarker } = await import("@ohmail/app-logic/storage/owner-cookie");
    // Including the two values a second parse gets wrong on its own: the reserved word, and a
    // value outside the id shape.
    for (const jar of [`tf_owner=${A}`, "tf_owner=signed_out_pending", "tf_owner=not a id", ""]) {
      const marker = readOwnerMarker(jar);
      expect(readOwner(jar)).toBe(marker.kind === "account" ? marker.id : null);
    }
  });

  it("the unowned fallback is SAID, once per state, and not on every read", async () => {
    const { storageOwnerState, resetStorageOwnerForTest } = await import("@ohmail/app-logic/storage/storage-owner");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetStorageOwnerForTest();
    setJar("absent");

    storageOwnerState();
    storageOwnerState();
    storageOwnerState();
    expect(warn, "a render-path read became a log flood").toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("no owner");

    // A DIFFERENT unowned state is a different fact and says itself.
    setJar("signed-out");
    storageOwnerState();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("a sentence rendered as the server's is the server's", () => {
  it("a CODED server refusal lends its words", async () => {
    const { ApiError } = await import("../app/api-client.js");
    const { clientRefusalKey, disarmsAutoSuggest } = await import("../app/shell/screener-suggest.js");
    const err = new ApiError(409, "ai_disabled", "managed AI is switched off", undefined, { coded: true });
    expect(clientRefusalKey(err)).toBeNull();
    expect(disarmsAutoSuggest(err)).toBe(true);
  });

  it("an UNCODED client refusal gets this client's own key, one per owner state", async () => {
    const { ApiError } = await import("../app/api-client.js");
    const { clientRefusalKey } = await import("../app/shell/screener-suggest.js");
    const pairs = [
      ["owner_absent", "suggest.refusedOwnerAbsent"],
      ["owner_signed_out", "suggest.refusedOwnerSignedOut"],
      ["owner_mismatch", "suggest.refusedOwnerMismatch"],
      ["network_unreachable", "suggest.refusedOffline"],
      ["passkey_cancelled", "suggest.refusedHere"],
    ] as const;
    for (const [code, key] of pairs) {
      expect(clientRefusalKey(new ApiError(0, code, "raw english", undefined, { coded: false }))).toBe(key);
    }
    // Distinct sentences, not one key wearing five names.
    expect(new Set(pairs.map(([, k]) => k)).size).toBe(5);
  });

  it("a client refusal does not disarm the automatic pass; a non-ApiError still does", async () => {
    const { ApiError } = await import("../app/api-client.js");
    const { disarmsAutoSuggest } = await import("../app/shell/screener-suggest.js");
    expect(disarmsAutoSuggest(new ApiError(0, "owner_absent", "x", undefined, { coded: false }))).toBe(false);
    // The desktop bridge throws its own class off a real wire — unchanged.
    expect(disarmsAutoSuggest(new Error("bridge said no"))).toBe(true);
  });

  it("every key this client can choose exists in BOTH catalogues", () => {
    const keys = [
      "refusedOwnerAbsent", "refusedOwnerSignedOut", "refusedOwnerMismatch",
      "refusedOffline", "refusedHere",
    ];
    for (const k of keys) {
      expect((en.screener.suggest as Record<string, string>)[k], `en is missing ${k}`).toBeTruthy();
      expect((de.screener.suggest as Record<string, string>)[k], `de is missing ${k}`).toBeTruthy();
      expect((de.screener.suggest as Record<string, string>)[k])
        .not.toBe((en.screener.suggest as Record<string, string>)[k]);
    }
  });
});
