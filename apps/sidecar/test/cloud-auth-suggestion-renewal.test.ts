import { afterEach, expect, it } from "vitest";
import { createCloudAuth, type CloudAuth } from "../src/cloud-auth.js";

const active: CloudAuth[] = [];
afterEach(() => { for (const auth of active.splice(0)) auth.stop(); });

const path = "/screener/suggest";
const denied = () => new Response(null, { status: 401 });
const renewed = () => new Response(JSON.stringify({ tokens: { accessToken: "new-session", refreshToken: "new-renewal" } }));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

it.each([false, true])("returns a refused suggestion to its caller after renewal (already rotated: %s)", async (rotated) => {
  const started = deferred();
  const answer = deferred();
  let suggestions = 0;
  const auth = createCloudAuth({
    baseUrl: "http://cloud.test",
    tokens: { accessToken: "session", refreshToken: "renewal" },
    fetchImpl: async (input) => {
      if (new URL(String(input)).pathname === "/auth/refresh") return renewed();
      if (++suggestions > 1) return new Response("{}", { status: 200 });
      started.resolve();
      await answer.promise;
      return denied();
    },
  });
  active.push(auth);

  const request = auth.authedFetch(path, { method: "POST" });
  await started.promise;
  if (rotated) await auth.renewNow();
  answer.resolve();
  expect((await request).status).toBe(401);
  expect(suggestions).toBe(1);
});

it("hands back a suggestion submitted during renewal without sending it afterward", async () => {
  const started = deferred();
  const answer = deferred();
  let suggestions = 0;
  const auth = createCloudAuth({
    baseUrl: "http://cloud.test",
    tokens: { accessToken: "session", refreshToken: "renewal" },
    fetchImpl: async (input) => {
      if (new URL(String(input)).pathname === "/auth/refresh") {
        started.resolve();
        await answer.promise;
        return renewed();
      }
      suggestions++;
      return new Response("{}", { status: 200 });
    },
  });
  active.push(auth);

  const renewal = auth.renewNow();
  await started.promise;
  const request = auth.authedFetch(path, { method: "POST" });
  answer.resolve();
  await renewal;
  expect((await request).status).toBe(503);
  expect(suggestions).toBe(0);
});
