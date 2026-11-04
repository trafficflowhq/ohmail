import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import {
  DEFAULT_NET_TIMEOUTS, WORKER_NET_TIMEOUTS, imapFlowOptions,
  type ImapConfig, type MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import { SIDECAR_NET_TIMEOUTS, createSidecar, type AdapterDialContext } from "../src/engine.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT DEADLINE THIS PROCESS DIALS WITH
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ImapAdapter.connect()` is one line — `new ImapFlow(imapFlowOptions({ ...this.config, auth }))`
 * — and `imapFlowOptions` resolves `{ ...DEFAULT_NET_TIMEOUTS, ...config.timeouts }`. So the
 * number the socket's inactivity timer actually gets is a pure function of the `ImapConfig` this
 * engine builds, and that is what this file measures: the sidecar's own dialled config, run
 * through the adapter's own resolver.
 *
 * ── WHY NOT A STALLED SERVER ──────────────────────────────────────────────────────────────
 *
 * The defect's shape is "a live connection with nothing on the wire for longer than `socketMs`",
 * so reproducing it end to end costs a real socket and a stall longer than the deadline — a
 * 30-second test to measure a constant that the adapter derives synchronously and purely. The
 * function under `imapFlowOptions` is the same one production calls, with the same argument, so
 * the answer is the same answer; what a stall would add is coverage of imapflow, not of this
 * engine. The release check's first-sync cell is where the whole path is exercised.
 *
 * `DEFAULT_NET_TIMEOUTS.socketMs` is 25 s, chosen — its own comment says so — against a
 * 60-second serverless invocation ceiling. A desktop install is not that: it holds its
 * connections for the life of the window and goes quiet between fetches, and imapflow arms IDLE
 * only some seconds after the last command and only with a mailbox SELECTED. Measured on the phone build
 * of this engine: a small mailbox finishes its first sync, and larger ones die with
 * `NoConnection` partway through.
 */

const HOUR = 60 * 60 * 1000;

describe("the sidecar dials with the persistent-process deadlines", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /** The `ImapConfig` the engine hands its dial — captured through the factory seam. */
  async function dialledConfig(): Promise<ImapConfig> {
    const dir = await freshDataDir("ohmail-dial-timeouts-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    let captured: ImapConfig | null = null;
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine that was left open",
      // Long enough that the timer never fires on its own; nothing here drains.
      pollIntervalMs: 60 * HOUR,
      adapterFactory: (cfg: ImapConfig, _ctx: AdapterDialContext): MailboxAdapter => {
        captured ??= cfg;
        /* NEVER DIALLED. This file measures the configuration, so the adapter only has to exist;
           every method throws rather than answering, because a double that quietly answered
           would let a test that accidentally drove a drain pass for the wrong reason. */
        return new Proxy({} as MailboxAdapter, {
          get: () => (): never => { throw new Error("this test never dials"); },
        });
      },
      log: () => {},
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    expect(captured, "the engine built no dial at all").not.toBeNull();
    return captured!;
  }

  it("THE SOCKET DEADLINE IS THE PERSISTENT ONE, not the serverless default", async () => {
    const cfg = await dialledConfig();

    /* THE RESOLVER THE ADAPTER ITSELF USES, on the config the engine itself built. `socketTimeout`
       is the key imapflow hands to the socket's inactivity timer. */
    const resolved = imapFlowOptions({ ...cfg, auth: { user: cfg.auth.user, pass: "x" } });
    expect(
      resolved.socketTimeout,
      "the sidecar dials with the serverless socket deadline: a quiet stretch longer than it — "
      + "which a first sync of a large mailbox produces between fetches, with no IDLE armed — "
      + "kills a connection that is perfectly healthy",
    ).toBe(WORKER_NET_TIMEOUTS.socketMs);
    expect(
      resolved.socketTimeout,
      "the dialled socket deadline is no longer above the serverless default",
    ).toBeGreaterThan(DEFAULT_NET_TIMEOUTS.socketMs);
    // The connect and greeting halves are unchanged by this: a dial that cannot be established in
    // fifteen seconds is a dial worth abandoning on any host.
    expect(resolved.connectionTimeout).toBe(DEFAULT_NET_TIMEOUTS.connectionMs);
    expect(resolved.greetingTimeout).toBe(DEFAULT_NET_TIMEOUTS.greetingMs);
  }, 60_000);

  it("THE SIDECAR'S SET IS THE WORKER'S SET — a divergence has to be somebody's decision", () => {
    /* `SIDECAR_NET_TIMEOUTS` is an ALIAS, so this cannot fail by drift today. It can fail the
       moment somebody makes it a literal, which is exactly when the two numbers should be
       compared by a person rather than by nobody. */
    expect(SIDECAR_NET_TIMEOUTS).toEqual(WORKER_NET_TIMEOUTS);
  });

  /**
   * THE CENSUS. One construction site today, and the rule is about the NEXT one.
   *
   * A future dial added with no `timeouts` inherits the serverless default silently — nothing
   * fails, nothing logs, and the symptom is a connection that dies on a slow link with a mailbox
   * big enough. So the check is structural: every `new ImapAdapter(` under `apps/sidecar/src` is
   * given a config the engine has put deadlines on.
   */
  it("EVERY DIAL THIS PACKAGE BUILDS CARRIES DEADLINES", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const sites: Array<{ file: string; ok: boolean }> = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(join(src, name), "utf8");
      // Comments stripped first: several headers in this package DISCUSS `new ImapAdapter(`, and
      // a census that counted prose would be measuring the documentation.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      for (const m of code.matchAll(/new ImapAdapter\(\s*([A-Za-z_$][\w$]*)/g)) {
        const configName = m[1]!;
        /* The config identifier is followed to its construction: the deadlines are set on the
           OBJECT, not at the call, so a site that names a config assembled with `timeouts` is
           covered and one that names a bare passthrough is not. */
        const assembled = new RegExp(
          `const ${configName}\\s*:\\s*ImapConfig\\s*=\\s*\\{[\\s\\S]*?\\btimeouts\\s*:`,
        ).test(code);
        sites.push({ file: name, ok: assembled });
      }
    }
    expect(sites.length, "the census found no `new ImapAdapter(` at all — it is measuring nothing")
      .toBeGreaterThan(0);
    expect(
      sites.filter((s) => !s.ok).map((s) => s.file),
      "an IMAP dial is built in this package from a config with no `timeouts`, so it inherits the "
      + "25 s serverless socket deadline",
    ).toEqual([]);
  });
});
