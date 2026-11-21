/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import phone from "../../messages/phone.en.json" with { type: "json" };
import {
  DiagnosticFileSheet,
  type DiagnosticFileActions,
} from "../../src/phone-settings/on-this-phone/DiagnosticFileSheet.js";
import { TextProvider } from "../../src/text/index.js";

const filename = "diagnostic-example.json";

function draw(actions: DiagnosticFileActions) {
  render(
    <TextProvider locale="en" messages={phone as never} timeZone="UTC">
      <DiagnosticFileSheet actions={actions} />
    </TextProvider>,
  );
}

const writeFile = () => screen.getByRole<HTMLButtonElement>("button", { name: /^Write file/ });
const shareFile = () => screen.getByRole<HTMLButtonElement>("button", { name: /^Share file/ });

afterEach(cleanup);

it("writes before offering to share and waits for an explicit share press", async () => {
  let confirm!: (name: string) => void;
  const write = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        confirm = resolve;
      }),
  );
  const share = vi.fn(async () => true);
  draw({ write, share });

  expect(screen.queryByRole("button", { name: /^Share file/ })).toBeNull();
  fireEvent.click(writeFile());
  const writing = screen.getByRole<HTMLButtonElement>("button", { name: /^Writing/ });
  expect(writing.disabled).toBe(true);
  fireEvent.click(writing);
  expect(write).toHaveBeenCalledTimes(1);
  expect(share).not.toHaveBeenCalled();

  confirm(filename);
  await screen.findByText(new RegExp(filename));
  expect(share).not.toHaveBeenCalled();
  fireEvent.click(shareFile());
  await waitFor(() => expect(shareFile().disabled).toBe(false));
  expect(write).toHaveBeenCalledTimes(1);
  expect(share.mock.calls).toEqual([[]]);
});

it("keeps sharing closed after a failed write and lets the person write again", async () => {
  const write = vi
    .fn<DiagnosticFileActions["write"]>()
    .mockRejectedValueOnce(new Error("disk unavailable"))
    .mockResolvedValueOnce(filename);
  const share = vi.fn(async () => true);
  draw({ write, share });

  fireEvent.click(writeFile());
  await screen.findByText(/The file could not be written/);
  expect(screen.queryByRole("button", { name: /^Share file/ })).toBeNull();
  fireEvent.click(writeFile());
  await screen.findByText(new RegExp(filename));
  expect(share).not.toHaveBeenCalled();
});

it("retries a refused share from the file already written", async () => {
  const write = vi.fn(async () => filename);
  const share = vi
    .fn<DiagnosticFileActions["share"]>()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  draw({ write, share });

  fireEvent.click(writeFile());
  await screen.findByText(new RegExp(filename));
  fireEvent.click(shareFile());
  await screen.findByText(/could not open the share sheet/);
  fireEvent.click(shareFile());
  await screen.findByText(new RegExp(filename));

  expect(write).toHaveBeenCalledTimes(1);
  expect(share.mock.calls).toEqual([[], []]);
});
