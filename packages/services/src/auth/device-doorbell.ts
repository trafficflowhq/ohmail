import { and, eq, isNull } from "drizzle-orm";
import { createLogger } from "@trafficflow/core/mail";
import { devices, inTransactionHandle, type LedgerTx } from "@trafficflow/db";
import { recordSettingsChange } from "../consent-seed.js";
import { bridgeTx, runInTransaction, type ServiceContext } from "../context.js";

/**
 * THE DEVICES' DOORBELL, AFTER THE COMMIT: how the account's other signed-in clients learn that a
 * named device was made, or that one was taken back in Devices.
 *
 * The settings record carries the account's named devices as three whole numbers
 * (`device-numbers.ts`), and a client tells a person of a new device when the number of devices
 * ever made rose between two of its readings. That number is counted from the device rows at every
 * read, so the path that makes a device has already raised it by committing. What is left is to
 * make the clients read: one `settings` change row, which wakes them and carries the record.
 *
 * WHO RINGS. Only a path that MAKES a named device, and the Devices list's own take-back:
 *
 *   made      a scanned pairing code's redeem and a phone app's handoff (`pairing.ts`), a desktop
 *             app's sign-in by a link code, by the browser's approval, by the authorization code's
 *             exchange and by a password with a second factor, and a desktop's first-factor
 *             enrollment (`auth-service.ts`)
 *   revoked   `SessionLifecycle.revokeDevice`, when it ended a named device's session
 *
 * A path that only ENDS a session never rings: a device signing itself out, a sign-in replacing an
 * install's previous one, a reuse sweep, a change of a second factor. None of them moves either
 * number that a notice is decided from.
 *
 * AFTER ITS PATH HAS COMMITTED, IN A SHORT FENCED TRANSACTION OF ITS OWN (the settings doorbell's
 * rule in `mailbox-service.ts`): the account row `FOR SHARE` as the first statement, then the
 * change-log counter, and for a take-back the one device row before the counter. Never inside the
 * path's own transaction: a mint holds its user row and its session rows, a take-back its sessions,
 * and the counter taken under those meets a writer that takes the counter first. Handed a
 * transaction's handle this refuses and writes nothing, so "after the commit" is held here and not
 * by each caller remembering it.
 *
 * NOTHING HERE CAN FAIL ITS PATH. The device is made, or taken back, by the time this runs: an
 * error is logged and swallowed, never thrown into a sign-in that has committed. What a lost ring
 * costs: for a device made, time alone (the number already rose; the clients read it at the next
 * settings change or the next first page of a copy). For a take-back, the notice: the stamp below
 * is what raises that number, and it is written here.
 *
 * AN ACCOUNT ERASED BETWEEN THE COMMIT AND THE RING: the fence finds the stamp and the body never
 * runs. No row is written and nothing is logged; nobody is left to tell.
 *
 * THE PATH AWAITS ITS RING, as the settings doorbell's press does: an answer that returned before
 * the ring had finished would leave it to a process that may be frozen once it has answered. The
 * ring waits for the account's change-log counter like every writer of the account, and for
 * nothing a sign-in holds.
 */
const log = createLogger({ service: "auth" });

/** Which device a take-back names: the Devices list's own id for a named device, and whose it is. */
export interface TakenBack {
  readonly accountId: string;
  readonly userId: string;
  readonly deviceId: string;
}

async function ring(ctx: ServiceContext, accountId: string, taken: TakenBack | null): Promise<void> {
  try {
    if (inTransactionHandle(ctx.db)) {
      throw new Error("the devices' doorbell rings after its path has committed, never inside a transaction");
    }
    await runInTransaction(ctx, async (txCtx) => {
      const tx = bridgeTx(txCtx.db);
      if (taken !== null) {
        // The stamp is what `revoked` counts. Once per device: a row that carries one is left as it
        // is, and an id that names no device of this person's (a plain browser session's own id)
        // stamps nothing. Then nothing rose, and nothing is rung.
        const stamped = await tx.update(devices)
          .set({ revokedAt: txCtx.now() })
          .where(and(
            eq(devices.id, taken.deviceId),
            eq(devices.accountId, accountId),
            eq(devices.userId, taken.userId),
            isNull(devices.revokedAt),
          ))
          .returning({ id: devices.id });
        if (stamped.length === 0) return;
      }
      await recordSettingsChange(tx as LedgerTx, accountId);
    }, { fence: { accountId, onErased: () => undefined } });
  } catch (err) {
    log.warn("devices_doorbell_failed", {
      accountId,
      err,
      reason: taken === null
        ? "the device was MADE and its number already rose; the account's other clients read it at the "
          + "next settings change instead of at once"
        : "the take-back COMMITTED; its stamp and its change row did not, so no client is told of it",
    });
  }
}

/** A named device was made for `accountId`, and the path that made it has committed. */
export function ringDeviceMade(ctx: ServiceContext, accountId: string): Promise<void> {
  return ring(ctx, accountId, null);
}

/** The Devices list's take-back ended a session, and has committed. Stamps the device, then rings. */
export function ringDeviceRevoked(ctx: ServiceContext, taken: TakenBack): Promise<void> {
  return ring(ctx, taken.accountId, taken);
}
