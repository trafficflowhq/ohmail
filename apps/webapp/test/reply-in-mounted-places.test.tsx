/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, message, mountShell, NOW, press, stubDom, unmountAll, waitFor } from "./_draft-shell.js";
import { typeInto } from "./fixtures/rich-editor-driver";

beforeEach(() => stubDom());
afterEach(unmountAll);

async function newsReply() {
  const { el } = await mountShell("#/reads", [
    message("workshop", { folder: "ohmail/News", subject: "Workshop notes" }),
  ]);
  const queries = within(el);
  const news = queries.getByRole("region", { name: "News stream" });
  await press(within(news).getByRole("heading", { name: "Workshop notes" }), "the News letter");
  await press(within(news).getByRole("button", { name: "Reply" }), "Reply to the News letter");
  const reply = () => within(news).queryByRole("textbox", { name: "Reply body" });
  await waitFor(() => reply() !== null, "the reply editor inside News");
  expect(queries.queryByRole("region", { name: "Open message" })).toBeNull();
  return { surface: reply()!, actions: within(news).getByRole("toolbar", { name: "Actions" }) };
}

async function typeReply(surface: HTMLElement) {
  for (const text of ["T", "Th", "Tha", "Than", "Thanks"]) {
    await act(async () => { typeInto(surface, text); });
  }
  expect(surface.textContent).toBe("Thanks");
}

describe("a reply in a mounted place", () => {
  it("typing in place changes nothing on the page outside the editor", async () => {
    const { surface, actions } = await newsReply();
    // The reply owns its fields and its action panel. The Send control is enabled by the first words.
    const composer = surface.closest(".oh-composer")!;
    expect(composer).not.toBeNull();
    const send = within(actions).getByRole("button", { name: "Send" });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    const outside = () => document.body.innerHTML.replace(composer.outerHTML, "").replace(actions.outerHTML, "");
    let last = outside();
    for (let quiet = 0; quiet < 3;) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
      const now = outside();
      quiet = now === last ? quiet + 1 : 0;
      last = now;
    }
    await typeReply(surface);
    expect(send.getAttribute("aria-disabled")).toBeNull();
    expect(outside(), "the page outside the editor changed while typing").toBe(last);
  }, 20_000);

  it("typing the reply in place in Reads never puts the reading mark on <body>", async () => {
    const changes: MutationRecord[] = [];
    const watch = new MutationObserver((records) => changes.push(...records));
    watch.observe(document.body, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    try {
      const { surface } = await newsReply();
      changes.push(...watch.takeRecords());
      expect(changes.some((change) => change.oldValue?.split(/\s+/).includes("reading"))).toBe(false);
      expect(document.body.classList.contains("reading")).toBe(false);
      changes.length = 0;
      await typeReply(surface);
      changes.push(...watch.takeRecords());
      expect(changes, "the body's class churned while typing").toHaveLength(0);
      expect(document.body.classList.contains("reading")).toBe(false);
    } finally {
      watch.disconnect();
    }
  }, 20_000);

  it("inside Triage: `r` opens the editor in the reading column", async () => {
    const id = "answer-this";
    const at = NOW.toISOString();
    const { el } = await mountShell(`#/triage/m/${id}`, [
      message(id, {
        subject: "Notes to answer",
        triage: { messageId: id, state: "reply_later", bubbleUpAt: null, setAt: at, updatedAt: at },
      }),
    ]);
    const queries = within(el);
    const reader = () => queries.queryByRole("region", { name: "Open message" });
    await waitFor(() => reader() !== null, "the Answer Later reader");
    expect(within(reader()!).getByRole("heading", { name: "Notes to answer" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(within(reader()!).getByRole("button", { name: "Reply" }), { key: "r" });
    });
    await waitFor(
      () => within(reader()!).queryByRole("textbox", { name: "Reply body" }) !== null,
      "the reply editor in Answer Later",
    );
  }, 20_000);
});
