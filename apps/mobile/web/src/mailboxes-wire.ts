import { NONE, mailboxRosterOver, type ConnectWire, type MailboxesWire } from "@ohmail/app/host";
import { refusalOf } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { reveal } from "@ohmail/app-logic/mailboxes/connect/secret";
import type { Answered } from "@ohmail/app-logic/mailboxes/connect/types";
import type { MailboxDTO } from "@ohmail/wire";
import type { PhoneServerPatch } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { bridgeFetch } from "./bridge-fetch";

const NO_ANSWER: Answered<never> = { ok: false, refusal: refusalOf(null) };

export async function readPhoneMailboxes(request: ReturnType<typeof bridgeFetch>, counts = false) {
  const response = await request(counts ? "/mailboxes?counts=1" : "/mailboxes");
  if (!response.ok) throw new Error(`Mailbox list refused (${response.status})`);
  const answer = (await response.json()) as { items?: MailboxDTO[] } | null;
  if (!Array.isArray(answer?.items) || answer.items.some((row) =>
    typeof row?.id !== "string" || typeof row.address !== "string" || typeof row.status !== "string"
  )) throw new Error("The engine did not answer with a mailbox list");
  return answer.items;
}

export function phoneMailboxWires(bridge: Bridge, scope: string, standalone: boolean) {
  const request = bridgeFetch(bridge, scope);
  const roster = mailboxRosterOver({
    async list({ counts }) {
      if (!standalone) return readPhoneMailboxes(request, counts);
      const answer = await bridge.request("phone.mailbox", { do: "list", counts });
      if (answer.rows === undefined) throw new Error("Mailbox list unavailable");
      return answer.rows;
    },
    async resync(id) {
      const answer = await request(`/mailboxes/${encodeURIComponent(id)}/resync`, { method: "POST" });
      if (!answer.ok) throw { status: answer.status };
    },
  }, standalone, NONE);
  if (!standalone) return { mailboxes: roster, connect: NONE } as const;
  const mailboxes: MailboxesWire = {
    ...roster,
    async selfCheck(mailboxId) {
      try {
        const { checked } = await bridge.request("phone.mailbox", { do: "check", mailboxId });
        return checked === undefined ? NO_ANSWER : { ok: true, value: checked };
      } catch {
        return NO_ANSWER;
      }
    },
  };
  const connect: ConnectWire = {
    probe: NONE,
    connect: async () => NO_ANSWER,
    async edit(mailboxId, { imap, smtp }) {
      function open(leg: typeof imap): PhoneServerPatch {
        const { host, port, user, pass } = leg;
        return { host, port, user, pass: reveal(pass) };
      }
      try {
        const answer = await bridge.request("phone.mailbox", {
          do: "edit", mailboxId, patch: { imap: open(imap), ...(smtp ? { smtp: open(smtp) } : {}) },
        });
        return answer.edited ?? NO_ANSWER;
      } catch {
        return NO_ANSWER;
      }
    },
    discover: NONE,
    signIn: NONE,
    localServerWait: true,
  };
  return { mailboxes, connect };
}
