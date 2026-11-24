import { organizerNotices } from "@ohmail/app-logic/mail-state/mail-state";
import { describe, expect, it } from "vitest";
import mailboxesDe from "../../../packages/app/messages/mailboxes.de.json";
import mailboxesEn from "../../../packages/app/messages/mailboxes.en.json";
import screenerDe from "../../../packages/app/messages/screener.de.json";
import screenerEn from "../../../packages/app/messages/screener.en.json";

type Row = Parameters<typeof organizerNotices>[0] extends ReadonlyArray<infer R> | null ? R : never;

const EARLIER = "2026-09-04T09:00:00.000Z";
const LATER = "2026-09-04T09:30:00.000Z";

const row = (over: Partial<Row> = {}): Row => ({
  id: "mb1",
  address: "person@example.com",
  status: "connected",
  disabledReason: null,
  organizerRole: "reader",
  organizedBy: { kind: "cloud", name: "ohmail Cloud", since: EARLIER },
  organizeConsentedAt: EARLIER,
  organizerState: "held",
  organizerEventAt: LATER,
  organizerEventSeenAt: null,
  ...over,
} as Row);

describe("organizerNotices — a change nobody has acknowledged", () => {
  it("an unacknowledged change is one notice, naming the holder and the mailbox", () => {
    expect(organizerNotices([row()])).toEqual([{
      id: "mb1", address: "person@example.com", kind: "elsewhere", name: "ohmail Cloud", at: LATER, order: 0,
    }]);
  });

  it("IT IS GONE ONCE ACKNOWLEDGED — the whole of once-per-change", () => {
    expect(organizerNotices([row({ organizerEventSeenAt: LATER })])).toEqual([]);
    expect(organizerNotices([row({ organizerEventSeenAt: "2026-09-04T09:45:00.000Z" })])).toEqual([]);
  });

  it("…and a LATER change re-shows it, over the same acknowledgement", () => {
    // The property that makes an acknowledgement an answer to ONE change rather than a mute.
    const again = organizerNotices([row({
      organizerEventSeenAt: EARLIER, organizerEventAt: LATER,
    })]);
    expect(again).toHaveLength(1);
  });

  it("a build that cannot tell says NOTHING, in both directions", () => {
    // Absent `event_at` is an older server, not a change. Inventing one would put a sentence
    // about a machine handover over every mailbox of every older deployment.
    expect(organizerNotices([row({ organizerEventAt: undefined })])).toEqual([]);
    expect(organizerNotices([row({ organizerEventAt: null })])).toEqual([]);
    // An UNPARSEABLE acknowledgement is not evidence the change was never seen either — treating
    // it as such would re-show a dismissed line on every poll.
    expect(organizerNotices([row({ organizerEventSeenAt: "not a date" })])).toEqual([]);
    expect(organizerNotices(null)).toEqual([]);
  });

  it("a TOMBSTONE is not news about organizing", () => {
    expect(organizerNotices([row({ status: "disabled" })])).toEqual([]);
  });

  it("two kinds are news, told apart by the row, not by a stored kind", () => {
    expect(organizerNotices([row()])[0]!.kind).toBe("elsewhere");
    expect(organizerNotices([row({ organizerState: "stopped" })])[0]!.kind).toBe("stopped");
  });

  it("THIS INSTALL ORGANIZING IS NEVER A NOTICE — the stack after a paid reopening", () => {
    /* The reported screen: one roster pass promoted five parked rows, each with a fresh
       unacknowledged event, and each drew "You organize … here now" over the mail. The person
       asked for it (consent, payment); the sync line already says organizing. */
    const five = ["a", "b", "c", "d", "e"].map((id) => row({
      id, organizerRole: "organizer", organizedBy: null, organizerState: null,
    }));
    expect(organizerNotices(five)).toEqual([]);
    // Absent role reads as organizer, the role's default on this surface.
    expect(organizerNotices([row({ organizerRole: undefined, organizedBy: null })])).toEqual([]);
  });

  it("a RELEASE the person pressed is never a notice either", () => {
    expect(organizerNotices([row({
      organizedBy: null, organizerState: null, organizerReleasedAt: LATER,
    })])).toEqual([]);
  });

  it("A HOLDER-LESS ROW WITH NO RELEASE MARKER IS `stopped`, NOT A RELEASE", () => {
    /* THE CASE THIS FIXTURE USED TO STAND IN FOR, and it is not the release.
       `refreshOrganizerHolder` (`apps/worker/src/mailboxes.ts`) and the sidecar's
       `notePeekedHolder` rewrite ALL FOUR holder columns on every reader cycle and write them all
       NULL when the peek finds an empty claim folder — the shape a stand-down takes on its own
       once the install that beat it is removed. The same write stamps `organizer_event_at` on a
       flip in either direction INCLUDING to and from NULL, so the decayed row reaches this
       function with a fresh unacknowledged event and the line fires on it. Announcing it as a
       release told somebody they had stopped organizing a mailbox they never organized.

       `stopped` with NO NAME, which the view renders as `noticeStoppedUnknown` — "the install
       that organized this has stopped; nothing files it until something takes it over". True of
       this row, and the one open condition of the four: mail accumulates unsorted while it holds.

       Removing the stopped notice classification makes this unacknowledged change disappear. */
    const only = organizerNotices([row({ organizedBy: null, organizerState: null })]);
    expect(only[0]!.kind).toBe("stopped");
    expect(only[0]!.name, "an unknown holder must not be invented for the decayed row").toBeNull();
  });

  it("…and an explicit `null` marker is not a release either", () => {
    // Absent is a host too old to send the column; `null` is a host that sends it for a mailbox
    // this account never let go. Both mean "not released", which is the direction that costs a
    // stale explanation rather than a false claim about something the person did.
    expect(organizerNotices([row({
      organizedBy: null, organizerState: null, organizerReleasedAt: null,
    })])[0]!.kind).toBe("stopped");
  });

  it("ONCE-PER-CHANGE HOLDS FOR THE DECAYED ROW — the gate is still the two instants", () => {
    expect(organizerNotices([row({
      organizedBy: null, organizerState: null, organizerEventSeenAt: LATER,
    })])).toEqual([]);
  });

  it("A MAILBOX THE WALL PAUSED SAYS NOTHING — never `stopped`", () => {
    const paused = { organizedBy: null, organizerState: null, organizerReleasedAt: LATER };
    expect(organizerNotices([row({ ...paused, organizerParkedAt: LATER })])).toEqual([]);
    // Cloud's own stale claim named by a peek after the reopening: still paused, not stopped.
    expect(organizerNotices([row({ organizerState: "stopped", organizerParkedAt: LATER })])).toEqual([]);
    // CONTROL: the marker `null` leaves the stopped holder a notice.
    expect(organizerNotices([row({ organizerState: "stopped", organizerParkedAt: null })])[0]!.kind)
      .toBe("stopped");
  });

  it("a FRESHLY CONNECTED reader nobody has agreed to has nothing to announce", () => {
    // Its next screen is the agreement, not a notice about a handover that never happened.
    expect(organizerNotices([row({ organizedBy: null, organizeConsentedAt: null })])).toEqual([]);
  });

  it("an unnamed holder is `null`, never an invented name", () => {
    const only = organizerNotices([row({
      organizedBy: { kind: "local", name: null, since: EARLIER },
    })]);
    expect(only[0]!.name).toBeNull();
  });

  it("several mailboxes are several facts, newest change first", () => {
    const out = organizerNotices([
      row({ id: "old", organizerEventAt: EARLIER }),
      row({ id: "new", organizerEventAt: LATER }),
    ]);
    expect(out.map((n) => n.id)).toEqual(["new", "old"]);
  });
});

