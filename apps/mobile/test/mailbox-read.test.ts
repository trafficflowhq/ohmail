import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { Copy } from "../src/copy";
import { phoneOrganizer, SCREENING_UNSUPPLIED, type WorldActions } from "../src/state/live";
import { leaveFilings, readFilings, readMailboxes, retryFilings, type PhoneMailbox } from "../src/net/mailboxes";
import { createProjector, type ProjectionInputs } from "../src/state/world-projection";

/**
 * ═══ THE PHONE READS THE MAILBOX IT IS SHOWING ═══════════════════════════════════════════════
 *
 * ── THE GAP, IN THE CODE'S OWN WORDS ────────────────────────────────────────────────────────
 *
 * `apps/mobile/src/state/live.ts` said it twice. `canReplyAll` carried *"The phone holds no
 * `GET /mailboxes` facts, so the reader cannot be told apart"*, and `NO_OWN_ADDRESSES` carried
 * *"this client has no mailbox read yet … the day a mailbox read lands there is one place to
 * feed it"*. A third surface was never built for the same reason: the onboarding deck has shipped
 * `phoneBanner` and `phoneBannerWhy` with NO consumer, because a banner naming who organizes the
 * mailbox would have been a claim with no source.
 *
 * ── WHAT IS DRIVEN HERE, AND WHAT IS NOT ────────────────────────────────────────────────────
 *
 * The wire reader and the banner derivation are pure and are driven directly — the `live.ts`
 * charter keeps logic out of screens for exactly this reason. The world layer's CADENCE (boot +
 * after every completed drain, session-gated) is asserted over its source, because it is a
 * property of an effect graph that a node suite cannot mount; those assertions name the shape
 * they require rather than claiming to have run it.
 *
 * Mutation-checked, each watched red and restored:
 *  · drop the `distinct.size !== 1` guard      → the two-holders case;
 *  · read `organizedBy` as a truthy object     → the object-of-nulls case;
 *  · return `[]` instead of `null` on a non-200 → the could-not-ask case;
 *  · `every` → `some` on the stopped fold      → the mixed-state case.
 */

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(at(p), "utf8");
const en = JSON.parse(read("../../webapp/messages/en.json")) as Record<string, Record<string, string>>;

const box = (o: Partial<Parameters<typeof phoneOrganizer>[0][number]> = {}) => ({
  organizedBy: null,
  organizerState: null as "held" | "stopped" | null,
  ...o,
});

describe("phoneOrganizer — the banner's one fact, or silence", () => {
  it("names the holder when the server names exactly one", () => {
    const o = phoneOrganizer([box({ organizedBy: { kind: "local", name: "Andreas's laptop" } })]);
    expect(o).toEqual({ name: "Andreas's laptop", kind: "local", stopped: false });
  });

  it("is SILENT when nobody is named — the answering server organizes it, and has no name here", () => {
    // `MailboxDTO.organizedBy` is null when the answering install organizes it, and null when
    // nobody ever has. Neither is a machine name, and the account header above the banner
    // already says which server this phone is paired with.
    expect(phoneOrganizer([box(), box()])).toBeNull();
  });

  it("is SILENT for an object of nulls — the DTO's own guarantee, tested as the webapp tests it", () => {
    // A server that starts sending `{kind:null,name:null}` must not put a banner over a mailbox
    // with no holder. `deriveOnboardingStep` tests `kind || name` rather than the object for
    // this exact reason; the phone does the same, one client further out.
    expect(phoneOrganizer([box({ organizedBy: { kind: null, name: null } })])).toBeNull();
  });

  it("is SILENT when two DIFFERENT holders organize the account's mailboxes", () => {
    // The copy has one `{name}` and naming either is false about the other.
    expect(phoneOrganizer([
      box({ organizedBy: { kind: "local", name: "the laptop" } }),
      box({ organizedBy: { kind: "cloud", name: "ohmail Cloud" } }),
    ])).toBeNull();
  });

  it("…but ONE holder across several mailboxes is still one holder", () => {
    const o = phoneOrganizer([
      box({ organizedBy: { kind: "cloud", name: "ohmail Cloud" } }),
      box({ organizedBy: { kind: "cloud", name: "ohmail Cloud" } }),
    ]);
    expect(o?.name).toBe("ohmail Cloud");
  });

  it("reports STOPPED only when every row says so — the alarming sentence needs the whole answer", () => {
    const all = phoneOrganizer([
      box({ organizedBy: { kind: "local", name: "the laptop" }, organizerState: "stopped" }),
      box({ organizedBy: { kind: "local", name: "the laptop" }, organizerState: "stopped" }),
    ]);
    expect(all?.stopped).toBe(true);
    const mixed = phoneOrganizer([
      box({ organizedBy: { kind: "local", name: "the laptop" }, organizerState: "stopped" }),
      box({ organizedBy: { kind: "local", name: "the laptop" }, organizerState: "held" }),
    ]);
    expect(mixed?.stopped, "a claim still being renewed was reported as stopped").toBe(false);
  });
});

