/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PHONE'S ENGINE BUNDLE IS LOADED, BOOTED AND WATCHED DIALLING — over the ARTIFACT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * OVER THE PACKAGED FILE, at the path a release carries it: `apps/mobile/generated/phone-engine.js`,
 * which is the same `BUNDLE` the app's own loader requires and `metro.config.js` refuses to
 * configure without. That matters more than it reads — this suite used to boot a copy in the
 * repository's `build/`, so "the artifact boots" and "the artifact the app ships boots" were two
 * claims and only one of them was measured. `test/engine-packaging.test.ts` holds the rest of the
 * packaging (the path, the absolute-path census, the size ceiling, the refusal).
 *
 * `no-node-builtins.test.ts` reads the metafile and proves what the graph CONTAINS.
 * `apps/sidecar/test/phone-engine-boot.test.ts` drives the composition, but it imports
 * `apps/sidecar/src/mobile.ts` as SOURCE, under Node, where `url`, `path`, `buffer` and `process`
 * are the real ones rather than the substitutes a phone gets. So the substitution set is asserted
 * by a table, censused by a graph, and EXECUTED by nothing.
 *
 * Five device-fatal defects lived in that gap at once, and every one of them is a `require` and one
 * `await` away:
 *
 *  1. `@ohmail/db-mail`'s barrel computes two migration directories at MODULE SCOPE from
 *     `fileURLToPath(import.meta.url)`; the phone's `url` substitute throws by design, so the
 *     artifact throws while still initialising, before `startPhoneEngine` exists.
 *  2. `createSidecar` → `createLocalAi` calls `path.join`. `shims/node-absent.js` says it throws on
 *     CALL and not on READ so the failure names the module and the member — but esbuild's `__toESM`
 *     builds its namespace from the CommonJS module's OWN KEYS, and a Proxy over an empty target
 *     has none, so the member is `undefined` and the failure names neither.
 *  3. `buffer@6.0.3` has no `base64url`, which sealing the mailbox credential writes.
 *  4. the `process` stand-in has no `memoryUsage`, which `startEngineVitals` calls at boot.
 *  5. nothing starts the drain: `main.ts` runs `void sidecar.start()`, and `startPhoneEngine`
 *     neither calls it nor exposes it — so a phone boots, says `organizing: true`, and syncs
 *     nothing for ever without a diagnostic.
 *
 * The three cases below catch them in that order: LOADS (1), ANSWERS (2–4), DIALS (5).
 *
 * ── THE THIRD CASE ASSERTS AN EFFECT ONLY A DIAL PRODUCES ─────────────────────────────────
 *
 * A booted engine that "resolved" proves nothing; so does an `organizing: true` read back off the
 * object that wrote it. The evidence is a TCP connection ARRIVING at a listener this test owns.
 * Watched red by removing the engine's start — which is how defect 5 was found, and the reason this
 * case is not written as an assertion about a field.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { BUNDLE, TYPES, buildPhoneEngine } from "../scripts/bundle-engine.mjs";
import { LOCAL_ENGINE_ORIGIN, localEngineTransport } from "../src/engine/boot";
import { organizeHere, readMailboxes } from "../src/net/mailboxes";
import { reopenStandaloneMailbox, type StartPhoneEngineFromSealed, type StoreMigrating } from "../src/engine/standalone-door";
import { sayRefusal } from "../src/refusal";
import { migratingState } from "../src/ui/boot-migrating";

const require_ = createRequire(import.meta.url);
const sqlite = require_("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void; close(): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; columns?(): { column?: string | null; name?: string }[] };
  };
};

/**
 * NODE STANDS IN FOR THE TWO NATIVE MODULES, and for nothing else.
 *
 * The bundle leaves exactly two requires behind. Answering them from `node:net`/`node:tls` and
 * `node:crypto` is the ONLY difference between this and a device: every substituted module — the
 * ones that actually failed — is inside the artifact and runs here exactly as it runs there.
 */
function loadArtifact(): Record<string, unknown> {
  const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      const net = require_("node:net") as Record<string, unknown>;
      const tls = require_("node:tls") as Record<string, unknown>;
      return { createConnection: net.createConnection, connectTLS: tls.connect, TLSSocket: tls.TLSSocket,
               isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
    }
    if (request === "react-native-quick-crypto") return require_("node:crypto");
    return original.call(this, request, parent, isMain);
  };
  try {
    delete (require_ as unknown as { cache?: Record<string, unknown> }).cache?.[BUNDLE];
    return require_(BUNDLE) as Record<string, unknown>;
  } finally { Module._load = original; }
}

