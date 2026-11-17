import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { ImapAdapter, ImapConnectionClosedError } from "../../src/adapters/imap.js";

/**
 * THE LISTENERS, TESTED AT THE LINE — the kill mechanism of 2026-08-02 and the silence of
 * 2026-08-04.
 *
 * `ImapFlow` extends `EventEmitter` and reports an asynchronous connection FAILURE — a dead
 * socket, a server `BYE`, an `ETIMEOUT` from imapflow's own `_socketTimeout` handler when the
 * client is not idling — by EMITTING `error`. Node throws when `error` is emitted with no
 * listener, `packages/organizer/src/entry.ts` answers uncaught exceptions with `exit(1)` by design, and
 * so one mailbox's socket ended the whole worker every ~26 s for eight minutes.
 *
 * ── AND A CONNECTION THAT MERELY *ENDS* EMITS SOMETHING ELSE ENTIRELY ──────────
 *
 * imapflow's `_socketClose` / `_socketEnd` / failed-IDLE-recovery paths all call `this.close()`,
 * and `close()` emits **`close`** — never `error`. The adapter listened for `error` only, so on
 * one day both production mailboxes stopped syncing for many minutes with ZERO connection events
 * anywhere in the log: `onConnectionError` never fired, the worker's `handleConnectionError` never
 * ran, and the IDLE handlers registered in `watch()` sat on a dead emitter that would never speak
 * again. The `close` block below is the fix, and the two suppression cases beside it are the two
 * ways routing `close` into an error callback goes wrong.
 *
 * ── WHY THIS FILE AND NOT `apps/worker/test` ────────────────────────────────────────────────
 *
 * `guardAsyncErrors` returns early for a client with no `.on` — which is EVERY fake in the worker
 * suite, including the fake fleet that drives `dead-connection.e2e.test.ts`. There is no worker-level
 * test that can reach these lines at all, so a `close` fix without this file would be
 * built-tested-unreachable on the day it shipped. `apps/worker/test/connection-error.e2e.test.ts`
 * proves what the worker DOES with the event; this proves the event is heard.
 */

/** The smallest client `ImapAdapter.connect()` accepts, on a real EventEmitter. */
class FakeClient extends EventEmitter {
  logouts = 0;
  async list(): Promise<Array<{ path: string; name: string; delimiter: string; flags: Set<string> }>> {
    return [{ path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() }];
  }
  /**
   * imapflow's `logout()` ends by calling its own `close()`, which EMITS `close`. Reproduced here
   * rather than stubbed away, because the suppression this file asserts is only meaningful against a
   * client that actually emits on a deliberate teardown — a `logout` that emitted nothing would make
   * the "a clean close is silent" test pass for the wrong reason.
   */
  async logout(): Promise<void> {
    this.logouts++;
    this.emit("close");
  }
}

const CONFIG = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

describe("ImapAdapter — asynchronous connection errors", () => {
  it("an emitted `error` does not throw, and reaches onConnectionError", async () => {
    const client = new FakeClient();
    const seen: unknown[] = [];
    const adapter = new ImapAdapter(CONFIG, {
      client, onConnectionError: (err) => { seen.push(err); },
    });
    await adapter.connect();

    const err = Object.assign(new Error("socket timeout"), { code: "ETIMEOUT" });
    // Unhandled, this line throws. That is the entire outage, in one statement.
    expect(() => client.emit("error", err)).not.toThrow();
    expect(seen).toEqual([err]);
  });

  it("swallows it even with NO callback — containment must not depend on being asked for", async () => {
    // The property is "this process stays alive", and a property contingent on a construction
    // option somebody remembered to pass is not a property.
    const client = new FakeClient();
    const adapter = new ImapAdapter(CONFIG, { client });
    await adapter.connect();
    expect(() => client.emit("error", new Error("BYE"))).not.toThrow();
  });

  it("a callback that itself throws cannot re-raise the crash one frame further out", async () => {
    const client = new FakeClient();
    const adapter = new ImapAdapter(CONFIG, {
      client, onConnectionError: () => { throw new Error("handler is broken"); },
    });
    await adapter.connect();
    expect(() => client.emit("error", new Error("socket timeout"))).not.toThrow();
  });
});

