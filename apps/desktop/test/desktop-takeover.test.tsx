/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DoorChooser } from "../src/DoorChooser.js";
import { GateNotice } from "../src/GateNotice.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";

/**
 * ═══ LEAVING THE OTHER COMPUTER — the consequences, and the list that only exists until you do ══
 *
 * Two surfaces, one act. A person whose other computer is not coming back can set this machine up
 * on its own: it opens the mail server itself and takes over the organizing. That discards the
 * copy here and reads the mailbox again from the server.
 *
 * ── THE PART THAT NEEDS A TEST RATHER THAN A COMMENT ────────────────────────────────────────
 *
 * WHICH mailboxes the other computer was organizing is a fact that lives only in the copy this
 * act discards. Read afterwards it is an empty list — and an empty list is not an error. So the
 * flow would open saying "the mailboxes that computer held:" with nothing under it, and a person
 * would conclude their host had been organizing nothing. That is a confident wrong answer, which
 * is worse than a refusal, and no type or compiler can see it.
 *
 * So there are three states here and they must render as three different things: reading, failed,
 * and answered. `null` may never be spelled the way `[]` is.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
});

function render(node: React.ReactElement): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(node));
  return el;
}

const ROSTER = [
  { address: "mila@example.com", id: "m1" },
  { address: "post@example.org", id: "m2" },
];

describe("the takeover card states what it costs before it asks for anything", () => {
  it("names the consequences in the order they happen, and the one thing that does not change", () => {
    const el = render(
      <DoorChooser start="takeover" host="kestrel" roster={ROSTER} onEntered={() => {}} />,
    );
    const text = el.textContent ?? "";
    expect(text).toContain(DOOR_COPY.takeoverLabel(machineWord()));
    /* The three consequences, and the fourth sentence that is the only reassurance the code can
       actually keep: nothing on the server moves until somebody agrees to organize. */
    expect(text).toContain("open your mail server itself and organize it");
    expect(text).toContain("is discarded and read again from the server");
    expect(text).toContain("Nothing on the server changes until you agree to organize");
  });

  it("lists the mailboxes the other computer held, by address", () => {
    const el = render(
      <DoorChooser start="takeover" host="kestrel" roster={ROSTER} onEntered={() => {}} />,
    );
    const rows = [...el.querySelectorAll(".join-roster li")].map((li) => li.textContent);
    expect(rows).toEqual(["mila@example.com", "post@example.org"]);
    expect(el.textContent).toContain("Mailboxes kestrel held");
    /* THE REST IS NAMED, because the next screen opens exactly one of them and a list of two says
       nothing about the second unless this line does. */
    expect(el.textContent).toContain("The other mailbox: add it afterwards");
  });

  it("with ONE mailbox it says nothing about the others, because there are none", () => {
    const el = render(
      <DoorChooser start="takeover" host="kestrel" roster={[ROSTER[0]!]} onEntered={() => {}} />,
    );
    expect(el.querySelectorAll(".join-roster li")).toHaveLength(1);
    expect(el.textContent, "a sentence about other mailboxes when there are none")
      .not.toContain("add it afterwards");
  });

  /**
   * THE CASE THE WHOLE THING IS FOR. A failed read and a host that held nothing are different
   * facts, and only one of them means "there is nothing to take over".
   */
  it("a roster that could NOT be read says so — never an empty list", () => {
    const el = render(
      <DoorChooser start="takeover" host="kestrel" roster={null} onEntered={() => {}} />,
    );
    expect(el.textContent).toContain("Could not read which mailboxes kestrel held");
    expect(el.querySelector(".join-roster"), "an empty list drawn for a failed read").toBeNull();
  });

  it("and a host that genuinely held none renders an empty list, not an error", () => {
    const el = render(
      <DoorChooser start="takeover" host="kestrel" roster={[]} onEntered={() => {}} />,
    );
    expect(el.querySelector(".join-roster")).toBeTruthy();
    expect(el.querySelectorAll(".join-roster li")).toHaveLength(0);
    expect(el.textContent, "a read failure reported for a host that held nothing")
      .not.toContain("Could not read");
  });

  it("while the read is in flight it says it is looking, and claims nothing", () => {
    const el = render(
      <DoorChooser start="takeover" host="kestrel" roster={undefined} onEntered={() => {}} />,
    );
    expect(el.textContent).toContain(DOOR_COPY.hostChecking);
    expect(el.querySelector(".join-roster")).toBeNull();
    expect(el.textContent).not.toContain("Could not read");
  });

  /**
   * THE CLAIM UNDER THE CARD. The roster is read from the mirrored `GET /mailboxes` answer, which
   * carries an ADDRESS and no IMAP or SMTP host — so the card may not promise the next screen
   * arrives pre-filled. It said "the servers are filled in" and that was a promise the following
   * screen could not keep.
   */
  it("CLAIM: it does not promise servers it cannot fill in", () => {
    const wire = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/mailbox-facts-wire.ts"),
      "utf8",
    );
    const shape = /interface MailboxWire \{[\s\S]*?\n\}/.exec(wire)?.[0] ?? "";
    expect(shape, "the wire shape was not found — this case is vacuous").toContain("address");
    /* If the answer ever DOES carry a server, this case fails and the sentence may be restored —
       which is the right direction for a claim to move. */
    expect(shape.toLowerCase(), "the roster wire now carries a server; the copy may say so")
      .not.toMatch(/imaphost|smtphost/);
    expect(DOOR_COPY.takeoverRest(2)).not.toContain("servers are filled in");
    expect(DOOR_COPY.takeoverWhy("kestrel", "Mac")).not.toContain("filled in");
  });
});

describe("a pairing that was revoked offers both ways out", () => {
  it("names the computer, says the copy is kept, and gives two actions", () => {
    let paired = 0;
    let own = 0;
    const el = render(
      <GateNotice
        reason={DOOR_COPY.gateUnpaired("Mac", "kestrel")}
        actionLabel={DOOR_COPY.gatePairAgain}
        onAction={() => { paired += 1; }}
        secondaryLabel={DOOR_COPY.gateOwn}
        onSecondary={() => { own += 1; }}
      />,
    );
    /* THE REASON PARAGRAPH, not the whole card. The shared footer below it says "on your own
       server, or in your hosted account" and stays — it covers all four callers and its first
       clause is the true one here. What must not appear is the hosted door's REASON, which says
       somebody was signed out of an account this install has never had. */
    const reason = el.querySelector(".gate-card > p")?.textContent ?? "";
    expect(reason, "the reason paragraph was not found — this case is vacuous").not.toBe("");
    expect(reason).not.toContain("hosted account");
    expect(reason).not.toContain("signed out");
    expect(reason).toContain("no longer paired with kestrel");
    expect(reason).toContain("The copy of your mail here is kept.");

    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Pair again", "Set up on its own"]);
    act(() => buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => buttons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect([paired, own]).toEqual([1, 1]);
  });

  it("and the other three callers still get exactly one action", () => {
    /* The second action is opt-in. An engine that will not start has one honest remedy, and a
       card that offered a second would be inventing one. */
    const el = render(
      <GateNotice reason="The mail engine stopped." actionLabel="Try again" onAction={() => {}} />,
    );
    expect(el.querySelectorAll("button")).toHaveLength(1);
  });
});
