/** @vitest-environment jsdom */
/**
 * THE SPLASH READS THE REFRESH DOOR'S ANSWER. The report — "Please
 * sign in again", then a full 2FA sign-in over a live 90-day cookie — was two defects here: a refresh
 * that FAULTED (503 `db_busy`, jar untouched) was answered with `/login` as if the server had
 * cleared the jar, and the loop guard fired after a MINT whenever the edge refused the browser again.
 * Now a mint reloads, the door's refusals go to `/login` at once with their sentence, and a fault
 * retries here and ends on "could not be reached" with Try again and no Sign in. Every needle is
 * RENDERED catalogue text, never a source string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { resumeOnceKey } from "../app/(product)/resume/ResumeScreen.js";
import { shareSignedOutNote } from "../app/(product)/resume/signed-out-note.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
process.env.NEXT_PUBLIC_API_BASE = "/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const ONCE_KEY = resumeOnceKey("acct_A");
const NOTE_KEY = "ohmail.signed-out-reason";
const R = messages.resume;

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const db503 = (): Response =>
  json({ error: { code: "db_busy", retryable: true, message: "busy" } }, 503, { "retry-after": "5" });
const refused = (code: string) => (): Response => json({ error: { code, message: "refused" } }, 401);
/** The refusal as the server sends it: `clearSessionCookies()` takes `tf_owner` with the rest of the jar. */
const refusedClearing = (code: string) => (): Response => {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  return refused(code)();
};
/** A reuse sweep's own refusal: the code every client ends on, and `details.cause` saying why. */
const reuseSwept = (cause: string, clearing: boolean) => (): Response => {
  if (clearing) document.cookie = "tf_owner=; Path=/; Max-Age=0";
  return json({ error: { code: "refresh_revoked", message: "refresh token reuse detected", details: { cause } } }, 401);
};
const platform401 = (): Response => new Response("<html>401</html>", { status: 401, headers: { "content-type": "text/html" } });
const minted = (): Response => new Response(null, { status: 204 });

let script: Array<() => Response> = [];
/** Presentations of the refresh token; the cache purge after a refusal is counted apart. */
let refreshes = 0;
let purges = 0;
let purgeAnswer: () => Promise<Response> = async () => new Response(null, { status: 202 });
let reloads = 0;
let replaced: string[] = [];
let priorFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(async () => {
  // A coded 401 arms the death latch and its heal schedule; neither may leak into the next case.
  (await import("../app/shell/session-truth.js")).resetSessionTruthForTests();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-23T08:00:00.000Z"));
  // Full jitter pinned at its top: every wait is the schedule's whole number, so a retry that
  // came before the server's Retry-After cannot hide inside the jitter.
  vi.spyOn(Math, "random").mockReturnValue(1);
  script = [minted];
  refreshes = 0;
  purges = 0;
  purgeAnswer = async () => new Response(null, { status: 202 });
  reloads = 0;
  replaced = [];
  sessionStorage.clear();
  localStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://mail.example/", origin: "https://mail.example", protocol: "https:", hash: "",
      reload: () => { reloads += 1; },
      replace: (u: string) => { replaced.push(u); },
    },
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/refresh") && new Headers(init?.headers).has("x-ohmail-clear")) {
      purges += 1;
      return purgeAnswer();
    }
    if (url.includes("/auth/refresh")) {
      refreshes += 1;
      return script[Math.min(refreshes, script.length) - 1]!();
    }
    if (url.includes("/api/auth/session")) return json({ error: { code: "unauthorized", message: "no" } }, 401);
    return json({}, 200);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  await unmount();
  globalThis.fetch = priorFetch;
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  sessionStorage.clear();
  localStorage.clear();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

/** Advance in steps, each its own `act`, so a rung armed mid-advance is not skipped. */
async function tick(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(250, left)); });
    await flush();
  }
}

async function mountResume(owner = "acct_A"): Promise<HTMLElement> {
  const { ResumeScreen } = await import("../app/(product)/resume/ResumeScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(ResumeScreen, { initialOwner: owner }),
    }));
  });
  await flush();
  return host;
}

const text = (el: HTMLElement): string => el.textContent ?? "";
const buttons = (el: HTMLElement, label: string): number =>
  [...el.querySelectorAll("a, button")].filter((b) => (b.textContent ?? "").trim() === label).length;
const stamp = (answer: string, reloadsSoFar = 0): void =>
  sessionStorage.setItem(ONCE_KEY, JSON.stringify({ at: Date.now(), answer, reloads: reloadsSoFar }));

