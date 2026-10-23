/**
 * THE STANDALONE DOOR — the same client, talking to an engine in this runtime instead of a server.
 *
 * A paired phone reaches a desktop or the hosted service over the network. A standalone phone
 * organizes its own mailbox, and the engine doing that runs in this same runtime, so the client's
 * transport is a function call rather than a socket. This file drives `bootEngine` on that arm.
 *
 * ── THE PROPERTY THAT MATTERS MOST IS THE ONE ABOUT THE OTHER THREE DOORS ─────────────────
 *
 * This app already has three doors and they must not acquire a branch. So the assertions here come
 * in pairs: what the standalone arm does, and — in the last block — that the ordinary paired door
 * still behaves exactly as it did, composed the same way, through a network transport. A test file
 * for a new arm that only exercises the new arm cannot see the regression it is most likely to
 * cause.
 *
 * ── AND THE TRANSPORT IS ASSERTED BY DRIVING IT, NOT BY READING THE COMPOSITION ────────────
 *
 * The door below answers the real `/sync` contract — snapshot, then pages — so the engine actually
 * drains through it and the mirror actually holds mail at the end. A test that asserted "the fetch
 * seam was set to the right function" would pass over a composition that never used it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTH_HINTS,
  authHintPreset,
  encodeSeqCursor,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
  type SyncChange,
} from "@ohmail/client-engine";

import {
  LOCAL_ENGINE_ORIGIN,
  bootEngine,
  type LocalEngineDoor,
  type MobileEngineDeps,
} from "../src/engine/boot";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";
import { authHintOf, certificateKindOf, incomingUnreachable, openStandaloneMailbox } from "../src/engine/standalone-door";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { refuse, sayRefusal } from "../src/refusal";
import { EMPTY_STANDALONE, refusalField, refusalLinks } from "../src/ui/standalone-form";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function nodeSqlExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const handles: DatabaseSync[] = [];
function deps(overrides: Partial<MobileEngineDeps> = {}): MobileEngineDeps {
  return {
    /* One in-memory store per open. The NAME is deliberately ignored: this fixture is about the
       transport, and a store keyed by name would make two cases share one database. */
    openExecutor: () => {
      const db = new sqlite.DatabaseSync(":memory:");
      handles.push(db);
      return nodeSqlExecutor(db);
    },
    deleteDatabase: async () => undefined,
    uuid: () => `11111111-1111-4111-8111-${String(handles.length).padStart(12, "0")}`,
    /**
     * THE GLOBAL TRANSPORT, ARMED TO FAIL. Any request that escaped the local door would come
     * here, and it must not be a silent fallback: the whole claim of this arm is that mail never
     * touches a network on a standalone install.
     */
    fetch: async () => {
      throw new Error("the global transport was used on the standalone door");
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const h of handles.splice(0)) { try { h.close(); } catch { /* already closed */ } }
});

interface DoorLog {
  readonly urls: string[];
  readonly bearers: (string | null)[];
}

/**
 * The engine's own local API, minimally: the `/sync` family, answering the real contract.
 *
 * `sessionToken` is a GETTER so the case below can prove the bearer is read per request rather
 * than captured once — a captured token would be stale on a launch that rotated it.
 */
function localDoor(log: DoorLog, changes: SyncChange[], token: { value: string }): LocalEngineDoor {
  return {
    get sessionToken() { return token.value; },
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      log.urls.push(req.url);
      log.bearers.push(req.headers.get("authorization"));
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

      if (url.pathname === "/sync/snapshot") {
        return json(200, {
          asOfSeq: changes.length,
          changes: changes.map((c, i) => ({ ...c, seq: i + 1 })),
          nextCursor: null,
          window: { days: 90, minRows: 5000 },
        });
      }
      if (url.pathname === "/sync") {
        return json(200, {
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: encodeSeqCursor(changes.length),
          hasMore: false,
          serverTime: new Date().toISOString(),
        });
      }
      if (url.pathname === "/sync/pull" && req.method === "POST") {
        return json(200, { results: [] });
      }
      return json(404, { error: { code: "not_found", message: url.pathname } });
    },
  };
}

/**
 * A `message` create in the shape the real sync service emits.
 *
 * Copied from the neighbouring suite's own fixture rather than invented: the first version here was
 * hand-built with a `data` field and the drain accepted the page, applied nothing, and reported a
 * mirror with zero messages — a green transport over an empty store. The change carries `entity`,
 * an `updatedAt`, and a DTO whose every field the projection reads.
 */
