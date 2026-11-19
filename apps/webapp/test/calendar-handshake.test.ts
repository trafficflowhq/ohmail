/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { serverHello } from "../app/hello";
import { useServerWords } from "../app/server-words";

vi.mock("../app/hello", () => ({ serverHello: vi.fn() }));
const hello = vi.mocked(serverHello);

afterEach(() => {
  cleanup();
  hello.mockReset();
});

async function online() {
  await act(async () => { window.dispatchEvent(new Event("online")); });
}

it("keeps an incoming Calendar link pending while the handshake can still answer", async () => {
  hello.mockResolvedValueOnce(null).mockResolvedValueOnce({
    product: "ohmail", flavor: "selfhost", needsSetup: false,
    features: { staging: true, ai: false, pairing: true, calendar: true },
  });
  const page = renderHook(() => useServerWords(false));
  await act(async () => { await Promise.resolve(); });
  expect(hello).toHaveBeenCalledTimes(1);
  expect(page.result.current.calendar).toBeNull();
  await online();
  expect(page.result.current.calendar).toBe(true);
});

it("settles an unanswered Calendar link when the last handshake retry ends", async () => {
  hello.mockResolvedValue(null);
  const page = renderHook(() => useServerWords(false));
  await act(async () => { await Promise.resolve(); });
  expect(hello).toHaveBeenCalledTimes(1);
  for (let count = 0; count < 3; count += 1) {
    expect(page.result.current.calendar).toBeNull();
    await online();
  }
  expect(page.result.current.calendar).toBe(false);
});
