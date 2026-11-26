import { OhmailEngine } from "@ohmail/client-engine";
import { vi } from "vitest";
import { within } from "@testing-library/react";
import type { EngineMessage, Folder, RuleEntity } from "@ohmail/wire";
import { personalAt } from "../../../../test/support/fixture-credentials.js";
import { settleFirstPaint } from "../_first-paint.js";
import messages from "../../messages/en.json";
import { ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb, teardownScreeningWeb, tick } from "./screening-web.js";

const sender = personalAt("fixture.ada", "sender.example");
const id = "current-letter";
const base: EngineMessage = {
  id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "A note from Ada", from: { name: "Ada", address: sender }, to: [], cc: [],
  date: ISO, folder: "INBOX", snippet: "A note", unread: true, placeDecided: true,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
};

interface SenderWrite {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

type SenderCheck = (test: {
  shell: HTMLElement;
  sheet: ReturnType<typeof within>;
  writes: SenderWrite[];
  sender: string;
  id: string;
}) => Promise<void>;

export function clickMounted(control: HTMLElement) {
  return act(async () => { control.click(); });
}

export async function withMountedSender(check: SenderCheck, options: {
  place?: "history" | "ohbox";
  rules?: readonly Folder[];
  refused?: boolean;
  queued?: boolean;
  extraPlaced?: boolean;
  placeDecided?: boolean;
  subjectRule?: boolean;
  organizerFilesBacklog?: boolean;
  answer?: Parameters<typeof installScreeningWeb>[1];
  extraSync?: readonly object[];
  calendarSnapshot?: boolean;
  secondMailbox?: boolean;
} = {}) {
  const writes: SenderWrite[] = [];
  const ruleOf = (ruleId: string, destination: Folder): RuleEntity => ({
    id: ruleId, kind: "sender", match: sender, destination, priority: 0,
    provenance: "manual", enabled: true, createdAt: ISO, updatedAt: ISO,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
  });
  const rules = (options.rules ?? []).map((dest, index) => ruleOf(`standing-${index}`, dest));
  if (options.subjectRule) rules.push({
    ...ruleOf("subject-rule", "INBOX"), subjectContains: base.subject!,
  });
  const rows: EngineMessage[] = [{ ...base }];
  if (options.secondMailbox) rows.push({
    ...base, id: "other-mailbox-letter", mailboxId: "mb_2", folder: "ohmail/News", subject: "From the other mailbox",
  });
  if (options.placeDecided === false) delete rows[0]!.placeDecided;
  if (options.extraPlaced) rows.push({ ...base, id: "already-there", folder: "ohmail/News", subject: "Already in News" });
  const backlog = options.organizerFilesBacklog
    ? { ...base, id: "backlog-letter", subject: "An earlier note" }
    : undefined;
  if (backlog) rows.push(backlog);
  const sync = backlog ? vi.spyOn(OhmailEngine.prototype, "syncOnce") : undefined;
  let backlogFiled = false;
  let seq = 20;
  installScreeningWeb(`#/${options.place ?? "ohbox"}/m/${id}`, (path, query, method, init) => {
    const supplied = options.answer?.(path, query, method, init);
    if (supplied !== undefined) return supplied;
    if (path === "/api/mailboxes") {
      const primary = {
        id: base.mailboxId, address: personalAt("fixture.reader", "mailbox.example"),
        status: "connected", organizerRole: "organizer", organizerChecked: true,
        createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
      };
      const secondary = { ...primary, id: "mb_2", address: personalAt("fixture.other", "mailbox.example") };
      return Response.json({ items: options.secondMailbox ? [primary, secondary] : [primary] });
    }
    const snapshot = path === "/api/sync/snapshot" && options.calendarSnapshot === true;
    if (path === "/api/sync" || snapshot) {
      if (backlog && backlogFiled && query.get("types") !== "rule") {
        return Response.json({
          changes: { creates: [], moves: [], deletes: [], updates: [{
            type: "message", op: "update", id: backlog.id, seq, updatedAt: ISO, entity: backlog,
          }] },
          cursor: `c${seq}`, hasMore: false, serverTime: ISO,
        });
      }
      const changes = query.get("types") === "rule" ? rules.map((rule, index) => ({
        type: "rule", op: "create", id: rule.id, seq: index + 1, updatedAt: ISO, entity: rule,
      })) : rows.map((row, index) => ({
        type: "message", op: "create", id: row.id, seq: index + rules.length + 1, updatedAt: ISO, entity: row,
      }));
      const extra = query.get("types") === "rule" ? [] : options.extraSync ?? [];
      const asOfSeq = rules.length + rows.length + extra.length;
      const all = [...changes, ...extra.map((entry, index) => ({ ...entry, seq: rules.length + rows.length + index + 1 }))];
      if (snapshot) {
        return Response.json({
          asOfSeq, nextCursor: null,
          calendarWindow: { daysBack: 366, daysAhead: 731, maxRows: 10_000 },
          changes: [...rules.map((entity) => ({ type: "rule", op: "create", id: entity.id, updatedAt: ISO, entity })),
            ...all].map((entry) => ({ ...entry, seq: asOfSeq })),
        });
      }
      return syncScreeningWeb(all, asOfSeq);
    }
    if (method !== "GET" && /^\/api\/(?:rules|messages|screener)(?:\/|$)/.test(path)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      writes.push({ path, method, body });
      if (path.startsWith("/api/rules")) {
        if (options.refused || options.queued) {
          return Response.json({ error: { code: "ineligible" } }, { status: options.refused ? 422 : 503 });
        }
        if (method === "DELETE") return new Response(null, { status: 204 });
        const rule = {
          ...ruleOf(path === "/api/rules" ? "new-rule" : path.split("/").at(-1)!, body.destination as Folder),
          ...(body.kind === "domain" ? { kind: "domain" as const, match: String(body.match) } : {}),
        };
        return Response.json({
          ...rule,
          ...(typeof body.subjectContains === "string" ? { subjectContains: body.subjectContains } : {}),
          ...(body.applyRetro === true ? { retro: { requestedAt: ISO, doneAt: null } } : {}),
        }, { status: 201, headers: { "X-Sync-Seq": String(++seq) } });
      }
      const moved = rows.find((row) => path === `/api/messages/${row.id}/move`);
      if (moved) return (async () => {
        if (options.refused || options.queued) return Response.json({ error: { code: "ineligible" } }, { status: 422 });
        // Let the organizer's sync add a shown row before the pressed letter's move answers.
        if (backlog && sync && moved.id === id) {
          backlog.folder = body.folder as Folder;
          backlogFiled = true;
          seq++;
          const engine = sync.mock.contexts.at(-1) as OhmailEngine;
          await engine.syncOnce();
        }
        moved.folder = body.folder as Folder;
        return Response.json(moved, { headers: { "X-Sync-Seq": String(++seq) } });
      })();
      return Response.json({});
    }
    return undefined;
  });

  try {
    const shell = await mountScreeningWeb();
    await tick(4000);
    await settleFirstPaint();
    const reader = within(within(shell).getByRole("region", { name: "Reading" }));
    await clickMounted(reader.getByRole("button", { name: /^Ada / }));
    const sheet = within(document.body).getByRole("dialog", { name: messages.screening.aria.replace("{sender}", sender) });
    await check({ shell, sheet: within(sheet), writes, sender, id });
  } finally {
    await teardownScreeningWeb();
  }
}