/**
 * A REMOVED MAILBOX IS NO CARD AND NO HOLDER. `GET /mailboxes` keeps a `disabled` row per removal,
 * with the role and the holder it last had; the world hands the screens the live rows, and the raw
 * roster only where a message on a removed mailbox is named.
 */
describe("the world's mailboxes over removed copies", () => {
  const phoneBox = (id: string, address: string, o: Partial<PhoneMailbox> = {}): PhoneMailbox => ({
    id, address, status: "connected", organizerRole: "organizer", organizedByThisInstall: false,
    organizedBy: null, organizerState: null, organizeConsentedAt: null, junkFolder: null, sentFolder: null,
    smtpMaxSizeBytes: null, firstSyncStopFolder: null, ...o,
  } as PhoneMailbox);
  const gone = (id: string, address: string) => phoneBox(id, address, {
    status: "disabled", organizedBy: { kind: "local", name: "Old laptop" }, organizerState: "held",
  });
  const project = async (mailboxes: PhoneMailbox[]) => {
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({ store, storePolicy: { mode: "full" }, adapter: {} as never });
    return createProjector().project({
      engine, worldKey: "rig", standalone: false, bearer: null, images: "direct" as never,
      zone: "UTC", locale: "en", now: new Date(), foldersOn: false, foldersPending: false, foldersStorable: true,
      signatures: null, resurfaceTime: null, screenerServer: null, relayed: null, mailboxes, mailboxesReadAt: () => null,
      walker: null, searchWalker: null, openOffMirror: () => undefined,
      scopes: {}, leavingWaiting: [], heldDeletes: new Set<string>(), heldPlaces: new Map(),
      ownAddresses: [], posture: SCREENING_UNSUPPLIED,
      actions: {} as WorldActions, onPresented: () => undefined, account: () => ({ name: "rig", email: "" }),
      setFoldersEnabled: async () => true, folderSummary: async () => null, rememberResurfaceTime: () => undefined,
    } as unknown as ProjectionInputs).mailboxes;
  };
  const A = phoneBox("mb-a", "a@x.invalid");
  const B = phoneBox("mb-b", "b@x.invalid");

  it("one live mailbox beside its removed copies is one row, and no removed copy's holder heads the banner", async () => {
    const w = await project([gone("mb-a-1", A.address), gone("mb-a-2", A.address), A]);
    expect(w.rows.map((r) => r.id)).toEqual([A.id]);
    expect(w.organizer, "a removed copy's old holder named the banner").toBeNull();
    expect(w.all.map((r) => r.id)).toEqual(["mb-a-1", "mb-a-2", A.id]);
  });

  it("CONTROL — two live mailboxes are two rows", async () => {
    const w = await project([gone("mb-b-1", B.address), A, B]);
    expect(w.rows.map((r) => r.id)).toEqual([A.id, B.id]);
  });
});

