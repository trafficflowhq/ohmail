import { senderNameOf } from "@ohmail/app-logic/mailboxes/connect/sender-name";
import { liveMailboxRows, readMailboxes, writeMailboxName } from "../net/mailboxes";
import type { ShellSession } from "../net/pairing";
import type { PhoneNameRequest, Refused, Requests } from "./bridge-kinds";

type NameSession = Pick<ShellSession, "fetch" | "profile" | "standalone">;
type NameAnswer = Requests["phone.name"]["answer"] | { readonly refused: Refused };

export async function answerPhoneName(
  request: PhoneNameRequest,
  session: NameSession,
  isLive: () => boolean,
  signal: AbortSignal,
): Promise<NameAnswer> {
  const refusal = () => (signal.aborted ? "cancelled" : isLive() ? null : "foreignScope");
  const before = refusal();
  if (before) return { refused: before };
  if (!session.standalone) return { refused: "notReady" };
  const name = request.do === "save" && request.name !== null ? senderNameOf(request.name) : null;
  if (name === undefined) return { refused: "malformed" };

  const rows = await readMailboxes(session);
  const afterRead = refusal();
  if (afterRead) return { refused: afterRead };
  if (rows === null) return { refused: "notReady" };
  const own = liveMailboxRows(rows).filter((row) => row.addressIsOwn !== false);
  if (request.do === "read") {
    return { rows: own.map(({ id, address, displayName }) => ({ id, address, name: displayName ?? null })) };
  }
  if (!own.some(({ id }) => id === request.mailboxId)) return { refused: "foreignScope" };

  const saved = await writeMailboxName(session, request.mailboxId, name);
  const afterSave = refusal();
  if (afterSave) return { refused: afterSave };
  return saved.k === "written" ? { name: saved.displayName } : { refused: "notReady" };
}
