-- A HELD FIRST-CONTACT SENDER'S ACCOUNT IS OWED A SUGGEST VISIT — the mark the worker's cycle
-- reads to serve that account FIRST. Until this table the automatic Screener suggestion was
-- bought only on the worker's cycle cadence, at the tail of its per-account pass sections: a mail
-- that landed and was held at the gate within seconds waited out the rest of the cycle — over a
-- minute on the cycle cadence alone, measured on a test account — before the model was asked, and
-- the row on screen said nothing. The mark is written by the ingest that HELD the sender — gated on the
-- account's `auto_suggest_at` opt-in, so an account that never opted in never gets a row — and
-- consumed by the cycle's owed-first serve; the 60-second cycle remains the backstop, so a lost
-- mark costs latency, never a suggestion. None of the four spend bounds moves: the watermark, the
-- per-cycle batch, `spend()` before the model and one purchase per sender all live in the pass.
--
-- CLOUD, not mail: the mark is the HOSTED worker's scheduling priority. A standalone install runs
-- the same pass at the tail of every drain (`apps/sidecar`), which is already ingest-driven, so
-- the device store has no cycle to prioritise and must not carry the table.
--
-- ON DELETE CASCADE: a mark naming an erased account is a row nothing will ever serve.
--
-- DEPLOY ORDER: migration, then worker. The reverse costs a logged `screener_suggest_owed_mark_failed`
-- per held ingest and the cadence falls back to the cycle — visible, and nothing is lost.
--
-- ROLLBACK is `DROP TABLE screener_suggest_owed`, after reverting the writer. Nothing else moves.

CREATE TABLE IF NOT EXISTS "screener_suggest_owed" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  -- When the FIRST unserved hold arrived — `ON CONFLICT DO NOTHING` keeps it, so the owed order
  -- is arrival order and a flood of holds from one account cannot keep re-jumping the queue.
  "owed_at" timestamp with time zone DEFAULT now() NOT NULL
);