describe("readMailboxes — the wire, and what it refuses to guess", () => {
  const session = (res: Partial<Response> | Error) => ({
    profile: { origin: "https://srv.test", accountId: "a" },
    /* `session.fetch` — the SESSION's transport, which is the manager's on a paired door and the
       engine's `handle` on the standalone one. This double is a paired door either way. */
    fetch: vi.fn(async () => {
      if (res instanceof Error) throw res;
      return res as Response;
    }),
  }) as unknown as Parameters<typeof readMailboxes>[0];

  const ok = (body: unknown) => ({ status: 200, json: async () => body });

  /**
   * THE SHAPE THE ROUTE REALLY ANSWERS — `jsonResponse({ items })`
   * (`packages/api/src/routes/mailboxes.ts`, `GET /mailboxes`).
   *
   * Every fixture in this file used to be a bare array, which is what the reader looked for, so the
   * suite and the reader agreed with each other and both were wrong about the wire: the read
   * answered `null` on every door and the two surfaces behind it — Settings' "This phone" panel and
   * the More screen's organizer banner — drew nothing. Read off a device before this line existed.
   */
  const served = (rows: unknown[]) => ({ status: 200, json: async () => ({ items: rows }) });

  it("reads the ENVELOPE the route actually serves — `{ items }`", async () => {
    const out = await readMailboxes(session(served([
      { id: "m1", address: "me@example.test", organizedBy: { kind: "local", name: "laptop" }, organizerState: "held" },
    ])));
    /* `null` here is "could not ask", which is what this read answered for every door until the
       envelope was named — and an empty list would be the OTHER wrong answer, "no mailboxes". */
    expect(out).toEqual([
      /* `status`, `junkFolder` and `firstSyncStopFolder` are the roster's later fields
         (JUNK-INVISIBLE; mail 0115); a wire that names none lands them as `null`, which every
         reader treats as "nothing to say". */
      {
        id: "m1", address: "me@example.test", organizerRole: null,
        // Nobody consented on this wire, and nothing paused it (mail 0135).
        organizeConsentedAt: null, organizerParkedAt: null,
        organizedBy: { kind: "local", name: "laptop" }, organizedByThisInstall: false,
        organizerState: "held", status: null, junkFolder: null, sentFolder: null,
        smtpMaxSizeBytes: null, firstSyncStopFolder: null,
      },
    ]);
  });

  it("still reads a bare array and `{ mailboxes }` — the shapes it already admitted", async () => {
    /* Kept rather than replaced: a client that reports "no mailboxes" the day an envelope gains a
       second name is worse than one that reads three. */
    expect(await readMailboxes(session(ok([{ id: "m1", address: "a@b.test" }])))).toHaveLength(1);
    expect(await readMailboxes(session(ok({ mailboxes: [{ id: "m1", address: "a@b.test" }] })))).toHaveLength(1);
    /* AND AN UNRECOGNISED ENVELOPE IS STILL "could not ask" — the positive control's counterweight. */
    expect(await readMailboxes(session(ok({ rows: [{ id: "m1", address: "a@b.test" }] })))).toBeNull();
  });

  it("reads the rows, keeping the address and the holder", async () => {
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "me@example.test", organizedBy: { kind: "local", name: "laptop" }, organizerState: "held" },
    ])));
    expect(out).toEqual([
      /* `status`, `junkFolder` and `firstSyncStopFolder` are the roster's later fields
         (JUNK-INVISIBLE; mail 0115); a wire that names none lands them as `null`, which every
         reader treats as "nothing to say". */
      {
        id: "m1", address: "me@example.test", organizerRole: null,
        // Nobody consented on this wire, and nothing paused it (mail 0135).
        organizeConsentedAt: null, organizerParkedAt: null,
        organizedBy: { kind: "local", name: "laptop" }, organizedByThisInstall: false,
        organizerState: "held", status: null, junkFolder: null, sentFolder: null,
        smtpMaxSizeBytes: null, firstSyncStopFolder: null,
      },
    ]);
  });

  it("reads the recorded Sent folder as the path, untouched, or `null` (mail 0132)", async () => {
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "a@b.test", sentFolder: "INBOX.Verzonden" },
      { id: "m2", address: "c@d.test", sentFolder: "" },
      { id: "m3", address: "e@f.test", sentFolder: null },
      { id: "m4", address: "g@h.test", sentFolder: 7 },
      { id: "m5", address: "i@j.test" },
    ])));
    expect(out!.map((m) => m.sentFolder)).toEqual(["INBOX.Verzonden", null, null, null, null]);
  });

  it("reads the closed account's pause, a non-empty instant or `null` (mail 0135)", async () => {
    const at = "2026-09-23T02:15:07.000Z";
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "a@b.test", organizerParkedAt: at },
      { id: "m2", address: "c@d.test", organizerParkedAt: "" },
      { id: "m3", address: "e@f.test" },
    ])));
    expect(out!.map((m) => m.organizerParkedAt)).toEqual([at, null, null]);
  });

  it("reads the submission server's SIZE announcement, admitting only a positive finite number", async () => {
    /* `smtpMaxSizeBytes` feeds the composer's attach cap (`composeAttachCap`, the one shared
       bound). `SIZE 0` is RFC 1870's "no fixed maximum" — not a ceiling — and a server that
       predates the field sends nothing; both land as `null`, where the cap rule applies the
       strict constant, never unbounded. */
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "a@b.test", smtpMaxSizeBytes: 50 * 1024 * 1024 },
      { id: "m2", address: "b@b.test", smtpMaxSizeBytes: 0 },
      { id: "m3", address: "c@b.test", smtpMaxSizeBytes: -5 },
      { id: "m4", address: "d@b.test", smtpMaxSizeBytes: "big" },
      { id: "m5", address: "e@b.test" },
    ])));
    expect(out?.map((b) => b.smtpMaxSizeBytes)).toEqual([50 * 1024 * 1024, null, null, null, null]);
  });

  it("reads when the mailbox was connected, the first-import floor's clock, only as a non-empty string", async () => {
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "a@b.test", createdAt: "2026-09-22T08:00:00.000Z" },
      { id: "m2", address: "b@b.test", createdAt: "" },
      { id: "m3", address: "c@b.test" },
    ])));
    expect(out?.map((b) => b.createdAt)).toEqual(["2026-09-22T08:00:00.000Z", undefined, undefined]);
  });

  it("reads the error code and the sign-in kind the support mail's block classes, only as the wire sent them", async () => {
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "a@b.test", errorCode: "auth", authKind: "oauth" },
      { id: "m2", address: "b@b.test", errorCode: null, authKind: 7 },
      { id: "m3", address: "c@b.test" },
    ])));
    expect(out?.map((b) => [b.errorCode, b.authKind])).toEqual([["auth", "oauth"], [undefined, undefined], [undefined, undefined]]);
  });

  it("asks the PAIRED origin and nothing else, and does not buy the counts aggregate", async () => {
    const s = session(ok([]));
    await readMailboxes(s);
    const [url] = (s.fetch as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    expect(url).toBe("https://srv.test/mailboxes");
    // `?counts=1` is the route's one opt-in and it costs an aggregate over the whole messages
    // table. Nothing on this phone renders a server-side count.
    expect(url).not.toContain("counts");
  });

  it("answers NULL for could-not-ask, which is not the same as an empty account", async () => {
    // An account whose mailbox was removed really does answer `[]`, and a client that read a
    // failure the same way would blank the banner and un-recognise the reader on every flaky
    // request.
    expect(await readMailboxes(session({ status: 503, json: async () => ({}) }))).toBeNull();
    expect(await readMailboxes(session(new Error("offline")))).toBeNull();
    expect(await readMailboxes(session(ok([]))), "an empty account is an ANSWER").toEqual([]);
  });

  it("drops a row that can neither be matched nor named", async () => {
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "" },
      { address: "no-id@example.test" },
      { id: "m2", address: "kept@example.test" },
    ])));
    expect(out?.map((b) => b.id)).toEqual(["m2"]);
  });

  /**
   * ══ THE ROLE IS CARRIED, AND `organizedBy: null` DECIDES NOTHING ON ITS OWN ══════════
   *
   * The row below is what the live hosted API answered for both mailboxes of a Cloud-paired
   * account, read on a device at 0.19.6: role `organizer`, no holder, and `organizedByThisInstall`
   * FALSE. This reduction carried the holder and not the role, and the panel behind it reads
   * `organizedBy === null` — which the DTO gives for "the answering install organizes it" AND for
   * "nobody ever has" — so every organized mailbox was captioned "Nothing organizes this mailbox".
   * The wire half of the fix is here; the sentence half is `test/fourth-door.test.ts`.
   */
  it("carries the organizer role and the server's own claim comparison", async () => {
    const out = await readMailboxes(session(served([
      {
        id: "m1", address: "me@example.test",
        organizerRole: "organizer", organizedBy: null, organizedByThisInstall: false,
      },
    ])));
    expect(out?.[0]!.organizerRole).toBe("organizer");
    expect(out?.[0]!.organizedByThisInstall).toBe(false);
    expect(out?.[0]!.organizedBy, "a null holder must stay null — it is not a second role").toBeNull();
  });

  it("an unknown role reads as `this server said nothing`, never as a verdict", async () => {
    /* `stateOf`'s rule, one field over: a server that predates the column, or names something
       this build cannot rank, gets silence rather than `reader` — read as `reader` the panel
       would say nothing organizes a mailbox such a server may well be organizing. */
    for (const role of ["sideways", undefined, null, 7]) {
      const out = await readMailboxes(session(ok([{ id: "m1", address: "a@b.test", organizerRole: role }])));
      expect(out?.[0]!.organizerRole, String(role)).toBeNull();
    }
    /* The positive control: both real values survive the parse. */
    for (const role of ["organizer", "reader"] as const) {
      const out = await readMailboxes(session(ok([{ id: "m1", address: "a@b.test", organizerRole: role }])));
      expect(out?.[0]!.organizerRole).toBe(role);
    }
  });

  it("takes `organizedByThisInstall` only as a literal true", async () => {
    /* The server sends its own comparison's answer; anything else — a string, a missing field on
       an older deployment — is "not the answering install's", which withholds nothing but the
       admitting half of a claim the role already carries. */
    for (const [sent, want] of [[true, true], [false, false], ["true", false], [undefined, false]] as const) {
      const out = await readMailboxes(session(ok([
        { id: "m1", address: "a@b.test", organizedByThisInstall: sent },
      ])));
      expect(out?.[0]!.organizedByThisInstall, String(sent)).toBe(want);
    }
  });

  it("keeps whether the mailbox's provider's word is read only as the server said it", async () => {
    /* `MailboxDTO.providerConfirms`: where no mailbox has it, no screen-out unsubscribes by itself and
       none is said. Absent is a server that cannot say, which keeps the sentence (the safe side). */
    for (const [sent, want] of [[true, true], [false, false], ["false", undefined], [undefined, undefined]] as const) {
      const out = await readMailboxes(session(ok([{ id: "m1", address: "a@b.test", providerConfirms: sent }])));
      expect(out?.[0]!.providerConfirms, String(sent)).toBe(want);
      expect("providerConfirms" in out![0]!, String(sent)).toBe(want !== undefined);
    }
  });

  it("reads an object of nulls as NO holder, at the wire", async () => {
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "a@b.test", organizedBy: { kind: null, name: null } },
    ])));
    expect(out?.[0]!.organizedBy).toBeNull();
  });

  it("an unknown organizerState reads as `has not looked`, never as a verdict", async () => {
    const out = await readMailboxes(session(ok([
      { id: "m1", address: "a@b.test", organizerState: "sideways" },
    ])));
    expect(out?.[0]!.organizerState).toBeNull();
  });
});

