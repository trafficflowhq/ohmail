/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { en as messages } from "../../../test/support/web-catalogues.js";
import { LocalSuggest } from "../src/local-suggest.js";
import type { LocalAiStatus } from "../src/local-ai.js";
import { bridgeFetch } from "../src/bridge-fetch.js";

vi.mock("../src/bridge-fetch.js", () => ({ bridgeFetch: vi.fn() }));

const bridge = vi.mocked(bridgeFetch);
const ai: LocalAiStatus = {
  provider: "ollama", available: true, unavailableReason: null, contentGoesTo: "this_machine",
  settings: {} as LocalAiStatus["settings"], probe: null, canStoreKey: false,
};
const senders = Array.from({ length: 6 }, (_, index) => [String(index), "example.invalid"].join("@"));
const answer = (body: unknown) => new Response(JSON.stringify(body));
const requests = () => bridge.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const button = () => screen.getByRole<HTMLButtonElement>("button", { name: "Suggest for 6 senders" });

function mount(known: boolean, check: () => boolean, grant = () => 1) {
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <LocalSuggest senders={senders} absorb={() => undefined} ai={ai} onConfigure={() => undefined}
        permission={{ known, grant: () => check() ? grant() : null }} />
    </IntlProvider>,
  );
}

beforeEach(() => {
  bridge.mockReset();
  bridge.mockImplementation(async (path) => path.includes("?") ? answer({ items: [] }) : answer({ suggestions: [], skipped: [] }));
});

afterEach(cleanup);

it("disables the standalone Suggest press while consent is unreadable", async () => {
  mount(false, () => false);
  fireEvent.click(button());
  expect(requests()).toHaveLength(0);
  expect(button().disabled).toBe(true);
});

it("checks consent at dispatch when the last rendered button is still enabled", async () => {
  let known = true;
  mount(true, () => known);
  expect(button().disabled).toBe(false);
  known = false;
  fireEvent.click(button());
  expect(requests()).toHaveLength(0);
});

it("stops asking for further senders when consent fails during a press", async () => {
  let known = true;
  bridge.mockImplementation(async (path) => {
    if (path.includes("?")) return answer({ items: [] });
    known = false;
    return answer({ suggestions: [], skipped: [] });
  });
  mount(true, () => known);
  fireEvent.click(button());
  await waitFor(() => expect(button()).toBeTruthy());
  expect(requests()).toHaveLength(1);
});

it("stops the remaining chunks after an Off answer even when consent is still readable", async () => {
  let grant = 1;
  bridge.mockImplementation(async (path) => {
    if (path.includes("?")) return answer({ items: [] });
    grant++;
    return answer({ suggestions: [], skipped: [] });
  });
  mount(true, () => true, () => grant);
  fireEvent.click(button());
  await waitFor(() => expect(button()).toBeTruthy());
  expect(requests()).toHaveLength(1);
});

it("keeps the released batch size and request count for an uninterrupted press", async () => {
  mount(true, () => true);
  fireEvent.click(button());
  await waitFor(() => expect(button()).toBeTruthy());
  const chunks = requests().map(([, init]) => JSON.parse(String((init as RequestInit).body)).senders);
  expect(chunks).toEqual([senders.slice(0, 5), senders.slice(5)]);
});