/** `node:sqlite` behind the statement-runner contract, yielding between calls as the device's driver does. */
function sqlExecutor(): { all: unknown; run: unknown; batch: unknown; close: unknown } {
  const raw = new sqlite.DatabaseSync(":memory:");
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T,>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job); tail = next.catch(() => undefined); return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    all: (sql: string, params: readonly unknown[]) => serial(async () => {
      await yielded();
      const st = raw.prepare(sql);
      const columns = (st.columns?.() ?? []).map((c) => c.name ?? c.column ?? "");
      const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
      return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
    }),
    run: (sql: string, params: readonly unknown[]) => serial(async () => { await yielded(); raw.prepare(sql).run(...(params as unknown[])); }),
    batch: (statements: readonly { sql: string; params?: readonly unknown[] }[]) => serial(async () => {
      await yielded(); raw.exec("BEGIN IMMEDIATE");
      try { for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[])); raw.exec("COMMIT"); }
      catch (err) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw err; }
    }),
    close: async () => { try { raw.close(); } catch { /* already closed */ } },
  };
}

/**
 * THIS FILE'S RIG: A SERVER THAT SIGNS THE START IN, AND THEN IS GONE.
 *
 * The cases were written against a bundle dialling a port nothing answers. Connect now opens a
 * mailbox only over a login, so the start signs in once to a listener this file
 * owns, which is closed before the case goes on: every later dial meets the dead port the cases
 * reason about. It answers what the sign-in needs and nothing else: the connect's own LIST once,
 * and no later one, so no look at `ohmail/_meta` ever lands, as on the dead port.
 */
