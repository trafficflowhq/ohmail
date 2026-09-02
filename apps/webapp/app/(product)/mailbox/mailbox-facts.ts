import type { MailboxDTO } from "../../api-client";
import type { MailboxFacts } from "../../shell/mail-state";

/**
 * ONE MAILBOX ROW, NARROWED FROM THE WIRE TO WHAT THE SHELL MAY READ.
 *
 * ── WHY THIS IS A MODULE AND NOT A CLOSURE IN `CloudShell` ─────────────────────────────────
 *
 * It was a closure, and that is precisely what made the most dangerous line in it untestable.
 * Every component test injects `MailboxFacts` through the mocked provider, so none of them ever
 * reaches the mapping — the defaults for an ABSENT field are decided here and were checked
 * nowhere. The equivalent seam on the desktop had the same hole and it was found the same way:
 * inverting the absent-role default left every component case GREEN, while the line it inverted
 * decides whether a claim banner appears on every mailbox of every install whose API predates the
 * column.
 *
 * So the mapping is a plain function over a plain object, driven directly by its own unit tests.
 * `CloudShell` keeps the fetch.
 *
 * ── THE RULE EVERY LINE HERE FOLLOWS ──────────────────────────────────────────────────────
 *
 * An optional field is forwarded UNTOUCHED unless there is a reason to narrow it, because absent
 * and `null` are different answers and a `?? null` at a seam destroys the difference. Two fields
 * were broken exactly that way before: the import stamp (which pinned "Syncing your mail" over a
 * finished mirror) and the pending-move count (which turned "cannot tell" into "nothing
 * outstanding"). The one field that IS narrowed says why in its own comment.
 */
export function toMailboxFacts(m: MailboxDTO): MailboxFacts {
  return {

    // The From selector's value, and the only handle that stays unambiguous the day one
    // mailbox carries several addresses. The ladder in `mail-state.ts` does not read it.
    id: m.id,
    address: m.address,
    // The label the "me" recipient chip wears as the account's name. Nullable on the
    // wire and forwarded as such; the chip's fallback is the bare address.
    displayName: m.displayName ?? null,
    status: m.status,
    errorCode: m.errorCode ?? null,
    // WHY a `disabled` mailbox is disabled (mail 0027), when the organizer lease decided
    // it. Without this line the strip cannot tell a mailbox another install has claimed from a
    // mailbox the user removed, and answers both with "No mailbox connected, so nothing can
    // arrive" — which was true of neither. The RAW wire token travels; `mail-state.ts` owns
    // the mapping to copy, for the reason it owns `SYNC_BLOCK_REASONS`.
    disabledReason: m.disabledReason ?? null,
    syncBlockedReason: m.syncBlockedReason ?? null,
    syncBlockedSince: m.syncBlockedSince ?? null,
    // ── THE ORGANIZING ROLE AND ITS HOLDER (mail 0083) ──────────────────────────────────
    //
    // NARROWED, not forwarded: an unrecognised string becomes `organizer`, which is the safe
    // direction and the one this seam is tested for. Absent has the same answer, and for the
    // same reason — every install was an organizer before the column existed, so a server that
    // cannot say has not demoted anybody. The inverse default would put a claim banner over
    // every mailbox of every install whose API predates the column, and offer a button the
    // server would refuse. Inverting this line is a watched mutation and it goes red.
    organizerRole: m.organizerRole === "reader" ? "reader" : "organizer",
    // FORWARDED as-is with a null floor: the three fields inside are already nullable, and the
    // object is null AS A WHOLE when nobody is named, which is the shape the banner tests.
    organizedBy: m.organizedBy ?? null,
    organizerState: m.organizerState ?? null,
    // FORWARDED UNTOUCHED, and the missing `?? null` is the point — the rule
    // `initialImportCompletedAt` below states, applied to a control rather than to a strip.
    // `null` is "nobody has agreed to this mailbox" and makes the claim offer eligible; ABSENT
    // is an API that predates the column and must NOT. A `?? null` here would collapse the
    // second into the first and offer "Organize here instead" on every row of every older
    // deployment.
    organizeConsentedAt: m.organizeConsentedAt,
    lastSyncAt: m.lastSyncAt,
    // WHEN the first import finished (mail 0038), or null while it has not. The ladder in
    // `mail-state.ts` reads it as a FLOOR — a null keeps the strip saying "still importing" past
    // the point this client's own mirror stops growing, so a partial mailbox cannot read as
    // complete. FORWARDED UNTOUCHED, and the missing `?? null` is the fix: the DTO field is
    // optional, and a bundle older than the column sends it ABSENT. Collapsing that `undefined`
    // to `null` — which is what `?? null` did — is exactly the value the floor reads as "not
    // finished", so it would pin "Syncing your mail" permanently over every non-empty mirror on
    // a deploy skew. The ladder distinguishes `=== null` (a real, ongoing import) from a missing
    // field (`undefined`, degrade to growth-only), and that distinction only survives if the
    // absent field arrives absent.
    initialImportCompletedAt: m.initialImportCompletedAt,
    // How many of the user's own filings this mailbox has not applied yet. FORWARDED
    // UNTOUCHED, for the same reason the line above is: the field is optional, an older
    // server omits it, and the ladder gates on `typeof === "number"`. A `?? 0` here would
    // turn "this build cannot tell" into "nothing is outstanding" — the wrong answer in
    // precisely the case the field was added for.
    pendingMoves: m.pendingMoves,
    // What this mailbox's submission server said it will accept. FORWARDED UNTOUCHED, on
    // the same rule as the two lines above: the field is optional, an older API omits it, and a
    // `?? null` here would erase the difference between "this API cannot say" and "the server
    // announced no ceiling". Both fall back to the same number at the compose surface today, so
    // nothing breaks either way — the `??` is left off because the seam is where that distinction
    // was destroyed the last two times, not because this consumer needs it.
    smtpMaxSizeBytes: m.smtpMaxSizeBytes,
    // The server has sent this since mail 0001 and always will (`toDTO` reads a NOT NULL
    // column). The fallback exists so a stale cached bundle cannot crash the strip on a
    // field it was compiled without, and it degrades to "no elapsed time", never to a wrong
    // one — `minutesSince(null)` is `null`, which the copy renders as "moments ago".
    createdAt: m.createdAt ?? new Date().toISOString(),
  };
}
