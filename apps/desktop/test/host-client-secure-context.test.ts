import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ═══ THE SECURE-CONTEXT AUDIT, ENCODED — why the LAN door is API-only ════════════════════════
 *
 * The LAN fallback serves `http://<lan-ip>:<port>` — plain HTTP on a non-loopback host, which no
 * browser treats as a secure context. The decision to ship that door API-ONLY (an explainer page
 * instead of the browser client) rests on an audit of what the served client actually uses, and
 * this file pins the audit's findings AS FINDINGS: each test asserts that a specific
 * `[SecureContext]`-gated dependency still exists in the source it was found in.
 *
 * **If one of these goes red, that is not a failure to silence — it is the premise of the
 * API-only ruling dissolving.** Whoever removes or guards the dependency should revisit whether
 * the LAN door can now serve the full browser client (`apps/sidecar/src/host-lan.ts`, the pane
 * copy in `DesktopDevices.tsx`, and the `lanOptionWhy`/`lanBrowserNote` messages), not merely
 * update this test. The other half of the ruling — the auth origin model refusing non-loopback
 * `http:` origins — is pinned where it lives (`packages/services`' origin suite) and would have
 * to move too.
 *
 * Source-reading tests are brittle by nature; these read for one expression each and say why.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), "utf8");

describe("the served browser client's secure-context dependencies (the API-only premise)", () => {
  it("the shared shell calls crypto.randomUUID() bare in the tag flows — absent on an insecure origin, so the flow would throw", () => {
    const shell = read("../../webapp/app/shell/AppShell.tsx");
    // `crypto.randomUUID` is [SecureContext]: on `http://<lan-ip>` it is undefined and the call
    // is a TypeError. Two call sites at the time of the audit (createTag, createTagAlone).
    expect(shell).toMatch(/crypto\.randomUUID\(\)/);
  });

  it("the bearer manager's cross-tab rotation lock is navigator.locks — absent on an insecure origin, where a two-tab double-present reads as theft and unpairs the phone", () => {
    const bearer = read("../src/host-client/bearer.ts");
    expect(bearer).toContain("navigator.locks");
    // The manager itself documents that the bare fallback cannot close the double-present
    // window; on this door's strict reuse detection that residual is a family revocation.
    expect(bearer).toContain("it cannot close it");
  });
});

describe("the auth origin model's half of the ruling", () => {
  it("normalizeOrigin refuses non-loopback http — a LAN origin can never enter a request-guard allow-list", () => {
    const origins = readFileSync(
      join(here, "../../../packages/services/src/auth/origins.ts"), "utf8");
    expect(origins).toContain('u.protocol === "http:" && !isLoopback(u.hostname)');
  });
});
