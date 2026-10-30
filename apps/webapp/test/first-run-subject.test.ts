import { describe, expect, it } from "vitest";
import {
  accountOrganizer, firstRunCounts, firstRunSubject,
} from "../app/shell/first-run-subject";

/**
 * ═══ WHICH MAILBOX A FIRST RUN IS ABOUT, AND WHOSE MAIL IT COUNTS ══════════════════════════
 *
 * Two expressions lifted out of the shell's first-run mount, where neither could be driven.
 *
 * `firstRunSubject` — the route names a mailbox and the facts may not hold it. That answer used to
 * be one word, `null`, and the two situations behind it want opposite screens: an ADD run's hash
 * carries the new id a round trip before the facts do (the form is right there), and a RE-RUN whose
 * row has left has nothing to re-run at all — and the re-run's form posts `seed`, which reconfigures
 * the whole install. Five states, named (the fifth asks which of several), so a caller cannot collapse them.
 *
 * `firstRunCounts` — the pull screen's two numbers and the summary's two rows. They were the
 * INSTALL's: the mirror's whole row count minus the whole History list. The fixture here is two
 * mailboxes whose numbers DIFFER in both directions, because a fixture where they agree measures
 * alignment rather than the property.
 */

interface Row { id: string; organizedBy?: { kind: string | null; name: string | null } | null }

const rows: Row[] = [{ id: "mb-1" }, { id: "mb-2" }];

describe("firstRunSubject — which mailbox, and which kind of nothing", () => {
  it("the route names a row the facts hold: that row, whatever its position", () => {
    expect(firstRunSubject(rows, "mb-2", false)).toEqual({ mailbox: rows[1], state: "mailbox" });
  });

  it("THE SHARP ONE — a re-run naming a row the facts do not hold is `vanished`, never a mailbox", () => {
    const s = firstRunSubject(rows, "mb-gone", false);
    expect(s.state).toBe("vanished");
    expect(s.mailbox).toBeNull();
  });

  it("and it is vanished on an install that still holds mailboxes — the state the seed form ruins", () => {
    // The premise of the row: `rows` is non-empty, so falling back to `rows[0]` or to a connect
    // form is a statement about an install that is already set up.
    expect(rows.length).toBeGreaterThan(1);
    expect(firstRunSubject(rows, "mb-gone", false).state).toBe("vanished");
  });

  it("an ADD run naming a row the facts do not hold is PENDING — its create has not landed yet", () => {
    expect(firstRunSubject(rows, "mb-3", true)).toEqual({ mailbox: null, state: "pending" });
  });

  it("an ADD run naming nothing is pending too — there is no row to name before the create", () => {
    expect(firstRunSubject(rows, null, true)).toEqual({ mailbox: null, state: "pending" });
  });

  it("a hash naming nothing falls back to the one row, and only when there is one", () => {
    expect(firstRunSubject([rows[1]!], null, false)).toEqual({ mailbox: rows[1], state: "mailbox" });
  });

  it("a hash naming nothing on an install with several is `choose` — never the first row", () => {
    expect(firstRunSubject(rows, null, false)).toEqual({ mailbox: null, state: "choose" });
  });

  it("no rows at all is `none` — a first run, which is what the connect form is FOR", () => {
    expect(firstRunSubject([], null, false)).toEqual({ mailbox: null, state: "none" });
  });

  it("`GET /mailboxes` has not answered: `none`, never vanished — an unread list accuses nobody", () => {
    expect(firstRunSubject(null, "mb-1", false)).toEqual({ mailbox: null, state: "none" });
  });
});

/** Two mailboxes whose mirrored mail and History lists differ in both directions. */
const mirrored = [
  ...Array.from({ length: 9 }, () => ({ mailboxId: "mb-1" })),
  ...Array.from({ length: 4 }, () => ({ mailboxId: "mb-2" })),
  { /* a row from a build that predates the column */ },
];
const history = [
  ...Array.from({ length: 2 }, () => ({ mailboxId: "mb-1" })),
  ...Array.from({ length: 3 }, () => ({ mailboxId: "mb-2" })),
];