describe("the catalogues say only what is still said", () => {
  it("the two dropped sentences are gone and the seven new keys are in both languages", () => {
    const NEW = ["noticeElsewhereMany", "noticeStoppedMany", "noticeCountShow", "noticeCountHide",
      "noticeRowUnknown", "noticeRowStopped", "noticeRowStoppedUnknown"];
    for (const cat of [mailboxesEn, mailboxesDe]) {
      const m = cat.mailboxes as unknown as Record<string, string>;
      expect(m.noticeHere, "the 'here' sentence is still in a catalogue").toBeUndefined();
      expect(m.noticeReleased, "the 'released' sentence is still in a catalogue").toBeUndefined();
      for (const k of NEW) expect(m[k], `${k} missing`).toBeTruthy();
      // The *Many keys take `{count}` >= 2 (one mailbox takes the named sentence): no plural form.
      for (const k of ["noticeElsewhereMany", "noticeStoppedMany"]) {
        expect(m[k]).toContain("<c>{count} ");
        expect(m[k]).not.toContain("plural");
      }
    }
  });
});

describe("the organizer refusal words", () => {
  it("EVERY reason in the organizer's vocabulary has a sentence in both catalogues", () => {
    /* The set is closed on the wire, so the whole of it can be asserted rather than sampled. A
       reason added on the server without copy here would render "reason unknown" — quiet, wrong,
       and invisible to every other guard. */
    const REASONS = [
      "unauthenticated", "conflict", "wrong_mailbox", "invalid_payload",
      "unhandled_kind", "stale", "account_erased",
    ] as const;
    for (const catalogue of [screenerEn, screenerDe]) {
      for (const reason of REASONS) {
        const sentence = catalogue.screener[`pendingReason_${reason}`];
        expect(sentence, `no sentence for the refusal reason ${reason}`).toBeTruthy();
        expect(sentence, `${reason} renders its own token`).not.toContain(reason);
      }
    }
  });
});
