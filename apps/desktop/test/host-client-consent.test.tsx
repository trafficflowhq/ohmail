/** @vitest-environment jsdom */
import { describe, expect, expectTypeOf, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConsentTransport } from "@ohmail/app-logic/consent/consent-state";
import type { ConsentStateWire as StandInConsentRead } from "../src/no-api-client.js";
import { capturePairedFrame } from "../../../test/paired-host/paired-frame-capture.js";

/**
 * ═══ THE PAIRED PHONE'S CONSENT ROW — the wire the host door was not handing in ══════════════
 *
 * ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────────────────────
 *
 * `HostGate` mounts the SAME shell the desktop window mounts, and this artifact aliases
 * `app/api-client` to a refusing stub exactly as the window's does. `useConsentState` decides
 * whether to ask at all from `transport !== undefined || apiConfigured()`, so with no transport
 * and no Cloud client the hook rested: `known` false, and the screening window, the dormancy
 * dial and the remote-image, tracking-pixel and auto-unsubscribe rows all withheld — on a door
 * whose host serves every one of those routes one hop away (`desktopHostRoutes` spreads
 * `localRoutes`, which mounts `consentRoutes`). The desktop's own window had the wire; the phone
 * paired to it did not, for no stated reason.
 *
 * ── WHAT IS MEASURED HERE ───────────────────────────────────────────────────────────────────
 *
 * The composition, driven: the gate renders with a bearer whose transport RECORDS, the wire it
 * hands the shell is taken from the render and used, and the calls are compared with the desktop
 * window's own transport — both are one `consentVia` call, so a call added on one door and not
 * the other is a build error here rather than a surface missing on a phone. What the controls
 * ABOVE the seam do with the answers is the shared shell's and lives in `apps/webapp/test`.
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

/* The capture of what `HostGate` handed today's `AppShell` (a mock of today's shell, the gate rendered over a
   recording bearer) left with that shell: no case of this file read it any more, and the gate mounts the new frame
   (`MailFrame`). What the paired page hands the frame is read in `host-client-outbox-gate.test.tsx`. */

describe("the consent wire a paired device's gate hands the shared shell", () => {

  /* The pane reads WHY a write was refused from the envelope's code and details, as the web's
     `ApiError` carries them; a door that kept only the sentence left the pane saying "try again". */
  it("a refused write keeps the envelope's status, code and details", async () => {
    const details = { reason: "no_organizer", by: null };
    const host = await capturePairedFrame(async (_input, init) => init?.method === "PATCH"
      ? Response.json({
        error: { code: "organized_elsewhere", message: "nothing organizes this mailbox", details },
      }, { status: 409 })
      : Response.json({ dormancyDays: 30 }));
    expect(host.wires.consent).not.toBe("none");
    const wire = host.wires.consent as ConsentTransport;
    expect(wire.foldersStorable).toBe(false);
    await expect(wire.state()).resolves.toMatchObject({ dormancyDays: 30 });
    await expect(wire.setMailboxSignature("mb-one", "-- mine")).rejects.toMatchObject({
      status: 409, code: "organized_elsewhere", details, message: "nothing organizes this mailbox",
    });
  });

  it("the routes it asks for are served on the paired-device table", () => {
    /* A cross-package read rather than an import: `apps/desktop` does not depend on the api
       package. `desktopHostRoutes` spreads `localRoutes`, and `localRoutes` mounts the consent
       group — a dropped spread on either line reddens this. */
    expect(read("packages/api/src/routes/desktop-host.ts")).toContain("...localRoutes,");
    expect(read("packages/api/src/routes/local.ts"))
      .toContain("...withoutFoldersFlag(consentRoutes)");
    const consentSrc = read("packages/api/src/routes/consent.ts");
    expect(consentSrc).toContain('pattern: "/consent"');
    expect(consentSrc).toContain('pattern: "/consent/settings"');
  });

  /* The desktop's stand-in for the server client restates the consent read, and the shared hook declares the read it
     takes. Held here by the compiler, beside the stand-in: no file of the web app may import this app to say it. */
  it("the read the client's stand-in declares is one the consent row takes", () => {
    expectTypeOf<StandInConsentRead>().toMatchTypeOf<Awaited<ReturnType<ConsentTransport["state"]>>>();
  });
});
