/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { COPY } from "../../../../packages/letter-body/src/MessageBody.js";
import { message, mountShell, press, stubDom, unmountAll, waitFor } from "../_draft-shell.js";
import {
  ACCOUNT, ISO, installConfirmEnv, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "../fixtures/cloud-confirm-shell.js";

beforeAll(warmCloudShell, 120_000);

describe("the note on News and Receipts", () => {
  it("News asks its pile, states the server's number, and moves nothing until the press", async () => {
    const live = await import("../fixtures/live-walk-shell.js");
    const { createEngine } = await import("../../app/shell/engine-config.js");
    const calls: Array<{ method: string; url: string; body: string | null }> = [];
    let total = 3;
    live.installShellEnv();
    try {
      const otherDoors = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.includes("/api/screener/unscreened")) return otherDoors(input, init);
        const method = init?.method ?? "GET";
        calls.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
        if (method === "POST") {
          const screened = total;
          total = 0;
          return Response.json({ screened: [], total: screened });
        }
        return Response.json({
          groups: total > 0 ? [{ address: "paper@example.invalid", count: total, newestAt: ISO }] : [],
          total, complete: true, max: 200, pile: "news",
        });
      };
      await live.mountShell([live.mailbox({ lastSyncAt: live.ISO })], {
        engine: createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" }),
      });
      await live.tick(30_000);
      await act(async () => { window.location.hash = "#/reads"; window.dispatchEvent(new Event("hashchange")); });
      await live.tick(1_000);
      const note = () => [...document.querySelectorAll<HTMLElement>('[role="note"]')]
        .find(n => n.textContent?.includes("you haven't screened yet")) ?? null;
      const posts = () => calls.filter(c => c.method === "POST");
      expect(calls.map(c => `${c.method} ${c.url}`)).toContain("GET /api/screener/unscreened?pile=news");
      expect(note()?.textContent).toBe("3 letters in News come from senders you haven't screened yet Screen sends them to the Screener, where you decide once per sender. Nothing is deleted.Screen 3Not now");
      expect(posts(), "a READ moved somebody's mail").toEqual([]);

      await act(async () => { note()!.querySelector("button")!.click(); });
      await live.tick(50);
      expect(posts().map(c => [c.url, JSON.parse(c.body ?? "null")])).toEqual([["/api/screener/unscreened", { pile: "news" }]]);
      const reports = [...document.querySelectorAll('.fr-report [role="status"][data-kind="detail"]')];
      expect(reports.map(report => report.querySelector("b")?.textContent)).toEqual(["Screened 3"]);
      expect(reports.map(report => report.textContent)).toEqual([
        "Screened 3 Cloud moves them the next time it checks this mailbox.",
      ]);
      expect(note(), "the note outlived the press it answered").toBeNull();
    } finally {
      await live.teardownShellEnv();
    }
  });
});

describe("the card being read carries the message's verbs", () => {
  it("dispatches the shell's action, for the message the bar is on", async () => {
    stubDom();
    try {
      const pile = ["one", "two"].map(id => message(id, { folder: "ohmail/News" }));
      const shell = await mountShell("#/reads", pile);
      const card = shell.el.querySelector<HTMLElement>('[data-stream-item="one"]');
      expect(card, "the registered stream shows the letter").not.toBeNull();
      await press(card, "the first News card");
      const bar = shell.el.querySelector<HTMLElement>('.fr-reading [role="toolbar"][aria-label="Actions"]');
      expect(bar, "the selected card's actions").not.toBeNull();
      const later = within(bar!).getByRole("button", { name: "Later" });
      await press(later, "Later on the selected card");
      const writes = () => shell.sent.filter(m => m.kind === "triage_set");
      await waitFor(() => writes().length > 0, "the letter's Later command reaches the engine");
      expect(writes()).toEqual([{ kind: "triage_set", messageId: "one", state: "reply_later" }]);
    } finally {
      await unmountAll();
    }
  });
});

