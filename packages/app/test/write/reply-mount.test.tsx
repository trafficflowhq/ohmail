/** @vitest-environment jsdom */
/**
 * THE READER'S REPLY SLOT: where the shell hands `write`'s reply, the reader draws its sheet after the conversation's
 * last letter, and Reply, Reply all and Forward (the key, the action panel, a letter's own menu) open it before
 * anything else: no linked draft is handed to the place `write` and nothing is sent. Where the shell hands `none`,
 * the reader keeps its own line (held by the reader's keys case).
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PanelVerb } from "@ohmail/ui/mail";
import type { ReaderReply } from "../../src/reader/ports.js";
import { letter, mountReader } from "../reader/support/mail.js";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

/** The open reply's verbs as `write` hands them: null while no reply stands. */
function verbsStore() {
  let verbs: readonly PanelVerb[] | null = null;
  const told = new Set<() => void>();
  return {
    set(next: readonly PanelVerb[] | null) {
      verbs = next;
      for (const tell of told) tell();
    },
    use: () =>
      useSyncExternalStore(
        (tell) => {
          told.add(tell);
          return () => told.delete(tell);
        },
        () => verbs,
      ),
  };
}

function replyDouble(): { reply: ReaderReply; opened: string[]; verbs: ReturnType<typeof verbsStore> } {
  const opened: string[] = [];
  const verbs = verbsStore();
  return {
    opened,
    verbs,
    reply: {
      Sheet: ({ letters }) => <section aria-label="the reply">{letters.join(" ")}</section>,
      useOpen: () => (messageId, how) => void opened.push(`${how} ${messageId}`),
      useVerbs: verbs.use,
    },
  };
}

describe("write's reply in the reader", () => {
  it("draws the reply's sheet after the conversation's last letter, with its letters", () => {
    const { reply } = replyDouble();
    const thread = { threadId: "t1" };
    mountReader({
      letters: [
        letter("m1", { ...thread, date: "2026-11-10T09:00:00.000Z" }),
        letter("m2", { ...thread, date: "2026-11-10T10:00:00.000Z" }),
      ],
      open: "m2",
      parts: { reply },
    });
    const sheet = screen.getByRole("region", { name: "the reply" });
    expect(sheet.textContent).toBe("m1 m2");
    const letters = [...document.querySelectorAll("article")];
    expect(letters.length).toBeGreaterThan(0);
    expect(letters.at(-1)!.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("r opens the reply on the open letter; nothing goes to the place write and nothing is sent", () => {
    const { reply, opened } = replyDouble();
    const { mail, address } = mountReader({ letters: [letter("m1")], open: "m1", parts: { reply } });
    act(() => {
      fireEvent.keyDown(document.body, { key: "r" });
    });
    expect(opened).toEqual(["reply m1"]);
    expect(address.read()).toBe("#/ohbox/m/m1");
    expect(mail.mutations).toEqual([]);
  });

  it("the panel's Forward opens the reply's forward", () => {
    const { reply, opened } = replyDouble();
    mountReader({ letters: [letter("m1")], open: "m1", parts: { reply } });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    });
    expect(opened).toEqual(["forward m1"]);
  });

  it("a letter's own menu opens the reply's Reply all and Forward on that letter; nothing goes to the place write", () => {
    const { reply, opened } = replyDouble();
    const { mail, address } = mountReader({
      letters: [letter("m1", { cc: [{ name: "Ada", address: "ada@kiln.example" }] })],
      open: "m1",
      parts: { reply },
    });
    for (const how of ["Reply all", "Forward"]) {
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Message" }));
      });
      act(() => {
        fireEvent.click(screen.getByRole("menuitem", { name: how }));
      });
    }
    expect(opened).toEqual(["reply_all m1", "forward m1"]);
    expect(address.read()).toBe("#/ohbox/m/m1");
    expect(mail.mutations).toEqual([]);
  });

  it("an open reply's verbs stand in the letter's panel; given back, the keyboard is on the letter's Reply", () => {
    const { reply, verbs } = replyDouble();
    mountReader({ letters: [letter("m1")], open: "m1", parts: { reply } });
    const sent: string[] = [];
    act(() =>
      verbs.set([
        { id: "send", label: "Send", kind: "ink", onPress: () => void sent.push("send") },
        { id: "discard", label: "Discard", onPress: () => verbs.set(null) },
      ]),
    );
    expect(screen.queryByRole("button", { name: "Forward" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sent).toEqual(["send"]);
    const discard = screen.getByRole("button", { name: "Discard" });
    discard.focus();
    act(() => {
      fireEvent.click(discard);
    });
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByRole("button", { name: "Forward" })).toBeTruthy();
    const at = document.activeElement as HTMLElement;
    expect({ role: at.tagName, name: at.getAttribute("aria-label") }).toEqual({
      role: "BUTTON",
      name: "Reply",
    });
    expect(at.closest("[data-read-stop]")).not.toBeNull();
  });

  it("a press elsewhere that closed the reply keeps the keyboard where it went", () => {
    const { reply, verbs } = replyDouble();
    mountReader({ letters: [letter("m1")], open: "m1", parts: { reply } });
    act(() => verbs.set([{ id: "send", label: "Send", kind: "ink" }]));
    const forward = document.createElement("button");
    document.body.append(forward);
    forward.focus();
    act(() => verbs.set(null));
    expect(document.activeElement).toBe(forward);
    forward.remove();
  });
});
