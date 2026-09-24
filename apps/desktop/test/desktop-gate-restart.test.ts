import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DOOR_COPY } from "../src/door-copy.js";

/**
 * ═══ THREE REASONS `signedIn` CAN BE FALSE, AND THE ORDER THEY ARE READ IN ═════════════════
 *
 * `/health` answers `signedIn: false` in three genuinely different situations, and two of them
 * used to be indistinguishable from the third:
 *
 *   pre-auth              `{signedIn:false, sessionExpired:false, restartRequired:false}`
 *   session ended         `{signedIn:false, sessionExpired:true,  …}`
 *   pairing worked, waiting for a relaunch
 *                         `{signedIn:false, sessionExpired:false, restartRequired:true}`
 *
 * The third has the SAME shape as the first on the two fields the window used to read. So a
 * window that checked pre-auth first drew the hosted PASSWORD FORM — for an account that does not
 * exist — at the moment a pairing the person had asked for succeeded. Had the engine set
 * `sessionExpired` for it instead, the other arm would have claimed "no longer paired", the
 * precise opposite of what happened.
 *
 * ── WHY THE ORDER IS ASSERTED FROM THE SOURCE ─────────────────────────────────────────────
 *
 * Because an arm placed after `preAuth` is CORRECT AND UNREACHABLE. It compiles, it reads well,
 * every one of its own cases passes when driven directly, and it never runs — the failure is
 * invisible to any test that calls the branch rather than the router. The only thing that can see
 * it is where the branch sits relative to the other two, so that is what this reads.
 */

const GATE = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/DesktopGate.tsx"),
  "utf8",
);

/** The line each arm's condition sits on, or -1. */
const armAt = (needle: string): number => {
  const at = GATE.indexOf(needle);
  return at < 0 ? -1 : GATE.slice(0, at).split("\n").length;
};

describe("the relaunch arm outranks the two that would lie about it", () => {
  it("all three arms are present — otherwise the ordering below is vacuous", () => {
    expect(armAt("if (hostedRestartRequired) {"), "no relaunch arm").toBeGreaterThan(0);
    expect(armAt("if (hostedPreAuth"), "no pre-auth arm").toBeGreaterThan(0);
    // Both doors' expiry is the card over the mail, rendered below every early return; the paired
    // door's early notice, which replaced the mail, is gone.
    expect(armAt("const refusedCard = "), "no expiry card").toBeGreaterThan(0);
    expect(armAt("if (hostedSessionGone && paired) {"), "the paired door's expiry returns early again").toBe(-1);
  });

  it("and the relaunch arm is evaluated FIRST", () => {
    const restart = armAt("if (hostedRestartRequired) {");
    const preAuth = armAt("if (hostedPreAuth");
    const card = armAt("const refusedCard = ");
    expect(
      restart,
      "the relaunch arm sits after the pre-auth arm, whose condition its own /health shape also "
        + "matches — so it can never run and the window shows a password form instead",
    ).toBeLessThan(preAuth);
    expect(restart, "the relaunch arm sits after the expiry card").toBeLessThan(card);
  });

  /* THE FIELD IS READ BY EVERY ASKER. The gate asks `/health` on the slow steady cadence, on the
     fast loop until the first answer lands, and when the engine answers the held session question.
     A field read by one of them works on a warm window and not on a cold start, or the reverse — so
     all three ask through ONE reader that hands the answer to ONE parser. */
  it("every /health asker parses it, through the one reader and the one parser", () => {
    const reads = GATE.split("restartRequired: health.restartRequired === true").length - 1;
    expect(reads, "the field is parsed in one place").toBe(1);
    expect(GATE.split("hostedAuthOf(").length - 1, "the parser's definition and its one call").toBe(2);
    expect(GATE.split("readHostedAuth(authKey)").length - 1, "the three askers call the one reader").toBe(3);
    expect(GATE.split('bridgeFetch("/health")').length - 1, "and only the reader asks").toBe(1);
    expect(GATE.split("health.restartRequired").length - 1, "no probe reads the field on its own").toBe(1);
  });

  it("the card says the pairing worked and names the one action", () => {
    /* IT LEADS WITH THE SUCCESS. The two states around it lead with failure, and a person here
       has just pressed something destructive on purpose. */
    expect(DOOR_COPY.gateRestartTitle).toBe("Pairing finished");
    const said = DOOR_COPY.gateRestart("kestrel");
    expect(said).toContain("kestrel");
    expect(said).toMatch(/quit ohmail and open it again/i);
    /* AND IT SAYS WHAT HAPPENS TO THE OLD COPY, because the person chose that and should not meet
       it as a surprise on the next launch. */
    expect(said).toMatch(/replaced/i);
    /* NOT the apology card's words: the pairing SUCCEEDED. */
    expect(said).not.toMatch(/cannot open|no longer paired|signed out/i);
  });

  /* NO BUTTON. Nothing in this window can restart the app — `app.restart()` is the shell's and
     reaching it would mean a new command. A control that did nothing would be worse than a
     sentence that is true, so the card renders the sentence alone and this pins that it is not
     quietly given a dead action later. */
  it("the card offers no action, because this window has none to offer", () => {
    const card = GATE.slice(GATE.indexOf("if (hostedRestartRequired) {"));
    const body = card.slice(0, card.indexOf("\n  }"));
    expect(body).not.toContain("<Button");
    expect(body).not.toContain("onAction");
    /* And it is NOT `GateNotice`, whose title is "ohmail cannot open your mailbox" and whose
       footer promises "Your mail is untouched" — both false here. */
    expect(body).not.toContain("GateNotice");
  });
});
