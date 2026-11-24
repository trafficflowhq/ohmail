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
let reports: string[];

beforeAll(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  return warmCloudShell();
});
beforeEach(() => {
  installConfirmEnv();
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  posts = [];
  reports = [];
});
afterEach(teardownConfirmEnv);

async function mount(waitForConfirmation: boolean, failure?: "file" | "refresh") {
  let confirm!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { confirm = resolve; });
  scriptSession(waitForConfirmation ? () => pending : sessionFull);
  let released = false;
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (path === endpoint && method === "GET") {
      if (released && failure === "refresh") return new Response(null, { ...scoped, status: 503 });
      return Response.json({
        groups: released ? [] : groups, total: released ? 0 : 3,
        max: 200, fingerprint: "fixture", dismissed: false,
      }, scoped);
    }
    if (path === endpoint && method === "POST") {
      posts.push(path);
      if (failure === "file") return Response.json({ error: { code: "conflict", message: "refused" } }, { ...scoped, status: 409 });
      released = true;
      return Response.json({ released: groups, total: 3 }, scoped);
    }
    return fixture(input, init);
  };
  window.location.hash = "#/screener";
  const seen = new MutationObserver(() => {
    const notice = document.querySelector('.fr-report [role="status"]:not([data-leaving])')?.textContent;
    if (notice) reports.push(notice);
  });
  seen.observe(document.body, { childList: true, subtree: true, characterData: true });
  try {
    host = await mountCloudShell();
    await tick(3000);
  } finally {
    seen.disconnect();
  }
  return async () => {
    await act(async () => { confirm(sessionFull()); });
    await tick(200);
  };
}

const report = () => host.querySelector('.fr-report [role="status"]:not([data-leaving])')?.textContent;
const releaseControl = () => within(host).queryByRole("button", { name: "Release 3" });

describe("automatic filing when the Screener opens", () => {
  it("files only after the account is confirmed", async () => {
    const confirm = await mount(true);
    expect(sessionCalls()).toBeGreaterThan(0);
    expect(releaseControl()).toBeNull();
    expect(posts).toEqual([]);

    await confirm();
    expect(posts).toEqual([endpoint]);
    expect(report()).toBeUndefined();
  });

  it("tells the person when the automatic filing request fails", async () => {
    await mount(false, "file");
    expect(posts).toEqual([endpoint]);
    expect(reports).toContain(messages.screener.heldReleaseFailed.replace(/\.$/u, ""));
    expect(releaseControl()).toBeNull();
  });

  it("stays quiet when filing succeeded and only the refreshed count failed", async () => {
    await mount(false, "refresh");
    expect(posts).toEqual([endpoint]);
    expect(reports).not.toContain(messages.screener.heldReleaseFailed.replace(/\.$/u, ""));
  });

  it("the German catalogue carries the sentence", () => {
    for (const key of ["heldReleaseFailed", "unscreenedWaiting"] as const) {
      expect(typeof de.screener[key]).toBe("string");
      expect(de.screener[key]).not.toBe(messages.screener[key]);
    }
  });
});