function signsInOnce(): Promise<{ port: number; close(): Promise<void> }> {
  const open = new Set<Socket>();
  const srv = createServer((sock) => {
    open.add(sock);
    sock.on("close", () => open.delete(sock));
    sock.on("error", () => undefined);
    const write = (s: string): void => { if (!sock.destroyed) sock.write(s); };
    let listed = false;
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd, ...args] = line.split(" ");
        const c = (cmd ?? "").toUpperCase();
        if (c === "CAPABILITY") write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (c === "LOGIN") write(`${tag} OK signed in\r\n`);
        // imapflow's delimiter probe: the delimiter alone, or it becomes every LIST's prefix.
        else if (c === "LIST" && args.join(" ") === `"" ""`) write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
        else if (c === "LIST" && !listed) { listed = true; write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`); }
        else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
        else write(`${tag} NO not on this rig\r\n`);
      }
    });
    write("* OK the rig\r\n");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    port: (srv.address() as { port: number }).port,
    close: () => new Promise<void>((done) => { for (const s of open) s.destroy(); srv.close(() => done()); }),
  })));
}

/** `startPhoneEngine` over {@link signsInOnce}: signed in, and the server gone when this returns. */
async function overADeadPort<T>(
  start: (d: unknown) => Promise<T>, deps: Record<string, unknown> & { imap: Record<string, unknown> },
): Promise<{ engine: T; port: number }> {
  const rig = await signsInOnce();
  try {
    return { engine: await start({ ...deps, imap: { ...deps.imap, port: rig.port } }), port: rig.port };
  } finally { await rig.close(); }
}

let live: { stop(): Promise<void> } | null = null;
let listener: Server | null = null;
afterEach(async () => {
  if (live) await live.stop().catch(() => undefined);
  live = null;
  if (listener) await new Promise<void>((r) => listener!.close(() => r()));
  listener = null;
});

describe("the engine bundle a phone would ship", () => {
  it("LOADS, and hands back a composition root", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    // Not "did not throw": the export the app calls has to be there. A bundle that loaded and
    // exported nothing is the same outage one step later.
    expect(typeof mod.startPhoneEngine, "the artifact exports its composition root").toBe("function");
  });

  it("exports everything the declaration beside it claims", async () => {
    /**
     * The generated `.d.ts` is what a reader of an ignored directory full of generated code has to
     * go on, and the app loads the artifact through an untyped `require` — so nothing compiles that
     * declaration against anything. This makes it a claim under test instead: the names it declares
     * are read out and looked up on the module that actually loaded. Watched failing by declaring a
     * name the bundle does not export.
     */
    await buildPhoneEngine();
    const mod = loadArtifact();
    const declared = [...readFileSync(TYPES, "utf8").matchAll(/export declare const (\w+)/g)]
      .map((m) => m[1]);
    expect(declared, "the declaration names nothing at all").not.toEqual([]);
    for (const name of declared) {
      expect(typeof mod[name], `the declaration claims ${name}`).toBe("function");
    }
  });

  it("BOOTS out of the artifact and answers its own door", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{ handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void> }>;
    const { engine } = await overADeadPort(start, {
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", secure: false, auth: { user: "a@b.test", pass: "pw" } },
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    });
    live = engine;
    const res = await engine.handle(new Request("http://sidecar/hello", { headers: { authorization: `Bearer ${engine.sessionToken}` } }));
    expect(res.status, "the store migrated, the routes are mounted and the bearer was accepted").toBe(200);
  });

  /**
   * THE THREE MEMBERS THE BACKGROUND HALF DRIVES, READ OFF A REAL BOOTED ENGINE.
   *
   * `StandaloneEngine` in `src/engine/standalone-door.ts` is a structural claim about an untyped
   * bundle, so its five members are only as true as this case. The two acts and the read are the
   * ones `background.ts` calls at every app-state edge, and they are also the three the type was
   * MISSING while `createBackgroundOrganizing` had no call site — a compile-time claim about a
   * bundle nothing compiles is exactly the shape that stays wrong quietly.
   *
   * `runtimes()` is read rather than asserted a function: its return shape is what the session's
   * adapter maps onto `{ mailboxId, organizing }`, and a `runtimes` answering something else would
   * make that adapter produce an empty list — which the claim watch reads as "organizing nothing"
   * and takes somebody's notification down for.
   */
  it("answers the two acts and the read the background half drives", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{
      stop(): Promise<void>;
      handBack(): Promise<readonly { mailboxId: string; released: number | null }[]>;
      resume(): Promise<readonly { mailboxId: string; served: number }[]>;
      claimHere(opts: { by: "press" | "watch" }): Promise<"claimed" | "held" | "held_consented" | "unreadable" | "refused">;
      stopOrganizing(): Promise<"released" | "not_organizing" | "refused">;
      serverSettings(): Promise<unknown>;
      runtimes(): { organizer: Record<string, {
        organizing: boolean; heldBy: string | null; reason: string | null;
        releaseRequestedAt: string | null;
      }> };
    }>;
    const { engine, port } = await overADeadPort(start, {
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", secure: false, auth: { user: "a@b.test", pass: "pw" } },
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    });
    live = engine;
    /* THE PERSON'S TWO VERBS ARE ON THE ARTIFACT TOO, and they are the ones that cannot be
       checked anywhere else: the app may not compose a request to its own engine (the privacy
       census admits a transport in six named files and the organizer session is not one), so the
       panel's stop and its start are METHOD calls on this bundle. A bundle without them leaves
       both presses throwing inside a `catch` that reports "refused", which on the stop looks like
       a mailbox that was handed back and was not. */
    for (const name of ["handBack", "resume", "runtimes", "claimHere", "stopOrganizing", "serverSettings"] as const) {
      expect(typeof engine[name], `the artifact does not answer ${name}`).toBe("function");
    }
    const states = engine.runtimes().organizer;
    expect(typeof states, "runtimes() answers no organizer map").toBe("object");
    expect(Object.keys(states).length, "the engine reports no mailbox at all").toBeGreaterThan(0);
    for (const [id, state] of Object.entries(states)) {
      expect(typeof id).toBe("string");
      expect(typeof state.organizing, `${id} reports no organizing flag`).toBe("boolean");
      /* AND THE ROW'S STANDING STOP, which is the second half of the same question and the only
         thing that separates a stop the mail server honoured from one it refused. Read off the
         ARTIFACT: absent from the bundle, the app's adapter answers `refused` for every stop for
         ever — a healthy-looking shape, and a notification that never comes down. `null` here is
         honest: nobody has asked this rig's mailbox to stop. */
      expect(state.releaseRequestedAt, `${id} reports no standing-stop field`).toBeNull();
      /* AND `heldBy`, which Settings' "This phone" panel turns into "another machine has it". The
         member was absent from the app's structural claim, so a phone standing down correctly
         showed the same sentence as a free mailbox — and only the artifact can say whether the
         bundle carries it. `null` here is honest: nothing has claimed on this rig. */
      expect(state.heldBy === null || typeof state.heldBy === "string",
        `${id} reports no holder field`).toBe(true);
      /* AND `reason`, WHICH IS THE ONE THAT DECIDES. A claim that named nothing leaves `heldBy`
         null, and so does every relaunch — the engine reassembles a stood-down mailbox from its
         own row, which remembers the reason and not the holder. So the panel branches on this, and
         a bundle not carrying it would put "Nothing organizes this mailbox" back over a mailbox
         another machine holds. `null` on this rig: nothing has claimed, which is the value the
         panel reads as "not stood down". */
      expect(state.reason === null || typeof state.reason === "string",
        `${id} reports no stand-down reason field`).toBe(true);
    }
    /* THE ACT ITSELF, not only its presence: a `handBack` that threw would leave every iPhone
       background with the claim standing. One entry per mailbox, each with the three answers'
       shape. */
    for (const entry of await engine.handBack()) {
      expect(typeof entry.mailboxId).toBe("string");
      expect(entry.released === null || typeof entry.released === "number").toBe(true);
    }
    /* AND THE RESUME'S COUNTS SURVIVE THE BUNDLE: the phone keeps "Handed back" standing on a `0`,
       and an artifact that dropped them would clear it over a cycle that never ran. This rig's
       server answers nothing, so the forced cycle is not served. */
    const served = await engine.resume();
    expect(Array.isArray(served), "the artifact's resume answers no per-mailbox counts").toBe(true);
    for (const entry of served) {
      expect(typeof entry.mailboxId).toBe("string");
      expect(entry.served, `${entry.mailboxId}'s forced cycle read as served against a dead port`).toBe(0);
    }
    /* AND THE TWO VERBS ANSWER RATHER THAN THROW, over the real bundle. Both answers are the
       honest ones for this rig — nothing has consented to organizing this mailbox and nothing is
       organizing it — and the point is that the answer arrives at all: a member that threw would
       be swallowed by the app's own catch and reported as `refused`, which on the stop is a
       mailbox a person believes they handed back. */
    /* FOUR WORDS. `unreadable` joined them when the door stopped reading "we have not looked" as
       "nobody holds it": on THIS rig — a bundle dialling a port nothing answers — it is the honest
       answer, and it used to be `claimed`. A list that omitted it would let the artifact answer a
       word the app has no sentence for. */
    expect(["claimed", "held", "held_consented", "unreadable", "refused"]).toContain(await engine.claimHere({ by: "press" }));
    /* THREE WORDS, read off the artifact. A boolean could not separate "the claim is gone" from
       "the server would not let it go", and the app takes the notification down on the first. */
    expect(["released", "not_organizing", "refused"]).toContain(await engine.stopOrganizing());
    /* AND WHERE THE SERVERS ARE, as the seal recorded them: Settings' server sheet reads this and
       nothing else, so a bundle without it offers a sheet with nothing to edit. */
    expect(await engine.serverSettings()).toEqual({ imap: { host: "127.0.0.1", port, secure: false }, smtp: null });
  }, 60_000);

  /**
   * ══ THE ROSTER READ, OVER THE PRODUCTION TRANSPORT, AGAINST A REAL ENGINE ══════════════════
   *
   * Settings' "This phone" panel and the More screen's organizer banner both draw only behind a
   * SUCCESSFUL `readMailboxes`, and on a device neither appeared. Three things had to be told
   * apart and only this case can do it: the route's answer (measured in the sidecar's own suite),
   * the app's ENVELOPE reading, and the app's TRANSPORT to its own door. So this drives the real
   * `readMailboxes` through the real `localEngineTransport` over the real artifact — the whole
   * production path with only React missing.
   *
   * A `null` here is "could not ask" and an EMPTY LIST is "this phone organizes nothing"; the
   * panel is dark for both, which is why they are asserted apart.
   */
  it("serves the app's OWN roster read through the transport the session uses", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{
      handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void>;
    }>;
    const { engine } = await overADeadPort(start, {
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", secure: false, auth: { user: "roster@b.test", pass: "pw" } },
      address: "roster@b.test",
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    });
    live = engine;
    /* THE SESSION'S OWN TRANSPORT, composed exactly as `buildLocalSession` composes it. */
    const fetchImpl = localEngineTransport(engine).fetch;
    const session = {
      profile: { origin: LOCAL_ENGINE_ORIGIN, accountId: "unused-here" },
      fetch: fetchImpl,
    } as unknown as Parameters<typeof readMailboxes>[0];

    const rows = await readMailboxes(session);
    expect(rows, "the app could not ask its own engine for the roster").not.toBeNull();
    expect(rows!.length, "the engine served an EMPTY roster — the panel is dark for this too").toBe(1);
    expect(rows![0]!.address).toBe("roster@b.test");
    expect(typeof rows![0]!.id).toBe("string");
  }, 60_000);

  /**
   * ══ THE CONSENT PRESS, AGAINST THE REAL ENGINE, THROUGH THE SESSION'S OWN TRANSPORT ════════
   *
   * PHONE-STANDALONE-DOOR-CANNOT-GIVE-CONSENT: a mailbox nobody consented to organizing is read
   * and nothing else, and the only client that can record that consent is the one bound to this
   * engine. The route is step-up gated on every other door, so whether the launch session this
   * engine mints satisfies it is a fact about the artifact and not about the app — which makes it
   * this file's question rather than a twin's.
   *
   * ── WHAT A SECOND PRESS ANSWERS HERE, MEASURED RATHER THAN ASSUMED ───────────────────────
   *
   * This case first asserted 200 `already_organizing` on the second press and it answered 202
   * again. `already_organizing` means this install ALREADY ORGANIZES the mailbox, and organizing
   * is the engine's lease — written by a gated cycle against the mail server, which on this rig
   * never happens. So the second answer is 202 here and 200 on a phone whose engine has claimed,
   * and both are the same fact: the consent is recorded and nothing took a second claim.
   *
   * What is asserted is therefore the property rather than the status: neither press is REFUSED,
   * and neither makes the engine organize the mailbox — the lease is the worker's to take.
   * The app's duty to tell 200-already apart from a fresh 202 is asserted against a fake door in
   * `standalone-adopt.test.ts`, where that answer is reachable.
   */
  it("takes the consent on its own door, and a second press takes no second claim", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{
      handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void>;
    }>;
    const exec = sqlExecutor();
    const { engine } = await overADeadPort(start, {
      exec,
      imap: { host: "127.0.0.1", secure: false, auth: { user: "consent@b.test", pass: "pw" } },
      address: "consent@b.test",
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    });
    live = engine;
    const session = {
      profile: { origin: LOCAL_ENGINE_ORIGIN, accountId: "unused-here" },
      fetch: localEngineTransport(engine).fetch,
    } as unknown as Parameters<typeof readMailboxes>[0];

    const rows = await readMailboxes(session);
    const id = rows?.[0]?.id ?? "";
    expect(id, "the engine served no mailbox id to consent for").not.toBe("");

    /* ── THE PREMISE, NOW STATED: A LOOK AT THE CLAIM FOLDER HAS ANSWERED ────────────────────
     *
     * This rig dials a port nothing answers, so the engine can never read `ohmail/_meta`, and the
     * phone's door refuses a consent press it cannot check — see the case below, which is that
     * refusal. The question THIS case exists to answer is a different one: whether the launch
     * session the artifact mints satisfies the consent route's step-up gate. That question is only
     * reachable past the door, so the premise the door needs is written here rather than left to
     * a rig that happens to get past it. `stopped` is "a look answered and nobody is renewing" —
     * the gate's own `available`, and a mailbox a press may take. */
    await (exec.run as (sql: string, p: readonly unknown[]) => Promise<void>)(
      "update mailboxes set organizer_state = 'stopped' where id = ?", [id],
    );

    const organizing = (): boolean => Object.values((engine as unknown as {
      runtimes(): { organizer: Record<string, { organizing: boolean }> };
    }).runtimes().organizer).some((s) => s.organizing);
    expect(organizing(), "the premise: nothing organizes the mailbox before the press").toBe(false);

    const first = await organizeHere(session, id);
    expect(first, "the engine's own door refused the consent").toEqual({ kind: "authorized" });
    expect(organizing(), "the consent press organized the mailbox itself").toBe(false);
    /* THE SECOND PRESS, which every relaunch makes. Not refused — see the note above for why the
       status it answers depends on whether the engine has claimed yet. */
    const second = await organizeHere(session, id);
    expect(second.kind, "a relaunch's press was refused").not.toBe("refused");
    /* AND NEITHER PRESS TOOK A CLAIM. The route writes a stamp and returns; the lease is the
       gated cycle's, which is what keeps one organizer per mailbox and which this rig never runs.
       The consent does move the INSTRUCTION (`claimed`), on its own clock: it entitles the gate. */
    expect(organizing(), "a second press organized the mailbox").toBe(false);
  }, 60_000);

  /**
   * ══ AND THE DOOR REFUSES A PRESS IT CANNOT CHECK — in the bundle, not only in the source ═══
   *
   * A fresh phone mailbox is created a consent-less READER with no holder columns at all
   * (`identity.ts`), and `organizer_state` NULL is two facts in one value: "nobody has ever
   * organized this mailbox" and "we have not looked". This door read it as the first, so with the
   * engine unable to reach the claim folder — this rig, exactly — the press was admitted, the
   * consent and the authorization were written, and the app was told the mailbox was claimed while
   * nothing organized it.
   *
   * Here rather than only in the sidecar's own suite because the refusal has to be IN THE ARTIFACT:
   * the app ships a bundle, and a door taught this in source and dropped by the build is a rule
   * with no enforcement on the one platform it is for.
   */
  it("REFUSES a consent press whose claim folder it could not read, and writes nothing", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{
      handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void>;
    }>;
    const exec = sqlExecutor();
    const { engine } = await overADeadPort(start, {
      exec,
      imap: { host: "127.0.0.1", secure: false, auth: { user: "unread@b.test", pass: "pw" } },
      address: "unread@b.test",
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    });
    live = engine;
    const session = {
      profile: { origin: LOCAL_ENGINE_ORIGIN, accountId: "unused-here" },
      fetch: localEngineTransport(engine).fetch,
    } as unknown as Parameters<typeof readMailboxes>[0];
    const rows = await readMailboxes(session);
    const id = rows?.[0]?.id ?? "";
    expect(id).not.toBe("");

    const answered = await organizeHere(session, id);
    expect(answered.kind, "the artifact admitted a press it could not check").toBe("refused");

    /* AND NOTHING WAS WRITTEN. The stamp is what a gate spends to promote, so its absence is the
       whole invariant — and its presence would be a consent recorded over a mailbox another
       machine may be organizing. */
    const stamps = await (exec.all as (sql: string, p: readonly unknown[]) => Promise<{
      rows: unknown[][];
    }>)(
      "select takeover_authorized_at, organize_consented_at from mailboxes where id = ?", [id],
    );
    expect(stamps.rows[0], "the row vanished").toBeDefined();
    expect(stamps.rows[0]![0], "an authorization was written over an unreadable claim folder").toBeNull();
    expect(stamps.rows[0]![1], "a consent was recorded over an unreadable claim folder").toBeNull();
  }, 60_000);

  /**
   * ══ THE ENGINE'S OWN LOG, OUT OF THE ARTIFACT — the only venue where the substitution is real ══
   *
   * `apps/sidecar/src/log.ts` is now INSIDE this bundle: the app hands a sink and the artifact
   * builds `createSidecarLog` over it, so the field allowlist and the redaction stay on this side
   * of the boundary. Whether that module survives the substitution is a fact about the artifact —
   * the core package's built logger reads a clock and composes a line, and the phone's `process` and
   * `url` stand-ins throw by design — so it is this file's question and not a twin's.
   *
   * A phone's engine wrote NOTHING before this: two `ReactNativeJS` lines in a whole release run,
   * neither from the engine, and the device-only defects that never reach a mail server's wire
   * could not be read at all.
   */
  it("WRITES its own diagnostic lines to the sink the app supplies", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{ stop(): Promise<void> }>;
    const lines: string[] = [];
    live = (await overADeadPort(start, {
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", secure: false, auth: { user: "logs@b.test", pass: "pw" } },
      address: "logs@b.test",
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
      logSink: (line: string) => { lines.push(line); },
    })).engine;

    expect(lines.length, "the artifact's engine wrote nothing at all").toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    /* THE DESKTOP'S OWN LINE SHAPE, which is what makes `adb logcat -s ohmail.engine` a reader (and
       `-s ReactNativeJS` on a development build, where the sink writes both):
       one JSON object per line, the service named, the level authored by the logger. */
    for (const line of parsed) {
      expect(line.service).toBe("sidecar");
      expect(typeof line.event).toBe("string");
      expect(typeof line.ts).toBe("string");
      expect(["info", "warn", "error"]).toContain(line.level);
    }
    expect(parsed.map((l) => l.event), "the boot's own vocabulary is missing")
      .toContain("boot_phases");
    /* AND NO PASSWORD IN ANY OF THEM. The whole reason the app hands a destination rather than a
       `Diagnostic` is that the redaction belongs to the thing inside this bundle. */
    for (const line of lines) expect(line).not.toContain("pw");
  }, 60_000);

  /**
   * ══ AND THE APP'S OWN READS CARRY A BODY ON THE `Response` A PHONE HAS ═════════════════════
   *
   * The strongest venue for it, and the reason it is here: this drives the REAL artifact through
   * the REAL transport with the REAL `Response` a phone runs — react-native's `whatwg-fetch`,
   * out of the store — and that polyfill has no `body` property at all. The shared pipeline
   * stamped its two headers by rebuilding the response from `res.body`, so on this door every
   * session-authenticated answer came back EMPTY: the drain reported `JSON Parse error:
   * Unexpected end of input` on a release build, the mirror stayed at zero rows beside an engine
   * store holding the mail, and the roster read Settings' panel draws from answered nothing.
   *
   * The property is asserted in `packages/api/test/request-id-header.test.ts` over the pipeline
   * itself; this case is the one that proves it end to end, over the file a release ships.
   */
  it("answers the app's roster read with a BODY on react-native's own Response", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{
      handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void>;
    }>;
    const { engine } = await overADeadPort(start, {
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", secure: false, auth: { user: "body@b.test", pass: "pw" } },
      address: "body@b.test",
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    });
    live = engine;

    const wf = require_("whatwg-fetch") as {
      Response: typeof Response; Request: typeof Request; Headers: typeof Headers;
    };
    /* THE PREMISE, measured rather than assumed: a polyfill that had grown a `body` would make
       everything below a test of nothing. */
    expect("body" in wf.Response.prototype,
      "react-native's Response grew a `body` — re-derive this, do not delete it").toBe(false);

    const platform = {
      Response: globalThis.Response, Request: globalThis.Request, Headers: globalThis.Headers,
    };
    try {
      globalThis.Response = wf.Response;
      globalThis.Request = wf.Request;
      globalThis.Headers = wf.Headers;
      const session = {
        profile: { origin: LOCAL_ENGINE_ORIGIN, accountId: "unused-here" },
        fetch: localEngineTransport(engine).fetch,
      } as unknown as Parameters<typeof readMailboxes>[0];
      const rows = await readMailboxes(session);
      /* `null` is "could not ask", which is what an unparseable body reads as — and it is exactly
         what the panel saw on a device. */
      expect(rows, "the app could not read its own roster on the phone's Response").not.toBeNull();
      expect(rows!.length).toBe(1);
      expect(rows![0]!.address).toBe("body@b.test");
    } finally {
      globalThis.Response = platform.Response;
      globalThis.Request = platform.Request;
      globalThis.Headers = platform.Headers;
    }
  }, 60_000);

  /* A bodiless write on the phone's own Request: whatwg-fetch has no `body`, so the engine's guard
     read every DELETE as an undeclared body and answered 415 — Drafts' Discard never worked. */
  it("takes a bodiless write, with the adapter's own headers, on react-native's own Request", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{
      handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void>;
    }>;
    const { engine } = await overADeadPort(start, {
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", secure: false, auth: { user: "discard@b.test", pass: "pw" } },
      address: "discard@b.test",
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    });
    live = engine;
    const wf = require_("whatwg-fetch") as { Response: typeof Response; Request: typeof Request; Headers: typeof Headers };
    expect("body" in wf.Request.prototype, "react-native's Request grew a `body` — re-derive this").toBe(false);
    const platform = { Response: globalThis.Response, Request: globalThis.Request, Headers: globalThis.Headers };
    try {
      globalThis.Response = wf.Response;
      globalThis.Request = wf.Request;
      globalThis.Headers = wf.Headers;
      const t = localEngineTransport(engine);
      const at = (path: string) => `${LOCAL_ENGINE_ORIGIN}${path}`;
      const rows = await readMailboxes({ profile: { origin: LOCAL_ENGINE_ORIGIN, accountId: "unused-here" }, fetch: t.fetch } as never);
      const made = await t.fetch(at("/drafts"), {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "k-create-1" },
        body: JSON.stringify({ mailboxId: rows![0]!.id, threadId: null, inReplyToMessageId: null, subject: "Discard me", body: "x", to: [], cc: [], bcc: [] }),
      });
      expect(made.status).toBe(201);
      const { id } = await made.json() as { id: string };
      const gone = await t.fetch(at(`/drafts/${encodeURIComponent(id)}`), { method: "DELETE", headers: { "idempotency-key": "k-discard-1" } });
      expect(gone.status, `Discard answered ${gone.status}: ${await gone.clone().text()}`).toBeLessThan(300);
      expect((await t.fetch(at(`/drafts/${encodeURIComponent(id)}`), { method: "GET", headers: {} })).status).toBe(404);
      const unknown = await t.fetch(at("/messages/00000000-0000-4000-8000-000000000999"), { method: "DELETE", headers: { "idempotency-key": "k-delete-1" } });
      expect(unknown.status, "a Delete was refused by its media type").toBe(404);
    } finally {
      globalThis.Response = platform.Response;
      globalThis.Request = platform.Request;
      globalThis.Headers = platform.Headers;
    }
  }, 60_000);

  it("DIALS the mail server on its own — nobody outside has to start it", async () => {
    /* THE EFFECT, not the field. `organizing: true` is read back off the object that wrote it and
       is true on an engine that never opened a socket; a connection arriving here is not. */
    const dialled = new Promise<boolean>((resolve) => {
      listener = createServer((socket) => { socket.destroy(); resolve(true); });
    });
    const port = await new Promise<number>((resolve) => {
      listener!.listen(0, "127.0.0.1", () => resolve((listener!.address() as { port: number }).port));
    });

    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{ stop(): Promise<void> }>;
    const opened = start({
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", port, secure: false, auth: { user: "a@b.test", pass: "pw" } },
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    }).then((engine) => { live = engine; return null; }, (err: unknown) => err);

    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000));
    expect(await Promise.race([dialled, timeout]), "a booted phone engine opens its mailbox connection").toBe(true);
    /* AND A SERVER THAT HUNG UP SIGNED NOBODY IN, so Connect refuses rather than opening it. */
    expect(((await opened) as { incomingUnreachable?: unknown } | null)?.incomingUnreachable).toBe("unreachable");
  }, 30_000);
});
/**
 * A FAILED STORE UPGRADE ENDS IN A REFUSAL THAT NAMES THE ENTRY (FIX-026 row 95, the required
 * control). A failing entry is planted through the artifact's `journal` seam; the relaunch hears
 * the upgrade begin, settles `refused` with the migrator's own sentence, and the count the boot
 * shell was showing does not survive into the refused state.
 */
