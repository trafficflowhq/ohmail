/** @vitest-environment jsdom */
import type { EngineMessage, SyncResponse } from "@ohmail/wire";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const copy = messages.screener;
const address = "q1@spammer.invalid";
const another = "q2@spammer.invalid";
const mailbox = "mailbox@fixture.example";
const junkPath = "/api/screener/junk";
const junkLetters = [
  { uid: 5, subject: "The open provider letter" },
  { uid: 6, subject: "Another letter from that sender" },
].map(({ uid, subject }) => ({
  uid, subject, mailboxId: "mb_1", uidValidity: "7", date: ISO,
  from: { name: null, address }, messageIdHeader: null, seen: false, origin: "provider",
}));

function message(id: string, from: string): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: ISO, folder: "ohmail/Quarantine", snippet: `snippet ${id}`, unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

type Write = { path: string; body: unknown };
let mounted = false;

beforeAll(warmCloudShell);
async function unmount() {
  if (mounted) await teardownConfirmEnv();
  mounted = false;
  vi.unstubAllGlobals();
}
afterEach(unmount);

async function mount(folders: boolean, providerItems = junkLetters) {
  installConfirmEnv();
  mounted = true;
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  vi.stubGlobal("innerWidth", 1280);
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];

  const mail = [message("q1", address), message("p1", address), message("q2", another)];
  const changes: SyncResponse["changes"] = {
    creates: mail.map((entity, index) => ({
      type: "message", op: "create", id: entity.id, seq: index + 1, updatedAt: ISO, entity,
    })),
    updates: [], moves: [], deletes: [],
  };
  let sequence = mail.length;
  scriptSync(() => Response.json({ changes, cursor: String(sequence), hasMore: false, serverTime: ISO } satisfies SyncResponse));

  const writes: Write[] = [];
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb_1", address: mailbox, status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    if (method === "GET" && path === "/api/consent") {
      const facts = await (await fixture(input, init)).json();
      return Response.json({ ...facts, foldersEnabledAt: folders ? ISO : null });
    }
    if (method === "GET" && path === junkPath) {
      return Response.json({
        items: providerItems, nextCursor: null,
        mailboxes: [{ id: "mb_1", address: mailbox, window: "ok" }],
      });
    }
    if (method === "GET" && path === `${junkPath}/sweep` && providerItems.length === 0) {
      return Response.json({
        items: [], mailboxes: [], movable: 0, pending: false,
        held: { ids: mail.map(({ id }) => id), truncated: false },
      });
    }
    if (method === "GET" && path === `${junkPath}/body`) {
      return Response.json({ subject: junkLetters[0]!.subject, text: "letter" });
    }
    if (method === "POST" && path === `${junkPath}/rescue`) {
      writes.push({ path, body: JSON.parse(String(init?.body)) });
      return Response.json({ status: "queued", rescueId: "rescue-one" });
    }
    const id = /^\/api\/messages\/([^/]+)\/move$/.exec(path)?.[1];
    if (method === "POST" && id !== undefined) {
      const original = mail.find((letter) => letter.id === id);
      if (!original) throw new Error("Move for a letter outside the seeded mail");
      const body = JSON.parse(String(init?.body));
      writes.push({ path, body });
      const entity = { ...original, folder: body.folder };
      const seq = ++sequence;
      changes.moves.push({
        type: "message", op: "move", id, seq, updatedAt: ISO, entity,
        move: { from: original.folder, to: entity.folder },
      });
      return Response.json(entity, { headers: { "x-sync-seq": String(seq) } });
    }
    if (method !== "GET" && /^\/api\/(rules|messages|screener)(?:\/|$)/.test(path)) {
      writes.push({ path, body: init?.body });
      throw new Error("Unexpected filing request");
    }
    return fixture(input, init);
  };

  window.location.hash = "#/screener/spam";
  const host = await mountCloudShell();
  await tick(3000);
  const screen = within(host);
  const click = async (target: HTMLElement) => {
    await act(() => { fireEvent.click(target); });
    await tick(200);
  };
  const press = (name: string) =>
    click(within(screen.getByRole("toolbar", { name: copy.place.panel })).getByRole("button", { name }));
  return { screen, host, click, press, writes };
}

describe("the Quarantine shelf under the Junk window", () => {
  it("folders off is the Spam segment over the whole pile, no shelf heading", async () => {
    const s = await mount(false);
    expect(s.screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining([expect.stringContaining(address), expect.stringContaining(another)]),
    );
    expect(s.screen.getAllByRole("option")).toHaveLength(2);
    expect(s.host.textContent).not.toContain(copy.quarantineShelf);

    await unmount();
    const emptyProvider = await mount(true, []);
    expect(emptyProvider.screen.getByRole("button", { name: "Spam 2", pressed: true })).toBeTruthy();
    expect(emptyProvider.screen.getByRole("listbox", { name: "Spam" })).toBeTruthy();
    expect(emptyProvider.screen.queryByRole("searchbox", { name: copy.junkSearchLabel })).toBeNull();
    expect(emptyProvider.host.textContent).not.toContain("Junk is empty");
    await emptyProvider.click(emptyProvider.screen.getByRole("button", { name: copy.place.listMenu }));
    await emptyProvider.click(within(document.body).getByRole("menuitem", { name: copy.junkSearchLabel }));
    expect(emptyProvider.screen.getByRole("searchbox", { name: copy.junkSearchLabel })).toBeTruthy();
    await emptyProvider.click(emptyProvider.screen.getByRole("button", { name: copy.place.listMenu }));
    await emptyProvider.click(within(document.body).getByRole("menuitem", { name: copy.hideSpamSearch }));
    expect(emptyProvider.screen.queryByRole("searchbox", { name: copy.junkSearchLabel })).toBeNull();
    expect(emptyProvider.writes).toEqual([]);
  });

  // Junk lists individual provider letters. With folders off the Spam row belongs to the sender.
  it("Not spam → Ohbox moves the held letter and not the sender's letter filed to Junk; folders off moves both", async () => {
    const junk = await mount(true);
    const first = junk.screen.getByRole("option", { name: /The open provider letter/ });
    expect(junk.screen.getByRole("option", { name: /Another letter from that sender/ })).toBeTruthy();
    await junk.click(first);
    await junk.press("Not junk");
    expect(junk.writes).toEqual([{ path: `${junkPath}/rescue`, body: { mailboxId: "mb_1", uid: 5, uidValidity: "7" } }]);

    await unmount();
    const spam = await mount(false);
    await spam.click(spam.screen.getByRole("option", { name: /^q1@spammer\.invalid:/ }));
    await spam.press(copy.pileOhbox);
    expect(spam.writes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "/api/messages/p1/move", body: { folder: "INBOX" } },
      { path: "/api/messages/q1/move", body: { folder: "INBOX" } },
    ]);
  });
});
