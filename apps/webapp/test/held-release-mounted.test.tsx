/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import {
  ACCOUNT, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, sessionCalls, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const groups = [{ ruleId: "r1", kind: "sender", match: "sender@example.invalid", destination: "INBOX", count: 3 }];
const endpoint = "/api/screener/held-releases";
const scoped = { headers: { "X-Ohmail-Account": ACCOUNT } };
let host: HTMLElement;
let posts: string[];

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  posts = [];
});
afterEach(teardownConfirmEnv);

async function mount(waitForConfirmation: boolean) {
  let confirm!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { confirm = resolve; });
  scriptSession(waitForConfirmation ? () => pending : sessionFull);
  let released = false;
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === endpoint && method === "GET") return Response.json({
      groups: released ? [] : groups, total: released ? 0 : 3,
      max: 200, fingerprint: "fixture", dismissed: false,
    }, scoped);
    if (path === endpoint && method === "POST") {
      posts.push(path);
      released = true;
      return Response.json({ released: groups, total: 3 }, scoped);
    }
    return fixture(input, init);
  };
  window.location.hash = "#/screener";
  host = await mountCloudShell();
  await tick(3000);
  return async () => {
    await act(async () => { confirm(sessionFull()); });
    await tick(200);
  };
}

const report = () => host.querySelector('.fr-report [role="status"]:not([data-leaving])')?.textContent;
const release = async () => {
  const button = within(host).getByRole("button", { name: "Release 3" });
  await act(async () => { button.click(); });
  await tick(200);
};

describe("a release pressed during the warm open", () => {
  it("waits for the account's confirm, says the mailbox is still loading, then releases", async () => {
    const confirm = await mount(true);
    expect(sessionCalls()).toBeGreaterThan(0);
    await release();
    expect(report()).not.toBe(messages.screener.heldReleaseFailed);
    expect(report()).toBe(messages.screener.heldReleaseWaiting);
    expect(posts).toEqual([]);

    await confirm();
    expect(posts).toEqual([endpoint]);
    expect(report()).toBe("Released 3. Your rules file them on the next pass.");
  });

  it("a confirmed account presses at once, with no loading sentence", async () => {
    await mount(false);
    await release();
    expect(posts).toEqual([endpoint]);
    expect(report()).toBe("Released 3. Your rules file them on the next pass.");
  });

  it("the German catalogue carries the sentence", () => {
    for (const key of ["heldReleaseWaiting", "unscreenedWaiting"] as const) {
      expect(typeof de.screener[key]).toBe("string");
      expect(de.screener[key]).not.toBe(messages.screener[key]);
    }
  });
});