describe("(b) a fault at the refresh is retried in place — the jar is never given up", () => {
  it("503 then 204: waits the server's Retry-After, retries, reloads; /login is never visited", async () => {
    script = [db503, minted];
    const el = await mountResume();
    expect(refreshes).toBe(1);
    await tick(4_750);
    expect(refreshes, "the retry came before the server's Retry-After").toBe(1);
    await tick(500);
    expect(refreshes, "the fault was not retried").toBe(2);
    expect(reloads, "a mint after a retry did not reload").toBe(1);
    expect(replaced, "a fault sent a signed-in browser to the sign-in form").toEqual([]);
    expect(text(el)).not.toContain(R.failedTitle);
  });

  it("an UNCODED 401 is a platform, not the server's verdict — retried like a fault", async () => {
    script = [platform401, minted];
    await mountResume();
    await tick(1_000);
    expect(refreshes).toBe(2);
    expect(replaced).toEqual([]);
    expect(reloads).toBe(1);
  });
});

describe("(c) a fault that does not clear ends on 'could not be reached' — Try again, no Sign in", () => {
  it("four 503s: the busy card, then Try again reaches the mailbox", async () => {
    script = [db503];
    const el = await mountResume();
    await tick(30_000);
    expect(refreshes, "the ladder is four asks, no more and no fewer").toBe(4);
    expect(text(el)).toContain(R.busyTitle);
    expect(text(el)).toContain(R.busyBody);
    expect(buttons(el, R.tryAgain), "the busy card has no Try again").toBe(1);
    expect(buttons(el, R.signIn), "the busy card offers a sign-in over a live jar").toBe(0);
    expect(text(el)).not.toContain(R.failedTitle);
    expect(replaced).toEqual([]);
    expect(reloads).toBe(0);

    script = [minted];
    const again = [...el.querySelectorAll("button")].find((b) => b.textContent === R.tryAgain)!;
    await act(async () => { again.click(); });
    await flush();
    expect(refreshes).toBe(5);
    expect(reloads, "Try again did not resume").toBe(1);
  });

  it("THE CONTROL — the loop guard does not fire on a fault: a second visit asks again", async () => {
    script = [db503];
    await mountResume();
    await tick(30_000);
    expect(refreshes).toBe(4);
    await unmount();
    const el = await mountResume();
    expect(refreshes, "a fault left a stamp that vetoed the next resume").toBe(5);
    expect(text(el)).not.toContain(R.failedTitle);
  });
});

describe("(d) the door's refusals go to /login on the FIRST attempt, with the sentence", () => {
  it.each([
    ["refresh_revoked", "revoked"],
    ["refresh_expired", "expired"],
    ["refresh_missing", "absent"],
    ["unauthorized", "revoked"],
  ])("a coded 401 %s — /login at once, note %s", async (code, note) => {
    script = [refused(code)];
    await mountResume();
    expect(refreshes, "a refusal was retried — the verdict lost its speed").toBe(1);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe(note);
    await tick(10_000);
    expect(refreshes).toBe(1);
  });

  it.each([
    ["refresh_revoked", "revoked"],
    ["refresh_expired", "expired"],
  ])("%s with the jar cleared as the server clears it — /login with note %s, never the landing page", async (code, note) => {
    script = [refusedClearing(code)];
    await mountResume();
    expect(reloads, "the door's own refusal was read as a jar that changed hands").toBe(0);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe(note);
  });

  it.each([false, true])("a reuse sweep's refusal (the server clears the jar: %s) — /login at once, note reused", async (clearing) => {
    script = [reuseSwept("reuse", clearing)];
    await mountResume();
    expect(refreshes, "the refused token was presented again").toBe(1);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe("reused");
  });

  it("the control: a cause this build does not know is the plain revoked note", async () => {
    script = [reuseSwept("replayed", true)];
    await mountResume();
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe("revoked");
  });

  it("the control: a refusal that lands under another account's jar reloads, with no sentence", async () => {
    script = [() => { document.cookie = "tf_owner=acct_B; Path=/"; return refused("refresh_revoked")(); }];
    await mountResume();
    expect(reloads).toBe(1);
    expect(replaced).toEqual([]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull();
  });

  it("the sign-in form does not wait for the cache purge the refusal sends", async () => {
    // Chrome held a refusal carrying Clear-Site-Data for a walk of its whole disk cache.
    purgeAnswer = () => new Promise<Response>(() => {});
    script = [refusedClearing("refresh_expired")];
    await mountResume();
    expect(purges, "the refusal asked for no cache clear").toBe(1);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe("expired");
    expect(refreshes).toBe(1);
  });

  it("an erased account's 410, on a splash that registers no erased door: one purge, then /login", async () => {
    script = [() => {
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
      return json({ error: { code: "account_erased", message: "deleted" } }, 410, { "X-Ohmail-Account": "acct_A" });
    }];
    await mountResume();
    expect(purges, "the erased account's cached files stay on this browser's disk").toBe(1);
    expect(refreshes).toBe(1);
    expect(replaced).toEqual(["/login"]);
  });
});

/**
 * TWO TABS ON THE SPLASH. Tab A presents and hears the refusal while this tab (B) waits on the
 * cross-tab lock; A's answer clears the jar, `tf_owner` with it, and A leaves its sentence for the
 * other tabs. B presents nothing and must not reload into the gate, which sent every reload back
 * here while the clears were held: it goes to the sign-in form with A's sentence.
 */
describe("(e) another tab heard the door while this one waited", () => {
  /** The lock manager B queues on; `meanwhile` is what tab A does before B's grant. */
  function lockedBehindTabA(meanwhile: () => void): void {
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: async (_n: string, _o: unknown, fn: () => Promise<unknown>) => {
          meanwhile();
          return fn();
        },
      },
    });
  }

  it("tab A's refusal empties the jar: B presents nothing, does not reload, and says A's sentence", async () => {
    lockedBehindTabA(() => {
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
      shareSignedOutNote("expired");
    });
    await mountResume();
    expect(refreshes, "B presented a token tab A had just heard refused").toBe(0);
    expect(reloads, "B reloaded into the gate").toBe(0);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBe("expired");
  });

  it("the control: a sentence older than the window is not taken — the sign-in form alone", async () => {
    lockedBehindTabA(() => {
      shareSignedOutNote("revoked");
      vi.setSystemTime(Date.now() + 16_000);
      document.cookie = "tf_owner=; Path=/; Max-Age=0";
    });
    await mountResume();
    expect(refreshes).toBe(0);
    expect(replaced).toEqual(["/login"]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull();
  });

  it("the control: another account signed in meanwhile — B reloads, with no sentence", async () => {
    lockedBehindTabA(() => {
      shareSignedOutNote("expired");
      document.cookie = "tf_owner=acct_B; Path=/";
    });
    await mountResume();
    expect(refreshes).toBe(0);
    expect(reloads).toBe(1);
    expect(replaced).toEqual([]);
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull();
  });
});

