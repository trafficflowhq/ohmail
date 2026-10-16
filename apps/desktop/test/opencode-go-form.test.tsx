/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { AiProviderForm } from "../src/AiProviderForm.js";
import type { LocalAiStatus } from "../src/local-ai.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: unknown } }
const host = globalThis as unknown as Host;

function encode(status: number, body: unknown): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const initialStatus = (): LocalAiStatus => ({
  provider: null,
  available: false,
  unavailableReason: "not_configured",
  contentGoesTo: null,
  settings: {
    provider: null,
    anthropic: { classifyModel: "claude-haiku-4-5-20251001", draftModel: "claude-sonnet-5", hasKey: false },
    openai: { classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1", hasKey: false },
    opencodeGo: { classifyModel: "", draftModel: "", hasKey: false },
    ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama3.2", draftModel: "llama3.2" },
  },
  probe: null,
  canStoreKey: true,
} as LocalAiStatus);

const GO_MODELS = ["glm-5.3-flash", "kimi-k3", "deepseek-v4.1-flash"];

function goVerifiedStatus(options: {
  classifyModel?: string; draftModel?: string; hasKey?: boolean; models?: string[];
} = {}): LocalAiStatus {
  return {
    ...initialStatus(),
    provider: "opencode-go",
    available: true,
    unavailableReason: null,
    contentGoesTo: "opencode-go",
    settings: {
      ...initialStatus().settings,
      provider: "opencode-go",
      opencodeGo: {
        classifyModel: options.classifyModel ?? "glm-5.3-flash",
        draftModel: options.draftModel ?? "kimi-k3",
        hasKey: options.hasKey ?? true,
      },
    },
    probe: {
      ok: true, reason: null, detail: null, models: options.models ?? GO_MODELS,
      at: "2026-10-15T12:00:00.000Z",
    },
  } as LocalAiStatus;
}

function goKeyAbsentStatus(): LocalAiStatus {
  return {
    ...goVerifiedStatus({ hasKey: false }),
    available: false,
    unavailableReason: "key_absent",
    probe: { ok: false, reason: "credential", detail: null, models: [], at: "2026-10-15T12:00:00.000Z" },
  } as LocalAiStatus;
}

function inactiveGoKeyStatus(): LocalAiStatus {
  return {
    ...initialStatus(),
    settings: { ...initialStatus().settings, opencodeGo: { classifyModel: "", draftModel: "", hasKey: true } },
  } as LocalAiStatus;
}

let root: Root | null = null;
let mount: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  mount?.remove();
  root = null;
  mount = null;
  delete host.__TAURI_INTERNALS__;
});

type BridgeWrite = Record<string, unknown>;
type WriteResponse = (write: BridgeWrite, previous: LocalAiStatus) => LocalAiStatus;

async function render(
  locale: "en" | "de",
  initial: LocalAiStatus = initialStatus(),
  respondToWrite: WriteResponse = (_write, previous) => previous,
  onStatus?: (status: LocalAiStatus | null) => void,
): Promise<{ element: HTMLElement; writes: BridgeWrite[]; requests: Array<{ method: string; url: string; body: string }> }> {
  const bridge = { status: initial, writes: [] as BridgeWrite[], requests: [] as Array<{ method: string; url: string; body: string }> };
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command !== "engine_request") return null;
      const method = String(payload?.method ?? "GET");
      const url = String(payload?.url ?? "");
      const bytes = Uint8Array.from((payload?.body as number[] | undefined) ?? []);
      const body = new TextDecoder().decode(bytes);
      bridge.requests.push({ method, url, body });
      if (method === "GET" && url === "/local/ai") return encode(200, bridge.status);
      if (method === "PUT" && url === "/local/ai") {
        const write = JSON.parse(body) as BridgeWrite;
        bridge.writes.push(write);
        bridge.status = respondToWrite(write, bridge.status);
        return encode(200, bridge.status);
      }
      return encode(200, bridge.status);
    },
  };
  mount = document.createElement("div");
  document.body.appendChild(mount);
  root = createRoot(mount);
  const messages = locale === "de" ? de : en;
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: messages as never, timeZone: "Europe/Zurich", children: h(AiProviderForm, { onStatus }),
    }));
  });
  await act(async () => { await Promise.resolve(); });
  return { element: mount, writes: bridge.writes, requests: bridge.requests };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function chooseProvider(element: HTMLElement, provider: string): Promise<void> {
  const radio = element.querySelector<HTMLInputElement>(`input[name="ai-provider"][value="${provider}"]`);
  if (!radio) throw new Error(`provider radio ${provider} was not rendered`);
  await act(async () => radio.click());
  await settle();
}

