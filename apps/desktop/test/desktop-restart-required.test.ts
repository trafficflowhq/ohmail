import { describe, expect, it } from "vitest";

import {
  HOST_REFUSAL_KINDS,
  enterHostDoor,
  pairAgainWithHost,
} from "../src/doors.js";
import { sentenceForKind } from "../src/DoorChooser.js";
import { DOOR_COPY } from "../src/door-copy.js";
import { parsePairLink } from "@ohmail/client-engine";

/**
 * ═══ A PAIRING THAT WORKED, AND THE ONE REFUSAL THAT HAS A WAY OUT ═════════════════════════
 *
 * Two states the paired door reaches that a status code cannot describe.
 *
 * ── WHY `res.ok` IS NOT "PAIRED AND READY" ─────────────────────────────────────────────────
 *
 * A start-over redeem answers **200**, and it is right to: the pairing genuinely succeeded, the
 * single-use code is spent and the session is sealed. What it does NOT do is activate anything.
 * The previous account's mirror is an open database, and removing it under the process holding it
 * corrupts that process — so the discard is staged for the next launch and every read stays
 * refused until then.
 *
 * Read as an ordinary success, the window mounts a signed-in mail client over an engine answering
 * 409 to everything. Nothing throws. So the BODY decides here, not the status.
 *
 * ── AND WHY THE VERB IS NEVER INFERRED ─────────────────────────────────────────────────────
 *
 * `startOver` discards the mail this machine holds for another account. The engine matches the
 * exact boolean `true` and treats every truthy near-miss as an ordinary pairing, deliberately.
 * This file holds the window to the same standard from the other side: the flag leaves this
 * process only when a caller asked for it, and an ordinary pairing sends no such field at all.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as Host;

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

/** The request that actually left the window — `bridgeFetch` sends bodies as a number array. */
function sentBody(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const bytes = (payload as { body?: number[] } | undefined)?.body ?? [];
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) as Record<string, unknown>;
}

const PIN = "C".repeat(43);
const link = parsePairLink(`https://192.168.1.24:8443/pair#k1.${PIN}.tok_start`)!;

function shell(answers: (url: string) => Uint8Array) {
  const asked: { command: string; payload?: Record<string, unknown> }[] = [];
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      asked.push({ command, payload });
      if (command === "engine_configure") return { state: "starting", mode: "cloud" };
      if (command === "engine_status") {
        return { state: "serving", mode: "cloud", flavor: "desktop-host", mailboxId: "m1" };
      }
      if (command === "engine_request") {
        return answers((payload as { url?: string } | undefined)?.url ?? "");
      }
      throw new Error(`unexpected ${command}`);
    },
  };
  return asked;
}

const redeemOf = (asked: { payload?: Record<string, unknown> }[]) =>
  asked.find((a) => (a.payload as { url?: string })?.url === "/cloud/pair-redeem");

describe("a 200 is not always a finished pairing", () => {
  it("a start-over 200 reports the relaunch, not a completed sign-in", async () => {
    shell((url) =>
      url === "/cloud/pair-redeem"
        ? encode(200, '{"status":"paired","restartRequired":true,"mailboxId":"m1","address":"a@b.c"}')
        : encode(200, '{"ok":true}'));
    const result = await pairAgainWithHost(link, true);
    expect(result.restartRequired, "a staged pairing was reported as an ordinary success").toBe(true);
    expect(result.refusal).toBeNull();
    expect(result.problem).toBeNull();
  });

  /* THE OTHER SIDE OF THE SAME COIN, and without it the case above would pass for a reader that
     simply always reported a relaunch. An ordinary pairing's 200 carries no `restartRequired` at
     all, which is why the check is for the exact `true` rather than for the field's presence. */
  it("an ordinary pairing's 200 does NOT report a relaunch", async () => {
    shell((url) =>
      url === "/cloud/pair-redeem"
        ? encode(200, '{"status":"paired","mailboxId":"m1","address":"a@b.c"}')
        : encode(200, '{"ok":true}'));
    const result = await enterHostDoor(link, "https://192.168.1.24:8443");
    expect(result.restartRequired).toBeFalsy();
    expect(result.refusal).toBeNull();
    expect(result.status?.state).toBe("serving");
  });

  /**
   * A `restart_required` IS A REFUSAL AND NOT THE SUCCESS ABOVE — the two share a restart and
   * nothing else.
   *
   * This used to collapse into the staged-200 outcome, which put a false sentence on screen: the
   * success card says "Pairing finished — this computer is now paired with {host}", and on this
   * arm NOTHING was paired. What is pending is an EARLIER start-over the person asked for, and the
   * app has to be reopened before this pairing can even be attempted.
   *
   * The engine also refuses it BEFORE spending the token, so the link in the person's hand still
   * works afterwards — the opposite of the account-mismatch refusal, and the reason the two need
   * different sentences rather than one hedged one.
   */
  it("a `restart_required` is a refusal, NOT the finished pairing", async () => {
    shell((url) =>
      url === "/cloud/pair-redeem"
        ? encode(409, '{"error":{"code":"restart_required","message":"reopen ohmail"}}', "Conflict")
        : encode(200, '{"ok":true}'));
    const result = await pairAgainWithHost(link);
    expect(result.restartRequired, "a refusal was reported as a finished pairing").toBeFalsy();
    expect(result.refusal?.kind).toBe("restart_required");
    /* AND ITS SENTENCE IS ITS OWN. Both halves asserted, because the defect was that one sentence
       served two states: this one must say nothing was paired, and must NOT claim the pairing
       finished. */
    const said = sentenceForKind("restart_required", "kestrel")!;
    expect(said).toContain("Nothing was paired.");
    expect(said).toMatch(/quit ohmail and open it again/i);
    expect(said).toMatch(/link has not been used/i);
    expect(said, "the refusal borrowed the success card's claim").not.toMatch(/now paired with/i);
    expect(said).not.toBe(DOOR_COPY.gateRestart("kestrel"));
  });
});

