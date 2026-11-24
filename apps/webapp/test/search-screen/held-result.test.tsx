/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

beforeEach(() => {
  stubDom();
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

it("an older Screener hit opens that held letter within Search", async () => {
  const common = {folder:"ohmail/Screener", unread:true} as const;
  const before = message("found-earlier", {...common, subject:"Unique ceramic invoice", date:"2026-09-25T08:00:00Z"});
  const after = message("newest", {...common,subject:"A different newer subject", date:"2026-09-27T08:00:00Z"});
  await mountShell("#/search",[before,after]);
  const field = await screen.findByRole("textbox", { name: "Search" });
  await act(async () => { fireEvent.change(field, {target: {value:"ceramic"}}); });
  const row = () => document.querySelector<HTMLElement>('[data-hit="found-earlier"]');
  await waitFor(() => row() !== null, "the older held letter in Search");
  await act(async () => { within(row()!).getAllByRole("button")[0]!.click(); });
  await waitFor(() => window.location.hash === "#/search/m/found-earlier?q=ceramic", "the held result in Search");
  const reading = screen.getByRole("region", { name: "Reading" });
  expect(reading.querySelector('[data-conv-id="found-earlier"]')).not.toBeNull();
  expect(reading.querySelector('[data-conv-id="newest"]')).toBeNull();
  expect(row()?.querySelector(".oh-row[data-open]")).not.toBeNull();
}, 60_000);
