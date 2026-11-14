/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { issue, mountStreamFrame } from "./registered-world.js";

afterEach(cleanup);

it.each([
  ["loading", "status", /Loading the full message/],
  ["failed", "alert", /The full message didn't load/],
] as const)("says when the cached state of a closed preview is %s", (state, role, pending) => {
  const letter = issue("first", 12, { body: undefined, snippet: "The preview stays" });
  const { address, mail } = mountStreamFrame({
    at: "#/reads",
    letters: [letter],
    rows: { "message_body:first": { messageId: "first", state } },
  });
  const stream = within(screen.getByRole("region", { name: "News stream" }));
  expect(stream.getByText("The preview stays")).toBeTruthy();
  expect(stream.getByRole(role).textContent).toMatch(pending);
  expect(stream.queryByRole("button", { name: /retry|try again/i })).toBeNull();
  expect(address.read()).toBe("#/reads");
  expect(mail.bodyAsks).toEqual([]);
  expect(mail.mutations).toEqual([]);
});
