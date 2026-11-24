import { cloneElement, type ReactElement } from "react";
import type { EngineMessage, UnsubscribeHeaderState } from "@ohmail/wire";
import type { SyncChange } from "@ohmail/client-engine";
import { isScreenerAcknowledgement, SCREENER_ACKNOWLEDGEMENTS } from "@trafficflow/core/screener-acknowledgements";
import {
  ISO, LIVE_ACCOUNT, answerConsentWith, answerSyncWith, goTo, mailbox, mountShell, tick,
} from "./live-walk-shell";
import { selectScreenerRow } from "./live-screener";

interface HeldLetter {
  id: string;
  posture: UnsubscribeHeaderState | null;
  verdict?: EngineMessage["authVerdict"];
}

export async function openScreenerSender({
  address, letters, autoUnsubscribe = true, providerConfirms = true, refused = false,
  consentRow = { screenerAcknowledgements: 0 },
}: {
  address: string;
  letters: readonly [HeldLetter, ...HeldLetter[]];
  autoUnsubscribe?: boolean;
  providerConfirms?: boolean;
  refused?: boolean;
  consentRow?: { screenerAcknowledgements: number };
}): Promise<{ shell: HTMLElement; decisions: Array<{ id: string; body: unknown }> }> {
  const decisions: Array<{ id: string; body: unknown }> = [];
  const answerConsent = () => answerConsentWith({
    ...consentRow,
    ...(autoUnsubscribe ? {} : { blockAutoUnsubscribeAt: ISO }),
  });
  answerConsent();
  const creates: SyncChange[] = letters.flatMap(({ id, posture, verdict }, index): SyncChange[] => {
    const entity: EngineMessage = {
      id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
      subject: `Subject ${id}`, from: { name: null, address }, to: [], cc: [],
      folder: "ohmail/Screener", snippet: "", hasAttachments: false, attachmentCount: 0,
      sensitivity: {
        sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
      },
      triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
      date: index === 0 ? ISO : "2026-08-03T09:00:00.000Z",
      unread: posture === null,
      ...(verdict === undefined ? {} : { authVerdict: verdict }),
    };
    return [
      { type: "message", id, op: "create", seq: index * 2 + 1, updatedAt: ISO, entity },
      ...(posture === null ? [] : [{
        type: "message_body", id, op: "create", seq: index * 2 + 2, updatedAt: ISO,
        entity: {
          messageId: id, state: "ready", text: "body from the server", html: null,
          loadedRemoteContent: false, unsubscribe: posture, unsubscribeUrl: null, withheld: null,
        },
      } satisfies SyncChange]),
    ];
  });
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "X-Ohmail-Account": LIVE_ACCOUNT },
    });
  answerSyncWith(() => json({
    changes: { creates, updates: [], moves: [], deletes: [] },
    cursor: String(creates.at(-1)?.seq), hasMore: false, serverTime: ISO,
  }));
  const fetchShell = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH" && String(input).endsWith("/consent/settings")) {
      const { acknowledgeScreener } = JSON.parse(String(init.body)) as { acknowledgeScreener?: unknown };
      if (isScreenerAcknowledgement(acknowledgeScreener)) {
        consentRow.screenerAcknowledgements |= SCREENER_ACKNOWLEDGEMENTS[acknowledgeScreener];
        answerConsent();
        return json({ screenerAcknowledgements: consentRow.screenerAcknowledgements });
      }
    }
    const press = /\/screener\/([^/?]+)$/.exec(String(input));
    if (init?.method === "POST" && press) {
      const body = JSON.parse(String(init.body)) as { dest: string };
      decisions.push({ id: press[1]!, body });
      if (refused) return json({ error: { code: "not_found", message: "Screener item not found" } }, 404);
      return json({ messageId: press[1], appliedFolder: body.dest, createdRuleId: "promoted-rule" });
    }
    return fetchShell(input, init);
  }) as typeof fetch;

  const shell = await mountShell([mailbox({ id: "mb_1", lastSyncAt: ISO, providerConfirms })], {
    wrap: (element) => cloneElement(element as ReactElement<{ scope: string }>, { scope: "acct_live_1" }),
  });
  await goTo("screener");
  await tick(50);
  await selectScreenerRow(shell, letters[0].id);
  return { shell, decisions };
}
