/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OhmailEngine } from "@ohmail/client-engine";
import type { JunkWire } from "@ohmail/app/host";
import type { EngineMessage } from "@ohmail/wire";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb,
  teardownScreeningWeb, tick, warmScreeningWeb,
} from "./fixtures/screening-web";

beforeAll(warmScreeningWeb, 60_000);
afterEach(teardownScreeningWeb);

const NEWS = { address: "letters@news.example.invalid", name: "A newsletter" };
const PEDLAR = { address: "offers@pedlar.example.invalid", name: "A pedlar" };
const MAILBOX = { id: "mb1", address: "me@example.invalid" };
type JunkFirstPage = Pick<JunkWire, "list" | "sweepPreview">;
const JUNK_WIRE: JunkFirstPage = {
  list: async () => ({ mailboxes: [{ ...MAILBOX, window: "ok" }], items: [], nextCursor: null }),
  sweepPreview: async () => ({ mailboxes: [], movable: 0, pending: false }),
};

function message(id: string, folder: EngineMessage["folder"], from: EngineMessage["from"]): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: MAILBOX.id, threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from, to: [], cc: [], date: ISO, updatedAt: ISO, folder, snippet: "",
    unread: false, hasAttachments: false, attachmentCount: 0, labels: [], triage: null,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    remoteContent: "none",
  };
}

async function mount(wire: JunkFirstPage, hash = "#/ohbox", postSweep?: (confirmation: string | null) => Response) {
  const engine = vi.spyOn(OhmailEngine.prototype, "syncOnce");
  const rows = [message("n1", "ohmail/News", NEWS), message("q1", "ohmail/Quarantine", PEDLAR)];
  let delivered = 0;
  let releaseConsent!: (response: Response) => void;
  const consent = new Promise<Response>((resolve) => { releaseConsent = resolve; });
  installScreeningWeb(hash, (path, query, method, init) => {
    if (method === "POST" && path === "/api/screener/junk/sweep" && postSweep) {
      return postSweep(new Headers(init?.headers).get("if-match"));
    }
    if (method !== "GET") return undefined;
    if (path === "/api/consent") return consent.then((response) => response.clone());
    if (path === "/api/screener/junk") return wire.list({}).then((page) => Response.json(page));
    if (path === "/api/screener/junk/sweep") return wire.sweepPreview().then((preview) => Response.json(preview));
    if (path === "/api/mailboxes") return Response.json({ items: [{
      ...MAILBOX, status: "connected", createdAt: ISO, lastSyncAt: ISO, initialImportCompletedAt: ISO,
      organizerRole: "organizer", organizerChecked: true, organizeConsentedAt: ISO,
    }] });
    if (path === "/api/sync") {
      if (query.get("types") === "rule") return syncScreeningWeb([], 0);
      const changes = rows.slice(delivered).map((row, index) => ({
        type: "message", op: "create", id: row.id, seq: delivered + index + 1, updatedAt: ISO, entity: row,
      }));
      delivered = rows.length;
      return syncScreeningWeb(changes, delivered);
    }
    return undefined;
  }, true);
  const container = await mountScreeningWeb();
  // The original finder starts with a loaded mirror. Let these two rows arrive
  // before giving the registered Web host permission to open its Junk window.
  await tick(2500);
  const mirror = engine.mock.contexts.at(-1);
  if (!(mirror instanceof OhmailEngine)) throw new Error("The Web engine did not start");
  expect(mirror.read().get("message", "q1")).toBeTruthy();
  await act(() => releaseConsent(Response.json({
    seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60, foldersEnabledAt: ISO,
  })));
  await tick(1000);
  return {
    container,
    async fileAnother() {
      rows.push(message("q2", "ohmail/Quarantine", PEDLAR));
      await act(() => { void mirror.syncOnce(); });
      await tick(250);
      expect(mirror.read().get("message", "q2")).toBeTruthy();
    },
  };
}

const click = (el: HTMLElement | null, what: string) => act(async () => {
  expect(el, what).not.toBeNull();
  fireEvent.click(el!);
});

async function waitFor(condition: () => boolean, what: string) {
  for (let elapsed = 0; elapsed < 3000 && !condition(); elapsed += 250) await tick(250);
  expect(condition(), what).toBe(true);
}

function junkButton(host: HTMLElement): HTMLElement | null {
  const sections = within(host).queryByRole("group", { name: messages.screener.segAria });
  return sections ? within(sections).queryByRole("button", { name: new RegExp(`^${messages.screener.segSpam}(?: [0-9]+)?$`) }) : null;
}

async function openScreener(host: HTMLElement): Promise<void> {
  const rail = within(host).getByRole("navigation", { name: "Places" });
  await click(within(rail).getByRole("button", { name: /^Screener\b/ }), "the Screener place");
}

