/** @vitest-environment jsdom */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailReader } from "@ohmail/app/mail";
import { NONE } from "@ohmail/app/host";
import { letterBody } from "@ohmail/app/reader/body";
import type { MessageBodyRecord } from "@ohmail/wire";
import { message, mountShell, press, storeWith, stubDom, unmountAll } from "./_draft-shell.js";

beforeEach(() => {
  stubDom();
  localStorage.clear();
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({
    ...matchMedia(query),
    matches: query === "(prefers-color-scheme: dark)",
  });
});
afterEach(unmountAll);

async function heldLetter(html: string | null) {
  const letter = message("held", { folder: "ohmail/Screened", subject: "Held letter" });
  const store = await storeWith([letter], []);
  const body: MessageBodyRecord = {
    messageId: letter.id, state: "ready", text: "Original body", html,
    withheld: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
  };
  await store.putLocal("message_body", letter.id, body);
  await mountShell("#/screener/screened", [letter], [], { store, reader: mailReader({ body: letterBody, look: NONE }) });
  const reading = within(await screen.findByRole("region", { name: "Reading" }));
  await reading.findByRole("heading", { name: "Held letter" });
  return reading;
}

describe("the held letter's views", () => {
  it("offers the original colours and lets the reader adapt them again", async () => {
    const reading = await heldLetter('<table width="600" bgcolor="#ffffff" cellpadding="0"><tr><td><h1>Designed</h1><p>Original body</p></td></tr></table>');
    const original = await reading.findByRole("button", { name: "Original" });
    await press(original, "show original colours");
    const adapt = await reading.findByRole("button", { name: "Adapt to dark" });
    await press(adapt, "adapt to dark");
    await reading.findByRole("button", { name: "Original" });
  });

  it("offers no view controls for a plain text letter", async () => {
    const reading = await heldLetter(null);
    await reading.findByText("Original body");
    expect(reading.queryByRole("group", { name: "How this letter is shown" })).toBeNull();
    expect(reading.queryByRole("button", { name: "Original" })).toBeNull();
  });
});
