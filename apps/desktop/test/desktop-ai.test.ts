/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@ohmail/ui";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";

import { clearAiProvider, readAiStatus, saveAiSettings, verifyAiProvider, type LocalAiStatus } from "../src/local-ai.js";
import { DesktopAiSettings } from "../src/DesktopAiSettings.js";
import { LocalSuggest } from "../src/local-suggest.js";

/**
 * A MODEL OF YOUR OWN, driven against a stand-in engine.
 *
 * What is asserted here is the part of this feature that decides rather than the part that draws:
 * where a typed API key travels, what happens on a door that has no local model, and — the one
 * that matters most — that a control which cannot do anything never offers a button that pretends
 * it can. The round trip against a REAL engine is `apps/sidecar`'s; this is the window's half.
 *
 * ── THE ASSERTIONS WORTH THE WHOLE FILE ─────────────────────────────────────────────────────
 *
 *  · An API key is never an argument to a native command. It is the body of one request addressed
 *    to the engine, exactly as the mailbox password is, and the shell has no other way to see it.
 *  · Nothing asks a model without a press. The desktop has no automatic path and must not grow
 *    one by accident — mutate the latch and this goes red.
 *  · A press asks in small requests, one at a time, and never more than one endpoint request's
 *    worth of senders. Serial is checked by watching how many are in flight, not by reading the
 *    code that intends it.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: unknown };
}
const host = globalThis as unknown as Host;

/** One answer, framed exactly as the shell frames one. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Asked {
  command: string;
  method: string;
  url: string;
  body: string;
  headers: Array<[string, string]>;
}

const READY: LocalAiStatus = {
  provider: "ollama",
  available: true,
  unavailableReason: null,
  contentGoesTo: "this_machine",
  settings: {
    provider: "ollama",
    anthropic: { classifyModel: "claude-haiku-4-5-20251001", draftModel: "claude-sonnet-5", hasKey: false },
    openai: { classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1", hasKey: false },
    ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
  },
  probe: { ok: true, reason: null, detail: null, models: ["llama3.2:latest"], at: "2026-01-01T00:00:00.000Z" },
  canStoreKey: true,
};

const UNSET: LocalAiStatus = {
  ...READY,
  provider: null,
  available: false,
  unavailableReason: "not_configured",
  contentGoesTo: null,
  settings: { ...READY.settings, provider: null },
  probe: null,
};

/**
 * A shell whose engine answers from a small table, records everything, and reports how many
 * requests were in flight at once.
 */
function engine(answer: (req: Asked) => { status: number; body: string }): {
  asked: Asked[];
  peak: () => number;
} {
  const asked: Asked[] = [];
  let live = 0;
  let peak = 0;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      const req: Asked = {
        command,
        method: String(payload?.method ?? ""),
        url: String(payload?.url ?? ""),
        body: new TextDecoder().decode(Uint8Array.from((payload?.body as number[]) ?? [])),
        headers: (payload?.headers as Array<[string, string]>) ?? [],
      };
      asked.push(req);
      if (command !== "engine_request") return null;
      live++;
      peak = Math.max(peak, live);
      // One turn of the event loop, so two overlapping requests would actually overlap.
      await new Promise((r) => setTimeout(r, 0));
      live--;
      const { status, body } = answer(req);
      return encode(status, body);
    },
  };
  return { asked, peak: () => peak };
}

let root: Root | null = null;
let mount: HTMLElement | null = null;

async function render(node: React.ReactElement): Promise<HTMLElement> {
  mount = document.createElement("div");
  document.body.appendChild(mount);
  root = createRoot(mount);
  await act(async () => {
    /* THE REAL CATALOGUE, not a stub: the form's twelve verdicts and every label on it come from
       `aiProvider` in `en.json`, so a test that supplied its own messages would be asserting
       against words the app does not ship. */
    root!.render(
      h(
        NextIntlClientProvider,
        { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, node),
      ),
    );
  });
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
  return mount;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mount?.remove();
  root = null;
  mount = null;
  delete host.__TAURI_INTERNALS__;
});

