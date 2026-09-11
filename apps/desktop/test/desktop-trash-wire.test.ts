import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { trashVia, TrashBridgeError } from "../src/trash-wire.js";
import { trashOverBridge } from "../src/local-trash.js";

/**
 * THE LIVE TRASH WINDOW'S DESKTOP TRANSPORT — the requests that leave, and the verb that does not.
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────────────────────
 *
 * The window's server half shipped on `localRoutes` and on the relay allowlist, so both desktop
 * doors could answer it. The section still never appeared: the shared hook reached for
 * `app/api-client`, which this build aliases to a refusing stub, so it could only ever report "no
 * server" and `AppShell` withheld the control — nothing on screen, no state naming why. The fix is
 * the Junk window's seam (`TrashWire`) plus this transport.
 *
 * ── WHY THE ASSERTIONS ARE ON THE REQUESTS ──────────────────────────────────────────────────
 *
 * Everything that decides what the reader SEES — the six states, the session body cache, the
 * dedupe against ohmail's own deletes — is the shared shell's and cannot be varied here. What only
 * this file can get wrong is what goes down the pipe, so that is what is measured: the two paths,
 * the epoch that travels with a UID, and the fact that every call is a bare GET.
 */

/** A transport that records every call and answers whatever the test queued. */
function recorder(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ path: string; init: unknown }> = [];
  const fetchImpl = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path, init });
    const a = answers.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(a.body ?? {}), {
      status: a.status, headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

const PAGE = { mailboxes: [], items: [], nextCursor: null };

describe("the paths the desktop's Trash window asks for", () => {
  it("the list is the bare route, and a cursor rides as an ENCODED query", async () => {
    const r = recorder([{ status: 200, body: PAGE }, { status: 200, body: PAGE }]);
    const wire = trashVia(r.fetchImpl);

    await wire.list();
    await wire.list({ cursor: "a b/c+d" });

    expect(r.calls[0]!.path).toBe("/trash/window");
    // Encoded, not interpolated raw: a cursor is the server's own opaque token and carries
    // whatever it likes. An unencoded `+` arrives as a space and pages the wrong place.
    expect(r.calls[1]!.path).toBe("/trash/window?cursor=a%20b%2Fc%2Bd");
  });

  it("the body carries the mailbox, the uid AND the epoch — all three, encoded", async () => {
    const r = recorder([{ status: 200, body: { subject: "s", text: "t" } }]);
    const wire = trashVia(r.fetchImpl);

    const got = await wire.body("mbx/1", 42, "7");

    // The EPOCH is not optional: a UID names a message only within one UIDVALIDITY, and Trash is
    // the folder providers purge. Without it the server would answer the body of whatever message
    // now wears the number in an emptied-and-recreated folder.
    expect(r.calls[0]!.path).toBe("/trash/window/body?mailboxId=mbx%2F1&uid=42&uidValidity=7");
    expect(got).toEqual({ subject: "s", text: "t" });
  });

  it("a non-2xx throws with the STATUS readable, and the server's sentence when it sent one", async () => {
    const r = recorder([
      { status: 410, body: { error: { message: "that folder was emptied" } } },
      { status: 503, body: null },
    ]);
    const wire = trashVia(r.fetchImpl);

    // 410 — the epoch moved under the row. The status has to survive the transport so a caller
    // can tell "gone" from "could not read".
    const gone = await wire.body("m", 1, "7").catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(TrashBridgeError);
    expect((gone as TrashBridgeError).status).toBe(410);
    expect((gone as TrashBridgeError).message).toBe("that folder was emptied");

    // No sentence in the body: the status is all there is, and it is still reported.
    const dead = await wire.list().catch((e: unknown) => e);
    expect((dead as TrashBridgeError).status).toBe(503);
    expect((dead as TrashBridgeError).message).toContain("503");
  });
});

describe("the desktop's Trash transport is READ-ONLY, and the absence is the contract", () => {
  it("EVERY call is a bare GET — no method, no headers, no body, on either read", async () => {
    const r = recorder([{ status: 200, body: PAGE }, { status: 200, body: { subject: "s", text: "t" } }]);
    const wire = trashVia(r.fetchImpl);

    await wire.list({ cursor: "c" });
    await wire.body("m", 1, "7");

    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      // `undefined` and not "a GET init": the transport passes no second argument at all, so
      // there is no field for a future edit to flip to POST without this going red.
      expect(c.init, `${c.path} carried a request init`).toBeUndefined();
    }
  });

  it("the wire's whole surface is TWO READS — a verb here would be ohmail filing somebody else's mail", () => {
    // The shared seam carries the same rule. Asserted as an exact set rather than "has list and
    // body", so a third member cannot arrive unnoticed: ohmail's restore aims at a mirror row's
    // recorded origin folder, and a message the provider filed in Trash has none.
    expect(Object.keys(trashVia(recorder([]).fetchImpl)).sort()).toEqual(["body", "list"]);
  });

  it("the SOURCE mentions no write — no method, no POST, no verb name anywhere in EITHER module", () => {
    // A census over the files, because the assertions above only measure the paths the two reads
    // take. This is what refuses a write being added beside them. `body` is NOT on the list: it
    // is the name of the second READ (one row's body, fetched live and never stored).
    //
    // TWO files since the requests moved out of the bridge binding: the served host client imports
    // the factory and must not reach `bridge-fetch.ts`, which would put the shell command's name
    // into the bundle a phone is handed. Both are censused, and each carries its own positive
    // control, so a write added to either one is refused — and neither can pass by being empty.
    const CENSUS = [
      { rel: "../src/trash-wire.ts", proves: ["/trash/window", "uidValidity", "trashVia"] },
      { rel: "../src/local-trash.ts", proves: ["trashVia(bridgeFetch)"] },
    ] as const;
    for (const { rel, proves } of CENSUS) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of ["POST", "PATCH", "PUT", "DELETE", "method:", "restore", "rescue", "sweep"]) {
        expect(code, `${rel}'s code mentions ${forbidden}`).not.toContain(forbidden);
      }
      // The positive control: the census really does read this file's code, so the absences above
      // are measured rather than asserted of an empty string.
      for (const proof of proves) expect(code, `${rel} — the census read nothing`).toContain(proof);
    }
  });

  it("the shipped wire is built over the bridge — the window gets a real transport, not a stub", () => {
    // `trashOverBridge` is what `DesktopGate` hands the shell; if this were undefined the section
    // would be withheld exactly as it was before the fix.
    expect(typeof trashOverBridge.list).toBe("function");
    expect(typeof trashOverBridge.body).toBe("function");
    const src = readFileSync(new URL("../src/local-trash.ts", import.meta.url), "utf8");
    expect(src).toContain("trashVia(bridgeFetch)");
    // …and it takes the factory from the door-free module, which is what keeps the served host
    // client's copy of the same two reads out of reach of the shell command.
    expect(src).toContain('from "./trash-wire.js"');
  });
});