describe("the banner's copy is the catalogue's, not a near-miss", () => {
  it("mirrors `onboarding.phoneBanner` and `phoneBannerWhy` — the keys written for this surface", () => {
    expect(Copy.phoneBanner("NAME")).toBe(en.onboarding!.phoneBanner!.replace("{name}", "NAME"));
    expect(Copy.phoneBannerWhy).toBe(en.onboarding!.phoneBannerWhy);
  });

  it("and the stopped sentence is the mailbox pane's own, not a phone rewrite", () => {
    expect(Copy.phoneBannerStopped("NAME")).toBe(en.mailboxes!.readerStopped!.replace("{name}", "NAME"));
  });

  it("the keys are REACHED — a deck entry nothing renders is what this whole row was about", () => {
    // The screen renders the two lines `phoneBannerLines` chooses; the deck calls live there.
    const more = read("../app/(tabs)/more.tsx");
    expect(more).toContain("phoneBannerLines(w.mailboxes.organizer).head");
    expect(more).toContain("phoneBannerLines(w.mailboxes.organizer).why");
    const live = read("../src/state/live.ts");
    expect(live).toContain("Copy.phoneBanner(o.name)");
    expect(live).toContain("Copy.phoneBannerWhy");
    expect(live).toContain("Copy.phoneBannerStopped(o.name)");
  });
});