function messageChange(id: string, seq: number, subject: string, accountId = "acct-standalone"): SyncChange {
  return {
    type: "message",
    op: "create",
    id,
    seq,
    updatedAt: "2026-09-07T08:00:00Z",
    entity: {
      id,
      accountId,
      mailboxId: "mb-1",
      threadId: null,
      messageIdHeader: `<${id}@local>`,
      subject,
      from: { name: "A Sender", address: "sender@example.test" },
      to: [],
      cc: [],
      date: "2026-09-07T08:00:00Z",
      folder: "INBOX",
      snippet: subject,
      unread: true,
      hasAttachments: false,
      attachmentCount: 0,
      sensitivity: {
        sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false,
        priority: false,
      },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: "2026-09-07T08:00:00Z",
      seqHint: seq,
    },
  } as unknown as SyncChange;
}

describe("the standalone door", () => {
  it("drains through the engine in this runtime, and never through a network", async () => {
    const log: DoorLog = { urls: [], bearers: [] };
    const token = { value: "launch-token-1" };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "acct-standalone",
      localEngine: localDoor(log, [messageChange("m1", 1, "Welcome"), messageChange("m2", 2, "Your invoice")], token),
    });

    expect(boot.kind).toBe("ready");
    if (boot.kind !== "ready") return;

    await boot.engine.start();

    // THE MAIL IS IN THE MIRROR. Asserted through the engine's own reader rather than through a
    // call count: a composition that used the door and dropped the answer would satisfy the count.
    expect(boot.engine.read().list("message").length).toBe(2);

    // EVERY request went to the local door, on the absolute local base, and none to the network —
    // the `fetch` in `deps()` throws precisely so a fallback cannot be silent.
    expect(log.urls.length).toBeGreaterThan(0);
    expect(log.urls.every((u) => u.startsWith(`${LOCAL_ENGINE_ORIGIN}/`))).toBe(true);
    boot.store.close();
  }, 60_000);

  it("carries the engine's own bearer, read per request", async () => {
    const log: DoorLog = { urls: [], bearers: [] };
    const token = { value: "first" };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "acct-standalone",
      localEngine: localDoor(log, [messageChange("m1", 1, "Welcome")], token),
    });
    if (boot.kind !== "ready") throw new Error(sayRefusal(boot.reason));

    await boot.engine.start();
    expect(log.bearers.every((b) => b === "Bearer first")).toBe(true);

    // ROTATED MID-LAUNCH: the next request must carry the new one. A captured token would keep
    // sending the old value, which on a real door is a 401 on every request after a rotation.
    token.value = "second";
    const before = log.bearers.length;
    await boot.engine.syncOnce();
    expect(log.bearers.slice(before).every((b) => b === "Bearer second")).toBe(true);
    boot.store.close();
  }, 60_000);

  it("needs no credential from its caller — the engine mints its own", async () => {
    // A standalone install has nobody to be given a token by. It still needs an account id, which
    // is what keys the mirror.
    const log: DoorLog = { urls: [], bearers: [] };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "acct-standalone",
      localEngine: localDoor(log, [], { value: "t" }),
    });
    expect(boot.kind).toBe("ready");
    if (boot.kind === "ready") boot.store.close();
  }, 60_000);

  it("still refuses when the account id is missing", async () => {
    // The positive control's mirror image: "no credential needed" must not have become "nothing
    // needed". Without an account id the mirror has no owner and a wrong one costs a wipe.
    const log: DoorLog = { urls: [], bearers: [] };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "   ",
      localEngine: localDoor(log, [], { value: "t" }),
    });
    expect(boot).toMatchObject({ kind: "refused" });
  }, 60_000);

  it("refuses a local engine handed a remote address", async () => {
    const log: DoorLog = { urls: [], bearers: [] };
    const boot = await bootEngine(deps(), {
      origin: "https://mail.example.org",
      accountId: "acct-standalone",
      localEngine: localDoor(log, [], { value: "t" }),
    });
    // Refused rather than corrected: a caller passing both has not decided which it is talking to,
    // and keying the mirror by the other string would fork one install's copy of its own mailbox.
    expect(boot).toMatchObject({ kind: "refused" });
    if (boot.kind === "refused") expect(sayRefusal(boot.reason)).toContain(LOCAL_ENGINE_ORIGIN);
    expect(log.urls).toEqual([]);
  }, 60_000);

  it("opens the drain routes immediately, without asking the door about itself", async () => {
    const log: DoorLog = { urls: [], bearers: [] };
    const boot = await bootEngine(deps(), {
      origin: LOCAL_ENGINE_ORIGIN,
      accountId: "acct-standalone",
      localEngine: localDoor(log, [], { value: "t" }),
    });
    if (boot.kind !== "ready") throw new Error(sayRefusal(boot.reason));

    // The identity probe exists to catch a bearer belonging to a DIFFERENT account than the mirror
    // is keyed by — a remote server's answer about a locally stored id. There is no remote server
    // here and exactly one account, so running it would ask the local door a question about itself
    // and hold the drain shut for the full deadline with no route to answer.
    const before = log.urls.length;
    expect(await boot.verifyIdentity()).toEqual({ kind: "unverified" });
    expect(log.urls.slice(before)).toEqual([]);

    // And the drain works straight away rather than after a timeout.
    await boot.engine.start();
    expect(log.urls.length).toBeGreaterThan(before);
    boot.store.close();
  }, 60_000);
});