describe("the seams", () => {
  it("\"Show images\" keeps its place above the body, without the box and without the sentence", async () => {
    const { resetStorageOwnerForTest } = await import("@ohmail/app-logic/storage/storage-owner");
    const { resetSessionTruthForTests } = await import("@ohmail/app-logic/session/session-truth");
    const sender = "images.newsletter.example";
    const pictures = `<table width="600"><tr><td><p>hello</p><img src="https://${sender}/hero-1.png" width="600" height="200"><img src="https://${sender}/hero-2.png" width="600" height="200"></td></tr></table>`;
    resetSessionTruthForTests();
    installConfirmEnv();
    resetStorageOwnerForTest();
    try {
      window.localStorage.clear();
      rememberOwner();
      scriptRefresh(refresh204);
      scriptSession(() => sessionFull());
      const letter = message("notice-news", { accountId: ACCOUNT, mailboxId: "mb_1", folder: "ohmail/News" });
      scriptSync(() => Response.json({ changes: {
        creates: [{ type: "message", op: "create", id: letter.id, seq: 1, updatedAt: ISO, entity: letter }],
        updates: [], moves: [], deletes: [],
      }, cursor: "c1", hasMore: false, serverTime: ISO }));
      const inner = globalThis.fetch;
      const asked: string[] = [];
      const accountJson = (body: unknown) => Response.json(body, { headers: { "X-Ohmail-Account": ACCOUNT } });
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname.endsWith("/load-remote") || url.pathname === "/api/img" || url.host === sender) {
          asked.push(url.pathname);
          return accountJson({});
        }
        if (url.pathname === "/api/hello") {
          return Response.json({ product: "ohmail", flavor: "selfhost", needsSetup: false, features: { pairing: false, remoteImages: true } });
        }
        if (url.pathname === "/api/consent") {
          const consent = await (await inner(input, init)).json();
          return accountJson({ ...consent, foldersEnabledAt: ISO, blockRemoteImagesAt: ISO });
        }
        if (url.pathname === "/api/mailboxes") {
          return accountJson({ items: [{ id: letter.mailboxId, address: letter.from.address,
            displayName: "Fixture", lastSyncAt: ISO, syncBlockedReason: null, createdAt: ISO }] });
        }
        if (url.pathname === `/api/messages/${letter.id}/body`) {
          return accountJson({ text: "Two pictures", html: pictures, loadedRemoteContent: false });
        }
        return inner(input, init);
      };
      window.location.hash = "#/reads";
      await mountCloudShell();
      await tick(2_500);
      const card = document.querySelector<HTMLElement>('[data-stream-item="notice-news"]')!;
      expect(card, "the News card stands in its pile").not.toBeNull();
      await act(async () => { card.querySelector<HTMLButtonElement>(".oh-message-more button")!.click(); });
      await tick(1_000);
      expect(card.querySelector(".oh-blocked")?.textContent).toBe(COPY.imagesCaption);
      const bar = card.querySelector<HTMLElement>(".oh-letterviews");
      expect(card.querySelector(".mb-bar"), "the sender’s blocked pictures must not add a boxed sentence").toBeNull();
      expect(bar, "the button lost its row").not.toBeNull();
      const button = [...bar!.querySelectorAll("button")].find(b => b.textContent === COPY.show);
      expect(button, "Show images is gone").toBeTruthy();
      expect(button!.dataset.kind, "the controls row is still boxed").toBe("quiet");
      expect(bar!.getAttribute("role")).toBe("group");
      expect(bar!.closest('[role="status"], [role="alert"], [aria-live]'), "a row of controls is not a live region").toBeNull();
      expect(bar!.querySelector(".mb-bar-text, .oh-blocked-said")).toBeNull();
      expect(bar!.querySelector(".mb-bar-icon")).toBeNull();
      expect(card.querySelector(".oh-blocked")?.getAttribute("aria-expanded")).toBe("false");
      expect(bar!.compareDocumentPosition(card.querySelector(".mb")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(asked, "the pictures were fetched before anybody pressed Show images").toEqual([]);
      await act(async () => { button!.click(); });
      await tick(1_000);
      expect(asked).toEqual([`/api/messages/${letter.id}/load-remote`]);
    } finally {
      window.history.replaceState(null, "", "/");
      resetStorageOwnerForTest();
      await teardownConfirmEnv();
    }
  });
});
