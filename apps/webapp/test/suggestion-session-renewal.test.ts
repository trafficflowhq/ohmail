/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markSessionAlive } from "@ohmail/app-logic/session/session-truth";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const consentSender = ["sender", "example.invalid"].join("@");
const denied = () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "Renew the session" } }), { status: 401 });
const ok = () => new Response("{}", { status: 200 });

let refresh: () => Response | Promise<Response>;
let send: () => Response;
const renewed = () => new Response(null, { status: 204 });

beforeEach(() => {
  markSessionAlive();
  document.cookie = "tf_owner=account; Path=/";
  refresh = renewed;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/auth/refresh")) return refresh();
    if (url.endsWith("/screener/suggest")) return send();
    throw new Error("Unexpected request");
  });
});
afterEach(() => {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  localStorage.clear();
  vi.unstubAllGlobals();
});

it.each([true, false])("does not replay a suggestion request after renewal (quote: %s)", async (dryRun) => {
  const { screener } = await import("../app/api-client.js");
  let requests = 0;
  send = () => ++requests === 1 ? denied() : ok();
  const answer = await screener.suggest([consentSender], { dryRun }).catch((refusal: unknown) => refusal);
  expect(requests).toBe(1);
  expect(answer).toMatchObject({ status: 401 });
});

it("rechecks a pending grant before the first fetch after a renewal wait", async () => {
  const { screener } = await import("../app/api-client.js");
  const { resumeSession } = await import("../app/session-refresh.js");
  let finish!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const renewing = new Promise<void>((resolve) => { started = resolve; });
  refresh = async () => { started(); await pending; return renewed(); };
  let requests = 0;
  send = () => { requests++; return ok(); };
  const renewal = resumeSession();
  await renewing;
  let granted = true;
  const answer = screener.suggest([consentSender], { dryRun: true, maySend: () => granted })
    .catch((refusal: unknown) => refusal);
  granted = false;
  finish();
  await renewal;
  expect(await answer).toBeInstanceOf(Error);
  expect(requests).toBe(0);
});
