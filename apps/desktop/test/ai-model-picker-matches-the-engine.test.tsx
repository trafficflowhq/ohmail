/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

/* THE ENGINE'S OWN PROBE, driven here — not a copy of its rule and not its exported matcher
   either. The question this file asks is whether the two SURFACES agree, so each side is
   reached the way the product reaches it: the transport through `probe()`, the form through a
   render of `AiProviderForm`. */
import { ollamaTransport } from "../../sidecar/src/ai-ollama.js";
import { AiProviderForm } from "../src/AiProviderForm.js";
import type { LocalAiStatus } from "../src/local-ai.js";
import en from "../../webapp/messages/en.json";

/**
 * THE PICKER AND THE VERDICT ASKED THE SAME QUESTION TWO WAYS.
 *
 * The form decided "is this model present" with `models.includes(classify)` — an exact name —
 * while the engine matches a family against its tag, so an Ollama install holding
 * `llama3.2:latest` and configured for `llama3.2` was verified OK by the engine and rendered
 * *Choose a model* with Save disabled, over a configuration that works.
 *
 * ── HOW TO WATCH THIS FAIL — both mutations were run, restored `cmp`-proved ─────────────────
 *  · `installedModelName` compares whole names (`installed.find((n) => n === wanted)`) → the
 *    paired case goes red at its ENGINE half (`model_absent` for a model the daemon has) and
 *    `test/model-name-one-definition.test.ts` reads zero files: one matcher, so one mutation
 *    moves both surfaces.
 *  · `value={models.includes(classify) ? classify : ""}` back in the form → the paired case
 *    goes red at `expected '' to be 'llama3.2:latest'` with the engine still answering ok —
 *    the released defect exactly — and that census names the second definition.
 */

const h = React.createElement;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** The three names a daemon reports for one family, a variant of it, and a second family. */
const INSTALLED = ["llama3.2:latest", "llama3.2-vision:latest", "mistral:7b"];

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as unknown as Host;

/** The shell's `engine_request` frame — length, metadata, bytes. `desktop-ai-verdict` does this too. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

/** An Ollama status with one configured model and the list the endpoint reported. */
function statusOf(model: string, models: string[], ok: boolean): LocalAiStatus {
  return {
    provider: "ollama",
    available: ok,
    unavailableReason: ok ? null : "unreachable",
    contentGoesTo: "this_machine",
    settings: {
      provider: "ollama",
      anthropic: { classifyModel: "claude-haiku-4-5", draftModel: "claude-sonnet-5", hasKey: false },
      openai: { classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1", hasKey: false },
      ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: model, draftModel: model },
    },
    probe: {
      ok,
      reason: ok ? null : "model_absent",
      detail: null,
      models,
      at: "2026-09-02T10:00:00.000Z",
    },
    canStoreKey: true,
  };
}

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  for (const el of hosts.splice(0)) el.remove();
  delete host.__TAURI_INTERNALS__;
});

async function mount(status: LocalAiStatus): Promise<HTMLElement> {
  host.__TAURI_INTERNALS__ = {
    invoke: async (command) => (command === "engine_request" ? encode(200, JSON.stringify(status)) : null),
  };
  const el = document.createElement("div");
  document.body.appendChild(el);
  hosts.push(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => {
    /* `children` in the props object, not as the third argument: the provider's props type
       requires it, and the positional form is the one the neighbouring suites have pinned. */
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "Europe/Zurich",
      children: h(AiProviderForm, null),
    }));
  });
  // The status arrives in an effect, so the first frame is always "asking the mail engine".
  await act(async () => { await Promise.resolve(); });
  return el;
}

/** The engine's verdict for `model` against `INSTALLED`, through its own transport. */
async function engineSays(model: string, models: string[]): Promise<string | null> {
  const fetchImpl = (async () => new Response(
    JSON.stringify({ models: models.map((name) => ({ name })) }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;
  const out = await ollamaTransport({
    baseUrl: "http://127.0.0.1:11434",
    classifyModel: model, draftModel: model, fetchImpl, timeoutMs: 1_000,
  }).probe();
  return out.ok ? null : out.reason;
}

const select = (el: HTMLElement, id: string): HTMLSelectElement =>
  el.querySelector<HTMLSelectElement>(`#${id}`)!;

describe("the model picker and the engine ask one question", () => {
  it("ONE INPUT, BOTH MATCHERS: a family name the engine accepts is the name the picker shows", async () => {
    // The ENGINE half, first, so the case is about two readings of one fact and not about a fixture.
    expect(await engineSays("llama3.2", INSTALLED), "the engine refused a model it has").toBeNull();

    const el = await mount(statusOf("llama3.2", INSTALLED, true));
    const classify = select(el, "ai-classify");
    expect(classify, "the picker was not rendered — the list should be the endpoint's three").toBeTruthy();
    /* The endpoint's own name, not the stored family and not the placeholder: the form resolved
       the stored `llama3.2` to the installed `llama3.2:latest` the way the engine did. */
    expect(classify.value).toBe("llama3.2:latest");
    expect(select(el, "ai-draft").value).toBe("llama3.2:latest");

    /* AND SAVE IS REACHABLE. The exact-match form disabled it whenever EITHER stored model was a
       family name, so a person who picked a different model could not store the choice. */
    const save = [...el.querySelectorAll("button")].find((b) => b.textContent === en.aiProvider.save)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(classify, "mistral:7b");
      classify.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(save.disabled, "Save stayed disabled over two models the endpoint listed").toBe(false);
  });

  it("POSITIVE CONTROL: a model the endpoint does not have still renders Choose a model", async () => {
    const absent = ["mistral:7b"];
    expect(await engineSays("llama3.2", absent), "the engine accepted an absent model").toBe("model_absent");

    const el = await mount(statusOf("llama3.2", absent, false));
    const classify = select(el, "ai-classify");
    expect(classify.value, "an absent model selected a name anyway").toBe("");
    expect(classify.querySelector("option")!.textContent).toBe(en.aiProvider.modelChoose);
  });

  it("a vision variant is NOT the family, on both sides", async () => {
    expect(await engineSays("llama3.2", ["llama3.2-vision:latest"])).toBe("model_absent");
    const el = await mount(statusOf("llama3.2", ["llama3.2-vision:latest"], false));
    expect(select(el, "ai-classify").value).toBe("");
  });
});