describe("the world layer's shape — asserted over source, and said to be", () => {
  const world = read("../src/state/world.tsx");
  const live = read("../src/state/live.ts");

  it("the banner is drawn behind a SUCCESSFUL read, never behind a non-empty list", () => {
    const more = read("../app/(tabs)/more.tsx");
    expect(more).toContain("w.mailboxes.organizer ?");
    expect(readFileSync(new URL("../src/state/world-projection.ts", import.meta.url), "utf8")).toContain("known: inp.mailboxes !== null,");
  });

  it("the read rides the folders flag's cadence — boot and after every completed drain", () => {
    // One cadence to reason about. The two questions go stale together: another client claiming
    // a mailbox writes into the very delta feed that drain just applied.
    expect(world).toMatch(/const boxRead = freshestRead<readonly PhoneMailbox\[\]>/);
    expect(world).toMatch(/\(\) => void boxRead\(async \(\) => \{\s*const ans = await readMailboxes\(session\);/);
    // …and every accepted answer, an unchanged one too, stamps when the facts were read.
    expect(world).toContain("if (ans !== null && current.current === m) mailboxesReadAt.current = Date.now();");
    // …as one of the drain read's REST reads, which go on every drain (`drain-reads.test.ts`).
    expect(world).toContain("read: drainReads<FoldersConsent>({");
  });

  it("a superseded session's late answer applies NOTHING", () => {
    // Account A's addresses must not make account B's reader recognisable, and A's holder must
    // not name a banner over B's mail.
    expect(world).toContain("if (current.current === m) setMailboxes(ans);");
    expect(world).toContain("setMailboxes(null);");
  });

  it("the actions facade reads the addresses through a GETTER, keeping one identity", () => {
    // The facade is identity-stable by design (`World.worldKey`); the read lands after it is
    // built. A captured value would send every reply-all of the session against an empty set.
    expect(world).toContain("ownAddresses: () => addressesNow.current,");
    expect(live).toContain("deps.ownAddresses?.() ?? NO_OWN_ADDRESSES");
  });

  it("and both `NO_OWN_ADDRESSES` sites are fed, which is what the gap row asked for", () => {
    expect(live).toContain("replyAllRecipients(m, v.ownAddresses ?? NO_OWN_ADDRESSES)");
    expect(live, "the constant survives as the pre-read fallback, and should")
      .toContain("const NO_OWN_ADDRESSES: readonly string[] = [];");
  });
});

/* FOLDER-MISSING-FILINGS: the phone read no filing facts and had no way to ask about them. */
describe("the filings that wait — the facts and the block's three requests", () => {
  const asked: string[] = [];
  const session = (status: number, body: unknown) => ({
    profile: { origin: "https://srv.test", accountId: "a" },
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${url} ${typeof init?.body === "string" ? init.body : ""}`.trim());
      if (status === 0) throw new Error("offline");
      return { status, json: async () => body } as unknown as Response;
    }),
  }) as unknown as Parameters<typeof readMailboxes>[0];

  it("keeps the server's filing figures, and none where the wire sends none", async () => {
    const out = await readMailboxes(session(200, { items: [
      { id: "m1", address: "a@b.test", filing: { due: 1, deferred: 2, stuck: 2, stuckSince: "2026-10-24T04:02:00.000Z",
        stuckRefusalClass: "no_such_folder", lastRefusalClass: "no_such_folder", nextAttemptAt: "", asOf: "2026-10-24T04:46:00.000Z", attempts: 3 } },
      { id: "m2", address: "c@d.test" },
      { id: "m3", address: "e@f.test", filing: { due: -1, deferred: "2" } },
    ] }));
    expect(out![0]!.filing).toEqual({
      due: 1, deferred: 2, stuck: 2, stuckSince: "2026-10-24T04:02:00.000Z", stuckRefusalClass: "no_such_folder",
      lastRefusalClass: "no_such_folder", nextAttemptAt: null, asOf: "2026-10-24T04:46:00.000Z",
    });
    expect(out![1]).not.toHaveProperty("filing");
    expect(out![2]!.filing).toMatchObject({ due: 0, deferred: 0, stuck: 0 });
  });

  it("reads the groups of one mailbox, and a foreign or malformed answer is could-not-ask", async () => {
    const groups = [{ folder: "ohmail/Screened", count: 2, deletes: 0, since: "2026-10-24T04:02:00.000Z", through: "2026-10-24T04:06:00.000Z",
      nextAttemptAt: null, at: "INBOX", reasons: [{ reason: "no_such_folder", count: 2 }] }];
    asked.length = 0;
    expect(await readFilings(session(200, { mailboxId: "m1", groups }), "m1")).toEqual(groups);
    expect(asked).toEqual(["GET https://srv.test/mailboxes/m1/filings"]);
    expect(await readFilings(session(200, { mailboxId: "m2", groups }), "m1")).toBeNull();
    expect(await readFilings(session(200, { mailboxId: "m1", groups: [{ count: 1 }] }), "m1")).toBeNull();
    expect(await readFilings(session(500, {}), "m1")).toBeNull();
    expect(await readFilings(session(0, {}), "m1")).toBeNull();
  });

  it("Try again and Leave answer their counts, a 409 says another install organizes it, anything else did not go through", async () => {
    asked.length = 0;
    expect(await retryFilings(session(202, { reset: 2, skipped: 0 }), "m1", "ohmail/Screened")).toEqual({ k: "retried", count: 2 });
    expect(await leaveFilings(session(200, { settled: 2, remaining: 0 }), "m1", "ohmail/Screened", "2026-10-24T04:06:00.000Z"))
      .toEqual({ k: "left", count: 2 });
    expect(asked).toEqual([
      `POST https://srv.test/mailboxes/m1/filings/retry {"folder":"ohmail/Screened"}`,
      `POST https://srv.test/mailboxes/m1/filings/leave {"folder":"ohmail/Screened","through":"2026-10-24T04:06:00.000Z"}`,
    ]);
    expect(await retryFilings(session(409, {}), "m1", "x")).toEqual({ k: "elsewhere" });
    expect(await leaveFilings(session(400, {}), "m1", "x", "y")).toEqual({ k: "failed" });
    expect(await retryFilings(session(0, {}), "m1", "x")).toEqual({ k: "failed" });
  });
});

