/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, createTranslator } from "next-intl";

import { AiProviderForm, alreadyStopped, ollamaHost, ollamaIsLocal, verdictOf } from "../src/AiProviderForm.js";
import type { AiProbeFailure, AiProbeReport, AiUnavailableReason, LocalAiStatus } from "../src/local-ai.js";
import { setActiveCatalog } from "../../webapp/app/shell/locale.js";
import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * "TEST CONNECTION" HAS TO ANSWER WHERE THE PERSON IS LOOKING — and it has to say something
 * different for every way the answer can go.
 *
 * ── THE DEFECT THIS FILE WAS OPENED FOR ─────────────────────────────────────────────────────
 *
 * Pressing the button appeared to do nothing. It was doing everything: the engine was asked, it
 * answered, and the pane rendered the verdict — into a paragraph mounted near the TOP of the pane,
 * while the button sat at the BOTTOM behind the provider's own fields. So the one thing that
 * changed was above the fold, the label went "Testing…" and straight back, and the honest reading
 * from the chair is that the control is dead. A control whose outcome renders outside the region
 * the person is looking at reports NOTHING, and a test action that reports nothing is
 * indistinguishable from one that is not wired up — which is how it was reported.
 *
 * ── AND THE SECOND HALF, WHICH IS WHAT THE VERDICT BLOCK IS FOR ─────────────────────────────
 *
 * A verdict surface is worth having only if the verdicts DIFFER. There are twelve outcomes the
 * form can be in and each one has a different recovery — paste the key again, start Ollama, pick a
 * model from the list, wait, or nothing at all because this is the resting state. So each is
 * pinned on its own below rather than by a "they are all distinct" set count: a set count passes
 * when two arms are wrong in different ways, and the arms nobody reaches by hand
 * (`key_unreadable`, `internal`) are exactly the ones that rot.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 *  · In `AiProviderForm.tsx`, move the `<SettingsVerdict>` above the `<SettingsChoice>` → the
 *    document-order case goes red. Restore it and it goes green. Run.
 *  · Delete any one arm of `verdictOf`'s inner switch → that outcome's case goes red, and the
 *    `bad`/`off` state assertion catches the arms that fall through to a neighbour. Run for
 *    `model_absent` and for `key_unreadable`.
 *  · Make `ollamaIsLocal` return true unconditionally → the remote-origin case goes red, which is
 *    the one that keeps "nothing leaves this computer" from being said about a server elsewhere.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

type Copy = Parameters<typeof verdictOf>[1];
const t = createTranslator({ locale: "en", messages: en as never, namespace: "aiProvider" }) as unknown as Copy;
const tDe = createTranslator({ locale: "de", messages: de as never, namespace: "aiProvider" }) as unknown as Copy;

const AT = "2026-09-02T10:00:00.000Z";
const NOW = new Date(AT).getTime() + 120_000;

const probe = (o: Partial<AiProbeReport> = {}): AiProbeReport => ({
  ok: false, reason: null, detail: null, models: [], at: AT, ...o,
});

/** A status in exactly the shape the engine sends, with one outcome selected. */
function statusOf(o: {
  provider?: LocalAiStatus["provider"];
  available?: boolean;
  reason?: AiUnavailableReason | null;
  probe?: AiProbeReport | null;
  ollamaBaseUrl?: string;
}): LocalAiStatus {
  const provider = o.provider === undefined ? "anthropic" : o.provider;
  return {
    provider,
    available: o.available ?? false,
    unavailableReason: o.reason ?? null,
    contentGoesTo: provider === "ollama" ? "this_machine" : provider,
    settings: {
      provider,
      anthropic: { classifyModel: "claude-haiku-4-5", draftModel: "claude-sonnet-5", hasKey: true },
      openai: { classifyModel: "gpt-4.1-mini", draftModel: "gpt-4.1", hasKey: true },
      ollama: {
        baseUrl: o.ollamaBaseUrl ?? "http://127.0.0.1:11434",
        classifyModel: "llama3.2",
        draftModel: "llama3.2",
      },
    },
    probe: o.probe === undefined ? null : o.probe,
    canStoreKey: true,
  };
}

/** One `unreachable` status carrying a probe failure — the six arms of the inner switch. */
const failing = (reason: AiProbeFailure, o: Partial<Parameters<typeof statusOf>[0]> = {}): LocalAiStatus =>
  statusOf({ reason: "unreachable", probe: probe({ reason }), ...o });