describe("firstRunCounts — this mailbox's mail, not the install's", () => {
  it("counts the run's own mailbox", () => {
    expect(firstRunCounts(mirrored, history, "mb-1")).toEqual({ screened: 7, history: 2 });
    expect(firstRunCounts(mirrored, history, "mb-2")).toEqual({ screened: 1, history: 3 });
  });

  it("THE FIXTURE DIFFERS FROM THE INSTALL'S NUMBERS — in both directions, or it measures alignment", () => {
    // What the mount used to hand the screen, for every run, whichever mailbox it was about.
    const installWide = {
      screened: Math.max(0, mirrored.length - history.length), history: history.length,
    };
    expect(installWide).toEqual({ screened: 9, history: 5 });
    for (const id of ["mb-1", "mb-2"]) {
      const mine = firstRunCounts(mirrored, history, id);
      expect(mine.screened).not.toBe(installWide.screened);
      expect(mine.history).not.toBe(installWide.history);
    }
  });

  it("a mailbox with nothing mirrored reads zero rather than the install's totals", () => {
    expect(firstRunCounts(mirrored, history, "mb-3")).toEqual({ screened: 0, history: 0 });
  });

  it("no mailbox at all reads zero — the install's numbers are the claim this function refuses", () => {
    expect(firstRunCounts(mirrored, history, null)).toEqual({ screened: 0, history: 0 });
  });

  it("the pair is two partitions of what this device holds: they add to it, never past it", () => {
    for (const id of ["mb-1", "mb-2"]) {
      const held = mirrored.filter((m) => "mailboxId" in m && m.mailboxId === id).length;
      const { screened, history: listed } = firstRunCounts(mirrored, history, id);
      expect(screened + listed).toBe(held);
    }
  });

  it("the account's own Sent mail went through no Screener: never counted as screened", () => {
    const inbound = Array.from({ length: 5 }, () => ({ mailboxId: "mb-1", folder: "INBOX" }));
    const sent = Array.from({ length: 3 }, () => ({ mailboxId: "mb-1", folder: "Sent" }));
    // One old Sent letter is listed under History, as the cutline lists pre-line outbound mail.
    expect(firstRunCounts([...inbound, ...sent], [sent[0]!, inbound[0]!], "mb-1"))
      .toEqual({ screened: 4, history: 2 });
  });

  it("clamped: History may out-run the mirror between two reads and must not print a negative", () => {
    expect(firstRunCounts([{ mailboxId: "mb-1" }], [
      { mailboxId: "mb-1" }, { mailboxId: "mb-1" }, { mailboxId: "mb-1" },
    ], "mb-1")).toEqual({ screened: 0, history: 3 });
  });
});

describe("accountOrganizer — the one holder the connect form can read", () => {
  it("names the first row that NAMES one", () => {
    expect(accountOrganizer([
      { id: "a", organizedBy: null },
      { id: "b", organizedBy: { kind: "cloud", name: "ohmail Cloud" } },
    ])).toEqual({ kind: "cloud", name: "ohmail Cloud" });
  });

  it("a kind with no name is still a holder — the legacy sentence's state", () => {
    expect(accountOrganizer([{ id: "a", organizedBy: { kind: "desktop", name: null } }]))
      .toEqual({ kind: "desktop", name: null });
  });

  it("`{null,null}` names nobody — the derivation's own rule, not the object's presence", () => {
    expect(accountOrganizer([{ id: "a", organizedBy: { kind: null, name: null } }])).toBeNull();
  });

  it("nothing connected, or nothing read yet: null", () => {
    expect(accountOrganizer([])).toBeNull();
    expect(accountOrganizer(null)).toBeNull();
  });
});
