import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveMailState, readerStandDown } from "@ohmail/app-logic/mail-state/mail-state";
/* The SHIPPED catalogues, both of them — the remedy cases at the foot of this file are a
   claim about what a stranded person reads, so they read what ships. */
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * ═══ A 0083-ERA READER IS EXPLAINED BY ITS ROLE — and the SYNC RAIL still says nothing ═══════
 *
 * ── THE DEFECT ────────────────────────────────────────
 *
 * The mailbox pane asked `status === 'disabled' && disabledReason` for "somebody else organizes
 * this", and mail 0083 moved that fact onto the ROLE: a demoted install is `connected` with
 * `organizer_role = 'reader'` and no reason. So the predicate matched nothing this build writes.
 * The row went quiet — and because the organizer CHECK and the claim button hang off the same
 * branch, a 0083-era reader also had no way back. `legacyStandDown` was added to the facts for
 * this and had no consumer; the pane had zero occurrences of `organizerRole`.
 *
 * ── THE RULING, PINNED HERE BECAUSE IT IS A DECISION AND NOT AN OVERSIGHT ────────────────────
 *
 * The SYNC RAIL gets no reader arm (2026-09-02). It reports sync health, and a reader's mirror is
 * growing — it reads, searches, marks read and sends — so `blocked` there would be a false
 * sentence about a mailbox that is working. The fact belongs to the pane's row and to the phone's
 * banner. The last case below is that ruling as a test, so the next reader finds a decision
 * rather than a gap.
 *
 * Mutation-checked, each watched red and restored:
 *  · drop the `holder || consent` test          → the freshly-connected case;
 *  · read the role before the tombstone          → the removed-mailbox case;
 *  · add a reader arm to `deriveMailState`       → the ruling case.
 */

const PANE = readFileSync(
  resolve(process.cwd(), "apps/webapp/app/(product)/mailbox/MailboxSection.tsx"), "utf8",
);

