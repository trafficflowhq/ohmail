/** @vitest-environment jsdom */
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageBodyRecord } from "@ohmail/wire";
import { qhFixtures, qhNorm } from "../../../packages/client-engine/test/quoted-history-fixtures.js";
import { message, mountShell, storeWith, stubDom, unmountAll } from "./_draft-shell.js";

const textOf = (el: Element): string => qhNorm(el.textContent ?? "");
const srcdocText = (el: Element): string => {
  const doc = el.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  return qhNorm(new DOMParser().parseFromString(doc, "text/html").body.textContent ?? "");
};

afterEach(unmountAll);

describe("a Reads or Receipts stream card reads the message's subject too", () => {
  it("an Outlook FW: shows the letter it forwards; the hop below it folds", async () => {
    const fx = qhFixtures().find((fixture) => fixture.id === "125")!;
    for (const [route, name, folder] of [
      ["#/reads", "News", "ohmail/News"],
      ["#/receipts", "Receipts", "ohmail/Receipts"],
    ] as const) {
      stubDom();
      const letter = message("m1", { subject: fx.subject, folder });
      const store = await storeWith([letter], []);
      await store.putLocal("message_body", letter.id, {
        messageId: letter.id, state: "ready", text: fx.text, html: fx.html, loadedRemoteContent: false,
      } satisfies MessageBodyRecord);
      const { el } = await mountShell(route, [letter], [], { store });
      const stream = within(el).getByRole("region", { name: `${name} stream` });
      await act(async () => { fireEvent.click(within(stream).getByRole("button", { name: "Expand" })); });
      const shown = () => textOf(stream) + srcdocText(stream);
      expect(shown(), "the forwarded letter is on screen").toContain("we can load the second truck on Thursday");
      expect(shown()).not.toContain("can you take a second truck in the week of 9 November?");
      const history = within(stream).getByRole("button", { name: /show history/i });
      await act(async () => { fireEvent.click(history); });
      expect(shown()).toContain("can you take a second truck in the week of 9 November?");
      await unmountAll();
    }
  });
});
