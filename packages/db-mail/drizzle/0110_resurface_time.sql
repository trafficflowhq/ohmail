-- THE RESURFACE TIME — the wall clock a person's resurfaced mail comes back at, one nullable
-- column on `account_settings`.
--
-- `'HH:MM'`, 24-hour, in the reader's own zone — the same wall clock the horizons have always
-- minted (`format.ts` resolves 09:00 through `zonedInstant`); only the hour and minute are
-- stored, never an instant, because a preference is "come back at half past two", not a date.
-- NULL is the product's built-in 09:00 and is what every existing row holds, so nothing that is
-- already scheduled moves and nobody's first resurface lands anywhere new.
--
-- NO CHECK, deliberately, where `locale` and `theme_face` have one. Those close a SET, and a
-- value outside it degrades silently — a language that simply does not load. This closes a
-- FORMAT: the route refuses anything but `HH:MM` by name, and a value that got past it anyway is
-- shown in the chooser's time control before any press, which is the one thing this feature
-- guarantees. A wrong value is visible and correctable rather than silent.
--
-- Additive, `IF NOT EXISTS`, no default and no backfill, so a desktop engine replaying this
-- journal at every launch applies it repeatedly without effect. ROLLBACK is
-- `ALTER TABLE account_settings DROP COLUMN resurface_time`: every account returns to 09:00.

ALTER TABLE "account_settings" ADD COLUMN IF NOT EXISTS "resurface_time" text;
