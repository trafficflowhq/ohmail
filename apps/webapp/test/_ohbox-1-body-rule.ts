/**
 * THE BODY RULE's WORLD, for share ohbox-1's split of `body-rule.test.tsx` (the join folds it): one sender's letters
 * and rules in a memory mirror. Moved here word for word so that the planner's cases (`body-rule-plan.test.ts`) and
 * the sheet's and the rules surface's (`body-rule.test.tsx`) stand on the same letters.
 */
import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import {
  MemoryMirrorStore,
  type SyncChange,
} from "@ohmail/client-engine";

let seq = 0;

export function msg(
  id: string, from: string, subject: string, folder: Folder = "INBOX",
  text?: { body?: string; snippet?: string },
): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: `2026-08-0${(seq % 8) + 1}${"T"}09:00:00.000Z`,
    folder,
    snippet: text?.snippet ?? "s",
    ...(text?.body !== undefined ? { body: text.body } : {}),
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

export function ruleRow(over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id: `r-${++seq}`,
    kind: "sender",
    match: "info@sichersatt.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    subjectContains: null,
    bodyContains: null,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

export async function mirror(list: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...list.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    ...rules.map((r): SyncChange => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r,
    })),
  ]);
  return store;
}

export const SENDER = "info@sichersatt.example";
export const TOKEN = "[NinjaFirewall]";

/** The corpus a subject term cannot split: one subject, three bodies, all in the Ohbox. */
export const CORPUS = () => [
  msg("alert-1", SENDER, "Notification", "INBOX", { body: `${TOKEN} brute-force attempt blocked` }),
  msg("alert-2", SENDER, "Notification", "INBOX", { body: `Scan finished.\n${TOKEN}\nUnsubscribe.` }),
  msg("invoice", SENDER, "Notification", "INBOX", { body: "Rechnung 2026-08. Zahlbar in 30 Tagen." }),
];
