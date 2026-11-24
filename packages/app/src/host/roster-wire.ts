import { liveMailboxes } from "@ohmail/app-logic/mail-state/mail-state";
import { mailboxIdOfAnswer } from "@ohmail/app-logic/mailboxes/connect/mailbox-id";
import { refusalOf } from "@ohmail/app-logic/mailboxes/connect/refusal";
import type { Answered } from "@ohmail/app-logic/mailboxes/connect/types";
import type { MailboxRow } from "@ohmail/app-logic/mailboxes/pane-contract";
import { NONE } from "./contract.js";
import type { MailboxesWire } from "./wires.js";

async function answer<T>(read: () => Promise<T>): Promise<Answered<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (failure) {
    return { ok: false, refusal: refusalOf(failure) };
  }
}

/** The host's complete roster and resync action, with only the handoff that host can perform. */
export function mailboxRosterOver(
  requests: {
    list(options: { counts: boolean }): Promise<readonly (Omit<MailboxRow, "id"> & { id: string })[]>;
    resync(id: string): Promise<void>;
  },
  local: boolean,
  out: MailboxesWire["out"],
): MailboxesWire {
  return {
    list: (options) =>
      answer(async () => {
        const rows = (await requests.list(options)).map((row) => {
          const id = mailboxIdOfAnswer(row.id);
          if (id === null) throw new Error("The engine did not name every mailbox on the list");
          return { ...row, id };
        });
        return local ? (liveMailboxes(rows) ?? []) : rows;
      }),
    resync: (id) =>
      answer(async () => {
        await requests.resync(id);
        return null;
      }),
    allowance: NONE,
    remove: NONE,
    erase: NONE,
    organizer: NONE,
    organizeHere: NONE,
    stopOrganizing: NONE,
    dismissForwardingNotice: NONE,
    selfCheck: NONE,
    filings: NONE,
    out,
  };
}