describe("the loop guard reads the answer of the previous pass", () => {
  it("back here right after a MINT: no second rotation, a reload after a backoff", async () => {
    stamp("minted");
    await mountResume();
    expect(refreshes, "a live jar was rotated again").toBe(0);
    await tick(1_300);
    expect(reloads).toBe(1);
    expect(JSON.parse(sessionStorage.getItem(ONCE_KEY)!).reloads).toBe(1);
  });

  it("after the reloads run out: the busy card, never the sign-in card", async () => {
    stamp("minted", 3);
    const el = await mountResume();
    expect(refreshes).toBe(0);
    expect(text(el)).toContain(R.busyTitle);
    expect(buttons(el, R.signIn)).toBe(0);
    expect(text(el)).not.toContain(R.failedTitle);
  });

  it("back here after a REFUSAL: the sign-in card with the sentence that names it", async () => {
    stamp("expired");
    const el = await mountResume();
    expect(refreshes).toBe(0);
    expect(text(el)).toContain(R.failedTitle);
    expect(text(el)).toContain(R.expiredBody);
    expect(buttons(el, R.signIn)).toBe(1);
  });

  it("back here after a REUSE SWEEP: the card says what happened and what to do", async () => {
    stamp("reused");
    const el = await mountResume();
    expect(refreshes).toBe(0);
    expect(text(el)).toContain(R.reusedBody);
    expect(buttons(el, R.signIn)).toBe(1);
  });

  it("a stamp from the previous build — a bare timestamp — resumes; it shows no card", async () => {
    sessionStorage.setItem(ONCE_KEY, String(Date.now()));
    const el = await mountResume();
    expect(refreshes).toBe(1);
    expect(reloads).toBe(1);
    expect(text(el)).not.toContain(R.failedTitle);
  });
});

describe("/login says why the splash sent this tab there", () => {
  it("the note renders its sentence once and is removed", async () => {
    sessionStorage.setItem(NOTE_KEY, "expired");
    const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
    });
    await flush();
    expect(text(host)).toContain(R.expiredBody);
    expect(sessionStorage.getItem(NOTE_KEY), "the note outlived its one reading").toBeNull();
  });

  it("the reuse note renders its sentence once and is removed", async () => {
    sessionStorage.setItem(NOTE_KEY, "reused");
    const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
    });
    await flush();
    expect(text(host).split(R.reusedBody).length - 1, "the reuse sentence, once").toBe(1);
    expect(sessionStorage.getItem(NOTE_KEY)).toBeNull();
  });

  it("THE CONTROL — no note, no sentence", async () => {
    const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(LoginScreen) }));
    });
    await flush();
    for (const body of [R.revokedBody, R.expiredBody, R.absentBody]) expect(text(host)).not.toContain(body);
  });
});

describe("the loop guard belongs to the account that wrote it", () => {
  it("B resuming in the tab where A just resumed asks the door, never reads A's stamp as a loop", async () => {
    stamp("minted");
    document.cookie = "tf_owner=acct_B; Path=/";
    await mountResume("acct_B");
    expect(refreshes, "B's resume was taken for A's loop and never asked the refresh door").toBe(1);
    expect(sessionStorage.getItem(resumeOnceKey("acct_B")), "B's own pass was not stamped under B").not.toBeNull();
  });

  it("control: A back within the window IS a loop for A — its own stamp still reads", async () => {
    stamp("minted");
    await mountResume("acct_A");
    expect(refreshes, "the guard stopped seeing the account's own loop").toBe(0);
  });
});
