import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

// Every test here stands up the real sidecar (createSidecar boots the engine's PGlite and
// runs its migrations) in the test body — see pglite-budget.ts for the measured cost.
vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * `GET /hello` ON THE LOCAL DOOR — the desktop engine states what it is.
 *
 * A client's server picker negotiates against `/hello` on every composition, and this one must
 * answer `flavor: "local"`: a picker that reads "managed" or "selfhost" here would offer sign-in
 * ceremonies this process does not have. The auth block is all-false and that is the composition's
 * truth rather than a gap — the engine mints one session per launch for the shell that spawned
 * it, so there is no ceremony a remote caller could be offered; `needsSetup` is false for the
 * same reason (the world is created at first boot, never through a setup page).
 *
 * Driven through `sidecar.handle`, the same entry the stdio bridge serves, with `adapterFactory`
 * injected so no IMAP connection is opened — this is the real composition root answering, not an
 * imitation of it.
 */

const dirs: string[] = [];
const sidecars: Sidecar[] = [];

afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function standUp(): Promise<Sidecar> {
  const dir = await freshDataDir("ohmail-sidecar-hello-");
  dirs.push(dir);
  const sidecar = await createSidecar({
    dataDir: dir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "mila@example.test", pass: "app-password-9f3a" } },
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
  });
  sidecars.push(sidecar);
  return sidecar;
}

describe("GET /hello — the local engine's capability statement", () => {
  it("answers flavor local, needsSetup false, no sign-in ceremonies, and the frozen keys", async () => {
    const sidecar = await standUp();
    const res = await sidecar.handle(new Request("http://sidecar/hello"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    // The frozen wire shape, exact — the same census the API package's contract test pins, so
    // the two suites fail together if the shape and a composition ever disagree.
    expect(Object.keys(body).sort()).toEqual(
      ["apiVersion", "auth", "features", "flavor", "needsSetup", "product"],
    );
    expect(body.product).toBe("ohmail");
    expect(body.flavor).toBe("local");
    expect(body.needsSetup).toBe(false);
    expect(body.auth).toEqual({ password: false, totp: false, webauthn: false, publicSignup: false });
    // A fresh install has no model configured, SSE is disabled in this host, and there is no
    // object storage to stage into. `pairing: false` is the DISARMED reading — this install
    // composes no `hostMode`, so no mint is mounted and the descriptor says so. It used to be
    // pinned here as false-for-good; host mode falsified that, and the ARMED reading
    // (`pairing: true`, the mint answering) is pinned beside the disarmed one in
    // `host-mode.e2e.test.ts` — both directions, so neither composition can lie.
    /* `accountHeader` is a CONSTANT of the BUILD, not a host choice: the route table sets it
       `true` outright because `createApp.handle` sets `X-Ohmail-Account` in every composition
       compiled from that table, and a capability a host could contradict is worse than none. It
       is pinned HERE, in the frozen key set, because its whole use is negotiation by ABSENCE — a
       client requires the header only from a server that advertises it, so the day this key stops
       being sent every older client silently stops requiring it. That is exactly the change a
       frozen `toEqual` exists to catch. */
    expect(body.features).toEqual({
      sse: false, staging: false, ai: false, pairing: false,
      /* This door's image proxy fetches — the composition wires the real egress and the gate's
         own resolver. It was effectively `false` while that fetch was a refusal, and the route
         being mounted never said otherwise, which is why the word exists. */
      remoteImages: true, accountHeader: true, forwardParts: true,
    });
  });

  it("needs no credential — the whole point of a negotiation endpoint", async () => {
    const sidecar = await standUp();
    // No authorization header at all: unlike every product route, this must not 401.
    const res = await sidecar.handle(new Request("http://sidecar/hello"));
    expect(res.status).toBe(200);
  });
});
