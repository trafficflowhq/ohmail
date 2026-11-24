/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useOlderBodyDoor } from "@ohmail/app-logic/reader";
import type { HostWires } from "../../src/host/wires.js";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider } from "../../src/text/index.js";
import { FOLDERS_ON, LIST_WORDS, listFrame } from "../places/list-seat.js";
import { letter } from "../reader/support/mail.js";

afterEach(cleanup);

const folder = "Projects" as ReturnType<typeof letter>["folder"];
const item = letter("old-letter", { folder, subject: "An older project", snippet: "Snippet text" });

async function openOlder(olderBody: HostWires["olderBody"]) {
  const { host } = listFrame({
    letters: [],
    consent: FOLDERS_ON,
    first: "#/folder/projects",
    more: { "folder:projects": { id: "projects", name: folder, mailboxId: item.mailboxId } },
    engine: () => ({
      storeCoverage: () => ({ state: "partial" }),
      listOlderAvailable: () => true,
      listOlder: async () => ({ state: "ready", items: [item], nextCursor: null }),
      storePageRow: () => item,
    }),
  });
  render(
    <TextProvider locale="en" messages={LIST_WORDS} timeZone="Europe/Zurich">
      <Frame host={{ ...host, wires: { ...host.wires, olderBody } }} />
    </TextProvider>,
  );
  fireEvent.click(await screen.findByRole("option", { name: /An older project/ }));
}

it("loads the off-mirror body only on open and retries one failed read", async () => {
  const body = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue({
    kind: "ok",
    text: "The full older letter",
    html: null,
    withheld: null,
    loadedRemoteContent: false,
    unsubscribe: "no_header",
    unsubscribeUrl: null,
  });
  await openOlder({ body });
  const tryAgain = await screen.findByRole("button", { name: "Try again" });
  expect(body.mock.calls).toEqual([["old-letter"]]);
  fireEvent.click(tryAgain);
  expect(await screen.findByText("The full older letter")).toBeTruthy();
  expect(body.mock.calls).toEqual([["old-letter"], ["old-letter"]]);
});

it("renders a gone body as terminal and offers no retry", async () => {
  const body = vi.fn(async () => ({ kind: "gone" as const }));
  await openOlder({ body });
  await waitFor(() => expect(body.mock.calls.length).toBe(1));
  await waitFor(() => expect(document.body.textContent?.includes("Gone from your mail server")).toBe(true));
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("keeps a failing open single-flight and refuses a retry after ownership changes", async () => {
  let mayRead = true;
  let refuse!: () => void;
  const body = vi.fn(
    () =>
      new Promise<never>((_, reject) => {
        refuse = () => reject(new Error("unavailable"));
      }),
  );
  const { result } = renderHook(() => useOlderBodyDoor({ body }, () => mayRead));
  const row = { id: "old-letter", snippet: "Snippet text" };
  act(() => {
    result.current.open(row.id);
    result.current.open(row.id);
  });
  expect(body.mock.calls).toEqual([[row.id]]);
  await act(async () => refuse());
  expect(result.current.bodyFor(row).state).toBe("failed");
  mayRead = false;
  await act(async () => result.current.open(row.id, { retry: true }));
  expect(body.mock.calls).toEqual([[row.id]]);
  expect(result.current.bodyFor(row).state).toBe("failed");
});
