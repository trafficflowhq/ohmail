/** @vitest-environment jsdom */
import type { EngineMessage, Folder, RuleEntity, SyncResponse } from "@ohmail/wire";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_MS } from "@ohmail/app-logic/press/routing-undo";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const copy = messages.screener;
const OWN = "out@one.test";
const DOMAIN = "three.test";
const MEMBER = "d@three.test";
const SPAMMER = "spam@two.test";
const SCREENED = "ohmail/Screened";
const SPAM = "ohmail/Quarantine";

function message(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: ISO, folder, snippet: `snippet ${id}`, unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

function rule(id: string, match: string, destination: Folder, kind: "sender" | "domain" = "sender"): RuleEntity {
  return {
    id, kind, match, destination, priority: 0, provenance: "promoted", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO, updatedAt: ISO,
  } as RuleEntity;
}

type Write = { method: string; path: string; body?: Record<string, unknown> };

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  vi.stubGlobal("innerWidth", 1280);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
});
afterEach(async () => {
  await teardownConfirmEnv();
  vi.unstubAllGlobals();
});

async function mount(letter: EngineMessage, standing: RuleEntity, segment = copy.segScreened) {
  let sequence = 2;
  let current = letter;
  const namedRules = new Map([[standing.id, standing]]);
  const writes: Write[] = [];
  const changes: SyncResponse["changes"] = {
    creates: [
      { type: "message", op: "create", id: letter.id, seq: 1, updatedAt: ISO, entity: letter },
      { type: "rule", op: "create", id: standing.id, seq: 2, updatedAt: ISO, entity: standing },
    ],
    updates: [], moves: [], deletes: [],
  };
  scriptSync(() => Response.json({ changes, cursor: String(sequence), hasMore: false, serverTime: ISO } satisfies SyncResponse));

  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb_1", address: "mailbox@fixture.example", status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] }, { headers: { "X-Ohmail-Account": ACCOUNT } });
    }
    if (method === "GET" || !/^\/api\/(rules|messages|screener)(?:\/|$)/.test(path)) {
      return fixture(input, init);
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    writes.push({ method, path, body });
    const place = (folder: Folder) => {
      const from = current.folder;
      current = { ...current, folder };
      changes.moves.push({ type: "message", op: "move", id: letter.id, seq: ++sequence, updatedAt: ISO, entity: current, move: { from, to: folder } });
    };
    if (body?.release?.messageIds.includes(letter.id)) place(body.release.to);
    if (method === "POST" && path === `/api/messages/${letter.id}/move`) {
      place(body.folder);
      return Response.json(current, { headers: { "x-sync-seq": String(sequence), "X-Ohmail-Account": ACCOUNT } });
    }
    const seq = ++sequence;
    const headers = { "x-sync-seq": String(seq), "X-Ohmail-Account": ACCOUNT };
    const ruleId = path.split("/").at(-1)!;
    if (method === "PATCH" && namedRules.has(ruleId)) {
      const entity = { ...namedRules.get(ruleId)!, destination: body.destination };
      namedRules.set(ruleId, entity);
      changes.updates.push({ type: "rule", op: "update", id: ruleId, seq, updatedAt: ISO, entity });
      return Response.json(entity, { headers });
    }
    if (method === "DELETE" && namedRules.delete(ruleId)) {
      changes.deletes.push({ type: "rule", op: "delete", id: ruleId, seq, updatedAt: ISO, entity: null });
      return new Response(null, { status: 204, headers });
    }
    if (method === "POST" && path === "/api/rules") {
      const entity = rule("r-new", body.match, body.destination, body.kind);
      namedRules.set(entity.id, entity);
      changes.creates.push({ type: "rule", op: "create", id: entity.id, seq, updatedAt: ISO, entity });
      return Response.json(entity, { status: 201, headers });
    }
    throw new Error(`Unexpected release request: ${method} ${path}`);
  };

  window.location.hash = "#/screener";
  const host = await mountCloudShell();
  await tick(3000);
  const screen = within(host);
  const click = async (control: HTMLElement) => {
    await act(() => { fireEvent.click(control); });
    await tick(50);
  };
  const sections = within(await vi.waitFor(() => screen.getByRole("group", { name: copy.segAria })));
  await click(sections.getByRole("button", { name: (name) => name === segment || name.startsWith(`${segment} `) }));
  const row = () => screen.queryByRole("option", { name: new RegExp(letter.subject) });
  expect(row(), "the sender is on the requested shelf").not.toBeNull();
  await click(row()!);
  const press = (label: string) => click(within(screen.getByRole("toolbar", { name: copy.place.panel }))
    .getByRole("button", { name: label }));
  const report = () => host.querySelector<HTMLElement>('.fr-report [role="status"]:not([data-leaving])');
  const reportText = () => {
    const sentence = report()?.cloneNode(true) as HTMLElement | undefined;
    sentence?.querySelectorAll("button").forEach((node) => node.remove());
    return sentence?.textContent?.trim();
  };
  const undoButton = () => within(report()!).getByRole("button", { name: /^Undo/ });
  return {
    row, press, reportText, undoButton,
    undo: () => click(undoButton()),
    rules: () => writes.filter(({ path }) => path.startsWith("/api/rules")),
    moves: () => writes.filter(({ path }) => path.endsWith("/move")),
  };
}

