import { ohbox, reads, receipts, waiting } from "@ohmail/testing";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import type { Db } from "@trafficflow/services";
import { seedBody, seedContact, seedMailbox, seedMessage, seedRule, seedThread } from "../../../packages/api/test/helpers.js";

/**
 * The world a journey starts in, said once and planted by whichever planter the setting has.
 * Every sender is invented, and every address is under the reserved example domain.
 */
export type Pile = "ohbox" | "reads" | "receipts" | "screener";

export interface ConversationSpec {
  from: { name: string; address: string };
  subject: string;
  pile: Pile;
  /** How many letters the conversation holds (default 1). */
  letters?: number;
  unread?: boolean;
  /** The newest letter's text. */
  text?: string;
  /** The newest letter as HTML, for a journey about what a letter may load. */
  html?: string;
}

export interface WorldSpec {
  mailbox?: { address: string };
  conversations: ConversationSpec[];
  /** Rules the account already has: mail from `from` is filed into `pile`. */
  rules?: Array<{ from: { address: string }; pile: Pile }>;
}

/** What a journey may know of a planted conversation: its row's two halves, and its letters' ids at the far end. */
export interface Planted {
  from: string;
  subject: string;
  messageIds: string[];
}

export interface Planter {
  kind: "fixtures" | "api" | "mail";
  plant(spec: WorldSpec): Promise<Planted[]>;
}

/**
 * The demo's world. It is read-only: nothing can be planted in it, so a journey asks for a
 * conversation it already holds and is refused when it holds none like it.
 */
export function fixturesPlanter(): Planter & {
  find(want: { pile: Pile; unread?: boolean }): Planted;
  /** How many conversations of that kind the demo's world holds. */
  count(want: { pile: Pile; unread?: boolean }): number;
} {
  const piles = {
    ohbox, reads, receipts,
    // A waiting sender's row is named by their newest held letter.
    screener: waiting.map((w) => ({ from: w.from, subject: w.held[w.held.length - 1]?.subject ?? "", unread: true, id: w.id })),
  };
  return {
    kind: "fixtures",
    plant() {
      return Promise.reject(new Error("the demo's world is read-only: ask it for a conversation with find()"));
    },
    count(want) {
      return piles[want.pile].filter((m) => want.unread === undefined || m.unread === want.unread).length;
    },
    find(want) {
      const hit = piles[want.pile].find((m) => want.unread === undefined || m.unread === want.unread);
      if (!hit) throw new Error(`the demo's world holds no ${want.unread ? "unread " : ""}conversation in ${want.pile}`);
      return { from: hit.from.name, subject: hit.subject, messageIds: [hit.id] };
    },
  };
}

const FOLDER: Record<Pile, string> = {
  ohbox: "INBOX", reads: "ohmail/News", receipts: "ohmail/Receipts", screener: "ohmail/Screener",
};

/** Seeds an account's mail through the server's own tables' test helpers; the far end is the API's answer. */
export function apiPlanter(db: Db, account: { accountId: string }, now: () => Date): Planter & { mailboxId(): Promise<string> } {
  let mailbox: string | null = null;
  const mailboxId = async (address?: string): Promise<string> => {
    mailbox ??= await seedMailbox(db, {
      accountId: account.accountId, address: address ?? "mila@lichtgrat.example",
      folders: Object.values(FOLDER).map((folder) => ({ folder })),
    });
    return mailbox;
  };
  return {
    kind: "api",
    mailboxId: () => mailboxId(),
    async plant(spec) {
      const box = await mailboxId(spec.mailbox?.address);
      const out: Planted[] = [];
      for (const rule of spec.rules ?? []) await seedRule(db, { accountId: account.accountId, match: rule.from.address, destination: FOLDER[rule.pile] });
      let age = spec.conversations.length * 10;
      for (const conv of spec.conversations) {
        const count = conv.letters ?? 1;
        const newest = new Date(now().getTime() - age * 60_000);
        age -= 10;
        // Somebody waiting in the Screener is nobody the account knows yet.
        if (conv.pile !== "screener") await seedContact(db, { accountId: account.accountId, address: conv.from.address, name: conv.from.name });
        const threadId = await seedThread(db, {
          accountId: account.accountId, subject: conv.subject, lastMessageAt: newest,
          participants: [{ name: conv.from.name, address: conv.from.address }],
        });
        const ids: string[] = [];
        for (let i = 0; i < count; i += 1) {
          const last = i === count - 1;
          const { id } = await seedMessage(db, {
            accountId: account.accountId, mailboxId: box, threadId, subject: conv.subject,
            fromAddress: conv.from.address, folder: FOLDER[conv.pile],
            date: new Date(newest.getTime() - (count - 1 - i) * 60_000),
            unread: last ? conv.unread ?? true : false,
            snippet: last ? (conv.text ?? "A short letter.").slice(0, 80) : "An earlier letter.",
          });
          // The helper seeds no sender name; the row is named by it.
          await db.update(messages).set({ fromName: conv.from.name }).where(eq(messages.id, id));
          await seedBody(db, {
            messageId: id, text: last ? conv.text ?? "A short letter." : "An earlier letter.",
            html: last ? conv.html ?? null : null,
          });
          ids.push(id);
        }
        out.push({ from: conv.from.name, subject: conv.subject, messageIds: ids });
      }
      return out;
    },
  };
}

/**
 * Mail planted on a mail server and brought in by one pass of the worker. This bench has no mail
 * server yet; a journey that needs one says so (`needs: ["mail"]`) and fails until it does.
 */
export function mailPlanter(): Planter {
  return {
    kind: "mail",
    plant() {
      return Promise.reject(new Error("this bench plants no mail on a mail server yet (needs: mail)"));
    },
  };
}

/** Invented people for a planted world. */
export const PEOPLE = {
  ben: { name: "Ben Arnold", address: "ben@lichtgrat.example" },
  giulia: { name: "Giulia Ferrari", address: "giulia@terracotta-milano.example" },
  skylark: { name: "Skylark Notes", address: "mara@skylarknotes.example" },
  stranger: { name: "Lena Kaufmann", address: "lena@atelier-eichspan.example" },
} as const;