describe("a relaunch whose store upgrade fails, out of the artifact", () => {
  it("settles refused, naming the entry, and keeps no count", async () => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const sealed = mod.startPhoneEngineFromSealed as StartPhoneEngineFromSealed;
    const bad = { name: "9999_fix026_planted", statements: ["SELECT nope FROM nowhere"] };
    const heard: StoreMigrating[] = [];
    const outcome = await reopenStandaloneMailbox({
      startFromSealed: (d) => sealed({ ...d, journal: [bad] } as Parameters<StartPhoneEngineFromSealed>[0]),
      platform: async () => ({ kind: "ready", exec: sqlExecutor(), keks: { 1: "a".repeat(64) } }),
      machineName: () => "census",
      installId: async () => "census-install",
      onMigrating: (p) => { heard.push(p); },
    });
    expect(heard, "the upgrade was not announced").toEqual([{ applied: 0, pending: 1, fresh: true }]);
    expect(outcome.ok).toBe(false);
    const said = outcome.ok ? "" : sayRefusal(outcome.reason);
    expect(said, "the refusal does not name the entry").toContain("9999_fix026_planted");
    expect(migratingState({ k: "refused" }, LOCAL_ENGINE_ORIGIN, heard[0]!, Date.now())).toBeNull();
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  AND THE AI DOOR ANSWERS OUT OF THE ARTIFACT — the only place the substitution is real
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `apps/sidecar/test/phone-engine-boot.test.ts` drives the same composition from SOURCE, and
 * cannot answer this: the module swap is a BUNDLER rule, so under Node that suite composes the
 * DESKTOP's AI provider — which opens a store file, gets `mkdir ''` from a phone's empty data
 * directory, and answers `500 internal error`. Measured, not assumed. So the question "does the
 * refusal reach a person?" has exactly one honest venue, and it is the artifact.
 *
 * The question matters because of what sits between the provider and the response: the request
 * pipeline carries a TYPED service error's own status and sentence, and turns anything else into
 * `500 internal error` with the message discarded. Somebody halfway through typing an API key
 * would be shown "internal error" instead of being told the build cannot do it and that nothing
 * they typed went anywhere. Asserting the error's class where it is thrown proves half of that;
 * only the response proves the half a person sees.
 */
describe("the AI settings door, out of the artifact a phone would ship", () => {
  async function booted(): Promise<{ handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void> }> {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<{
      handle(r: Request): Promise<Response>; sessionToken: string; stop(): Promise<void>;
    }>;
    const { engine } = await overADeadPort(start, {
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", secure: false, auth: { user: "a@b.test", pass: "pw" } },
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
    });
    live = engine;
    return engine;
  }

  it("refuses a write with 503 and a sentence about the phone — never a bare 500", async () => {
    const engine = await booted();
    const res = await engine.handle(new Request("http://sidecar/local/ai", {
      method: "PUT",
      headers: { authorization: `Bearer ${engine.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    // The shared code every client already renders, so no client is taught a new state.
    expect(body.error?.code).toBe("ai_provider_unavailable");
    // The two facts somebody in the middle of typing a key needs. The exact sentence is pinned
    // against the constant in `apps/sidecar/test/phone-engine-substitutes.test.ts`; this app must
    // not import that workspace, so the assertion here is on what a person reads.
    expect(body.error?.message).toMatch(/not available on this phone/);
    expect(body.error?.message).toMatch(/nothing was stored and nothing was sent/);
    expect(body.error?.message).not.toMatch(/internal error/);
  }, 60_000);

  it("READS the state without refusing — the positive control", async () => {
    // Without this, the case above would pass over a build whose AI door refused everything,
    // including the settings pane's own read.
    const engine = await booted();
    const res = await engine.handle(new Request("http://sidecar/local/ai", {
      headers: { authorization: `Bearer ${engine.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: unknown; unavailableReason: unknown; canStoreKey: unknown };
    expect(body.provider).toBeNull();
    // An existing member of the reason vocabulary, and the one the product treats as normal.
    expect(body.unavailableReason).toBe("not_configured");
    expect(body.canStoreKey).toBe(false);
  }, 60_000);
});

/**
 * ══ THE ARTIFACT'S OWN LOGGER, AND THE FIELDS THE APP HANDS IT ═══════════════════════════════
 *
 * The sink's return trip: the app may never build a logger, so `startPhoneEngine` hands its own
 * hardened one back out and `background.ts` writes every decline through it. What that leaves is a
 * seam only the ARTIFACT can answer — the field census lives in the shared core package, which
 * the bundler resolves through its `dist/`, so a name added to `ALLOWED_FIELDS` and not rebuilt
 * ships an artifact that strips it. Measured on a device exactly so: `organizer_background_declined`
 * arrived as `{"restricted":true,"droppedFields":["why"]}` — the reason code gone — while the
 * source-resolved node control read the line whole. Both halves below, because a suite that only
 * asserts what a CALL SITE HANDS OVER cannot see it.
 */
describe("the artifact's logger carries the phone's own field names", () => {
  const lineFor = async (
    detail: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    await buildPhoneEngine();
    const mod = loadArtifact();
    const start = mod.startPhoneEngine as (d: unknown) => Promise<
      { log(e: string, d: Record<string, unknown>): void; stop(): Promise<void> }>;
    const lines: string[] = [];
    const { engine } = await overADeadPort(start, {
      exec: sqlExecutor(),
      imap: { host: "127.0.0.1", secure: false, auth: { user: "a@b.test", pass: "pw" } },
      machineName: "census", installId: "census-install", keks: { 1: "a".repeat(64) },
      logSink: (line: string) => { lines.push(line); },
    });
    live = engine;
    lines.length = 0;
    engine.log("organizer_background_declined", detail);
    expect(lines.length, "the engine handed the app no logger at all").toBe(1);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  };

  it("emits every field the background machine passes — none stripped by the built census", async () => {
    const line = await lineFor({
      why: "notification_not_showing", restricted: true,
      mailboxes: 1, unresolved: 0, handedBack: true, stopped: false,
    });
    expect(line.droppedFields, "the shipped artifact's census refused a field the app passes")
      .toBeUndefined();
    expect(line.why).toBe("notification_not_showing");
    expect(line.restricted).toBe(true);
    expect(line.handedBack).toBe(true);
    expect(line.unresolved).toBe(0);
    expect(line.stopped).toBe(false);
  }, 60_000);

  it("POSITIVE CONTROL: a name nobody added IS reported dropped", async () => {
    /* Without this the case above is satisfied by an artifact whose census refuses nothing, which
       is the state the whole allowlist exists to prevent. */
    const line = await lineFor({ why: "system_restricted", unlistedCounter: 1 });
    expect(line.droppedFields).toEqual(["unlistedCounter"]);
    expect(line.why).toBe("system_restricted");
  }, 60_000);
});
