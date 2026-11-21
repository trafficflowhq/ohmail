/** @vitest-environment jsdom */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { JUNK_REFILL_BOUND_MS } from "@ohmail/client-engine";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import messages from "../../../packages/app/messages/reader.en.json";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { receipt } from "../../../packages/app/test/streams/registered-world.js";
import { mountCheckedStream } from "./stream-check-frame.js";

async function card() {
  const mail = fakeMail([receipt("m1", 12, { body: undefined })]);
  const mirror = mail.engine.read();
  const get = mirror.get;
  let body: unknown = { state: "ready", text: "", html: null, withheld: "junk_filed" };
  mirror.get = <T,>(type: string, id: string) =>
    type === "message_body" && id === "m1" ? body as T : get<T>(type, id);
  await mountCheckedStream(mail.engine, "#/receipts");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => { vi.useRealTimers(); });
  const host = screen.getByRole("region", { name: "Receipts stream" });
  fireEvent.click(within(host).getByRole("button", { name: "Expand" }));
  let shed = false;
  const draw = (_state: "loading") => act(() => {
    body = shed ? { state: "loading" } : undefined;
    shed = true;
    mail.patch("m1", {});
  });
  return { host, draw, asked: mail.bodyAsks };
}

describe("a stream card over a husk moved out of Junk", () => {
  it("asks for the body again once the husk sheds, and only once", async () => {
    const { host, draw, asked } = await card();
    expect(host.textContent).toContain(messages.body.withheldJunkLoading);
    expect(asked).toEqual([]);
    await draw("loading");
    expect(asked, "the shed husk was never asked for again").toEqual(["m1"]);
    await draw("loading");
    expect(asked).toEqual(["m1"]);
  });

  it("past the bound it says the text could not be read", async () => {
    const { host } = await card();
    expect(host.textContent).toContain(messages.body.withheldJunkLoading);
    act(() => { vi.advanceTimersByTime(JUNK_REFILL_BOUND_MS + 1); });
    expect(host.textContent).toContain(messages.body.failed);
    expect(host.textContent).not.toContain(messages.body.withheldJunkLoading);
  });
});