function move(id: string, folder: Folder, pressRule = false): Write {
  return { method: "POST", path: `/api/messages/${id}/move`, body: { folder, ...(pressRule ? { pressRule: true } : {}) } };
}
const windowCloses = () => tick(UNDO_MS + 100);

function release(messageId: string, from: Folder, to: Folder) {
  return { messageIds: [messageId], from, to };
}

describe("a release from Screened out", () => {
  it("writes the rule and moves the mail in one request", async () => {
    const s = await mount(message("m1", OWN, SCREENED), rule("r1", OWN, SCREENED));
    await s.press(copy.pileOhbox);
    const write = {
      method: "PATCH", path: "/api/rules/r1",
      body: { destination: "INBOX", release: release("m1", SCREENED, "INBOX") },
    };
    expect(s.moves()).toEqual([]);
    expect(s.rules()).toEqual([write]);
    expect(s.undoButton()).toBeTruthy();
    expect(s.reportText()).toBe("Ohbox — 1 held from out@one.test released. Their rule now files future mail here too");
    expect(s.row(), "the released sender is still on the shelf").toBeNull();
    await windowCloses();
    expect(s.rules()).toEqual([write]);
  });

  it("Undo restores the rule and moves the mail back in one request", async () => {
    const s = await mount(message("m1", OWN, SCREENED), rule("r1", OWN, SCREENED));
    await s.press(copy.pileOhbox);
    await s.undo();
    expect(s.reportText()).toBe(messages.screening.toastRoutingUndoneRules.replace(/\.$/, ""));
    await windowCloses();
    expect(s.moves()).toEqual([]);
    expect(s.rules()).toEqual([
      { method: "PATCH", path: "/api/rules/r1", body: {
        destination: "INBOX", release: release("m1", SCREENED, "INBOX"),
      } },
      { method: "PATCH", path: "/api/rules/r1", body: {
        destination: SCREENED, applyRetro: false, keepProvenance: true, restoreProvenance: "promoted",
        release: release("m1", "INBOX", SCREENED),
      } },
    ]);
  });
});

describe("a release from a domain rule", () => {
  it("writes the sender exception with the release and removes it on Undo", async () => {
    const s = await mount(message("m3", MEMBER, SCREENED), rule("r3", DOMAIN, SCREENED, "domain"));
    await s.press(copy.pileOhbox);
    expect(s.moves()).toEqual([]);
    const created = {
      method: "POST", path: "/api/rules",
      body: {
        kind: "sender", match: MEMBER, destination: "INBOX", applyRetro: true,
        release: release("m3", SCREENED, "INBOX"),
      },
    };
    expect(s.rules()).toEqual([created]);
    await s.undo();
    await windowCloses();
    expect(s.moves()).toEqual([]);
    expect(s.rules()).toEqual([
      created,
      { method: "DELETE", path: "/api/rules/r-new", body: { release: release("m3", "INBOX", SCREENED) } },
    ]);
  });
});

describe("Not spam, back to Waiting", () => {
  it("moves the mail to Waiting at once and holds the rule's removal, with Undo", async () => {
    const s = await mount(message("m2", SPAMMER, SPAM), rule("r2", SPAMMER, SPAM), copy.segSpam);
    await s.press(copy.place.toWaiting);
    expect(s.moves()).toEqual([move("m2", "ohmail/Screener")]);
    expect(s.rules(), "the rule was removed at the press").toEqual([]);
    expect(s.reportText()).toBe("Not spam — spam@two.test is back in Waiting");
    expect(s.undoButton()).toBeTruthy();
    await windowCloses();
    expect(s.rules()).toEqual([{ method: "DELETE", path: "/api/rules/r2", body: undefined }]);
  });
});
