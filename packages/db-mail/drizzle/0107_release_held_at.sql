-- THE OWNER'S PRESS TO RELEASE MAIL A RULE NEVER REACHED — recorded on the rule, once per press.
--
-- Mail an install adopted at the screening gate is stamped as a placement no pass may revisit, and
-- it stays at the gate even when its sender has a rule pointing elsewhere: the rule's retroactive
-- pass ran before the rule existed, or finished before the mail arrived, and nothing re-decides it
-- afterwards. `0100_reader_window_peer_restamp` corrected the stamp for the rows it could prove;
-- what it could not do is ask again.
--
-- This column is that asking. It is set only by an explicit press over a named group of held mail,
-- and the retroactive pass reads it as a NARROW licence: for a rule carrying it, mail still sitting
-- at the gate may be reconsidered even though its placement was recorded as a hand file. Outside
-- the gate, and for every rule without the stamp, a hand placement still wins.
--
-- Nullable with no default and no backfill: absent means nobody has pressed, which is the truth for
-- every existing row. Idempotent, because a desktop engine replays this journal at every launch.

ALTER TABLE "rules" ADD COLUMN IF NOT EXISTS "release_held_at" timestamptz;
