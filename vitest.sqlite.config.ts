import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "./vitest.config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * THE SECOND STORE'S SCHEMA, PUT WHERE THE CODE UNDER TEST ACTUALLY LOOKS FOR IT.
 *
 * The design this implements says a build for a device swaps `@trafficflow/db/mail` for
 * `@trafficflow/db/mail-sqlite`. Counted over the forty-six engine-closure files that carry a
 * construct the two stores spell differently, THIRTY-EIGHT import their tables from the barrel
 * `@trafficflow/db`, eight more inside `packages/db/src` import `./schema-mail.js` by relative
 * path, and exactly ONE imports `@trafficflow/db/mail` — a sidecar module the device entry drops.
 * So swapping that one specifier substitutes the schema for one file in forty, and every service
 * would run the second store's statements against the FIRST store's column types: Postgres
 * `uuid`, `timestamp` and `jsonb` mappers, and three generated `tsvector` columns the device twin
 * does not have.
 *
 * The substitution therefore happens at the module the barrel itself reaches. `packages/db/src/
 * index.ts` and `schema.ts` both say `export * from "./schema-mail.js"`, so rewriting THAT
 * specifier serves the twin to all thirty-eight barrel importers and to the eight relative ones
 * without editing a line of any of them.
 *
 * ── WHY THE SPECIFIER IS ANCHORED, MEASURED IN BOTH LOOSER SHAPES ─────────────────────────
 *
 * `^\.\/schema-mail\.js$` matches the exact specifier written inside `packages/db/src`, and
 * nothing else. `schema-twin-parity.test.ts` — the one file whose whole job is comparing the two
 * twins — reaches the Postgres side as `../src/schema-mail.js`, and the two ways of losing that
 * distinction behave DIFFERENTLY, which is worth knowing before trusting either:
 *
 *   · a TAIL-anchored pattern (`/schema-mail\.js$/`) fails loudly. The alias plugin rewrites only
 *     the span the pattern matched, so the specifier becomes `../src/` followed by an absolute
 *     path and nothing resolves: "Cannot find module '../src/schema-mail.js'". Unpleasant, but
 *     impossible to mistake for a pass.
 *   · a WHOLE-specifier pattern (`/^.*schema-mail\.js$/`) substitutes silently, and then the
 *     parity file is holding the device twin twice. Measured: four assertions fail, three of them
 *     by number ("expected 0 to be greater than 40") and one by name.
 *
 * So the danger is real and the detection was already partly there. What the control below adds is
 * the SENTENCE — a reader who sees "expected 0 to be greater than 40" goes looking at the schema;
 * a reader who sees "the server twin resolved to something with no Postgres tables in it" goes
 * looking at this file. The claim in this comment is a measurement, not an argument.
 */
const SQLITE_TWIN = r("./packages/db/src/schema-mail-sqlite.ts");
const baseAlias = (base.resolve?.alias ?? []) as { find: string | RegExp; replacement: string }[];
const alias = [
  { find: /^\.\/schema-mail\.js$/, replacement: SQLITE_TWIN },
  // Repointed IN PLACE rather than prepended: the base table is scanned in order and a string
  // `find` is a prefix match, so an entry for `@trafficflow/db/mail` ahead of the table would
  // also swallow `@trafficflow/db/mail-sqlite` and rewrite it to a path with `-sqlite` twice.
  ...baseAlias.map((entry) =>
    entry.find === "@trafficflow/db/mail" ? { ...entry, replacement: SQLITE_TWIN } : entry),
];

/**
 * THE SECOND RUN OF THE SUITE — the same files, against the store a device carries.
 *
 * A project rather than a flag. A flag inside one run would mean every file decides for itself
 * whether it is on the second store, which is how a suite ends up with a dialect nobody exercises
 * and a green that says nothing. Two runs of the same files, told apart by one variable read in
 * one place, is the only arrangement where "it passes on both" is a fact rather than a claim.
 *
 * The include list is deliberately narrow and grows as the code that reads the store learns to
 * speak both dialects. A file joins it when it passes on both — not before, because a red that is
 * expected is a red nobody reads.
 *
 * RUN BY `pnpm test:sqlite`, and both runs by `pnpm test:matrix`. A config nothing invokes is a
 * config that passes: this one existed for a day with no caller, so "the suite runs on both
 * stores" was true of a command nobody had ever typed.
 *
 * `fileParallelism` stays off for the base config's reason, and gains a second here: each file
 * opens its own store, and a device has exactly one writer.
 *
 * The base config is spread rather than MERGED, and that is not a style choice. Merging appends
 * array fields, so the narrow list below would have been added to the base run's include instead
 * of replacing it — the second store would have been handed the whole suite, and the resulting
 * hour of failures would have looked like the store's fault rather than the config's. Measured,
 * once, the expensive way.
 */
