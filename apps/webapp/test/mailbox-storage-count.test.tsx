/** @vitest-environment jsdom */
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StoreRefusals } from "@ohmail/app-logic/mail-state/mail-state";
import { drawPane, fakePane, ok, row } from "../../../packages/app/test/mailboxes/pane/support.js";
import en from "../messages/en.json";

afterEach(cleanup);

const CAPPED: StoreRefusals = { count: 612, retrying: 500, exact: true };

describe("web Settings → Mailboxes says the same count", () => {
  async function rowText(storeRefusals?: StoreRefusals) {
    const mailbox = row("mb1", "person@example.invalid", {
      status: "error", errorCode: "storage", ...(storeRefusals === undefined ? {} : { storeRefusals }),
    });
    const { wire } = fakePane({ list: [ok([mailbox])] });
    const view = drawPane(wire);
    const verdict = await view.findByText(/^Sync failed/);
    const text = verdict.textContent?.replace(/^error · /, "");
    view.unmount();
    return text;
  }

  it("the counted row, and the count-less one without the field", async () => {
    expect(await rowText(CAPPED)).toContain("could not store 612 items from your account on this computer, more than Sync now can retry.");
    expect(await rowText()).toBe((en.mailboxes as Record<string, string>).err_storage);
  });
});