describe("start over leaves this process only when it was asked for", () => {
  it("an ordinary pairing sends NO startOver field at all", async () => {
    const asked = shell(() => encode(200, '{"status":"paired","mailboxId":"m1"}'));
    await pairAgainWithHost(link);
    const body = sentBody(redeemOf(asked)!.payload);
    expect(Object.keys(body)).not.toContain("startOver");
    expect(body.token).toBe("tok_start");
  });

  /* THE EXACT BOOLEAN. The engine matches `startOver === true` and reads `"true"`, `1` and `{}`
     as ordinary pairings — deliberately, because this flag deletes mail. A window that sent the
     string would discard nothing and report success, which is the worst of both. */
  it("a start over sends the exact boolean true, never a string", async () => {
    const asked = shell(() => encode(200, '{"status":"paired","restartRequired":true}'));
    await pairAgainWithHost(link, true);
    const body = sentBody(redeemOf(asked)!.payload);
    expect(body.startOver).toBe(true);
    expect(typeof body.startOver, "a truthy near-miss discards nothing and reports success")
      .toBe("boolean");
  });

  /* `kind` IS NO LONGER SENT. The engine composes the device kind from its own `process.platform`
     and ignores the wire; sending it too invited a reader to think this window decided it. */
  it("the redeem body is the token and nothing else it does not need", async () => {
    const asked = shell(() => encode(200, '{"status":"paired","mailboxId":"m1"}'));
    await pairAgainWithHost(link);
    expect(Object.keys(sentBody(redeemOf(asked)!.payload)).sort()).toEqual(["token"]);
  });
});

describe("the refusal that has a way out", () => {
  it("is a kind this build knows, so it reads in the reader's language", () => {
    expect(HOST_REFUSAL_KINDS).toContain("pair_account_mismatch");
    const said = sentenceForKind("pair_account_mismatch", "kestrel");
    expect(said).toBe(DOOR_COPY.hostRefuseAccountMismatch("kestrel"));
    expect(said).toContain("kestrel");
  });

  /**
   * THE FRESH-CODE FACT. The engine redeems at the host BEFORE comparing accounts, so by the time
   * this refusal is written the single-use code has already been spent. Without this sentence a
   * person presses Start over with the code they have, it fails, and the failure looks exactly
   * like the refusal they were already stuck on.
   */
  it("says a NEW pairing link is needed, because the last one is already spent", () => {
    const said = sentenceForKind("pair_account_mismatch", "kestrel")!;
    expect(said).toMatch(/new pairing link/i);
    expect(said).toMatch(/spent/i);
  });

  it("and says what starting over costs, and what it does not touch", () => {
    const said = sentenceForKind("pair_account_mismatch", "kestrel")!;
    expect(said).toMatch(/discards/i);
    expect(said).toMatch(/different account/i);
    /* The MASTER copy is untouched — the discard is local. Saying so is what keeps the sentence
       from reading as "starting over deletes your mail". */
    expect(said).toMatch(/server is not touched/i);
  });

  it("the refusal is reported, and the window infers no discard from it", async () => {
    const asked = shell((url) =>
      url === "/cloud/pair-redeem"
        ? encode(409, '{"error":{"code":"pair_account_mismatch","message":"different account"}}', "Conflict")
        : encode(200, '{"ok":true}'));
    const result = await pairAgainWithHost(link);
    expect(result.refusal?.kind).toBe("pair_account_mismatch");
    expect(result.restartRequired).toBeFalsy();
    /* AND NOTHING WAS RETRIED. A window that answered the refusal by re-posting with `startOver`
       would discard somebody's mail without being asked — the whole reason the verb is a press. */
    const redeems = asked.filter((a) => (a.payload as { url?: string })?.url === "/cloud/pair-redeem");
    expect(redeems, "the window retried the refusal by itself").toHaveLength(1);
    expect(sentBody(redeems[0]!.payload)).not.toHaveProperty("startOver");
  });
});