export default defineConfig({
  ...base,
  resolve: { ...base.resolve, alias },
  test: {
    ...base.test,
    name: "sqlite",
    include: [
      "packages/db/test/sqlite-matrix.test.ts",
      "packages/db/test/sqlite-baseline.test.ts",
      "packages/db/test/sqlite-journal-inlined.test.ts",
      "packages/db/test/journal-lockstep.test.ts",
      "packages/db/test/schema-twin-parity.test.ts",
      "packages/db/test/dialect.test.ts",
      "packages/db/test/sqlite-serialization.test.ts",
      // THE CUTLINE, which three server paths read and the phone runs too. Its shared module's
      // first draft was Postgres-only and every other cutline test in the tree is a Postgres
      // twin, so this run is the only thing that could have refused it.
      "packages/db/test/sqlite-cutline.test.ts",
      // A rule's match as every SQL reader keys it: the phone runs the same readers.
      "packages/db/test/rule-match-sql.test.ts",
      // Mail 0144's two backfill classes and their controls, through this store's own file.
      "packages/db/test/migration-0144-person-decided.test.ts",
      // Mail 0146's two arms and their controls, through this store's own file.
      "packages/db/test/migration-0146-person-decided-followup.test.ts",
      // The stored-body counter, which is the write that rides every message the engine
      // stores — `now()` and the largest-of clamp, one case per arm.
      "packages/db/test/storage-dialect.test.ts",
      // A NEWER-FORMAT "NOT NOW" READ BACK — the version compared as text on the device store too.
      "packages/db/test/profile-import-newer-dialect.test.ts",
      // The change-log allocation's mailbox fence, whose two arms are different statements: the
      // server folds the locked read into the allocating statement (a data-modifying CTE), and
      // this store — which has no such form and one writer — answers from a read of its own.
      // Without this line the device arm is code nothing runs.
      "packages/db/test/allocate-seq-fence.test.ts",
      // The Screener decide's twin retarget: the standalone phone decides through the same
      // `applyScreenerDecision` on this store, so its UPDATE runs here as well as on the server.
      "packages/db/test/screener-apply-twins-dialect.test.ts",
      "packages/db/test/screener-apply-batches.test.ts",
      // The act's filing of letters their provider did not confirm, which the local engine runs too.
      "packages/db/test/screener-unconfirmed-reroute.test.ts",
      /* Retention's mail half: the local engine's drain-end upkeep runs it on the device store too. */
      "packages/db/test/change-log-retention-dialect.test.ts",
      // The ingest's FIRST write. It failed on this store before any message could land —
      // `no such column: xmax` — so its two arms are different code, and this is the file
      // that makes them answer `created` identically.
      "packages/core/test/thread-upsert-dialect.test.ts",
      // The read-state completion's compare-and-set. One raw UPDATE whose booleans are literals
      // (this driver takes no JavaScript boolean) and whose verdict comes back as TEXT (the two
      // stores spell a boolean column differently). The sidecar composes the worker's own cycle
      // over this store, so a server-only spelling is a phone that cannot settle a read mark.
      "packages/core/test/flag-completion-dialect.test.ts",
      /* The reaper's candidate read is an EXCEPT, spelled by each dialect's own set-operation form. */
      "packages/core/test/tombstone-instanceless-candidates.test.ts",
      // The own-mail release and the own-address read: the visit runs them on this store too.
      "packages/core/test/own-mail-release-dialect.test.ts",
      // The one own-address set, read three ways, on this store too (the phone's router reads it).
      "packages/db/test/own-mailbox-set-twins.test.ts",
      // The away pass's window predicate — the FIRST statement of every drain, and the one
      // whose server cast answered `unrecognized token: ":"` on this store.
      "packages/services/test/away-window-dialect.test.ts",
      // An expunged letter leaves its pile: the reaper's tombstone and the pile's read, both on this store.
      "packages/services/test/triage-pile-gone-letter.test.ts",
      // The away pass's claim, its finalize by row id and its release — a phone runs this pass
      // while it organizes, so the release's delete and re-projection are asked of this store too.
      "packages/services/test/away-one-door.test.ts",
      // A Cancel on the device store: the standalone phone answers its own Cancel through the same
      // `SendService.withdraw` — the tombstone, the replay refusal and a settled row's answer.
      "packages/services/test/send-withdraw-dialect.test.ts",
      // A send re-armed after a passing fault, its bounds and its Cancel: the phone re-arms on this store.
      "packages/services/test/send-rearm.test.ts",
      // A forward that met the mailbox's own IMAP cap, through the route and the door the Desktop and
      // phone serve it with: offered again on this store, and its replay sends it once.
      "packages/api/test/send-rearm-forward-cap.test.ts",
      // A reader's arrangement: the mirror write, its change row and the materializer, on the
      // store the standalone phone reads a mailbox with.
      "packages/services/test/reader-shows-the-organizers-arrangement.test.ts",
      // The row's sorting instant (FIX-020): the ingest write of `arrived_at` and the DTO's
      // clamped `sortAt`, whose device arm is the `timestamp_ms` round trip through this store's
      // own binder — the sidecar and the standalone phone ingest through exactly this dialect.
      "packages/services/test/ohbox-sort-instant.test.ts",
      // History's month rail by the reader's zone: the window arithmetic over `ts()` literals and a
      // VALUES table, which the phone's standalone engine serves from this store.
      "packages/services/test/history-timeline-zone.test.ts",
      // Every store order is the arrival key (mail 0139): the view list, History, the rail and the
      // snapshot window, and the device store's plan on the arrival index — the phone serves them.
      "packages/services/test/message-order-arrival.test.ts",
      // The History rail's cost bound on the phone's store: a large mailbox over years of months.
      "packages/services/test/message-timeline-cost.test.ts",
      // The triage piles' keyset (`listByState`): the sorting instant computed in SQL, the
      // millisecond truncation and `nulls last`. The local door serves `GET /triage` on this store.
      "packages/services/test/triage-list-pile-order.test.ts",
      /* the undecided-sender walk. It lives on the mail leaf, so the sidecar and the STANDALONE
         PHONE serve its two routes out of `localRoutes` — and its first draft spelled `::uuid`,
         `::jsonb` and `FOR UPDATE OF folder_state` inline. This run is the behavioural half of
         the census that refused them. */
      "packages/services/test/ohbox-unscreened-dialect.test.ts",
      "packages/services/test/unscreened-offer-leaves-a-decided-place.test.ts",
      // The organize decision's count and the organizer's sweep after it: the phone's engine runs
      // the same walk and the same pass over this store.
      "packages/services/test/organize-decision-sweep.test.ts",
      /* The Screener queue's `total`: the standalone phone serves `GET /screener` from this store,
         so the count and the page walk it equals are measured here too. */
      "packages/services/test/screener-total-dialect.test.ts",
      // The cheaper queue answers as the old one did, on the store the phone serves it from.
      "packages/services/test/screener-reads-same-answer.test.ts",
      // A reading install lists the whole gate: the standalone phone reading a mailbox another device organizes.
      "packages/services/test/screener-reader-queue-is-the-gate.test.ts",
      // The Screener queue's sort key and cursor: the header else the arrival, read back through
      // the column's own decoder, which is a number on this store and a timestamp on the server.
      "packages/services/test/screener-undated-order.test.ts",
      /* The sent-mail seed's header projection, whose server arm is
         `jsonb_strip_nulls(jsonb_build_object(…))` — neither function exists here, so the
         scan branches and this run is what proves the device arm answers the same question. */
      "packages/services/test/consent-seed-headers-dialect.test.ts",
      // The first files OUTSIDE this package to run on the second store. Each one exercises a
      // module whose statements now go through the seam, and each was watched fail here with the
      // server's spelling restored — `no such function: now` on this store while the same
      // mutation stayed green on the other, which is the whole reason the second run exists.
      "packages/services/test/learning-service.test.ts",
      // The one read of a graduation (a NOT EXISTS over the person's rows) and the prefix clear
      // (`substr` over code points) are statements the phone's and the desktop's pipeline run.
      "packages/services/test/learning-person-decides.test.ts",
      "packages/services/test/learning-pause-ends-the-graduation.test.ts",
      "packages/services/test/migration-0144-shipped-allows.test.ts",
      // An older ohmail's settings copy, imported: the arrival stamp, through the device store too.
      "packages/services/test/profile-import-legacy-copy.test.ts",
      // An imported rule keeps the age it had where it was made: both arms, this store too.
      "packages/services/test/profile-import-keeps-rule-ages.test.ts",
      /* A domain decision's statements per batch, counted on the device store's own prepare. */
      "packages/services/test/screener-decide-statements.test.ts",
      // A decided placement on the wire and out of the count, and a rule group's offer: this store too.
      "packages/services/test/screener-says-what-it-does.test.ts",
      // The "did not confirm" line and the name it gives, off the message and the Screener row:
      // the phone's local engine projects both over this store.
      "packages/services/test/sender-unverified.test.ts",
      "packages/services/test/card-move-is-conditional.test.ts",
      "apps/worker/test/inbound-quiet.test.ts",
      /* Mail from a gap: a phone that organizes again runs the same catch-up over this store. */
      "apps/worker/test/gap-catchup.test.ts",
      "apps/sidecar/test/local-consent-baseline.test.ts",
      "packages/services/test/kb-service.test.ts",
      "packages/services/test/search-materialize.test.ts",
      "packages/services/test/search-sort.r12.test.ts",
      "packages/services/test/search-estimate.test.ts",
      "packages/services/test/search-coverage.test.ts",
      /* The attachment door's repair write (a compare-and-set on the section read, IS NULL for a
         null read) and its gate: the phone serves attachments through this store too. */
      "packages/services/test/attachments-part-gate.test.ts",
      // …and the ingest that writes the server's section in the first place: the worker's cycle,
      // which the sidecar composes over this store.
      "apps/worker/test/attachment-sections-ingest.test.ts",
      // One message over the html cap, ingested with the phone's Buffer: the store's CHECK is the
      // refusal the device met, so the device store is the one this boundary is measured on.
      "apps/worker/test/phone-buffer-one-message.test.ts",
      // A device store's refusals by class, and the ledger that writes one off across cycles.
      "apps/worker/test/store-fault-classes.test.ts",
      // The local backstop over the same store: one cycle's cap, then the write-offs hold.
      "apps/worker/test/write-off-backstop.test.ts",
      // A batch-total overrun in a first-read and a renumbered folder: the cursor, the repoint and
      // the reset's proof over the device store, where the phone's engine runs them.
      "apps/worker/test/overrun-batch-total-stores.test.ts",
      "packages/services/test/search-part-word.test.ts",
      "packages/services/test/search-punctuation-parity.test.ts",
      // The device answers what the server answers: stems, joined forms, part-words (the census).
      "packages/services/test/search-device-parity.test.ts",
      /* The address search by recipient: mail 0154's side table on this store. */
      "packages/services/test/search-address-recipients.test.ts",
      "packages/db/test/sqlite-recipients.test.ts",
      /* The Screener cutline probe's range on mail 0157's index, with no planner statistics. */
      "packages/db/test/sqlite-sender-date-index.test.ts",
      "packages/services/test/search-page-fused-date.test.ts",
      "packages/services/test/search-eszett-fold.test.ts",
      "packages/api/test/search.test.ts",
      "packages/api/test/search-date-bounds.test.ts",
      /* Mark all read's statements per set, counted on the device store's own prepare. */
      "packages/api/test/mark-seen-statements.test.ts",
      /* An unchanged `/sync` poll's two statements, and the sync stamp's gate, on the device store. */
      "packages/api/test/sync-unchanged-poll-writes-nothing.test.ts",
      // The open read on the device store: the stamp, its scope and its clears run the
      // same statements over the twin, and `applyExternalFlag`'s clear is the phone's \Seen adoption.
      "packages/services/test/mark-seen-open-read.test.ts",
      "packages/core/test/external-flag-clears-open-read.test.ts",
      // The tag create claims its key: on the device store too.
      "packages/api/test/tag-create-replays-by-key.test.ts",
      // The junk rescue's COMMAND (mail 0117) — a four-column `ON CONFLICT`, a 64-bit epoch
      // through the device's own binder (a decimal string; this driver takes no bigint and a
      // double loses the low bits above 2^53), a due predicate compared as an instant, and the
      // window's `IN ()` over a page's epochs. The standalone phone serves the screener routes
      // through its own local door, so the press and the pass that drains it both run here.
      "packages/api/test/junk-rescue-dialect.test.ts",
      // The mailbox self-check's store read: a grouped count and a 64-bit epoch, which the local
      // door on the phone serves from this store.
      "packages/api/test/mailbox-self-check-dialect.test.ts",
      // The event stream's one read, whose session check this store answers as the integer 1: a
      // decode taking only `true` closed every stream at its first read here. Every device door
      // serves the stream off today; this run is what says the read works if one turns it on.
      "packages/api/test/events.test.ts",
      // THE CORRESPONDENT PREDICATE AND ITS TWO PASSES (FIX-023): the sidecar runs the auto-act's
      // gate over this store, and its reads spell a JSON element walk, a Sent-folder list and
      // the larger-of the connect and the seed, each through the seam.
      "apps/worker/test/screener-correspondent.test.ts",
      // A RULE'S "APPLY TO EXISTING MAIL": the sidecar's drain runs the worker's pass on this
      // store, so the whole suite runs here too (the server spelling died on `::uuid`).
      "apps/worker/test/rule-retro.test.ts",
      // The identity fact (mail 0148): a pass reads the column, and the backfill writes it, on this store too.
      "apps/worker/test/rule-retro-identity.test.ts",
      // A rule never moves a place somebody decided (`decided_at`): the device store runs the pass too.
      "apps/worker/test/rule-retro-leaves-a-decided-place.test.ts",
      "apps/worker/test/sender-check-backfill.test.ts",
      // A copy written to somebody else admits nobody, and a failed authentication is never released:
      // the correspondent retro on this store too.
      "apps/worker/test/correspondent-retro-holds-the-claim.test.ts",
      // An answer the gate admits is decided for that letter, through the ingest and the retro: this store too.
      "apps/worker/test/admitted-answer-is-decided.test.ts",
      // A report reaches the Ohbox only citing the account's own Sent copy, and the own-sent twin
      // adopts only a row that already has a Sent instance: both through this store's ingest too.
      "apps/worker/test/bounce-cites-own-sent.test.ts",
      "apps/worker/test/own-sent-twin-adopts-own-row.test.ts",
      // A brand at an r|n junction is still claimed through this store's ingest.
      "apps/worker/test/rn-junction-holds-the-claim.test.ts",
      // A list address is no person (mail 0150): its row, its brands and the passes that read it,
      // through this store's ingest, retro and press; and its one-time backfill on this store.
      "apps/worker/test/list-address-is-not-a-person.test.ts",
      "apps/worker/test/list-address-backfill.test.ts",
      // A crafted sender is read in bounded time at this store's ingest too.
      "apps/worker/test/crafted-identity-inputs.test.ts",
      // The account's own mail claiming a company keeps its place through this store's visit too.
      "apps/worker/test/own-mail-claim-keeps-its-place.test.ts",
      // A held claim is listed however old its Date, and the held-release press never takes one.
      "packages/services/test/dormant-claim-is-listed.test.ts",
      "packages/services/test/held-release-press-leaves-the-claim.test.ts",
      // A person's domain press checks the rows the check never reached before it moves them, here too.
      "packages/services/test/press-checks-unchecked-first.test.ts",
      // The act's contacts from before the column are marked inferred by the cycle tail, here too.
      "apps/worker/test/legacy-act-contacts.test.ts",
      // An allow rule for everyone at a shared provider admits nobody: the three twins on this store.
      "packages/services/test/shared-provider-rule-inert.test.ts",
      // The sender's identity fact on the queue row is a window over their held mail, on this store too.
      "packages/services/test/screener-sender-fact-caps-advice.test.ts",
      // A list address's row, its mirrored fact and the reset that forgets its brands (mail 0150).
      "packages/services/test/list-address-is-not-a-person.test.ts",
      // A decided sender whose claim the gate holds is waiting again, and no release offers it.
      "packages/services/test/held-claim-is-waiting.test.ts",
      // ...and the counts beside the queue count them, the client partition with them.
      "packages/services/test/held-claim-counts-parity.test.ts",
      // The client's held-claim twin and the decided arm ask the list's term, here too.
      "packages/services/test/held-claim-twin-parity.test.ts",
      // The identity backfill resurfaces no mail from before the cutline and moves nothing, here too.
      "apps/sidecar/test/screener-old-claims-stay-dormant.test.ts",
      // A person's contact stays off the Waiting list when the identity check stamps their held mail.
      "apps/sidecar/test/screener-claim-of-a-consented-sender.test.ts",
      // The held-claim term dates a claim by who wrote the fact, and both writers stamp it, here too.
      "apps/sidecar/test/screener-claim-dated-by-its-writer.test.ts",
      // A travelled request for everyone at a shared provider, and the key writer's belt, on this store too.
      "apps/worker/test/shared-provider-request-refused.test.ts",
      // A RULE REQUEST AND THE READER'S BELT: the sidecar runs both drains over this store, so the
      // create wire, the belt and a removal made on the other computer are measured here too.
      "apps/worker/test/rule-create-wire.test.ts",
      "apps/worker/test/reader-rule-rows-settle-on-the-ack.test.ts",
      "apps/worker/test/rule-removed-on-the-other-computer.test.ts",
      // The belt's every leg, the leaving doors and the late answer: the phone and the desktop
      // settle a reader's press over this store too.
      "apps/worker/test/rule-press-settles-on-every-leg.test.ts",
      "packages/db/test/settle-presses-leaving-mailbox.test.ts",
      // THE PHONE'S COMPOSITION ROOT. Here rather than in the default project because it composes
      // the whole engine over the DEVICE store, so it needs the schema substitution this project
      // performs — under the default one its first statement dies with `no such function:
      // gen_random_uuid`, the server twin's id default. The file carries a premise case for the
      // other project rather than skipping there silently.
      "apps/sidecar/test/phone-engine-boot.test.ts",
      // The phone engine store's open path sets and reads back synchronous = EXTRA, on a real file.
      "apps/mobile/test/engine-store-durable-commits.test.ts",
      "apps/sidecar/test/phone-local-retention.test.ts",
      // THE CLAIM THAT COMPOSITION WRITES, against a real mail server — same reason as the line
      // above, plus a private IMAP server it names its own variables for. It carries a premise
      // case for the default project and a NAMED skip when the server is not answering.
      "apps/sidecar/test/phone-claim-own.imap.test.ts",
      // THE HAND-BACK AND THE RESUME, on the same rig as the line above and for its reasons. An
      // unregistered file here is not a skip: the project's `include` is an allowlist, so a filter
      // naming it exits `No test files found` with rc 1 — measured, on this file's first run.
      "apps/sidecar/test/phone-hand-back.imap.test.ts",
      // THE BACKGROUND MACHINE OVER THAT ENGINE, on the same rig and for the same reasons. The
      // claim follows the organizer's ability to run, and the verdict is `ohmail/_meta`'s two
      // stamps: `X-Ohmail-Claimed-At` is carried by a renew and minted by a re-claim, so it prices
      // a flip, and the heartbeat moving after the transition is the organizer still running.
      "apps/sidecar/test/phone-background-claim.imap.test.ts",
      // MAIL THAT ARRIVED WHILE THE PHONE WAS OFFLINE, filed on the server after the return — the
      // same rig and reasons as the three lines above, with a cable the file cuts and mends.
      "apps/sidecar/test/phone-offline-arrivals-filed.imap.test.ts",
      // …and a send pressed during the outage, through the app's own client over that engine.
      "apps/sidecar/test/phone-offline-send-waits.imap.test.ts",
      // …and a send's late or accepted answer and a relaunch mid-send, one row per letter.
      "apps/sidecar/test/phone-send-is-one-row.imap.test.ts",
      // …and an outgoing server's "not now" once: the press waits under its key and goes once.
      "apps/sidecar/test/phone-send-rearm.imap.test.ts",
      // …and a forward kept as a draft, closed, reopened and sent as a forward.
      "apps/sidecar/test/phone-forward-draft-is-a-forward.imap.test.ts",
      // …and a relaunch whose login is slow, through the app's own connect over that engine.
      "apps/sidecar/test/phone-relaunch-shows-its-mail.imap.test.ts",
      // A MAILBOX CARRYING ANOTHER INSTALL'S SETTINGS DOCUMENT, organized by the phone: the gate, the
      // write and the hand-back, on the same rig as the lines above and for their reasons.
      "apps/sidecar/test/phone-settings-document.imap.test.ts",
      // THE CONSENT DOOR'S REFUSAL, on the phone's own composition and through the real route. No
      // mail server: the row's holder columns are what the refusal reads, and the adapter is a
      // double. Here for `phone-engine-boot.test.ts`'s reason — it composes the whole engine over
      // the device store — and it carries the same premise case for the default project.
      "apps/sidecar/test/phone-claim-door.test.ts",
      // A SEND WITH THE NETWORK CUT, through the same composition and the client the phone runs
      // over its door: the failure names its draft row, so a second press is the same letter.
      "apps/sidecar/test/phone-offline-send.test.ts",
      // STOP THEN START IN ONE RUN, with the GATE running between the two presses — the
      // cycle is where the device's defect lives and the door file above never runs one. Same
      // composition, an in-memory `ohmail/_meta` for the lease, so no mail server and no box lock.
      "apps/sidecar/test/phone-stop-then-start.test.ts",
      // A HAND-BACK OPENS THE GAP AT THE PRESS: the phone's stop, a letter taken in
      // before the first look, the offer after Organize here. Same composition, no mail server.
      "apps/sidecar/test/gap-window-opens-at-release.test.ts",
      // THE GAP TRAVELS ACROSS INSTALLS: two phone engines, two stores, one in-memory `_meta`.
      "apps/sidecar/test/gap-travels-across-installs.test.ts",
      // ORGANIZE HERE AFTER A HAND-BACK CLAIMS AT ONCE (VERIFY-026 L6): the same composition, the
      // person's press through the phone's door, no mail server and no box.
      "apps/sidecar/test/phone-organize-here-wakes.test.ts",
      // The consent doors' settings doorbell, after their commit, on the store the phone's press reaches.
      "apps/sidecar/test/agree-doorbell-after-the-commit.test.ts",
      // A RESUME THAT DID NOT FINISH STARTING. The hand-back clears the poll timer, the resume
      // claims the mailbox and the store then refuses before anything is scheduled — the state
      // where a person is shown a mailbox being organized by an install running nothing. Same
      // composition as the two files above, the device store, and no box.
      "apps/sidecar/test/phone-resume-that-did-not-start.test.ts",
      // THE OUTGOING SERVER AT CONNECT: the same composition and store, the submission dial the
      // only double that can refuse, and the seal read back on a fresh handle. No box.
      "apps/sidecar/test/phone-submission-at-connect.test.ts",
      // …AND THE SETTINGS SHEET'S CHANGE through the seal door, on the same composition and store.
      "apps/sidecar/test/phone-server-settings-in-place.test.ts",
      // ONE DOOR INTO THE DEVICE STORE: a save issued straight on the handle while a sync
      // transaction is open, and an announcement made inside one. Both are about the
      // proxy's separate `begin`/statement/`commit` calls, so only this project sees them.
      "apps/sidecar/test/phone-one-write-door.test.ts",
      // WHAT THE FIRST SYNC PRODUCED, against a real server and a relay that refuses to hand over
      // the mail. Here for `phone-engine-boot.test.ts`'s reason — the whole engine over the device
      // store — and it carries the same premise case for the default project.
      "apps/sidecar/test/phone-first-sync-unreadable.imap.test.ts",
      // A letter marked read elsewhere during the import is stored whole, never as an empty message,
      // on the engine over the device store (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS).
      "apps/sidecar/test/phone-sync-flag-race.imap.test.ts",
      // The import's clock the phone's engine writes (`stampSynced`), whose instant this store spells
      // as an integer: search reads it past a first import's first day.
      "apps/sidecar/test/sync-stamp-progress.test.ts",
      // THE ACCOUNT'S OWN MAIL IS NEVER HELD AT THE GATE by a phone that organizes: a letter from the
      // mailbox's own address stays in INBOX, and the one-time release returns what was filed there.
      "apps/sidecar/test/phone-own-mail-at-the-gate.imap.test.ts",
      // MAIL ALREADY IN THE INBOX AT THE CONNECT stays in place, and the Ohbox's offer holds its senders.
      "apps/sidecar/test/phone-offer-holds-pre-connect-senders.imap.test.ts",
      // A BURST OF ARRIVALS through the phone's own composition, behind a relay that charges the
      // adapter's clock per KB: each pass takes a page and a re-dial never re-dates the whole burst.
      "apps/sidecar/test/phone-arrival-burst.imap.test.ts",
      // ONE MESSAGE'S WRITE FAILED BY THE STORE through the phone's own composition: the store's
      // fault is never written off as the message's.
      "apps/sidecar/test/phone-store-fault-is-the-devices.test.ts",
      "apps/sidecar/test/phone-ingest-page.test.ts",
      // A MESSAGE THE PHONE SET ASIDE, the write-off run's read, and a store fault after an outage.
      "apps/sidecar/test/set-aside-is-said.test.ts",
      // THE SITES THE PHONE'S OWN BUNDLE LOADED WITH THE SERVER'S SPELLING STILL IN THEM. Each
      // file below exercises one of them and was watched fail here with that spelling restored,
      // while the same mutation stayed green on the other store.
      "packages/services/test/auto-reply-by-us-parity.test.ts",
      // The two calendar facts, for its neighbour's reason: the DTO batch runs both fragments on
      // every page this store serves, and they spell `replace`, `trim`, `strpos` and `substr` —
      // one of which (`chr`) is Postgres-only and was caught here before it shipped.
      "packages/services/test/calendar-facts-parity.test.ts",
      // The erase arm's advisory lock, which was the last of those sites and the one the census
      // found rather than the burn-down: raw, it was a method this store's handle does not have,
      // so the whole removal threw and rolled back. Watched fail here with that spelling restored.
      "packages/services/test/mailbox-erase-dialect.test.ts",
      // A draft answers one message or forwards one: the device twin's CHECK, beside the server's.
      "packages/services/test/draft-reply-xor-forward-dialect.test.ts",
      // The erasure's thread tombstones, through `/sync` into the client engine's store.
      "packages/services/test/mailbox-erase-thread-tombstone.test.ts",
      // A conversation counts the letters it still holds, through `/sync` into the client's store.
      "packages/services/test/thread-counts-live-letters.test.ts",
      // A Sent message deleted in another mail app, through the worker's cycle the phone composes.
      "apps/worker/test/sent-expunge.test.ts",
      // A letter to oneself deleted while the app was closed, over the real adapter.
      "apps/worker/test/deleted-while-closed.e2e.test.ts",
      // A letter to yourself, in INBOX and Sent: the INBOX copy is the row the phone's Ohbox reads.
      "apps/worker/test/self-sent-inbox-instance.test.ts",
      // A folder deleted in another mail app while the app was closed, and a reset's letter deleted
      // meanwhile, through the same cycle on the phone's store.
      "apps/worker/test/folder-deleted-elsewhere.e2e.test.ts",
      "apps/worker/test/folder-gone-one-transaction.test.ts",
      // A folder deleted on the server leaves the folder list, and one made there joins it.
      "apps/worker/test/empty-folder-deleted-elsewhere.e2e.test.ts",
      "apps/worker/test/gone-folder-leaves-the-list.test.ts",
      // A message over the download ceiling, listed from its headers on the phone's store too.
      "apps/worker/test/too-large-message-is-listed.e2e.test.ts",
      // The blank repair's read and its writes on the device store: the desktop repairs a blank
      // message through the same pass (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS); the phone's
      // build leaves the repair out (apps/mobile/test/phone-engine-leaves-out-blank-repair.test.ts).
      "apps/worker/test/blank-repair.test.ts",
      // THE UNSUBSCRIBE DRAIN'S TWO MEMORIES (mail 0116), as STATEMENTS. The mark's insert takes
      // an `ON CONFLICT DO NOTHING` on a primary key and the cursor's an `ON CONFLICT DO UPDATE`
      // reading `excluded`, and `cursor_at` is a timestamp column the two stores spell
      // differently — so both belong here, and both were watched fail with the server's spelling.
      "packages/db/test/unsubscribe-cursor-dialect.test.ts",
      // A KEY CLAIMED BEFORE ITS ANSWER: the pending claim, the settle and the release are three
      // upserts and a delete with compound conditions, and an idempotent route on this store runs
      // them the way the server does.
      "packages/db/test/idempotency-pending-dialect.test.ts",
      // A MAILBOX ERASURE'S RESPONSE CACHE, scoped to that mailbox: the phone's own store runs the
      // same erasure, and the scope reads messages, drafts and mailboxes with array predicates.
      "packages/db/test/idempotency-mailbox-scope.test.ts",
      // AND THE DRAIN ITSELF, which the entry above said was not here. Its candidate query spelled
      // `jsonb_exists` twice, so `drainScreenedOut` threw `no such function: jsonb_exists` at its
      // first statement on a device and the phone ran no unsubscribe pass at all — measured that
      // way at this lane's base, on both cases of the first file below. The predicate goes through
      // the seam now and the flag it produces is a verdict word rather than a driver boolean, so
      // all three pass on both stores, which is the only thing that admits a file here.
      //
      //   · the predicate's two arms, admitting and refusing, on the pass's own result;
      //   · the cursor and the examined mark, driven end to end over the device store;
      //   · the fenced chunk, including the page full of ineligible rows in front of one candidate.
      "packages/services/test/unsubscribe-drain-dialect.test.ts",
      "packages/services/test/unsubscribe-drain-cursor.test.ts",
      "packages/services/test/unsubscribe-drain-bounds.test.ts",
      // …and WHO it acts for (UD-R4-03): the person-decided rule predicate reaches both stores.
      "packages/services/test/unsubscribe-acts-only-for-a-person.test.ts",
      "packages/services/test/mailbox-filing-report.test.ts",
      // The mailbox list's facts, read for all of an account's mailboxes at once, on this store too.
      "packages/services/test/mailbox-facts-batched.test.ts",
      "packages/services/test/mailbox-inbound-quiet.test.ts",
      "packages/services/test/organize-rerun-window.test.ts",
      // The Agree press's settings doorbell, after its commit: a failed change row leaves the press.
      "packages/services/test/organize-doorbell-after-the-commit.test.ts",
      "packages/db/test/json-merge-dialect.test.ts",
      // WHERE A BUDGETED FIRST SYNC STOPPED (mail 0115). The phone composes the worker's own sync
      // cycle over this store, so the two statements the stop needs — an `is not null`-filtered
      // clear and an upsert on `(mailbox_id, folder)` — run here too. `sqlite-baseline.test.ts`
      // proves the columns arrive; without this file nothing proved anything could write them.
      "packages/core/test/first-sync-budget-stop-dialect.test.ts",
      // THE STAND-DOWN'S HANDOVER, which runs inside the demotion transaction a phone makes
      // when another machine takes its mailbox — so a statement this store cannot parse rolls
      // the ROLE write back with it and the row goes on saying this install organizes. Its
      // first statement is a row lock and its walk carries a keyset cursor in a raw fragment,
      // and the cursor arm only runs once a page FILLS, so no case here had ever executed it
      // on this store. Watched fail here with the server's spelling restored in that fragment
      // ("unrecognized token: \":\"", one case) while the same mutation stayed green on the other.
      "packages/db/test/request-apply.test.ts",
      // The Screener's act on suggestions, which the local engine runs over this store: its filing
      // is `applyScreenerDecision`, whose mark-read upsert bound a JavaScript boolean raw — this
      // driver refuses one, and the two denying cases failed here while the other store passed.
      "apps/worker/test/screener-auto-act.test.ts",
      // Which rules the act wrote (a grouped read over the Screener decisions on record) and a
      // reader's settings change travelling: the phone materializes rules and runs these doors.
      "packages/services/test/rule-by-ohmail.test.ts",
      "packages/services/test/reader-change-says-where.test.ts",
      // A person's press over an inferred twin makes the rule `manual` at both doors — the local
      // edit and the travelled request — and the local engines apply both over this store.
      "packages/db/test/rule-request-makes-the-rule-theirs.test.ts",
      "packages/db/test/inferred-press-repair.test.ts",
      "packages/db/test/rule-request-undo-keeps-provenance.test.ts",
      "packages/db/test/why-stayed.test.ts",
      "packages/services/test/rule-press-and-undo-provenance.test.ts",
      "packages/services/test/rule-press-makes-the-rule-theirs.test.ts",
      // The two files this list named as NOT YET are IN it now, three entries up: the reasons it
      // gave were a `.for("update")` the device builder does not have and a `::` cast in a DTO
      // projection, and both were among the burn-down's sites. The paragraph is kept as the shape
      // an entry's reason takes — a fact about a failure somebody measured, never a plan.
    ],
    // The second variable is what the matrix guard checks the first against — see
    // `sqlite-matrix.test.ts`. Declaring the EXPECTATION separately is what lets an unset
    // dialect fail rather than skip.
    env: { OHMAIL_TEST_DIALECT: "sqlite", OHMAIL_EXPECT_DIALECT: "sqlite" },
    fileParallelism: false,
  },
});