describe("the Screener reads the Junk window before the Spam click", () => {
  it("opening the Screener asks the page and the preview; the click draws both in its own commit", async () => {
    const calls: string[] = [];
    const release: Array<() => void> = [];
    const later = <T,>(name: string, v: T): Promise<T> => {
      calls.push(name);
      return new Promise((r) => { release.push(() => r(v)); });
    };
    const wire: JunkFirstPage = {
      ...JUNK_WIRE,
      list: () => later("list", {
        mailboxes: [{ id: "mb1", address: "me@example.invalid", window: "ok" as const }], nextCursor: null,
        items: [{
          mailboxId: "mb1", uid: 7, uidValidity: "1", subject: "A provider-filed offer",
          from: { name: "Provider junk", address: "junk@provider.example.invalid" },
          date: "2026-09-16T08:40:00.000Z", messageIdHeader: "<j7@x>", seen: false, origin: "provider" as const,
        }],
      }),
      sweepPreview: () => later("sweepPreview", { mailboxes: [], movable: 0, pending: false, held: { ids: ["q1"], truncated: false } }),
    };
    const { container: el } = await mount(wire, "#/screener");
    await waitFor(() => junkButton(el) !== null, "the Screener's Junk segment");
    expect(calls.sort(), "the Screener opened and the Junk window was not read").toEqual(["list", "sweepPreview"]);
    await act(async () => { for (const r of release) r(); });
    await click(junkButton(el), "the Junk section");
    const pane = el.textContent ?? "";
    expect(pane).toContain("A provider-filed offer");
    expect(pane, "the Quarantine shelf waited on the click's own read").toContain(PEDLAR.name);
    expect(pane).not.toContain(messages.screener.junkLoading);
    expect(calls).toHaveLength(2);
  });
});

describe("the shell keeps the Junk page from its start", () => {
  const junkRow = (uid: number, subject: string) => ({
    mailboxId: "mb1", uid, uidValidity: "1", subject, from: { name: "Provider junk", address: "junk@provider.example.invalid" },
    date: "2026-09-16T08:40:00.000Z", messageIdHeader: `<j${uid}@x>`, seen: false, origin: "provider" as const,
  });
  const page = (...items: ReturnType<typeof junkRow>[]) =>
    ({ mailboxes: [{ id: "mb1", address: "me@example.invalid", window: "ok" as const }], nextCursor: null, items });
  it("opened on the Ohbox, the page is read at once; the Screener's Junk click paints it and asks nothing", async () => {
    const calls: string[] = [];
    const wire: JunkFirstPage = {
      ...JUNK_WIRE,
      list: async () => { calls.push("list"); return page(junkRow(7, "A provider-filed offer")); },
      sweepPreview: async () => { calls.push("sweepPreview"); return { mailboxes: [], movable: 0, pending: false, held: { ids: ["q1"], truncated: false } }; },
    };
    const { container: el } = await mount(wire);
    await waitFor(() => calls.length === 2, "the Junk page read from the Ohbox");
    await openScreener(el);
    await waitFor(() => junkButton(el) !== null, "the Screener's Junk segment");
    await click(junkButton(el), "the Junk section");
    const pane = el.textContent ?? "";
    expect(pane).toContain("A provider-filed offer");
    expect(pane).toContain(PEDLAR.name);
    expect(pane).not.toContain(messages.screener.junkLoading);
    expect(calls.sort()).toEqual(["list", "sweepPreview"]);
  });

  it("a letter set aside into the spam pile reads the page again after the settle; the Junk click paints it", async () => {
    const { JUNK_MOVE_SETTLE_MS } = await import("@ohmail/app-logic/screener/junk-window");
    const pages = [page(junkRow(7, "A provider-filed offer")), page(junkRow(8, "The letter just filed"), junkRow(7, "A provider-filed offer"))];
    let lists = 0;
    const wire: JunkFirstPage = { ...JUNK_WIRE, list: async () => pages[Math.min(lists++, 1)]! };
    const { container: el, fileAnother } = await mount(wire);
    await waitFor(() => lists === 1, "the Junk page read from the Ohbox");
    await fileAnother();
    await tick(JUNK_MOVE_SETTLE_MS);
    await waitFor(() => lists === 2, "the page read again after the pile changed");
    await openScreener(el);
    await waitFor(() => junkButton(el) !== null, "the Screener's Junk segment");
    await click(junkButton(el), "the Junk section");
    const pane = el.textContent ?? "";
    expect(pane).toContain("The letter just filed");
    expect(pane).not.toContain(messages.screener.junkLoading);
    await waitFor(() => lists === 3, "the entry after a move reads once behind the painted page");
  });
});

it("asks again when the same number of different letters is available to move to Junk", async () => {
  const post = vi.fn(() => Response.json({ mailboxes: [], movable: 0, pending: true }));
  let previewKey = "A".repeat(43);
  let shown = "q1";
  const preview = vi.fn(async () => ({
    mailboxes: [{ ...MAILBOX, candidates: 1, hasJunkFolder: true, pending: false }],
    movable: 1, pending: false, confirmation: previewKey, held: { ids: [shown], truncated: false },
  }));
  const { container, fileAnother } = await mount({ ...JUNK_WIRE, sweepPreview: preview }, "#/screener", post);
  await waitFor(() => junkButton(container) !== null, "the Junk segment");
  await click(junkButton(container), "the Junk segment");
  const button = () => within(container).getByRole("button", { name: messages.screener.junkSweepAction });
  const question = () => within(document.body).queryByRole("dialog", { name: messages.screener.junkSweepAction });
  await click(button(), "the first offer");
  expect(question()).not.toBeNull();
  previewKey = "B".repeat(43);
  shown = "q2";
  const asks = preview.mock.calls.length;
  await fileAnother();
  const { JUNK_MOVE_SETTLE_MS } = await import("@ohmail/app-logic/screener/junk-window");
  await tick(JUNK_MOVE_SETTLE_MS);
  await waitFor(() => preview.mock.calls.length > asks, "the replacement preview");
  expect(question()).toBeNull();
  expect(post).not.toHaveBeenCalled();

  await click(button(), "the refreshed offer");
  await click(within(question()!).getAllByRole("button").find((control) =>
    control.textContent !== messages.screener.junkSweepCancel) ?? null, "confirm the new pile");
  expect(post.mock.calls).toEqual([[`"${previewKey}"`]]);
});