const reader = (over: Record<string, unknown> = {}) => ({
  status: "connected",
  organizerRole: "reader" as const,
  organizedBy: { kind: "local", name: "a laptop", since: "2026-08-01T00:00:00.000Z" },
  organizerState: "held" as const,
  organizeConsentedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("readerStandDown — the role is the record now", () => {
  it("a demoted install is explained, though nothing wrote a reason", () => {
    expect(readerStandDown(reader())).toBe("organized_elsewhere_local");
  });

  it("…and the holder's kind picks the sentence, cloud included", () => {
    expect(readerStandDown(reader({ organizedBy: { kind: "cloud", name: null, since: null } })))
      .toBe("organized_elsewhere_cloud");
  });

  it("a CONSENTED reader with no holder and NO RELEASE MARKER is still a stand-down — the winner decayed", () => {
    /* THE CASE THE MARKER EXISTS TO TELL APART, and the reason `readerStandDown` may not key
       `released` on the absent holder. `refreshOrganizerHolder` (`apps/worker/src/mailboxes.ts`)
       and the sidecar's `notePeekedHolder` rewrite all four holder columns on EVERY reader cycle
       and write them all NULL when the peek finds an empty claim folder — which is exactly what a
       stood-down reader sees once the install that beat it is removed. So a genuine stand-down
       decays into the holder-less shape on its own, with nothing having released anything.

       `holder OR consent` still decides that a stand-down happened at all; only the marker
       decides whose. Answering `released` here would tell somebody they had stopped organizing a
       mailbox they never got to organize. `standDownMemory` (`packages/db/src/organizer-role.ts`)
       reached the same conclusion server-side, through a review round that found the earlier
       absence-based test wrong. */
    expect(readerStandDown(reader({ organizedBy: null }))).toBe("organized_elsewhere_unknown");
  });

  it("…and WITH the release marker it is the RELEASE, which is a different sentence", () => {
    /* Measured live on 2026-09-04 on the hosted service: after `POST /mailboxes/:id/release`
       completed, `GET /mailboxes/:id` reported exactly this row — reader, no holder, no state, a
       release stamp, consent still set — and Settings → Mailboxes rendered "Another ohmail
       organizer has claimed this mailbox … it will not start again on its own" over it, above a
       check that answered "No other ohmail install is organizing this mailbox". The transient
       notice for the SAME row at the SAME instant said "You stopped organizing … here", so the
       two surfaces contradicted each other on one fact. */
    expect(readerStandDown({
      ...reader({ organizedBy: null, organizerState: null }),
      organizerReleasedAt: "2026-09-04T09:12:00.000Z",
    })).toBe("released");
  });

  it("a HOLDER OUTRANKS THE MARKER — somebody took it back, and that is not a release", () => {
    /* Every promotion clears `organizer_released_at`, so this row should not exist; the ordering
       is what makes the sentence right anyway on a row that lags one poll behind. A named holder
       is somebody organizing this mailbox NOW, which is the stand-down sentence and the takeover
       ceremony, whatever a stale marker beside it says. */
    expect(readerStandDown({
      ...reader(), organizerReleasedAt: "2026-09-04T09:12:00.000Z",
    })).toBe("organized_elsewhere_local");
  });

  it("a holder known only by NAME is still a holder — `unknown` is the sentence, not `released`", () => {
    /* The `kind || name` test, from the far side: a claim written by a version that recorded no
       kind still names a machine. It must reach the stand-down sentence for an unknown kind, and
       must not fall through to the release. */
    expect(readerStandDown({
      ...reader({ organizedBy: { kind: null, name: "a laptop", since: null } }),
      organizerReleasedAt: "2026-09-04T09:12:00.000Z",
    })).toBe("organized_elsewhere_unknown");
  });

  it("AN EXPLICIT `null` MARKER is not a release either — the column exists and says nothing happened", () => {
    /* Three states again, and both non-values mean "not released". Absent is the host too old to
       send the column at all (the role shipped first, so that deployment is real); `null` is the
       host that sends it for a mailbox this account has never let go. An out-of-date explanation
       costs a sentence; a release announced for a handover nobody made is a false claim about
       something the person is told they did. */
    expect(readerStandDown({
      ...reader({ organizedBy: null }), organizerReleasedAt: null,
    })).toBe("organized_elsewhere_unknown");
  });

  it("THE WALL'S PAUSE IS ITS OWN ANSWER — `parked`, never the release and never a stand-down", () => {
    // Mail 0135: the park writes both stamps at one instant; the account reading open resumes it.
    const at = "2026-09-23T02:15:07.000Z";
    const paused = { ...reader({ organizedBy: null, organizerState: null }), organizerReleasedAt: at };
    expect(readerStandDown({ ...paused, organizerParkedAt: at })).toBe("parked");
    // Cloud's own stale claim, named by a peek after the reopening, is not a stop either.
    expect(readerStandDown({ ...reader({ organizerState: "stopped" }), organizerParkedAt: at })).toBe("parked");
    // CONTROL: `null` (not paused) and absent (a host too old to say) keep the release.
    expect(readerStandDown({ ...paused, organizerParkedAt: null })).toBe("released");
    expect(readerStandDown(paused)).toBe("released");
  });

  it("A FRESHLY CONNECTED MAILBOX IS NOT A STAND-DOWN — `reader` is the pre-consent state too", () => {
    // The round-two correction that closed the role alone would report a mailbox nobody has
    // agreed to organize as taken back from an organizer it never had.
    expect(readerStandDown(reader({ organizedBy: null, organizeConsentedAt: null }))).toBeNull();
  });

  it("an ABSENT consent field with no holder claims NOTHING — the safe direction", () => {
    /* Three states, and absent is "cannot tell". The only host that reaches this line is one
       sending the role and not the stamp, where a holder-less reader is equally likely to be a
       mailbox nobody has agreed to organize yet — so claiming a stand-down would put a false
       sentence and a claim button over a fresh connect. Losing a sentence is the cheaper error. */
    const { organizeConsentedAt: _drop, ...noField } = reader({ organizedBy: null });
    expect(readerStandDown(noField)).toBeNull();
  });

  it("…but an absent stamp WITH a named holder still explains — the holder is evidence enough", () => {
    const { organizeConsentedAt: _drop, ...noField } = reader();
    expect(readerStandDown(noField)).toBe("organized_elsewhere_local");
  });

  it("an object of nulls is NOT a holder", () => {
    expect(readerStandDown(reader({
      organizedBy: { kind: null, name: null, since: null }, organizeConsentedAt: null,
    }))).toBeNull();
  });

  it("THE TOMBSTONE IS ASKED FIRST — a removed mailbox keeps whatever role it had", () => {
    /* The fixture carries a HOLDER as well as the tombstone, and that is what makes this case
       able to fail: a first draft used a bare `disabled` + `reader` row, and reordering the two
       branches left it green because both orders answer null for a row with no reason. With a
       holder present the two orders disagree — role-first would report `organized_elsewhere_local`
       about a mailbox the user REMOVED, which is a lie in the reassuring direction and the same
       order `organizeHere` takes on the server. */
    expect(readerStandDown({
      status: "disabled", disabledReason: null, organizerRole: "reader",
      organizedBy: { kind: "local", name: "a laptop", since: null },
      organizeConsentedAt: "2026-08-01T00:00:00.000Z",
    })).toBeNull();
  });

  it("and the LEGACY wire is untouched — `disabled` with a reason still answers", () => {
    expect(readerStandDown({ status: "disabled", disabledReason: "organized_elsewhere:cloud" }))
      .toBe("organized_elsewhere_cloud");
  });

  it("an organizer is never stood down, whatever else the row says", () => {
    expect(readerStandDown(reader({ organizerRole: "organizer" }))).toBeNull();
  });
});

describe("the pane explains a reader, and offers the way back", () => {
  it("the row derives its explanation from the ROLE, not from `status === disabled`", () => {
    expect(PANE).toContain("readerStandDown(m)");
    expect(PANE, "the old disabled-only predicate is back")
      .not.toContain('m.status === "disabled" ? standDownToken(m.disabledReason ?? null) : null');
  });
});

describe("THE SYNC RAIL GETS NO READER ARM — a ruling, not an omission", () => {
  const NOW = new Date("2026-09-02T12:00:00.000Z").getTime();
  const stamp = new Date(NOW - 30_000).toISOString();
  /** The resting inputs: a healthy account, nothing wrong, so only the mailbox row varies. */
  /* `syncBlockedSince: null` IS LOAD-BEARING IN THIS FIXTURE, and its absence is what made the
     first run of these two cases red for the wrong reason. The blocked arm tests
     `m.syncBlockedSince !== null`, so an ABSENT field is `undefined`, which is `!== null` — a
     minimal fixture lands on the infrastructure-blocked arm and looks exactly like the defect
     under test. The control below is what caught it: the plain ORGANIZER derived `blocked` too. */
  const inputs = (mailboxes: unknown[]): Parameters<typeof deriveMailState>[0] => ({
    sync: { bootstrapping: false, failures: 0, terminal: false, refused: false },
    failureStreak: 3,
    mailboxes: mailboxes as never,
    mirrored: 495,
    growth: { rises: 0, last: 495, at: NOW, first: null } as never,
    freshness: { state: "current", asOf: stamp },
    engineFreshness: { state: "current", asOf: stamp },
    now: NOW,
    demo: false,
  } as never);

  it("a reader whose mirror is growing is NOT `blocked`", () => {
    // `blocked` says nothing is happening. For a reader that is false: the mirror grows and the
    // mailbox reads, searches, marks read and sends. The rail is sync health; the organizer fact
    // belongs to the pane's row and to the phone's banner.
    const state = deriveMailState(inputs([
      reader({ id: "m1", address: "me@example.test", lastSyncAt: stamp, syncBlockedSince: null }),
    ]));
    expect(state.key, "the rail called a working reader blocked").not.toBe("blocked");
  });

  it("CONTROL: the same row as an ORGANIZER derives the same thing — the role changes nothing here", () => {
    // Which is the whole ruling, stated as a comparison rather than as an absence: the rail's
    // answer for a reader and for an organizer with identical sync facts must be identical.
    const row = { id: "m1", address: "me@example.test", lastSyncAt: stamp, syncBlockedSince: null };
    const asReader = deriveMailState(inputs([reader(row)]));
    const asOrganizer = deriveMailState(inputs([{ ...row, status: "connected" }]));
    expect(asReader.key).toBe(asOrganizer.key);
  });

  it("…and the LEGACY `disabled`+reason arm still reaches it", () => {
    // Kept deliberately: rows written before 0083 carry it, and it is the only thing they say.
    const state = deriveMailState(inputs([{
      id: "m1", address: "old@example.test", syncBlockedSince: null,
      status: "disabled", disabledReason: "organized_elsewhere:cloud",
    }]));
    expect(state.key).toBe("blocked");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SENTENCE A STRANDED PERSON READS FIRST HAS TO NAME THE REMEDY
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * REPORTED by a real user on the public issue tracker: on the Cloud pane a mailbox held by their
 * own desktop install showed *"Not organized here — ohmail on your own machine has claimed this
 * mailbox."* They then pressed "pull new mail", were refused, and did not know what to do.
 *
 * The sentence stated the fact and stopped. It said nothing about the two things that would have
 * unstranded them: that their mail is still arriving and readable here, and that a control on
 * this pane moves the organizing to this install.
 *
 * ── WHY THE PANE AND NOT THE BUTTON'S LABEL ────────────────────────────────────────────────
 *
 * `blocked_*` is the SHELL's vocabulary (`sync`), rendered by the failing-sync strip
 * (`SyncBar.tsx`) as well as by the mailbox row — there is no button beside the strip at all,
 * and the control's label differs by door ("Take over on Cloud…" hosted, "Organize here instead"
 * on the desktop's own pane). So it names the pane, which is the form `sync.blocked_where`
 * already uses for the billing states. `mailboxes.standDownHow` has exactly one consumer and one
 * button under it, so THAT one names the label.
 *
 * ── AND "has claimed" STAYS, WHICH THE FIRST DRAFT GOT WRONG ───────────────────────────────
 *
 * The first version of this slice rewrote the six sentences to say the other install
 * "organizes" the mailbox. `mailbox-stand-down.test.tsx`'s "THE COPY IS TRUE OF A DEAD CLAIM AS
 * WELL AS A LIVE ONE" went red, and its objection is older than this slice and load-bearing:
 * `standDownReason` (`apps/worker/src/lease.ts`) maps BOTH lease verdicts onto one token —
 * `stand_down` (a FRESH foreign claim, somebody is organizing right now) and `available` (a
 * STALE one, nobody is and we refuse to self-promote). The case that produced the original gap
 * was the second, a local worker three hours dead, and "organizes" is false there.
 *
 * A claim is a claim whether or not anybody is home. So the claim half is exactly the released
 * wording and this file does NOT assert against it; what it asserts is the two sentences that
 * were missing after it. Both are true of a dead claim too: a reader syncs whoever holds the
 * claim, so the mail does arrive and is searchable, and the control moves organizing here in
 * either case.
 *
 * ── HOW TO WATCH THESE FAIL ────────────────────────────────────────────────────────────────
 *
 * Restore any of the six sentences to its released wording (the claim alone, with neither
 * sentence after it) → the matching case goes red. Done for
 * `blocked_organized_elsewhere_local` and `standDownHow`.
 */
describe("the organized-elsewhere sentences name the remedy, not just the fact", () => {
  const BLOCKED = [
    "blocked_organized_elsewhere_local",
    "blocked_organized_elsewhere_cloud",
    "blocked_organized_elsewhere_unknown",
  ] as const;
  const STOOD_DOWN = [
    "standDown_organized_elsewhere_local",
    "standDown_organized_elsewhere_cloud",
    "standDown_organized_elsewhere_unknown",
    "standDownClaimedByServer",
  ] as const;

  for (const lang of ["en", "de"] as const) {
    const cat = lang === "en" ? en : de;
    /* The two halves the report was missing, per language. Substrings and not whole sentences:
       this is a claim about what the copy must SAY, and pinning the exact wording here would make
       every future edit a test edit — which is how a guard stops being read. */
    const reads = lang === "en" ? "readable" : "lesbar";
    const pane = lang === "en" ? "Settings → Mailboxes" : "Einstellungen → Postfächer";

    for (const key of BLOCKED) {
      it(`${lang}: ${key} says the mail still arrives and where the control is`, () => {
        const said = (cat.sync as Record<string, string>)[key]!;
        expect(said, "the person was not told their mail is still arriving").toContain(reads);
        expect(said, "the person was not told where to go").toContain(pane);
        /* THE CLAIM HALF IS NOT ASSERTED AGAINST — see the header. It is the released wording
           and it is the only one true of a stale claim, which is the case the row exists for. */
      });
    }

    for (const key of STOOD_DOWN) {
      it(`${lang}: ${key} says THIS install reads the mailbox`, () => {
        const said = (cat.mailboxes as Record<string, string>)[key]!;
        expect(said, "the row stated a claim and not what this install does")
          .toContain(lang === "en" ? "reads it" : "liest es");
      });
    }

    it(`${lang}: standDownHow names the button that is actually under it`, () => {
      /* ONE consumer — `MailboxSection.tsx`, the hosted pane — and the button directly beneath
         is `mailboxes.organizerCheck`. Read out of the catalogue rather than restated, so a
         relabelled button makes this red instead of leaving the sentence pointing at a control
         nobody can find. */
      const how = (cat.mailboxes as Record<string, string>).standDownHow!;
      const label = (cat.mailboxes as Record<string, string>).organizerCheck!;
      expect(how, "the sentence names no way forward").toContain(label);
      // The self-hosted build's pair, which the filer table picks there.
      const mb = cat.mailboxes as Record<string, string>;
      expect(mb.standDownHowServer, "the server's sentence names no way forward").toContain(mb.organizerCheckServer!);
    });
  }
});
