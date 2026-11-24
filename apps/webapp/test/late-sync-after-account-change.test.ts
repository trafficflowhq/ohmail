/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { SyncAbortedError } from "@ohmail/client-engine";
import { sessionFetch } from "@ohmail/app-logic/session/session-truth";

it("cancels an in-flight sync reply when the browser starts a different session", async () => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE", "/api");
  const { bindApiOwner } = await import("../app/api-client");
  const account = "fixture-account";
  document.cookie = `tf_owner=${account}; Path=/`;
  document.cookie = "tf_family=fixture-family; Path=/";
  bindApiOwner(account, "fixture-family");
  let started!: () => void;
  let answer!: (reply: Response) => void;
  const working = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<Response>((resolve) => { answer = resolve; });
  vi.stubGlobal("fetch", vi.fn(() => {
    started();
    return held;
  }));
  try {
    const sync = sessionFetch("/api/sync?since=0", { method: "GET" }, account);
    await working;
    document.cookie = "tf_owner=next-account; Path=/";
    document.cookie = "tf_family=next-family; Path=/";
    const cancelled = expect(sync).rejects.toBeInstanceOf(SyncAbortedError);
    answer(Response.json({ cursor: "1" }, { headers: { "X-Ohmail-Account": account } }));
    await cancelled;
  } finally {
    bindApiOwner(null);
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    document.cookie = "tf_family=; Path=/; Max-Age=0";
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
