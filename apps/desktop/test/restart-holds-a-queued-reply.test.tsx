/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMutation } from "@ohmail/wire";
import { MutationRejectedError, OhmailEngine } from "@ohmail/client-engine";
import { announceUpdate, resetUpdateStoreForTests, restartHold } from "@ohmail/app-logic/doors/app-update";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh,
  scriptSession, sessionFull, scriptSync, syncPage, teardownConfirmEnv, tick,
} from "../../webapp/test/fixtures/cloud-confirm-shell";
import en from "../../webapp/messages/en.json";
import { message, ROSTER, storeWith } from "../../webapp/test/_draft-shell";
import { typeInto } from "../../webapp/test/fixtures/rich-editor-driver";
import { EngineProvider } from "../../webapp/app/shell/engine";
import { DesktopFrame, type DesktopFrameProps } from "../src/DesktopFrame";
import { DesktopLocale } from "../src/DesktopLocale";
import { linkSlot } from "../src/link-in";

vi.mock("../src/local-mailbox-facts", async (load) => ({
  ...await load<typeof import("../src/local-mailbox-facts")>(),
  readMailboxFacts: async () => ROSTER,
}));

const BODY = "A reply that is still waiting";
const noChange = () => undefined;

async function sendReply(subject: string): Promise<void> {
  await tick(2500);
  await act(async () => void fireEvent.click(screen.getByRole("option", { name: new RegExp(subject) })));
  await tick(250);
  const reader = within(screen.getByRole("region", { name: "Open message" }));
  await act(async () => void fireEvent.click(reader.getByRole("button", { name: "Reply" })));
  await tick(250);
  await act(async () => typeInto(reader.getByRole("textbox", { name: "Reply body" }), BODY));
  await act(async () => void fireEvent.click(reader.getByRole("button", { name: "Send" })));
  await tick(1500);
}

async function expectRestartHeld(): Promise<void> {
  expect(restartHold()).toBe("send");
  const restart = vi.fn();
  await act(async () => announceUpdate({ kind: "ready", key: "ready:2.0.1", version: "2.0.1", act: restart }));
  expect(screen.getByText(en.update.lineAfterSend)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  expect(restart).not.toHaveBeenCalled();
}

beforeEach(() => {
  installConfirmEnv();
  resetUpdateStoreForTests();
  localStorage.clear();
  window.location.hash = "#/ohbox";
});

afterEach(async () => {
  cleanup();
  await teardownConfirmEnv();
  resetUpdateStoreForTests();
});

describe("a reply still on the outbox holds Restart", () => {
  it("in a signed-in browser, a send waiting for its server holds the offered restart", async () => {
    const subject = "Web reply for the restart check";
    scriptSession(sessionFull);
    scriptRefresh(refresh204);
    scriptSync(() => syncPage(subject));
    rememberOwner();
    const wire = globalThis.fetch;
    const drafts: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path.endsWith("/mailboxes")) return Response.json({ items: [{ ...ROSTER[0], id: "mb_1" }] });
      if (/messages\/[^/]+\/body$/.test(path)) return Response.json({ text: "Original", html: null });
      if (path.endsWith("/drafts") && init?.method === "POST") {
        drafts.push(JSON.parse(String(init.body)));
        throw new TypeError("Failed to fetch");
      }
      if (path.endsWith("/send")) throw new Error("A reply without a server draft cannot be sent");
      return wire(input, init);
    }) as typeof fetch;
    await mountCloudShell();
    await sendReply(subject);
    expect(JSON.stringify(drafts)).toContain(BODY);
    expect(screen.queryAllByText(en.reply.statusQueued).length).toBeGreaterThan(0);
    await expectRestartHeld();
  });

  it("in the desktop frame, a send waiting for its server holds the offered restart", async () => {
    const original = message("m1");
    const attempts: EngineMutation[] = [];
    const engine = new OhmailEngine({
      store: await storeWith([original], []),
      adapter: {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: ISO,
        }),
        fetchBody: async () => ({
          text: "Original", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
        }),
        withdrawSend: async () => ({ outcome: "unreachable" }),
        mutate: async (change: EngineMutation) => {
          if (change.kind !== "mail_send") return { changes: [], seq: null };
          attempts.push(change);
          throw new MutationRejectedError("No connection", { code: "network", retryable: true });
        },
      },
    });
    const props: DesktopFrameProps = {
      engine, status: { state: "serving", mode: "local" }, session: "live", sessionRefused: false,
      sealFailed: false, paired: false, hostLabel: null, freshness: null, account: null, storage: null,
      mayLinkOut: false, manageOffered: false, withdrawManage: noChange, rereadAccess: noChange,
      reuseSweeps: [], recheckSweeps: async () => undefined, ai: null, setAi: noChange, onStatus: noChange,
      openOverlay: noChange, takeOver: noChange, firstRunOpen: false, firstRun: undefined, takesMailLinks: true,
      scope: "restart-hold-desktop", onUnread: noChange,
      liveBody: async () => ({ kind: "loaded", text: "Original", html: null }),
      links: linkSlot(), connection: { read: () => null, subscribe: () => noChange },
    };
    await act(async () => void render(
      <DesktopLocale><ThemeProvider><ToastHost>
        <EngineProvider demo={false} engine={engine}><DesktopFrame {...props} /></EngineProvider>
      </ToastHost></ThemeProvider></DesktopLocale>,
    ));
    await sendReply(original.subject);
    expect(screen.queryByRole("button", { name: en.rail.getDesktopOpen })).toBeNull();
    expect(attempts).toContainEqual(expect.objectContaining({ kind: "mail_send", inReplyTo: original.id, body: BODY }));
    expect(engine.waitingSends()).toContainEqual(expect.objectContaining({ wire: false }));
    await expectRestartHeld();
  });
});