describe("the paired door, unchanged — the regression this file exists to catch", () => {
  it("still composes over a network transport with a static bearer", async () => {
    const seen: { url: string; bearer: string | null }[] = [];
    const changes = [messageChange("p1", 1, "Paired", "acct-remote")];
    const netFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      seen.push({ url, bearer: new Headers(init?.headers).get("authorization") });
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/auth/session") return json({ account: { id: "acct-remote" } });
      if (u.pathname === "/sync/snapshot") {
        return json({
          asOfSeq: 1,
          changes: changes.map((c, i) => ({ ...c, seq: i + 1 })),
          nextCursor: null,
          window: { days: 90, minRows: 5000 },
        });
      }
      if (u.pathname === "/sync") {
        return json({
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: encodeSeqCursor(1), hasMore: false, serverTime: new Date().toISOString(),
        });
      }
      if (u.pathname === "/sync/pull") return json({ results: [] });
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    };

    const boot = await bootEngine(deps({ fetch: netFetch }), {
      origin: "https://mail.example.org",
      accountId: "acct-remote",
      token: "paired-token",
    });
    if (boot.kind !== "ready") throw new Error(sayRefusal(boot.reason));

    // The probe RUNS on this door — the behaviour the standalone arm skips — and clears.
    expect((await boot.verifyIdentity()).kind).not.toBe("mismatch");
    await boot.engine.start();

    expect(boot.engine.read().list("message").length).toBe(1);
    expect(seen.every((s) => s.url.startsWith("https://mail.example.org/"))).toBe(true);
    expect(seen.every((s) => s.bearer === "Bearer paired-token")).toBe(true);
    // And it really did reach for the network seam rather than a local door.
    expect(seen.some((s) => s.url.includes("/auth/session"))).toBe(true);
    boot.store.close();
  }, 60_000);
});

/* ── A provider that says why it refused the sign-in ───────────────────────────────────────────── */