describe("verdictOf — one sentence per outcome, and they are the endpoint's own", () => {
  it("wait: a write in flight names the provider it is asking", () => {
    const v = verdictOf(statusOf({}), t, NOW, "openai");
    expect(v.state).toBe("wait");
    expect(v.headline).toContain("OpenAI");
    // …and never the vendor that is merely stored: the form is asking about the NEW one.
    expect(v.headline).not.toContain("Anthropic");
  });

  it("off: nothing chosen is a state, not a fault", () => {
    const v = verdictOf(statusOf({ provider: null }), t, NOW, null);
    expect(v.state).toBe("off");
    expect(v.headline).toBe(en.aiProvider.summaryOff);
    expect(v.when, "an unasked question has no timestamp").toBeUndefined();
  });

  it("ok: ready names BOTH models, because they can differ", () => {
    const v = verdictOf(
      statusOf({ available: true, probe: probe({ ok: true, models: ["claude-haiku-4-5", "claude-sonnet-5"] }) }),
      t, NOW, null,
    );
    expect(v.state).toBe("ok");
    expect(v.headline).toContain("claude-haiku-4-5");
    expect(v.headline).toContain("claude-sonnet-5");
    // The stamp is the checkable half — "it worked" is worth nothing without "when".
    expect(v.when).toMatch(/2 minutes ago/);
  });

  it("key_absent: an off state with the next step, not an error", () => {
    const v = verdictOf(statusOf({ reason: "key_absent" }), t, NOW, null);
    expect(v.state).toBe("off");
    expect(v.headline).toBe(en.aiProvider.verdictNoKey);
    expect(v.detail).toBe(en.aiProvider.verdictNoKeyDetail);
  });

  it("unverified: nothing is offered until the test passes, and it says so", () => {
    const v = verdictOf(statusOf({ reason: "unverified" }), t, NOW, null);
    expect(v.state).toBe("off");
    expect(v.headline).toBe(en.aiProvider.verdictUntested);
    expect(v.detail).toBe(en.aiProvider.verdictUntestedDetail);
  });

  it("key_unreadable: the keychain, not the key — a different recovery from a rejection", () => {
    const v = verdictOf(statusOf({ reason: "key_unreadable" }), t, NOW, null);
    expect(v.state).toBe("bad");
    expect(v.headline).toBe(en.aiProvider.verdictCredential);
    // The one arm that must NOT read as "the vendor said no": nothing was sent to the vendor.
    expect(v.headline).not.toContain("Anthropic");
  });

  it("unauthorized: the vendor rejected the key, and points at the vendor's console", () => {
    const v = verdictOf(failing("unauthorized"), t, NOW, null);
    expect(v.state).toBe("bad");
    expect(v.headline).toContain("Anthropic");
    expect(v.detail).toContain("Anthropic");
    expect(v.when).toMatch(/2 minutes ago/);
  });

  it("timeout: too slow is not the same as absent", () => {
    const v = verdictOf(failing("timeout"), t, NOW, null);
    expect(v.state).toBe("bad");
    expect(v.headline).toBe(en.aiProvider.verdictTimeout.replace("{vendor}", "Anthropic"));
  });

  /**
   * `probe.detail` IS A SENTENCE, AND THIS CASE USED TO PROVE THE OPPOSITE.
   *
   * It fed the fixture `detail: "claude-old-1"` — a model id — and asserted the headline
   * contained it, which passed while the engine has never sent one. What it actually writes is
   * `the model server is running and does not have "llama3.2"` (`ai-ollama.ts:244`) and
   * `"gpt-x" is not a chat model, …` (`ai-openai.ts:336`). Interpolated into "The key works, but
   * {model} is not on its list" that produced a mangled sentence, and on Ollama it announced that
   * a key works to somebody who has no key. The fixture now carries what the engine sends.
   */
  it("model_absent: our frame, the engine's sentence, and the repair", () => {
    const said = 'the model server is running and does not have "llama3.2"';
    const v = verdictOf(
      statusOf({
        provider: "ollama",
        reason: "unreachable",
        probe: probe({ reason: "model_absent", detail: said, models: ["mistral", "qwen2.5", "phi3"] }),
      }),
      t, NOW, null,
    );
    expect(v.state).toBe("bad");
    // OURS, translated, and true of a provider that has no key.
    expect(v.headline).toBe(en.aiProvider.verdictModelAbsent);
    expect(v.headline, "an Ollama user was told their key works").not.toMatch(/key/i);
    /* `model_absent` COVERS TWO CAUSES and the headline must be true of both. `ai-openai.ts:329-338`
       raises it for a model that EXISTS and cannot chat (`text-embedding-3-small`), so a headline
       saying the endpoint does not HAVE it contradicts the engine's own detail underneath it. */
    expect(v.headline, "the headline claims absence, which is false of an unusable-but-present model")
      .not.toMatch(/does not have|not on its list|nicht hat|hat das angeforderte/i);
    // The engine's own words, WHOLE and terminated, plus the pointer that repairs it. The engine
    // writes no full stop of its own, so an unjoined "{said} Pick one…" ran two sentences together.
    expect(v.detail).toContain(`${said}. Pick`);
    expect(v.detail).toContain("3");
  });

  it("…and the same headline is true when the model EXISTS and merely cannot chat", () => {
    const said = '"text-embedding-3-small" is not a chat model, so it cannot answer suggestions or drafts';
    const v = verdictOf(
      statusOf({
        provider: "openai",
        reason: "unreachable",
        probe: probe({ reason: "model_absent", detail: said, models: ["gpt-4.1-mini", "gpt-4.1"] }),
      }),
      t, NOW, null,
    );
    expect(v.state).toBe("bad");
    expect(v.headline).toBe(en.aiProvider.verdictModelAbsent);
    // The block may not contradict itself: the detail says the model is present and unusable.
    expect(v.detail).toContain("is not a chat model");
    expect(v.detail).toContain(`${said}. Pick`);
  });

  /**
   * NOT EVERY `detail` IS UNTERMINATED, and the round-2 fix assumed they all were.
   *
   * Two of the three `model_absent` details are ours and end without a stop. The third is the
   * VENDOR'S OWN 404 body, forwarded verbatim by `shortDetail` (`ai-transport.ts:116-120`) — which
   * also appends `…` when it truncates at 240 characters. Unconditionally appending "." to those
   * rendered `Not found.. Pick one of…` and `…. Pick one of…`.
   */
  it.each([
    ['the model server is running and does not have "llama3.2"', true],
    ['"gpt-x" is not a chat model, so it cannot answer suggestions or drafts', true],
    ["Not found.", false],
    ["model: unknown_model?", false],
    ["a very long upstream error the transport had to cut short…", false],
    ['the server said "no such model."', false],
  ])("%s → a stop is added: %s", (said, needsStop) => {
    expect(alreadyStopped(said)).toBe(!needsStop);
    const v = verdictOf(
      statusOf({ reason: "unreachable", probe: probe({ reason: "model_absent", detail: said, models: ["a"] }) }),
      t, NOW, null,
    );
    expect(v.detail).toContain(said);
    expect(v.detail, "a detail that already ended itself was given a second stop").not.toMatch(/\.\.|…\./);
  });

  it("…and says something sensible when the engine sent no sentence", () => {
    const v = verdictOf(
      statusOf({ reason: "unreachable", probe: probe({ reason: "model_absent", models: ["a", "b"] }) }),
      t, NOW, null,
    );
    expect(v.detail?.startsWith(" "), "an absent detail left a leading space").toBe(false);
    expect(v.detail).toContain("2");
  });

  it("bad_response: the endpoint answered, and ohmail could not read it", () => {
    const v = verdictOf(failing("bad_response"), t, NOW, null);
    expect(v.state).toBe("bad");
    expect(v.headline).toBe(en.aiProvider.verdictBadResponse.replace("{vendor}", "Anthropic"));
  });

  it("internal: our fault, said as our fault", () => {
    const v = verdictOf(failing("internal"), t, NOW, null);
    expect(v.state).toBe("bad");
    expect(v.headline).toBe(en.aiProvider.verdictInternal);
  });

  it("unreachable, hosted: names the literal host the request would go to", () => {
    const v = verdictOf(failing("unreachable"), t, NOW, null);
    expect(v.state).toBe("bad");
    expect(v.headline).toContain("api.anthropic.com");
  });

  it("unreachable, Ollama: names the stored origin and asks the question that fixes it", () => {
    const v = verdictOf(failing("unreachable", { provider: "ollama" }), t, NOW, null);
    expect(v.state).toBe("bad");
    expect(v.headline).toContain("127.0.0.1:11434");
    expect(v.headline).toMatch(/Is Ollama running\?/);
  });

  /**
   * THE ADDRESS IS READ OFF THE ENGINE, NOT WRITTEN INTO THE COPY.
   *
   * The form no longer offers an address field, so a literal in the sentence would be a claim
   * about a value this window can no longer see change — and an install that stored a remote
   * Ollama while the field existed still holds it. The verdict names what the engine holds.
   */
  it("…and it is the engine's origin, not a constant", () => {
    const v = verdictOf(
      failing("unreachable", { provider: "ollama", ollamaBaseUrl: "http://box.lan:11434" }),
      t, NOW, null,
    );
    expect(v.headline).toContain("box.lan:11434");
    expect(v.headline).not.toContain("127.0.0.1");
  });

  /**
   * BOTH HALVES OF THE VERDICT FOLLOW THE LANGUAGE, and they get there by two different routes.
   *
   * The sentence comes from the translator passed in. The "Checked 2 minutes ago" stamp does NOT —
   * `agoStamp` reads the app's active-catalogue register (`setActiveCatalog`, the non-hook seam
   * `format.ts` documents), because it is called from helpers that take no translator. In the app
   * one provider sets both on the same pass, so they cannot disagree; in a test they can, and this
   * case sets the register on purpose so a German verdict is asserted whole rather than half.
   */
  it("speaks German when the catalogue is German — sentence and stamp both", () => {
    setActiveCatalog("de", de as never);
    try {
      const v = verdictOf(failing("unauthorized"), tDe, NOW, null);
      expect(v.headline).toBe("Anthropic hat den Schlüssel abgelehnt.");
      expect(v.when).toMatch(/vor 2 Minuten/);
    } finally {
      setActiveCatalog("en", en as never);
    }
  });
});

