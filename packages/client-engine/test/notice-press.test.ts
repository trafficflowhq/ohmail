/**
 * WHAT A PRESS ON A CALENDAR NOTICE MAY DO. A notice lies on a locked screen where anyone can
 * press it. A press that changes a calendar (an answer to an invitation, adding or dismissing what
 * a letter proposed, ringing again later) is done only on an unlocked device, for the account the
 * notice was made under; otherwise it changes nothing and opens the app, which asks for the person.
 * A press that only opens the app is never refused, and never carries an event into another account.
 */
import { describe, expect, it } from "vitest";
import {
  NOTICE_ACTS, NOTICE_PRESSES, NOTICE_PRESS_WRITES, decidePress, pressWrites,
  type NoticePress, type NoticePressAnswer, type PressedOn,
} from "@ohmail/client-engine";

const UNLOCKED: PressedOn = { locked: false, live: "mb-1" };
const WRITES: readonly NoticePress[] = ["again", "yes", "maybe", "no", "add", "dismiss"];
const OPENS: readonly NoticePress[] = ["open", "join"];

describe("a press on a notice", () => {
  it("every press is a closed word, and each says whether it changes a calendar", () => {
    expect([...NOTICE_PRESSES].sort()).toEqual([...WRITES, ...OPENS].sort());
    for (const press of WRITES) expect(pressWrites(press), press).toBe(true);
    for (const press of OPENS) expect(pressWrites(press), press).toBe(false);
    expect(Object.keys(NOTICE_PRESS_WRITES).sort()).toEqual([...NOTICE_PRESSES].sort());
    // An alert's own acts are presses: Join opens the app (its link gate opens the call), Again moves the alarm.
    for (const act of NOTICE_ACTS) expect(NOTICE_PRESSES).toContain(act);
  });

  it("a press that changes a calendar is done on an unlocked device under the notice's own account", () => {
    for (const press of WRITES) expect(decidePress(press, "mb-1", UNLOCKED), press).toEqual({ do: "act" });
  });

  it("on a locked device it changes nothing and asks for the app", () => {
    for (const press of WRITES) {
      expect(decidePress(press, "mb-1", { locked: true, live: "mb-1" }), press).toEqual({ do: "app", at: "event" });
      // A device that cannot say whether it is locked is treated as locked.
      for (const locked of [null, undefined, "no", 0] as never[]) {
        expect(decidePress(press, "mb-1", { locked, live: "mb-1" }), `${press} ${String(locked)}`).toEqual({ do: "app", at: "event" });
      }
    }
  });

  it("under another account, or with nobody signed in, it changes nothing and opens the app at its own place", () => {
    const elsewhere: (string | null)[] = ["mb-2", null, "", "demo:fixtures", "MB-1"];
    for (const press of WRITES) {
      for (const live of elsewhere) {
        expect(decidePress(press, "mb-1", { locked: false, live }), `${press} ${String(live)}`).toEqual({ do: "app", at: "home" });
        expect(decidePress(press, "mb-1", { locked: true, live }), `${press} ${String(live)} locked`).toEqual({ do: "app", at: "home" });
      }
    }
    // A notice whose own scope is no account's is nobody's: nothing is written for it.
    expect(decidePress("yes", "demo:fixtures", { locked: false, live: "demo:fixtures" })).toEqual({ do: "app", at: "home" });
    expect(decidePress("yes", "", { locked: false, live: "" })).toEqual({ do: "app", at: "home" });
  });

  it("a press that only opens the app is never refused, locked or not, and names the event only under its own account", () => {
    for (const press of OPENS) {
      for (const locked of [true, false, null]) {
        expect(decidePress(press, "mb-1", { locked, live: "mb-1" }), press).toEqual({ do: "app", at: "event" });
        expect(decidePress(press, "mb-1", { locked, live: "mb-2" }), press).toEqual({ do: "app", at: "home" });
        expect(decidePress(press, "mb-1", { locked, live: null }), press).toEqual({ do: "app", at: "home" });
      }
    }
  });

  it("a word that is no press does nothing at all", () => {
    for (const press of ["delete", "accept", "Yes", "", "open ", 7, null, undefined, ["yes"], { press: "yes" }]) {
      expect(decidePress(press, "mb-1", UNLOCKED), String(press)).toEqual({ do: "nothing" });
    }
  });

  it("no answer but the three, and only one of them writes", () => {
    const answers = new Set<string>();
    for (const press of [...NOTICE_PRESSES, "other"]) {
      for (const locked of [true, false, null]) {
        for (const live of ["mb-1", "mb-2", null]) {
          const answer: NoticePressAnswer = decidePress(press, "mb-1", { locked, live });
          answers.add(JSON.stringify(answer));
          if (answer.do === "act") expect([WRITES.includes(press as NoticePress), locked, live]).toEqual([true, false, "mb-1"]);
        }
      }
    }
    expect([...answers].sort()).toEqual(['{"do":"act"}', '{"do":"app","at":"event"}', '{"do":"app","at":"home"}', '{"do":"nothing"}']);
  });
});
