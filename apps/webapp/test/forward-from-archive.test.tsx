/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { within } from "@testing-library/react";
import { storeMessage } from "./_store-fixture";
import {
  ISO, act as shellAct, answerStoreWith, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, page, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/** Open a message served only by the backend's History page. The sync fixture serves one different message. */
async function openStoreLetter(holdBody = false) {
  const message = storeMessage(0, "2024-03-20T10:00:00.000Z", {
    accountId: "acct_live_1", subject: "A letter from the archive",
  });
  answerStoreWith([message]);
  const sync = page(1);
  answerSyncWith(() => sync.clone());
  const endpoint = `/messages/${message.id}`;
  const calls: string[] = [];
  const body = Response.json({ text: "Archive body", html: null, loadedRemoteContent: false });
  let releaseBody = () => {};
  const bodyAnswer = holdBody
    ? new Promise<Response>((resolve) => { releaseBody = () => resolve(body); })
    : Promise.resolve(body);
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input).split("?")[0]!;
    const method = init?.method ?? "GET";
    if (url.endsWith(`${endpoint}/body`)) {
      calls.push("body");
      return (await bodyAnswer).clone();
    }
    if (url.endsWith(endpoint)) {
      if (method === "DELETE") calls.push("delete");
      return Response.json(message);
    }
    return fetch(input, init);
  };
  const host = await mountShell([mailbox({
    id: "mb_1", lastSyncAt: ISO, organizerRole: "organizer", organizeConsentedAt: ISO,
  })]);
  await goTo("history");
  const row = within(host).getByRole("option", { name: /A letter from the archive/ });
  await shellAct(async () => { row.click(); });
  await tick(100);
  expect(within(host).getByRole("heading", { name: message.subject })).toBeTruthy();
  return { host, calls, releaseBody };
}

it("an OFF-MIRROR message still offers Forward — the press fetches its body first", async () => {
  installShellEnv();
  try {
    const { host, calls, releaseBody } = await openStoreLetter(true);
    const actions = within(host).getByRole("toolbar", { name: "Actions" });
    await shellAct(async () => { within(actions).getByRole("button", { name: "Forward" }).click(); });
    await tick(50);
    expect.soft(calls).toContain("body");
    expect.soft(within(host).queryByRole("region", { name: "Forward" })).toBeNull();
    await shellAct(async () => { releaseBody(); });
    await tick(100);
    expect(within(host).getByRole("region", { name: "Forward" })).toBeTruthy();
  } finally {
    await teardownShellEnv();
  }
});