async function changeValue(control: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  if (!setter) throw new Error("form control has no native value setter");
  await act(async () => {
    setter.call(control, value);
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonWithText(element: HTMLElement, text: string): HTMLButtonElement {
  const button = [...element.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`button ${text} was not rendered`);
  return button;
}

/** The real SettingsRow names itself by aria-labelledby; find it by that label's text. */
function rowLabelled(element: HTMLElement, label: string): Element | undefined {
  return [...element.querySelectorAll('[role="group"]')].find((row) => {
    const id = row.getAttribute("aria-labelledby");
    return id !== null && element.ownerDocument.getElementById(id)?.textContent === label;
  });
}

describe("OpenCode Go in the shared onboarding/settings provider form", () => {
  it("offers OpenCode Go as a distinct provider in both shipped locales", async () => {
    const { element: english } = await render("en");
    const englishGo = english.querySelector<HTMLInputElement>('input[name="ai-provider"][value="opencode-go"]');
    expect(englishGo).toBeTruthy();
    expect(english.textContent).toContain(en.aiProvider.choiceOpenCodeGo);

    await act(async () => root!.unmount());
    mount?.remove();
    root = null;
    mount = null;

    const { element: german } = await render("de");
    const germanGo = german.querySelector<HTMLInputElement>('input[name="ai-provider"][value="opencode-go"]');
    expect(germanGo).toBeTruthy();
    expect(german.textContent).toContain(de.aiProvider.choiceOpenCodeGo);
  });

  it("keeps Go key writes isolated, lets classification and drafting choose separate bare IDs, and labels the read as non-inference", async () => {
    const typedKey = "fictional-go-key-used-only-in-this-test";
    const landed: Array<LocalAiStatus | null> = [];
    const respond = (write: BridgeWrite, previous: LocalAiStatus): LocalAiStatus => {
      const go = write.opencodeGo as Record<string, unknown> | undefined;
      if (go?.apiKey) return goVerifiedStatus();
      if (go && ("classifyModel" in go || "draftModel" in go)) {
        return goVerifiedStatus({
          classifyModel: String(go.classifyModel),
          draftModel: String(go.draftModel),
        });
      }
      if (write.provider === "opencode-go") return goKeyAbsentStatus();
      if (write.provider === "openai") {
        return {
          ...previous,
          provider: "openai",
          available: false,
          unavailableReason: "key_absent",
          contentGoesTo: "openai",
          settings: { ...previous.settings, provider: "openai" },
        } as LocalAiStatus;
      }
      return previous;
    };
    const { element, writes, requests } = await render("en", initialStatus(), respond, (status) => landed.push(status));

    await chooseProvider(element, "opencode-go");
    expect(writes[0]).toEqual({ provider: "opencode-go" });
    expect(element.textContent).toContain(en.aiProvider.verdictNoGoKey);
    const summary = rowLabelled(element, en.aiProvider.summaryLabel);
    expect(summary?.textContent).toContain(en.aiProvider.choiceOpenCodeGoWhy);

    const keyInput = element.querySelector<HTMLInputElement>("#ai-key")!;
    await changeValue(keyInput, typedKey);
    const keyForm = element.querySelector<HTMLFormElement>("form")!;
    await act(async () => keyForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();

    expect(writes[1]).toEqual({ provider: "opencode-go", opencodeGo: { apiKey: typedKey } });
    expect(JSON.stringify(writes[1])).not.toContain("openai");
    expect(JSON.stringify(writes[1])).not.toContain("anthropic");
    expect(keyInput.value).toBe("");
    expect(element.textContent).toContain(en.aiProvider.goConfigVerified);
    expect(element.textContent).toContain(en.aiProvider.goInferenceNotTested);
    expect(element.textContent).toContain(en.aiProvider.goPrivacyBilling);
    const configuredSummary = rowLabelled(element, en.aiProvider.summaryLabel);
    expect(configuredSummary?.textContent).toContain(en.aiProvider.summaryGoVerified);
    expect(configuredSummary?.textContent).not.toContain(en.aiProvider.summaryOn);

    const verifyStored = buttonWithText(element, en.aiProvider.goVerifyStoredKey);
    await act(async () => verifyStored.click());
    await settle();
    expect(requests.at(-1)).toEqual({ method: "POST", url: "/local/ai/verify", body: "" });
    expect(writes).toHaveLength(2);

    expect(element.querySelector("#ai-classify option[value='glm-5.3-flash']")).toBeTruthy();
    expect(element.querySelector("#ai-classify option[value='deepseek-v4.1-flash']")).toBeTruthy();
    expect(element.querySelector("#ai-draft option[value='kimi-k3']")).toBeTruthy();
    expect(element.querySelector("#ai-classify option[value='opencode-go/deepseek-v4.1-flash']")).toBeNull();

    await changeValue(element.querySelector<HTMLSelectElement>("#ai-classify")!, "deepseek-v4.1-flash");
    await changeValue(element.querySelector<HTMLSelectElement>("#ai-draft")!, "kimi-k3");
    const saveModels = buttonWithText(element, en.aiProvider.save);
    expect(saveModels.disabled).toBe(false);
    await act(async () => saveModels.click());
    await settle();

    expect(writes[2]).toEqual({
      provider: "opencode-go",
      opencodeGo: { classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3" },
    });
    expect(landed.at(-1)).toMatchObject({
      provider: "opencode-go", available: true, unavailableReason: null,
      settings: { opencodeGo: { classifyModel: "deepseek-v4.1-flash", draftModel: "kimi-k3", hasKey: true } },
    });

    await changeValue(keyInput, "second-unsaved-fixture-key");
    await chooseProvider(element, "openai");
    expect(writes[3]).toEqual({ provider: "openai" });
    expect(JSON.stringify(writes[3])).not.toContain(typedKey);
    expect(JSON.stringify(writes[3])).not.toContain("second-unsaved-fixture-key");
    expect(element.querySelector<HTMLInputElement>("#ai-key")?.value).toBe("");
    expect(landed.at(-1)?.settings.opencodeGo.hasKey).toBe(true);
  });

  it("does not claim Go is configured when verified config has no selected models", async () => {
    const incomplete = goVerifiedStatus();
    const status = {
      ...incomplete,
      available: false,
      unavailableReason: "unverified",
      settings: {
        ...incomplete.settings,
        opencodeGo: { classifyModel: "", draftModel: "", hasKey: true },
      },
    } as LocalAiStatus;
    const { element } = await render("en", status);

    expect(element.textContent).toContain(en.aiProvider.verdictGoUntested);
    expect(element.textContent).not.toContain(en.aiProvider.goConfigVerified);
    const summary = rowLabelled(element, en.aiProvider.summaryLabel);
    expect(summary?.textContent).toContain(en.aiProvider.summaryUntested);
    expect(summary?.textContent).not.toContain(en.aiProvider.summaryGoVerified);
  });

  it("shows the German recipient and account-control disclosure and keeps Forget for an inactive Go key", async () => {
    const { element } = await render("de", goVerifiedStatus());
    expect(element.textContent).toContain(de.aiProvider.choiceOpenCodeGoWhy);
    expect(element.textContent).toContain(de.aiProvider.goPrivacyBilling);
    expect(element.textContent).toContain(de.aiProvider.goConfigVerified);
    expect(element.textContent).toContain(de.aiProvider.goInferenceNotTested);
    const summary = rowLabelled(element, de.aiProvider.summaryLabel);
    expect(summary?.textContent).toContain(de.aiProvider.choiceOpenCodeGoWhy);
    expect(summary?.textContent).toContain(de.aiProvider.summaryGoVerified);
    expect(summary?.textContent).not.toContain(de.aiProvider.summaryOn);

    await act(async () => root!.unmount());
    mount?.remove();
    root = null;
    mount = null;
    const inactive = await render("de", inactiveGoKeyStatus());
    expect(buttonWithText(inactive.element, de.aiProvider.forget).textContent).toBe(de.aiProvider.forget);
  });

  it.each([["en", en], ["de", de]] as const)(
    "keeps free and preview models on offer and labels them (%s)",
    async (locale, cat) => {
      const models = ["kimi-k3", "hy4-preview", "step-5-preview-free", "cat-jam-free"];
      const { element } = await render(locale, goVerifiedStatus({ models }));
      const offered = (id: string) =>
        [...element.querySelectorAll<HTMLOptionElement>("#ai-classify option")].find((o) => o.value === id);
      const free = cat.aiProvider.goModelFree;
      const preview = cat.aiProvider.goModelPreview;

      expect(offered("kimi-k3")?.textContent).toBe("kimi-k3");
      expect(offered("hy4-preview")?.textContent).toBe(`hy4-preview (${preview})`);
      expect(offered("step-5-preview-free")?.textContent).toBe(`step-5-preview-free (${free}, ${preview})`);
      expect(offered("cat-jam-free")?.textContent).toBe(`cat-jam-free (${free})`);
      expect(offered("cat-jam-free")?.disabled).toBe(false);
      // The tier note sits beside the account note, and says what the labels mean.
      expect(element.textContent).toContain(cat.aiProvider.goPrivacyBilling);
      expect(element.textContent).toContain(cat.aiProvider.goFreePreviewNote);
    },
  );
});