describe("ImapAdapter — a connection that ENDS", () => {
  it("an emitted `close` reaches onConnectionError — the 52 minutes of 2026-08-04", async () => {
    // THE LINE THAT WAS MISSING. imapflow emits `close`, not `error`, when a connection ends:
    // `_socketClose`/`_socketEnd` call `close()` and `close()` emits `close`. Before this listener
    // existed, this statement was heard by nothing at all — the worker kept a client object that
    // threw `NoConnection` from every subsequent command, reported itself `leader` and `serving`,
    // and healed only on a process restart.
    const client = new FakeClient();
    const seen: unknown[] = [];
    const adapter = new ImapAdapter(CONFIG, {
      client, onConnectionError: (err) => { seen.push(err); },
    });
    await adapter.connect();

    expect(() => client.emit("close")).not.toThrow();
    expect(seen, "a `close` event did not reach the connection's owner").toHaveLength(1);
    // The class and the code ARE the payload: `log.ts` reduces any `err` field to exactly `name` +
    // `code` and discards the message, so these two are the entire production record of the event —
    // and they are distinguishable from the `Error`/`ETIMEOUT` a genuine socket failure produces.
    expect(seen[0]).toBeInstanceOf(ImapConnectionClosedError);
    expect((seen[0] as { name: string }).name).toBe("ImapConnectionClosedError");
    expect((seen[0] as { code: string }).code).toBe("EIMAPCLOSED");
  });

  it("a DELIBERATE close() is silent — risk 4, log noise masquerading as errors", async () => {
    // `adapter.close()` is reached by a roster pass dropping a disabled mailbox, a stand-down, a
    // quarantine, the new lease-unavailable detach and `stop()`. Every one of those is intended, and
    // imapflow's own `logout()` emits `close` on the way out — so without the suppression EVERY
    // clean teardown would log `mailbox_connection_error` at error level and enqueue a detach for a
    // mailbox that is already gone. An error line that fires on the happy path is an error line
    // nobody reads.
    const client = new FakeClient();
    const seen: unknown[] = [];
    const adapter = new ImapAdapter(CONFIG, {
      client, onConnectionError: (err) => { seen.push(err); },
    });
    await adapter.connect();
    await adapter.close();

    expect(client.logouts, "the teardown did not go through logout — the test proves nothing").toBe(1);
    expect(seen, "a deliberate close was reported as a connection fault").toEqual([]);
    // …and a LATE `close` for the same teardown (imapflow can emit after the logout resolves) stays
    // suppressed too: the flag is not reset until the adapter is re-dialled.
    client.emit("close");
    expect(seen).toEqual([]);
  });

  it("a `close` while connect() is still running belongs to the awaited path, not to this listener", async () => {
    // `guardAsyncErrors` is attached BEFORE the dial on purpose (imapflow's `emitError` routes to
    // `initialReject` only while the connect promise is pending). Without the `established` guard, a
    // connection that never came up would be reported TWICE — once by the rejection the caller is
    // holding and once out of band at error level, with no runtime to own it. `attach()` already
    // quarantines the mailbox with the real error; a second, vaguer line about the same mailbox is
    // strictly worse than none.
    class ClosesDuringList extends FakeClient {
      override async list(): Promise<Array<{ path: string; name: string; delimiter: string; flags: Set<string> }>> {
        this.emit("close");
        return super.list();
      }
    }
    const client = new ClosesDuringList();
    const seen: unknown[] = [];
    const adapter = new ImapAdapter(CONFIG, {
      client, onConnectionError: (err) => { seen.push(err); },
    });
    await adapter.connect();
    expect(seen, "a close during connect() was reported out of band as well as awaited").toEqual([]);

    // …and the connection is live afterwards, so a REAL later death is still heard. This half is
    // what stops the guard above from being satisfiable by simply never reporting anything.
    client.emit("close");
    expect(seen).toHaveLength(1);
  });

  it("swallows a `close` with NO callback — containment must not depend on being asked for", async () => {
    const client = new FakeClient();
    const adapter = new ImapAdapter(CONFIG, { client });
    await adapter.connect();
    expect(() => client.emit("close")).not.toThrow();
  });

  it("a callback that throws on `close` cannot re-raise one frame further out", async () => {
    const client = new FakeClient();
    const adapter = new ImapAdapter(CONFIG, {
      client, onConnectionError: () => { throw new Error("handler is broken"); },
    });
    await adapter.connect();
    expect(() => client.emit("close")).not.toThrow();
  });

  it("reports ONCE per connection, so a repeated `close` cannot double the detach", async () => {
    const client = new FakeClient();
    const seen: unknown[] = [];
    const adapter = new ImapAdapter(CONFIG, {
      client, onConnectionError: (err) => { seen.push(err); },
    });
    await adapter.connect();

    client.emit("close");
    client.emit("close");
    client.emit("close");
    expect(seen, "one dead connection was reported three times").toHaveLength(1);
  });
});