describe("the Ollama origin decides which sentence may be said about it", () => {
  it.each([
    ["http://127.0.0.1:11434", true],
    ["http://127.1.2.3:11434", true],
    ["http://localhost:11434", true],
    ["http://box.lan:11434", false],
    ["https://ollama.example.test", false],
    ["not a url", false],
  ])("%s is local: %s", (base, local) => {
    expect(ollamaIsLocal(base)).toBe(local);
  });

  it("shows the host, and echoes a value it cannot parse rather than inventing one", () => {
    expect(ollamaHost("http://127.0.0.1:11434")).toBe("127.0.0.1:11434");
    expect(ollamaHost("nonsense")).toBe("nonsense");
  });
});

/* ── the rendered form: the answer lands where the press was ───────────────────────────── */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as unknown as Host;

/** Encode an answer exactly as the shell's `engine_request` does — length, metadata, bytes. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
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
    root.render(
      h(
        NextIntlClientProvider,
        { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
        h(AiProviderForm, null),
      ),
    );
  });
  /* One more turn: the form reads its status in an effect, so the first render is always the
     "asking the mail engine" frame and every assertion belongs after the answer has landed. */
  await act(async () => { await Promise.resolve(); });
  return el;
}

describe("the model form's test action reports to the person who pressed it", () => {
  it("puts the verdict at or after the button, never only above it", async () => {
    const ready = statusOf({
      provider: "ollama",
      available: true,
      probe: probe({ ok: true, models: ["llama3.2", "llama3.2:1b"] }),
    });
    const el = await mount(ready);

    const button = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === en.aiProvider.testServer,
    );
    expect(button, "the model-server test button is not on this form").toBeTruthy();

    await act(async () => { button!.click(); });
    await act(async () => { await Promise.resolve(); });

    const verdict = el.querySelector(".set-verdict");
    expect(verdict, "pressing the test produced no verdict block anywhere").toBeTruthy();

    const rel = button!.compareDocumentPosition(verdict!);
    expect(
      (rel & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      "the only answer to the test renders above the button that asked for it — from the chair, " +
        "pressing it changes nothing",
    ).toBe(true);
  });

  it("is a live region, so the outcome reaches somebody not watching the pixels", async () => {
    const el = await mount(statusOf({ provider: "ollama", reason: "unverified" }));
    const verdict = el.querySelector(".set-verdict");
    expect(verdict?.getAttribute("role")).toBe("status");
    expect(verdict?.getAttribute("aria-live")).toBe("polite");
  });

  it("shows no verdict at all when nothing is chosen — there is no answer to report", async () => {
    const el = await mount(statusOf({ provider: null }));
    expect(el.querySelector(".set-verdict")).toBeNull();
  });
});
