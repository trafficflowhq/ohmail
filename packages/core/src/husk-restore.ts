import { and, eq } from "drizzle-orm";
import {
  applyBodyBytesDelta, bodyBytesOf, messageBodies, messages, recordChange, reserveBodyBytes,
  type Tx,
} from "@trafficflow/db";
import { fingerprintDedupKey, messageFingerprint, normalizeMessageId } from "./identity.js";
import { prepareHtmlForStorage } from "./html-storage.js";
import type { NormalizedMessage } from "./types.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  UN-HUSKING A `junk_filed` BODY — the ONE verify/rewrite both restore doors share
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A spam verdict that filed a message to the provider's native `\Junk` husked its stored body
 * (`message_bodies.withheld_reason = 'junk_filed'`, mail 0065): the bytes live on in the Junk
 * folder, which is the master, and the durable artifact of the verdict is the sender rule. When
 * that message LEAVES Junk again, the husk must be refilled — and there are two doors it leaves
 * through:
 *
 *  · the "Not junk" RESCUE (`packages/api/src/junk-window.ts#rescueJunk`) — our own verb, which
 *    fetched the raw while the message was still in Junk and restores right after its move; and
 *  · EVERYTHING ELSE — the user drags it back in another mail client, the provider un-junks it
 *    on its own — where the worker's scan later observes the message alive in a WATCHED folder
 *    while its body is still the verdict's husk (`apps/worker/src/junk-restore.ts`).
 *
 * Both doors end at this function, deliberately: the identity witness, the at-cap posture and
 * the byte accounting are POLICY, and two copies of a policy is how one door drifts. The shape
 * is `redacted-restore.ts`'s fetch-verify-rewrite with the fetch left to the caller (each door
 * reads from a different place on a different connection); this module owns VERIFY and REWRITE.
 *
 * ── THE IDENTITY WITNESS — never store bytes into a row they do not belong to ───────────────
 *
 * Two independent witnesses, exactly `redacted-restore.ts#isSameMessage`: the normalized
 * Message-ID matches the husk's, OR the canonical-content fingerprint reproduces the husk's own
 * dedup key — the fallback that lets a legitimately Message-ID-less message restore too. A
 * locator that no longer resolves to this message writes NOTHING: storing those bytes would put
 * one person's mail into another message's row, which is worse than any husk.
 *
 * ── THE LOCK-AND-RECHECK IS THE IDEMPOTENCY AND THE RACE ANSWER ─────────────────────────────
 *
 * The rescue and the worker pass are DIFFERENT PROCESSES and can race on one husk. The rewrite
 * re-reads the row `FOR UPDATE` and requires `withheld_reason = 'junk_filed'` to still stand;
 * the loser finds it already restored and writes nothing — one restore, one byte reservation,
 * one `change_log` delta, whoever wins. A `storage_cap` husk is standing policy and is refused
 * by the same recheck; a row already restored is `not_husked`.
 *
 * ── THE CAP HOLDS HERE TOO — at cap, the husk STANDS ────────────────────────────────────────
 *
 * The verdict's husk freed these bytes; putting them back is new stored content, and an at-cap
 * account must not grow past its entitlement through restores (a review caught the uncapped
 * rescue). `reserveBodyBytes` is ingest's own atomic reserve: a decline aborts the rewrite and
 * the husk stands, with its marker still TRUE — the bytes live on in the mailbox. `capBytes:
 * null` is the unmetered tier's DECLARATION (the caller resolved it; never inferred from absent
 * config). A shrink applies its delta the repair passes' way.
 */
export type JunkUnhuskOutcome = "restored" | "not_husked" | "identity_mismatch" | "at_cap";

/** The husk row's identity, as both doors already select it. */
export interface JunkHuskIdentity {
  id: string;
  dedupKey: string;
  messageIdHeader: string | null;
}

/** The two-witness identity check — see the module header for why it is load-bearing. */
export function isHuskSameMessage(husk: JunkHuskIdentity, fresh: NormalizedMessage): boolean {
  if (fingerprintDedupKey(messageFingerprint(fresh)) === husk.dedupKey) return true;
  const stored = normalizeMessageId(husk.messageIdHeader);
  const got = normalizeMessageId(fresh.canonical.messageIdHeader);
  return stored !== null && got !== null && stored === got;
}

/**
 * VERIFY + REWRITE for one `junk_filed` husk whose bytes the caller re-read. Opens its own
 * transaction (a savepoint when the caller is already inside one — the worker's fence), takes
 * the row lock only after the caller's network read is done, and answers what happened; it
 * never throws for a policy outcome, only for infrastructure.
 */
export async function unhuskJunkFiledBody(db: Tx, args: {
  accountId: string;
  husk: JunkHuskIdentity;
  fresh: NormalizedMessage;
  /** The account's cap in bytes; `null` = the unmetered tier's declaration. */
  capBytes: number | null;
  now?: Date;
}): Promise<JunkUnhuskOutcome> {
  const { accountId, husk, fresh, capBytes } = args;
  if (!isHuskSameMessage(husk, fresh)) return "identity_mismatch";

  return db.transaction(async (tx) => {
    const [live] = await tx
      .select({ text: messageBodies.text, html: messageBodies.html, withheld: messageBodies.withheldReason })
      .from(messageBodies)
      .where(eq(messageBodies.messageId, husk.id))
      .limit(1)
      .for("update");
    if (live?.withheld !== "junk_filed") return "not_husked"; // restored already, or another policy's husk
    const storedHtml = prepareHtmlForStorage(fresh.htmlBody);
    const oldBytes = bodyBytesOf({ text: live.text ?? "", html: live.html ?? null });
    const newBytes = bodyBytesOf({ text: fresh.textBody, html: storedHtml });
    const grow = newBytes - oldBytes;
    if (grow > 0) {
      if (!(await reserveBodyBytes(tx, accountId, grow, capBytes))) return "at_cap";
    } else if (grow < 0) {
      await applyBodyBytesDelta(tx, accountId, grow);
    }
    await tx.update(messageBodies).set({
      text: fresh.textBody,
      html: storedHtml,
      withheldReason: null,
    }).where(eq(messageBodies.messageId, husk.id));
    await tx.update(messages).set({
      snippet: fresh.textBody.replace(/\s+/g, " ").trim().slice(0, 200),
      updatedAt: args.now ?? new Date(),
    }).where(and(eq(messages.id, husk.id), eq(messages.accountId, accountId)));
    await recordChange(tx, {
      accountId, entityType: "message", entityId: husk.id, op: "update", meta: null,
    });
    return "restored";
  });
}
