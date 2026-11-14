/** @vitest-environment jsdom */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { JUNK_REFILL_BOUND_MS } from "@ohmail/client-engine";
import { expect, it, onTestFinished, vi } from "vitest";
import reader from "../../../packages/app/messages/reader.en.json";
import { fakeMail } from "../../../packages/app/test/reader/support/mail.js";
import { issue, receipt } from "../../../packages/app/test/streams/registered-world.js";
import { mountCheckedStream } from "./stream-check-frame.js";

async function mountRefill(route: string, name: string, make: typeof issue) {
  const id = "returning";
  const mail = fakeMail([make(id, 12, { body: undefined })]);
  const mirror = mail.engine.read();
  const read = mirror.get;
  let body: unknown = { state: "ready", text: "", html: null, withheld: "junk_filed" };
  mirror.get = <T,>(type: string, key: string) =>
    type === "message_body" && key === id ? body as T : read<T>(type, key);
  await mountCheckedStream(mail.engine, `#/${route}`);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => { vi.useRealTimers(); });
  const stream = within(screen.getByRole("region", { name: `${name} stream` }));
  fireEvent.click(stream.getByRole("button", { name: "Expand" }));
  const replace = (state?: string) => act(() => {
    body = state === undefined ? undefined : { state };
    mail.patch(id, {});
  });
  return { stream, replace, asks: mail.bodyAsks };
}

for (const [route, name, make] of [
  ["reads", "News", issue],
  ["receipts", "Receipts", receipt],
] as const) {
  it(`${name} re-asks once when the body becomes available to fetch again`, async () => {
    const { stream, replace, asks } = await mountRefill(route, name, make);
    expect(stream.getByText(reader.body.withheldJunkLoading)).toBeTruthy();
    expect(asks).toEqual([]);
    replace();
    expect(asks).toEqual(["returning"]);
    replace("loading");
    expect(asks).toEqual(["returning"]);
  });

  it(`${name} reports failure when the Junk refill reaches its bound`, async () => {
    const { stream, asks } = await mountRefill(route, name, make);
    expect(stream.getByText(reader.body.withheldJunkLoading)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(JUNK_REFILL_BOUND_MS + 1); });
    expect(stream.queryByText(reader.body.withheldJunkLoading)).toBeNull();
    expect(stream.getByText(reader.body.failed)).toBeTruthy();
    expect(asks).toEqual([]);
  });
}
