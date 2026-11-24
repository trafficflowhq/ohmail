/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { issue, mountStreamFrame } from "./registered-world.js";

afterEach(cleanup);

const person = (name: string) => ({ name, address: `${name.toLowerCase()}@example.test` });
const card = () => within(screen.getByRole("region", { name: "News stream" }));

it("names the first recipients in each folded field and gives each hidden count its own name", () => {
  const letter = issue("first", 12, {
    to: ["Adele", "Bill", "Cora", "Dylan"].map(person),
    cc: ["Ella", "Frank", "Gus"].map(person),
    date: "",
    arrivedAt: "",
    body: undefined,
  });
  const { address, mail } = mountStreamFrame({ at: "#/reads", letters: [letter] });
  const stream = card();
  expect(stream.getByRole("button", { name: "Adele" })).toBeTruthy();
  expect(stream.getByRole("button", { name: "Ella" })).toBeTruthy();
  expect(stream.queryByRole("button", { name: "Cora" })).toBeNull();
  expect(stream.queryByRole("button", { name: "Gus" })).toBeNull();
  const to = stream.getByRole("button", { name: /To Adele, Bill and 2 others.*Show every recipient/i });
  const cc = stream.getByRole("button", { name: /Cc Ella, Frank and 1 other.*Show every recipient/i });
  expect(cc.getAttribute("aria-expanded")).toBe("false");
  to.focus();
  fireEvent.click(to);
  expect(stream.getByRole("button", { name: "Cora" })).toBeTruthy();
  expect(stream.getByRole("button", { name: "Gus" })).toBeTruthy();
  const hide = stream.getByRole("button", { name: "Hide the additional details" });
  expect(document.activeElement).toBe(hide);
  fireEvent.click(hide);
  expect(document.activeElement).toBe(stream.getByRole("button", { name: /To Adele, Bill and 2 others/i }));
  expect(address.read()).toBe("#/reads");
  expect(mail.bodyAsks).toEqual([]);
  expect(mail.mutations).toEqual([]);
});

it.each([[[]], [[person("Adele")]]])("keeps the folded head quiet with zero or one recipient", (to) => {
  mountStreamFrame({ at: "#/reads", letters: [issue("first", 12, { to, cc: [] })] });
  expect(card().queryByRole("button", { name: "Adele" })).toBeNull();
  expect(card().queryByRole("button", { name: /show.*details/i })).toBeNull();
});

it("gives the News sender the room taken by the repeated mailbox address", async () => {
  const own = person("Adele");
  mountStreamFrame({
    at: "#/reads",
    letters: [issue("first", 12, { mailboxId: "mb-first", to: [own] })],
    mailboxes: async () => [
      { id: "mb-first", address: own.address, addressIsOwn: true, status: "active" },
      { id: "mb-second", address: person("Bill").address, addressIsOwn: true, status: "active" },
    ],
  });
  const stream = card();
  const to = await stream.findByText(`you (${own.address})`, { exact: true });
  const head = to.closest(".oh-messagehead")!;
  expect(head.querySelector(".oh-messagehead-delivery")).toBeNull();
  expect(head.querySelector(".oh-messagehead-sender")?.textContent).toContain("The Weekly");
  expect(head.querySelector("button[data-details]")?.textContent).toBe("details");
});
