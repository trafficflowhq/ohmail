-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--  0096 — WHICH PILES THE AWAY RESPONDER ANSWERS, AND WHICH CORRESPONDENTS ARE UNREACHABLE
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ══ WHAT WENT WRONG, FROM REAL USE ═════════════════════════════════════════════════════════════
--
-- A responder set to "people I've let in", at most once a day, sent eight automatic replies to
-- notification, shop and developer senders, and a bounce of one of those replies arrived back in
-- its owner's own Ohbox.
--
-- The rate was not the fault: two of those replies went to one service 25.5 h apart, so the
-- per-sender throttle held exactly as it says it does. The AUDIENCE was the fault, and not because
-- it is wrong — because it answers a different question from the one somebody setting it is asking.
-- `audience` is a fact about a SENDER: this person is past the Screener, decided once, true for
-- ever. It says nothing about WHERE that sender's later mail lands. A shop let in to deliver one
-- order confirmation is still "somebody I've let in" when its newsletter files to Reads six months
-- later.
--
-- So the responder needs a second, independent dimension: not only WHO may be answered but WHICH
-- OF THEIR MAIL. That is `piles`.
--
-- ══ WHY THE MEMBERS ARE FOLDERS AND NOT PILE WORDS ════════════════════════════════════════════
--
-- The pile a person calls "Ohbox" is the folder `INBOX`. The six destinations map onto the six
-- pile words in `VIEW_OF_FOLDER` (client-engine), where `ohmail/Quarantine` is the one a person
-- calls "Spam". THERE IS NO FOLDER CALLED `ohmail/Ohbox` — and this feature's own test fixture
-- carried that string for three cases, so each of them measured a placement the router cannot
-- produce and none of them noticed.
--
-- The value the rule compares against is `folder_state.desired_folder`, which holds a DESTINATION.
-- So this column holds destinations, the pile words stay a display concern, and the translation
-- happens once, in the surface that shows it.
--
-- ══ THE CLOSED SET IS TWO MEMBERS, AND THE OTHER FOUR ARE REFUSED ELSEWHERE ════════════════════
--
--   INBOX              the Ohbox. The default, and on its own.
--   ohmail/Reads       opt-in. This is the choice the eight replies above were missing.
--
-- The four that are not offered are each refused by something that already exists, and none of
-- them is refused by being merely absent from this column:
--
--   ohmail/Receipts    joins the never-answered map in `away-eligibility.ts` in this release. A
--                      receipt is machine mail about a transaction the account itself started.
--   ohmail/Screened    already there — the durable "no" of a screening decision.
--   ohmail/Quarantine  already there — mail the pipeline judged hostile. Answering a phish
--                      confirms to whoever sent it that the address is live and attended.
--   ohmail/Screener    deliberately NOT a member, and this is the one that would have been easy
--                      to get wrong. The Screener is the AUDIENCE's decision: `everyone` exists
--                      precisely to answer the strangers waiting there. Offering it as a pile
--                      would let two settings contradict each other about that one population,
--                      and whichever was consulted second would silently win.
--
-- A member nobody enumerated is a member no reader handles, and here the branch an unhandled
-- member falls through to is the branch that sends mail — the same argument 0087 makes for the
-- throttle's own CHECK, and the reason the closed set is in the schema and not only in a
-- validator. The validator turns a bad request into a 400 naming the field; this makes a member
-- nobody enumerated unrepresentable whichever writer produced it.
--
-- IT IS WIDENED, NEVER NARROWED (0090/0091's rule): a build that offers a third pile ships the
-- widening migration ahead of the code that writes it, so a row an older build wrote still
-- satisfies the constraint. `<@` is containment, so the EMPTY array satisfies it — which is a
-- responder that answers nobody. That is a coherent, fail-closed state the rule handles by name
-- ("empty piles answer NOBODY, and are not read as 'no filter'"), and refusing it here would mean
-- a person who unticks everything gets a 400 instead of a quiet responder.
--
-- ══ THE DEFAULT IS THE NARROW MEMBER, WHICH IS ALSO THE BEHAVIOUR CHANGE ═══════════════════════
--
-- `'{INBOX}'` for every existing row. That is a NARROWING of live behaviour and it is the point:
-- a responder that is on right now stops answering mail that files to Reads or Receipts the moment
-- this migration lands. Somebody who wants the old reach opts Reads in, which is one press.
--
-- The direction is deliberate and it is the opposite of 0087's, which widened on purpose. Widening
-- what a standing order reaches is the only irreversible thing this feature does — a reply sent to
-- somebody its owner did not mean cannot be recalled — so the value nobody chose has to be the one
-- that reaches fewest people. Being answered later is recoverable; the eight replies that prompted
-- this were not.
--
-- ══ `undeliverable_at` — THE BOUNCE, RECORDED ONCE ════════════════════════════════════════════
--
-- The bounce in that Ohbox is the other half of the report, and on its own it is harmless: a
-- delivery report is refused as a candidate in this release, so it earns no reply of its own. What
-- it MEANS is the problem — the address the responder wrote to does not accept mail — and nothing
-- recorded that, so the next message from the same correspondent produced another reply and
-- another bounce, once per throttle interval for the length of the trip.
--
-- On `away_sender_state` and not on the ledger, because it is a fact about a PERSON rather than
-- about one decision, which is the same reason that table exists at all. Nullable, and the stamp
-- is the instant the bounce was seen: "when did we learn this" is worth more than a boolean and
-- costs the same.
--
-- Permanent by design, with no expiry. A mailbox that starts accepting mail again is real but rare,
-- and the recoverable direction here is silence: the alternative is a bounce per interval into
-- this account's own Ohbox, which is the state this column exists to end.
--
-- ══ COMPATIBILITY ══════════════════════════════════════════════════════════════════════════════
--
-- Purely additive: two columns and one CHECK, no drop, no rename, no type change. An API one
-- deploy older ignores both and keeps working — it selects `away_responders` whole, which still
-- has every column it knew, and its writes omit `piles`, which the DEFAULT then supplies. That
-- older writer's saves therefore RESET the piles to the Ohbox on every PUT, because the endpoint
-- is a full replace; a narrowing on an unrelated save is the acceptable direction, and the same
-- one `validAudience` takes for an omitted audience.
--
-- ROLLBACK: drop the two columns and the constraint. Nothing outside this feature reads either.
--
-- Idempotent throughout (`IF NOT EXISTS`, and the CHECK dropped-then-added, the shape
-- `0007_staff_users` established), because a desktop engine replays this journal at every launch.

-- ── WHICH PILES ARE ANSWERED ─────────────────────────────────────────────────────────────────

ALTER TABLE "away_responders" ADD COLUMN IF NOT EXISTS "piles" text[] NOT NULL DEFAULT '{INBOX}';--> statement-breakpoint

-- Repair before constrain, on 0091's rule: the alternative to a repair is a FAILED migration on
-- somebody's mailbox at launch. No writer can have put anything else here — the column is created
-- in this same file — so this cannot fire against any database this fleet has produced, and it is
-- the honest thing to run anyway before a constraint that would refuse the row.
UPDATE "away_responders" SET "piles" = '{INBOX}'
  WHERE NOT ("piles" <@ ARRAY['INBOX', 'ohmail/Reads']::text[]);--> statement-breakpoint

ALTER TABLE "away_responders" DROP CONSTRAINT IF EXISTS "away_responders_piles_closed";--> statement-breakpoint

ALTER TABLE "away_responders" ADD CONSTRAINT "away_responders_piles_closed"
  CHECK ("piles" <@ ARRAY['INBOX', 'ohmail/Reads']::text[]);--> statement-breakpoint

-- ── THE CORRESPONDENT WHOSE ADDRESS DOES NOT ACCEPT MAIL ─────────────────────────────────────

ALTER TABLE "away_sender_state" ADD COLUMN IF NOT EXISTS "undeliverable_at" timestamptz;