describe("a refused sign-in the engine stamped with why", () => {
  const SECRET = "hinted-door-password-value";
  const preset = authHintPreset();
  const form = { ...EMPTY_STANDALONE, address: "someone@example.test", password: SECRET,
                 imapHost: preset.imap.host, imapPort: "993", imapTls: true };
  const pressWith = (thrown: unknown) => openStandaloneMailbox(form, {
    startEngine: (async () => { throw thrown; }) as never,
    platform: async () => ({ kind: "ready" as const, exec: {}, keks: {} }),
    machineName: () => "ohmail on a phone",
    installId: async () => "hinted-case",
  });
  /** imapflow's refused login, as the engine rethrows it with its stamp (`mobile.ts`). */
  const refused = (stamp: Record<string, unknown> = {}) =>
    Object.assign(new Error("Command failed"), { authenticationFailed: true, ...stamp });
  const catalogue = (lang: "en" | "de"): Record<string, string> =>
    (JSON.parse(readFileSync(new URL(`../../webapp/messages/${lang}.json`, import.meta.url), "utf8")) as {
      mailboxes: Record<string, string>;
    }).mailboxes;
  /* The deck key for each hint, in `AUTH_HINTS`' order. */
  const KEYS: Record<string, string> = Object.fromEntries(AUTH_HINTS.map((h, i) => [h, [
    "standaloneAuthAppOnly", "standaloneAuthWebLogin", "standaloneAuthImapDisabled", "standaloneAuthInvalid",
  ][i]!]));

  afterEach(() => { resetLocaleRegisterForTests(); });

  for (const [hint, key] of Object.entries(KEYS)) {
    it(`${hint}: its own sentence, the web's words in both languages, and never the password`, async () => {
      const out = await pressWith(refused({ authHint: hint }));
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason.say).toBe(key);
      for (const lang of ["en", "de"] as const) {
        setActiveLocale(lang);
        // The web catalogue's key is spelled from the table's id: no provider word in this tree.
        expect(sayRefusal(out.reason), lang).toBe(catalogue(lang)[`probe_auth_${preset.id}_${hint}`]);
        expect(sayRefusal(out.reason), lang).not.toContain(SECRET);
      }
      expect(JSON.stringify(out.reason)).not.toContain(SECRET);
      const links = refusalLinks(out.reason);
      expect(links === null ? [] : links.map((l) => l.url))
        .toEqual(hint === "app_password_required" || hint === "invalid" ? [preset.prereqUrl, preset.helpUrl] : []);
    });
  }

  it("found through a wrapping cause", async () => {
    const out = await pressWith(new Error("wrapped", { cause: refused({ authHint: "web_login" }) }));
    expect(out.ok ? null : out.reason.say).toBe("standaloneAuthWebLogin");
    expect(authHintOf(new Error("wrapped", { cause: refused({ authHint: "invalid" }) }))).toBe("invalid");
  });

  it("control: no stamp, or a word outside the set, is the generic refusal", async () => {
    for (const thrown of [refused(), refused({ authHint: "constructor" }), refused({ authHint: 7 })]) {
      const out = await pressWith(thrown);
      expect(out.ok ? null : out.reason.say).toBe("standaloneSignInRefused");
      expect(out.ok ? null : refusalLinks(out.reason)).toBeNull();
    }
  });
});

/* ── Connect's refusals, in the order a person needs them ─────────────────────────────────────── */