const buttonSaying = (el: HTMLElement, text: RegExp): HTMLButtonElement | undefined =>
  [...el.querySelectorAll("button")].find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement | undefined;

describe("the model settings this install holds", () => {
  it("carries a typed key in the request body and in no command argument", async () => {
    const { asked } = engine(() => ({ status: 200, body: JSON.stringify(READY) }));
    /* A STAND-IN THAT IS NOT KEY-SHAPED, on purpose. Its whole job is to be recognisable in the
       recorded traffic below, and a literal that matches a real provider's key format is one the
       payload gate has to refuse before this file is published — correctly, since it cannot tell a
       fixture from the genuine article. What the engine checks is length and character class, never
       a prefix, so nothing here is weakened by using a string nobody could mistake for a secret. */
    const key = "this-is-not-a-real-api-key-0000";

    const status = await saveAiSettings({ provider: "anthropic", anthropic: { apiKey: key } });
    expect(status.available).toBe(true);

    // ONE request, addressed to the engine, and the key is in its BODY.
    const puts = asked.filter((a) => a.command === "engine_request" && a.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe("/local/ai");
    expect(JSON.parse(puts[0]!.body)).toMatchObject({ anthropic: { apiKey: key } });

    // …and NOWHERE ELSE. Not in the URL, not in a header, not in any other command the shell was
    // asked to run. A credential that reaches a shell command is a credential the shell can store.
    for (const a of asked) {
      expect(a.url, "the key reached a URL").not.toContain(key);
      expect(JSON.stringify(a.headers), "the key reached a header").not.toContain(key);
      if (a.command !== "engine_request" || a.method !== "PUT") {
        expect(a.body, `the key reached ${a.command}`).not.toContain(key);
      }
    }
  });

  it("reads a door that has no local model as an absence rather than a fault", async () => {
    // The engine on the hosted door does not serve this route, so the request is forwarded and
    // comes back 404. That is a state the pane renders, not an error it reports.
    engine(() => ({ status: 404, body: JSON.stringify({ error: { code: "not_found", message: "no" } }) }));
    await expect(readAiStatus()).resolves.toBeNull();
  });

  it("gives the engine's own sentence back when it refuses", async () => {
    engine(() => ({
      status: 503,
      body: JSON.stringify({
        error: { code: "install_key_absent", message: "this install has no durable key, so an API key cannot be stored on this machine." },
      }),
    }));
    await expect(saveAiSettings({ provider: "anthropic", anthropic: { apiKey: "x".repeat(24) } }))
      .rejects.toThrow(/no durable key/);
  });

  it("verifies and forgets over the two verbs the engine serves", async () => {
    const { asked } = engine(() => ({ status: 200, body: JSON.stringify(UNSET) }));
    await verifyAiProvider();
    await clearAiProvider();
    const calls = asked.filter((a) => a.command === "engine_request").map((a) => `${a.method} ${a.url}`);
    expect(calls).toEqual(["POST /local/ai/verify", "DELETE /local/ai"]);
  });
});

describe("the Screener's suggest control on a standalone install", () => {
  const senders = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}@example.test`);

  /** An engine that serves the stored-queue read and answers every suggest with one verdict each. */
  const answering = () =>
    engine((req) => {
      if (req.url.startsWith("/screener?")) return { status: 200, body: JSON.stringify({ items: [] }) };
      if (req.url === "/screener/suggest") {
        const asked = (JSON.parse(req.body) as { senders: string[] }).senders;
        return {
          status: 200,
          body: JSON.stringify({
            suggestions: asked.map((s) => ({
              sender: s, messageId: `m-${s}`, decision: "no", destination: "ohmail/Reads",
              confidence: 0.8, rationale: "a newsletter",
            })),
            skipped: [],
          }),
        };
      }
      return { status: 404, body: "{}" };
    });

  it("asks nothing of a model until somebody presses something", async () => {
    // THE INVARIANT. A standalone install has no automatic path and must never grow one: the
    // hosted client's automatic batch is gated on a server this build does not have, and nothing
    // here replaces it. Mutate `start()` into an effect and this goes red.
    const { asked } = answering();
    await render(h(LocalSuggest, { senders: senders(12), absorb: () => {}, ai: READY, onConfigure: () => {} }));
    expect(asked.filter((a) => a.url === "/screener/suggest")).toEqual([]);
  });

  it("offers a way out instead of a button when there is no model", async () => {
    const { asked } = answering();
    let opened = 0;
    const el = await render(
      h(LocalSuggest, { senders: senders(3), absorb: () => {}, ai: UNSET, onConfigure: () => { opened++; } }),
    );
    expect(el.textContent).toMatch(/There is none on this install yet/);
    // NOT A DEAD CONTROL: the one button present goes somewhere, and it is not a purchase.
    const wayOut = buttonSaying(el, /Set up a model/);
    expect(wayOut).toBeDefined();
    await act(async () => { wayOut!.click(); });
    expect(opened).toBe(1);
    expect(asked.filter((a) => a.url === "/screener/suggest")).toEqual([]);
  });

  it("names no price, no credit and no ladder", async () => {
    answering();
    const el = await render(h(LocalSuggest, { senders: senders(12), absorb: () => {}, ai: READY, onConfigure: () => {} }));
    const text = el.textContent ?? "";
    expect(text).toMatch(/Suggest for 12 senders/);
    expect(text).toMatch(/Uses the model you set up/);
    for (const word of [/credit/i, /\$/, /\bcost\b/i, /\bbuy\b/i, /\bprice\b/i]) {
      expect(text, `the standalone control named ${String(word)}`).not.toMatch(word);
    }
  });

  it("asks in small requests, one at a time, each with its own idempotency key", async () => {
    const { asked, peak } = answering();
    const landed: string[] = [];
    const el = await render(
      h(LocalSuggest, {
        senders: senders(12),
        absorb: (rows: Array<{ address: string }>) => { landed.push(...rows.map((r) => r.address)); },
        ai: READY,
        onConfigure: () => {},
      }),
    );
    await act(async () => { buttonSaying(el, /Suggest for/)!.click(); });
    for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });

    const posts = asked.filter((a) => a.url === "/screener/suggest");
    // Twelve senders in chunks of five: 5, 5, 2 — and never two requests in flight at once.
    expect(posts.map((p) => (JSON.parse(p.body) as { senders: string[] }).senders.length)).toEqual([5, 5, 2]);
    expect(peak(), "requests overlapped").toBe(1);
    const keys = posts.map((p) => p.headers.find(([k]) => k.toLowerCase() === "idempotency-key")?.[1]);
    expect(new Set(keys).size, "chunks shared an idempotency key").toBe(3);
    expect(landed).toHaveLength(12);
  });

  it("asks about no more senders in one press than the endpoint accepts in one request", async () => {
    const { asked } = answering();
    const el = await render(
      h(LocalSuggest, { senders: senders(140), absorb: () => {}, ai: READY, onConfigure: () => {} }),
    );
    // The label states the bound before the press, so nobody is surprised by what it covered.
    expect(el.textContent).toMatch(/Suggest for 50 senders/);
    await act(async () => { buttonSaying(el, /Suggest for/)!.click(); });
    for (let i = 0; i < 60; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
    const covered = asked
      .filter((a) => a.url === "/screener/suggest")
      .reduce((n, p) => n + (JSON.parse(p.body) as { senders: string[] }).senders.length, 0);
    expect(covered).toBe(50);
  });

  it("shows the engine's own sentence when the model will not answer", async () => {
    engine((req) => {
      if (req.url.startsWith("/screener?")) return { status: 200, body: JSON.stringify({ items: [] }) };
      return {
        status: 503,
        body: JSON.stringify({
          error: { code: "ai_provider_unavailable", message: "the configured AI provider did not answer its last verification" },
        }),
      };
    });
    const el = await render(
      h(LocalSuggest, { senders: senders(3), absorb: () => {}, ai: READY, onConfigure: () => {} }),
    );
    await act(async () => { buttonSaying(el, /Suggest for/)!.click(); });
    for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
    // Verbatim, and pointed at the one place that fixes it. A second taxonomy composed here is how
    // somebody with a stopped model server gets told their mail is broken.
    expect(el.textContent).toMatch(/did not answer its last verification/);
    expect(el.textContent).toMatch(/Settings, Desktop/);
  });
});


/* ── the model form: one write path, and a key that can only go where it was typed ─────── */

describe("the AI provider form never sends a key to the vendor it was not typed for", () => {
  /**
   * A stand-in engine that BEHAVES like the real one across a write.
   *
   * The old pane held the vendor choice in local state, so a test could click a segment and see
   * the fields change with nothing round-tripping. The form reads the choice off the STATUS, which
   * is the whole point of it — a refused write leaves the control showing what is really stored —
   * so the stub has to answer the way the engine answers: the provider a PUT names is the provider
   * the next GET reports, and every write discards the previous verification.
   */
  const paneEngine = (initial: LocalAiStatus) => {
    let current = initial;
    const { asked } = engine((req) => {
      if (req.command === "engine_request" && req.method === "PUT") {
        const write = JSON.parse(req.body) as {
          provider?: string | null;
          anthropic?: { apiKey?: string };
          openai?: { apiKey?: string };
        };
        const provider = (write.provider ?? null) as LocalAiStatus["provider"];
        const settings = { ...current.settings, provider };
        if (write.anthropic?.apiKey) settings.anthropic = { ...settings.anthropic, hasKey: true };
        if (write.openai?.apiKey) settings.openai = { ...settings.openai, hasKey: true };
        current = {
          ...current,
          provider,
          settings,
          available: false,
          unavailableReason: provider ? "unverified" : "not_configured",
          probe: null,
        };
      }
      if (req.command === "engine_request" && req.method === "DELETE") {
        current = { ...UNSET, settings: { ...UNSET.settings } };
      }
      return { status: 200, body: JSON.stringify(current) };
    });
    return { asked, current: () => current };
  };

  const paneWith = async (
    status: LocalAiStatus,
  ): Promise<{ el: HTMLElement; asked: Asked[] }> => {
    const { asked } = paneEngine(status);
    const el = await render(h(DesktopAiSettings, { door: "local" as const }));
    return { el, asked };
  };

  /** The radio whose label reads `text`, in the provider choice list. */
  const choiceSaying = (el: HTMLElement, text: RegExp): HTMLInputElement | undefined =>
    [...el.querySelectorAll<HTMLLabelElement>(".set-choice label")]
      .find((l) => text.test(l.querySelector("b")?.textContent ?? ""))
      ?.querySelector("input") as HTMLInputElement | undefined;

  const typeKey = async (el: HTMLElement, key: string): Promise<HTMLInputElement> => {
    const field = el.querySelector("#ai-key") as HTMLInputElement;
    expect(field, "the key field must be rendered for a hosted vendor").toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, key);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return field;
  };

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
  };

  const KEY = "this-is-not-a-real-api-key-0000";

  /**
   * THE FINDING THIS BLOCK EXISTS FOR, AND HOW THE FORM DISPOSES OF IT.
   *
   * One key field serves both hosted vendors, because only one vendor's block is ever on screen.
   * Under the old pane that made the field's contents outlive the choice that framed them: paste
   * an Anthropic key, switch the control to OpenAI, press Save, and a live Anthropic credential
   * was sealed into the OpenAI block and sent to `api.openai.com` by the verification the write
   * triggers. The ENGINE cannot catch it — it receives a well-formed write naming OpenAI and
   * carrying a key, byte-for-byte what somebody legitimately choosing OpenAI sends.
   *
   * The guard used to be a hand-written "clear the field when the segment changes". It is now the
   * SHAPE of the form: a key is submitted by its own `<form>` at the moment it is typed, and a
   * vendor change is a write that carries `provider` and nothing else. There is no deferred save
   * for a stale key to ride out on. Both halves are asserted, because the shape is only a guard
   * for as long as it is the shape.
   */
  it("carries no key at all on a vendor change, and empties the field", async () => {
    const { el, asked } = await paneWith(UNSET);

    await act(async () => { choiceSaying(el, /Anthropic/)!.click(); });
    await settle();
    await typeKey(el, KEY);

    asked.length = 0;
    // …and now change your mind, without clearing the field yourself.
    await act(async () => { choiceSaying(el, /OpenAI/)!.click(); });
    await settle();

    const puts = asked.filter((a) => a.command === "engine_request" && a.method === "PUT");
    expect(puts.length, "the choice must have written once").toBe(1);
    expect(JSON.parse(puts[0]!.body)).toEqual({ provider: "openai" });
    for (const a of asked) {
      expect(a.body, "a key typed for one vendor travelled on the vendor change").not.toContain(KEY);
    }
    expect((el.querySelector("#ai-key") as HTMLInputElement).value, "the field kept a stale key").toBe("");
  });

  it("sends a typed key only to the vendor whose field it was typed in", async () => {
    const { el, asked } = await paneWith(UNSET);
    await act(async () => { choiceSaying(el, /Anthropic/)!.click(); });
    await settle();
    await typeKey(el, KEY);

    asked.length = 0;
    await act(async () => { buttonSaying(el, /Save key and test/)!.click(); });
    await settle();

    const puts = asked.filter((a) => a.command === "engine_request" && a.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe("/local/ai");
    const body = JSON.parse(puts[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({ provider: "anthropic", anthropic: { apiKey: KEY } });
    // The other vendor's block is ABSENT, not merely key-less: an omitted block keeps what is
    // stored, and a block naming the other vendor is where a mis-sent key would have to live.
    expect(body.openai).toBeUndefined();
  });

  /**
   * A STORED KEY IS TESTED, NOT RE-SAVED.
   *
   * With one already sealed, the action becomes "Test the stored key" and must ask the verify
   * verb. A PUT here would be an empty write, and the engine DISCARDS the previous verification
   * on every write — so a button labelled "test" would clear the very state it was pressed to
   * confirm, and the pane would go from "working" to "not tested" for pressing test.
   */
  it("tests the stored key over verify, and writes nothing", async () => {
    const stored: LocalAiStatus = {
      ...UNSET,
      provider: "anthropic",
      unavailableReason: "unverified",
      settings: {
        ...UNSET.settings,
        provider: "anthropic",
        anthropic: { ...UNSET.settings.anthropic, hasKey: true },
      },
    };
    const { el, asked } = await paneWith(stored);
    asked.length = 0;
    await act(async () => { buttonSaying(el, /Test the stored key/)!.click(); });
    await settle();

    const calls = asked.filter((a) => a.command === "engine_request").map((a) => `${a.method} ${a.url}`);
    expect(calls).toEqual(["POST /local/ai/verify"]);
  });

  /**
   * PRESSING THE VENDOR ALREADY CHOSEN DOES NOTHING AT ALL.
   *
   * The old pane cleared the key field on every `onChange`, including the segment already
   * selected — so pasting a key and re-pressing the vendor you were already on silently emptied
   * the field, after which Save omitted the key and kept whatever was stored. A guard that
   * discards a credential nobody asked it to discard is its own defect. Real radios do not fire a
   * change for the checked member, and the form guards it a second time (`next === choice`), so
   * the press is not a write and nothing typed is lost.
   */
  it("writes nothing when the already-chosen vendor is pressed again", async () => {
    const { el, asked } = await paneWith(UNSET);
    await act(async () => { choiceSaying(el, /Anthropic/)!.click(); });
    await settle();
    const field = await typeKey(el, KEY);

    asked.length = 0;
    await act(async () => { choiceSaying(el, /Anthropic/)!.click(); });
    await settle();

    expect(asked.filter((a) => a.command === "engine_request"), "a re-press wrote").toEqual([]);
    expect(field.value, "a re-press silently dropped the key that was typed").toBe(KEY);
  });

  /**
   * THE MODEL LIST IS THE ENDPOINT'S, AND A NAME THAT IS NOT ON IT CANNOT BE SAVED.
   *
   * The old pane offered free-text inputs with a `<datalist>` hint, so a model the endpoint does
   * not have could be typed, saved and verified into `model_absent` — a round trip to discover a
   * typo. The `<select>`s are filled from `probe.models` and from nothing else. `READY` is the
   * realistic awkward case: the endpoint reports `llama3.2:latest` while the stored setting says
   * `llama3.2`, so nothing is selected and Save stays refused until somebody picks.
   */
  it("offers only the models the endpoint reported, and refuses a save until one is chosen", async () => {
    const { el } = await paneWith(READY);
    const classify = el.querySelector("#ai-classify") as HTMLSelectElement;
    expect(classify, "the model pickers are absent after a successful probe").toBeTruthy();

    const offered = [...classify.querySelectorAll("option")]
      .filter((o) => o.value !== "")
      .map((o) => o.value);
    expect(offered).toEqual(["llama3.2:latest"]);
    expect(classify.value, "a stored model the endpoint does not have was shown as chosen").toBe("");
    expect(buttonSaying(el, /Save models/)!.disabled).toBe(true);
  });

  it("saves the two chosen models and no address — the origin is the engine's", async () => {
    const { el, asked } = await paneWith(READY);
    const pick = async (id: string): Promise<void> => {
      const select = el.querySelector(id) as HTMLSelectElement;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
        setter.call(select, "llama3.2:latest");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await pick("#ai-classify");
    await pick("#ai-draft");

    asked.length = 0;
    const save = buttonSaying(el, /Save models/)!;
    expect(save.disabled, "both models are chosen and Save is still refused").toBe(false);
    await act(async () => { save.click(); });
    await settle();

    const puts = asked.filter((a) => a.command === "engine_request" && a.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!.body)).toEqual({
      provider: "ollama",
      ollama: { classifyModel: "llama3.2:latest", draftModel: "llama3.2:latest" },
    });
    // THE ANTI-EXFILTRATION INVARIANT, as traffic. No surface in the product sets the endpoint a
    // model is reached at, so no write from one may carry it.
    expect(puts[0]!.body, "a write from the form carried a base URL").not.toContain("baseUrl");
  });

  /**
   * A stored key must always have a way out.
   *
   * Selecting None clears the provider and KEEPS the sealed envelope, deliberately — switching
   * away is not an instruction to forget a credential. That makes this row the only route to the
   * deletion, and while its condition named the Anthropic key alone, a stored OpenAI key with no
   * provider selected had none: the row disappeared, and reaching it again meant re-selecting the
   * vendor whose key you were trying to remove.
   */
  it("offers Forget when only the OpenAI key is stored and no provider is chosen", async () => {
    const storedOpenAiOnly: LocalAiStatus = {
      ...UNSET,
      settings: {
        ...UNSET.settings,
        provider: null,
        openai: { classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1", hasKey: true },
      },
    };
    const { el } = await paneWith(storedOpenAiOnly);
    expect(buttonSaying(el, /^Forget$/), "a stored key with no provider had no route to deletion")
      .toBeTruthy();
  });

  it("still offers Forget for a stored Anthropic key, and none when nothing is stored", async () => {
    const anthropicOnly: LocalAiStatus = {
      ...UNSET,
      settings: {
        ...UNSET.settings,
        provider: null,
        anthropic: { classifyModel: "claude-haiku-4-5-20251001", draftModel: "claude-sonnet-5", hasKey: true },
      },
    };
    expect(buttonSaying((await paneWith(anthropicOnly)).el, /^Forget$/)).toBeTruthy();
    // …and the negative control, so the two above are not passing on a row that is always there.
    expect(buttonSaying((await paneWith(UNSET)).el, /^Forget$/)).toBeFalsy();
  });

  /**
   * THE HOSTED DOOR SHOWS NOTHING HERE, where it used to show "Model — latest Frontier Models".
   *
   * That row named no setting: nothing on the pane set it, nothing could test it, and the words
   * described whatever the hosted service happens to run this quarter. A settings row that names
   * no setting is a claim dressed as a control.
   */
  it("draws nothing on the hosted door", async () => {
    paneEngine(READY);
    const el = await render(h(DesktopAiSettings, { door: "cloud" as const }));
    expect(el.textContent?.trim()).toBe("");
  });
});
