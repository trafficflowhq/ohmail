/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OhmailEngine } from "@ohmail/client-engine";
import {
  ISO, act, answerSyncWith, goTo, installShellEnv, liveAccountFetch, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

beforeEach(installShellEnv);
afterEach(teardownShellEnv);

const message: EngineMessage = {
  id: "mail", accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "Studio estimate", from: { name: "Clay studio", address: "clay@example.invalid" },
  to: [], cc: [], folder: "INBOX", date: ISO, snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: {
    sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false,
  },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
};

const json = (body: unknown, status = 200, seq?: number): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...(seq === undefined ? {} : { "X-Sync-Seq": String(seq) }) },
});

function tagWire() {
  const creates = [
    {
      type: "rule", op: "create", id: "mine", seq: 1, updatedAt: ISO,
      entity: {
        id: "mine", kind: "sender", match: message.from.address, destination: "INBOX", priority: 0,
        provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
        createdAt: ISO, updatedAt: ISO,
      },
    },
    {
      type: "tag", op: "create", id: "studio", seq: 2, updatedAt: ISO,
      entity: { id: "studio", name: "Studio", hue: "moss", createdAt: ISO, updatedAt: ISO },
    },
    { type: "message", op: "create", id: message.id, seq: 3, updatedAt: ISO, entity: message },
  ];
  let seq = 3;
  let labels: string[] = [];
  const requests: Array<{ path: string; body: { tagId: string; assigned: boolean } }> = [];
  const keys: Array<string | null> = [];
  let pending: ((res: Response) => void) | null = null;

  answerSyncWith(() => json({
    changes: {
      creates,
      updates: seq === 3 ? [] : [{
        type: "message", op: "update", id: message.id, seq, updatedAt: ISO, entity: { ...message, labels },
      }],
      moves: [], deletes: [],
    },
    cursor: String(seq), hasMore: false, serverTime: ISO,
  }));
  const fetchShell = globalThis.fetch;
  globalThis.fetch = liveAccountFetch(async (input, init) => {
    const path = String(input);
    if (init?.method !== "POST" || !/\/messages\/[^/?]+\/tags$/.test(path)) return fetchShell(input, init);
    const body = JSON.parse(String(init.body)) as { tagId: string; assigned: boolean };
    requests.push({ path: new URL(path, "https://fixture.invalid").pathname, body });
    keys.push(new Headers(init.headers).get("Idempotency-Key"));
    return new Promise<Response>((resolve) => { pending = resolve; });
  });

  return {
    requests,
    keys,
    async answer(outcome: "applied" | "refused" | "retry" = "applied") {
      const send = pending;
      if (send === null) throw new Error("no tag write is waiting");
      pending = null;
      if (outcome === "retry") {
        send(json({ error: { code: "temporarily_unavailable", message: "retry" } }, 503));
      } else if (outcome === "refused") {
        send(json({
          error: { code: "organized_elsewhere", message: "refused", details: { by: { kind: "local", name: "the laptop" } } },
        }, 409));
      } else {
        const { body } = requests.at(-1)!;
        labels = body.assigned ? [body.tagId] : [];
        send(json({ labels }, 200, ++seq));
      }
      await tick(25);
    },
  };
}

const report = (): string => document.querySelector('.fr-report [role="status"]:not([data-leaving])')?.textContent ?? "";
const click = (target: HTMLElement): Promise<void> => act(async () => { target.click(); });

async function studioOption(shell: HTMLElement): Promise<HTMLElement> {
  if (!within(document.body).queryByRole("menu", { name: "Tag" })) {
    const bar = within(shell).getByRole("toolbar", { name: "Actions" });
    await click(within(bar).getByRole("button", { name: "Tag" }));
  }
  const menu = within(document.body).getByRole("menu", { name: "Tag" });
  return within(menu).getByRole("menuitemcheckbox", { name: "Studio" });
}

async function toggleStudio(shell: HTMLElement): Promise<void> {
  await click(await studioOption(shell));
  await tick(25);
}

describe("the seam: nine families, each refused, each told", () => {
  it("8 — Tags", async () => {
    const wire = tagWire();
    const shell = await mountShell([mailbox({ id: "mb_1", lastSyncAt: ISO })]);
    await goTo(`ohbox/m/${message.id}`);
    await tick(25);
    expect(within(shell).getByRole("region", { name: "Open message" }).textContent).toContain(message.subject);

    const request = (assigned: boolean) => ({
      path: "/api/messages/mail/tags", body: { tagId: "studio", assigned },
    });
    await toggleStudio(shell);
    expect(wire.requests).toEqual([request(true)]);
    expect(report()).not.toContain("Tagged");
    await wire.answer("refused");
    expect(report()).toContain("Nothing changed — the laptop organizes this mailbox");
    expect(report()).not.toContain("Tagged");
    expect(within(document.body).queryByRole("button", { name: "Undo" })).toBeNull();
    expect((await studioOption(shell)).getAttribute("aria-checked")).toBe("false");

    await toggleStudio(shell);
    expect(wire.requests).toEqual([request(true), request(true)]);
    expect(report()).not.toContain("Tagged");
    await wire.answer();
    expect(report()).toContain("Studio");
    expect((await studioOption(shell)).getAttribute("aria-checked")).toBe("true");
    await goTo("ohbox");
    await click(within(document.body).getByRole("button", { name: "Undo" }));
    await tick(25);
    expect(wire.requests).toEqual([request(true), request(true), request(false)]);
    await wire.answer();
    await goTo(`ohbox/m/${message.id}`);
    expect((await studioOption(shell)).getAttribute("aria-checked")).toBe("false");
  });
  it("waits for the queued tag's actual acknowledgment before naming it or offering Undo", async () => {
    let origin: OhmailEngine | undefined;
    const mutate = OhmailEngine.prototype.mutate;
    vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(function (this: OhmailEngine, ...args) {
      if (args[0].kind === "tag_assign") origin = this;
      return mutate.apply(this, args);
    });
    const wire = tagWire();
    const shell = await mountShell([mailbox({ id: "mb_1", lastSyncAt: ISO })]);
    await goTo(`ohbox/m/${message.id}`);
    await tick(25);
    await toggleStudio(shell);
    await wire.answer("retry");

    const queued = origin?.pendingMutations().find((p) => p.mutation.kind === "tag_assign");
    expect(queued).toBeDefined();
    expect(wire.requests).toHaveLength(1);
    expect(report()).not.toContain("Tagged");
    expect((await studioOption(shell)).getAttribute("aria-checked")).toBe("true");
    expect(within(document.body).queryByRole("button", { name: "Undo" })).toBeNull();

    let retry!: ReturnType<OhmailEngine["retryQueued"]>;
    await act(async () => { retry = origin!.retryQueued(queued!.id); });
    await tick(25);
    expect(wire.requests).toHaveLength(2);
    expect(wire.requests[1]).toEqual(wire.requests[0]);
    expect(wire.keys).toEqual([queued!.key, queued!.key]);
    expect(report()).not.toContain("Tagged");
    await wire.answer();
    await act(async () => { expect((await retry)?.status).toBe("confirmed"); });
    expect(report()).toContain("Studio");
    await click(within(document.body).getByRole("button", { name: "Undo" }));
    await tick(25);
    expect(wire.requests).toEqual([
      wire.requests[0], wire.requests[0],
      { path: "/api/messages/mail/tags", body: { tagId: "studio", assigned: false } },
    ]);
    await wire.answer();
    expect((await studioOption(shell)).getAttribute("aria-checked")).toBe("false");
  });

});