describe("the fourth door's refusals, worded and ranked", () => {
  const SECRET = "door-arms-password-password";
  const form = { ...EMPTY_STANDALONE, address: "someone@example.test", password: SECRET,
                 imapHost: "imap.example.test", imapPort: "993", imapTls: true };
  const pressWith = (thrown: unknown) => openStandaloneMailbox(form, {
    startEngine: (async () => { throw thrown; }) as never,
    platform: async () => ({ kind: "ready" as const, exec: {}, keks: {} }),
    machineName: () => "ohmail on a phone",
    installId: async () => "door-arms-case",
  });
  const said = async (thrown: unknown): Promise<string | null> => {
    const out = await pressWith(thrown);
    return out.ok ? null : out.reason.say;
  };
  /** What the TLS shim stamps on a handshake the platform refused (`shims/tls.js`). */
  const certificate = (kind?: string) => Object.assign(new Error("the platform refused the certificate"),
    { tlsFailed: true, certificateRefused: true, ...(kind !== undefined ? { certificateKind: kind } : {}) });
  /** What the composition throws when the incoming server did not answer (`mobile.ts`). */
  const unanswered = (why: string) => Object.assign(new Error(`the incoming server could not be reached (${why})`),
    { incomingUnreachable: why });

  afterEach(() => { resetLocaleRegisterForTests(); });

  it("names each kind of certificate refusal, and the generic one where the platform said no more", async () => {
    for (const [kind, key] of [
      ["untrusted", "standaloneCertificateUntrusted"],
      ["hostname_mismatch", "standaloneCertificateName"],
      ["expired", "standaloneCertificateExpired"],
      ["not_yet_valid", "standaloneCertificateNotYetValid"],
      [undefined, "standaloneCertificateRefused"],
      ["a kind this build has never heard of", "standaloneCertificateRefused"],
    ] as const) {
      expect(await said(certificate(kind)), String(kind)).toBe(key);
    }
  });

  it("names an incoming server it could not reach, whether it refused or never answered", async () => {
    expect(await said(unanswered("unreachable"))).toBe("standaloneImapUnreachable");
    expect(await said(unanswered("timeout"))).toBe("standaloneImapUnreachable");
    // CONTROL: an error carrying nothing of the kind is still the engine's own words.
    expect(await said(new Error("something else entirely"))).toBe("standaloneRefused");
  });

  it("reads the kind and the unreachable answer through a wrapping cause, and nothing else as either", () => {
    expect(certificateKindOf(new Error("wrapped", { cause: certificate("expired") }))).toBe("expired");
    expect(incomingUnreachable(new Error("wrapped", { cause: unanswered("timeout") }))).toBe("timeout");
    expect(certificateKindOf(certificate())).toBeNull();
    expect(certificateKindOf(Object.assign(new Error("x"), { certificateKind: "vanilla" }))).toBeNull();
    expect(incomingUnreachable(Object.assign(new Error("x"), { incomingUnreachable: "elsewhere" }))).toBeNull();
    expect(incomingUnreachable(new Error("ECONNREFUSED"))).toBeNull();
  });

  it("ranks them: the outgoing server, the sign-in, the certificate, encryption, an unreachable server, the rest", async () => {
    const everything = Object.assign(certificate("untrusted"), { submissionRefused: "auth", authenticationFailed: true, incomingUnreachable: "unreachable" });
    expect(await said(everything)).toBe("standaloneSmtpSignInRefused");
    expect(await said(Object.assign(certificate("untrusted"), { authenticationFailed: true }))).toBe("standaloneSignInRefused");
    expect(await said(Object.assign(certificate("expired"), { incomingUnreachable: "timeout" }))).toBe("standaloneCertificateExpired");
    expect(await said(Object.assign(new Error("no STARTTLS"), { tlsFailed: true, incomingUnreachable: "timeout" }))).toBe("standaloneNoEncryption");
    expect(await said(unanswered("unreachable"))).toBe("standaloneImapUnreachable");
  });

  it("puts the password in none of them, in either language", async () => {
    for (const thrown of [certificate("untrusted"), certificate("hostname_mismatch"), certificate("expired"),
      certificate("not_yet_valid"), certificate(), unanswered("unreachable")]) {
      const out = await pressWith(thrown);
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      for (const lang of ["en", "de"] as const) {
        setActiveLocale(lang);
        expect(sayRefusal(out.reason), `${out.reason.say} in ${lang}`).not.toContain(SECRET);
      }
      expect(JSON.stringify(out.reason)).not.toContain(SECRET);
    }
  });

  it("wears the incoming server's field for a host to fix, and the verb's line for the server's own certificate", () => {
    expect(refusalField(refuse("standaloneImapUnreachable"))).toBe("imapHost");
    expect(refusalField(refuse("standaloneCertificateName"))).toBe("imapHost");
    expect(refusalField(refuse("standaloneCertificateRefused"))).toBe("imapHost");
    expect(refusalField(refuse("standaloneCertificateUntrusted"))).toBeNull();
    expect(refusalField(refuse("standaloneCertificateExpired"))).toBeNull();
    expect(refusalField(refuse("standaloneCertificateNotYetValid"))).toBeNull();
  });

  it("says the desktop's sentences, and the web catalogue's German", () => {
    const de = (JSON.parse(readFileSync(new URL("../../webapp/messages/de.json", import.meta.url), "utf8")) as {
      mailboxes: Record<string, string>;
    }).mailboxes;
    const stopped = "so we stopped before sending the password.";
    expect(EN.standaloneCertificateUntrusted).toBe(`That mail server's certificate is not issued by a trusted authority, ${stopped} Ask whoever runs the server to install a certificate from a public authority.`);
    expect(EN.standaloneCertificateName).toBe(`That mail server's certificate does not match the host you entered, ${stopped} Check the IMAP host with your provider.`);
    expect(EN.standaloneCertificateExpired).toBe(`That mail server's certificate has expired, ${stopped} Ask whoever runs the server to renew it.`);
    expect(EN.standaloneCertificateNotYetValid).toBe(`That mail server's certificate is not valid yet, ${stopped} Check with whoever runs the server.`);
    expect(EN.standaloneCertificateRefused).toBe(`That mail server's certificate was refused, ${stopped} Check the IMAP host, and whether the port expects TLS.`);
    expect(DE.standaloneCertificateUntrusted).toBe(de.probe_tls_untrusted);
    expect(DE.standaloneCertificateExpired).toBe(de.probe_tls_expired);
    expect(DE.standaloneCertificateNotYetValid).toBe(de.probe_tls_not_yet_valid);
    expect(DE.standaloneCertificateRefused).toBe(de.probe_tls);
    for (const deck of [EN, DE]) expect(deck.standaloneImapUnreachable).toContain("IMAP");
  });
});
