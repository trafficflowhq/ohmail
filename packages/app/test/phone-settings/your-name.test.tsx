/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import phone from "../../messages/phone.en.json" with { type: "json" };
import { YourNameSheet } from "../../src/phone-settings/your-name/YourNameSheet.js";
import { TextProvider } from "../../src/text/index.js";

const words = phone.phoneSettings.yourName;

function show(save: (name: string | null) => Promise<string | null>) {
  render(
    <TextProvider locale="en" messages={phone as never} timeZone="UTC">
      <YourNameSheet scope="first-phone" mailboxId="first-mailbox" name="The previous name" save={save} />
    </TextProvider>,
  );
  return {
    name: screen.getByRole<HTMLInputElement>("textbox", { name: words.label }),
    save: () => screen.getByRole("button", { name: words.save }),
  };
}

afterEach(cleanup);

it("uses the name confirmed by the mailbox, and clears it when saved blank", async () => {
  const write = vi.fn(async (name: string | null) => name);
  const form = show(write);
  fireEvent.change(form.name, { target: { value: "  A   different name  " } });
  fireEvent.click(form.save());
  await screen.findByText(words.saved);
  expect(form.name.value).toBe("A different name");
  fireEvent.change(form.name, { target: { value: " " } });
  fireEvent.click(form.save());
  await screen.findByText(words.saved);
  expect(form.name.value).toBe("");
  expect(write.mock.calls).toEqual([["A different name"], [null]]);
});

it("refuses an overlong name before saving it", () => {
  const write = vi.fn(async (name: string | null) => name);
  const form = show(write);
  fireEvent.change(form.name, { target: { value: "a".repeat(101) } });
  fireEvent.click(form.save());
  expect(form.name.getAttribute("aria-invalid")).toBe("true");
  expect(write).not.toHaveBeenCalled();
});

it("requires the mailbox's answer and leaves the typed name ready to retry", async () => {
  let refuse!: () => void;
  const write = vi.fn(
    () =>
      new Promise<string | null>((_accept, reject) => {
        refuse = () => reject(new Error());
      }),
  );
  const form = show(write);
  fireEvent.change(form.name, { target: { value: "Try this name" } });
  fireEvent.click(form.save());
  expect(form.name.disabled).toBe(true);
  fireEvent.click(form.save());
  expect(write).toHaveBeenCalledTimes(1);
  refuse();
  await screen.findByText(words.failed);
  expect(form.name.value).toBe("Try this name");
  expect(form.name.disabled).toBe(false);
  expect(screen.queryByText(words.saved)).toBeNull();
});

it.each([
  { where: "another mailbox", scope: "first-phone", mailboxId: "second-mailbox" },
  { where: "another phone using the same mailbox ID", scope: "second-phone", mailboxId: "first-mailbox" },
])(
  "opens $where with its own name while an earlier keyboard save is pending",
  async ({ scope, mailboxId }) => {
    let confirmFirst!: (name: string) => void;
    const first = vi.fn(
      (_name: string | null) =>
        new Promise<string>((resolve) => {
          confirmFirst = resolve;
        }),
    );
    const second = vi.fn(async (name: string | null) => name);
    const controls = (
      scope: string,
      mailboxId: string,
      name: string,
      save: (name: string | null) => Promise<string | null>,
    ) => (
      <TextProvider locale="en" messages={phone as never} timeZone="UTC">
        <YourNameSheet scope={scope} mailboxId={mailboxId} name={name} save={save} />
      </TextProvider>
    );
    const shown = render(controls("first-phone", "first-mailbox", "First name", first));
    const field = () => screen.getByRole<HTMLInputElement>("textbox", { name: words.label });
    fireEvent.change(field(), { target: { value: "First draft" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(first.mock.calls).toEqual([["First draft"]]);

    shown.rerender(controls(scope, mailboxId, "Second name", second));
    expect(field().value).toBe("Second name");
    expect(field().disabled).toBe(false);
    fireEvent.change(field(), { target: { value: "Second draft" } });
    await act(async () => {
      confirmFirst("Confirmed first name");
    });
    expect(field().value).toBe("Second draft");
    expect(screen.queryByText(words.saved)).toBeNull();

    fireEvent.keyDown(field(), { key: "Enter" });
    await screen.findByText(words.saved);
    expect(second.mock.calls).toEqual([["Second draft"]]);
  },
);
