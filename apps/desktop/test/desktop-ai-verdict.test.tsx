/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import { DesktopAiSettings } from "../src/DesktopAiSettings.js";
import { probeLine, type AiProbeReport } from "../src/local-ai.js";

/**
 * "TEST CONNECTION" HAS TO ANSWER WHERE THE PERSON IS LOOKING.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * Pressing the button appeared to do nothing. It was doing everything: the engine was asked, it
 * answered, and the pane rendered the verdict — into a paragraph mounted immediately after the
 * "State" row, which is near the TOP of the pane. The button lives in the "Save and test" row
 * near the BOTTOM, behind the provider's own fields (a key, two model names, an address). So the
 * one thing that changed was above the fold, the button's label went "Testing…" and straight back
 * to "Test connection", and the honest reading from the chair is that the control is dead.
 *
 * This is not a cosmetic complaint about spacing. A control whose outcome renders outside the
 * region the person is looking at reports NOTHING, and a test action that reports nothing is
 * indistinguishable from one that is not wired up — which is exactly how it was reported.
 *
 * ── WHAT IS AND IS NOT WRONG HERE ───────────────────────────────────────────────────────────
 *
 * The SENTENCES were never the problem and are not changed: `probeLine` already answers every
 * outcome the endpoint can produce with its own words — answered (with how many models it has,
 * which is the fact that makes "it works" checkable), nothing at that address, too slow, key
 * rejected, model absent, unreadable answer, no key, and our own fault. The second test below
 * pins that they stay DISTINCT, because a verdict surface is only worth having if the verdicts
 * differ.
 *
 * What was wrong is that none of them was delivered to the control that asked for them.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * In `DesktopAiSettings.tsx`, delete the `said`/`problem` paragraph from the "Save and test"
 * row's `control` and leave only the copy above the "Where the model comes from" row. The first
 * test goes red on the document-order assertion; restore it and it goes green. That mutation was
 * run.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

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

/** The engine's answer for a standalone install with a local model configured. */
function statusBody(probe: AiProbeReport): string {
  return JSON.stringify({
    provider: "ollama",
    available: probe.ok,
    unavailableReason: probe.ok ? null : "probe_failed",
    contentGoesTo: "this_machine",
    probe,
    canStoreKey: true,
    settings: {
      anthropic: { classifyModel: "claude-x", draftModel: "claude-x", hasKey: false },
      openai: { classifyModel: "gpt-x", draftModel: "gpt-x", hasKey: false },
      ollama: { baseUrl: "http://127.0.0.1:11434", classifyModel: "llama", draftModel: "llama" },
    },
  });
}

/** A shell whose engine answers both the read and the verify POST with the same status. */
function armBridge(probe: AiProbeReport): void {
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, _payload) => {
      if (command !== "engine_request") return null;
      return encode(200, statusBody(probe));
    },
  };
}

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  for (const el of hosts.splice(0)) el.remove();
  delete host.__TAURI_INTERNALS__;
});

async function mount(probe: AiProbeReport): Promise<HTMLElement> {
  armBridge(probe);
  const el = document.createElement("div");
  document.body.appendChild(el);
  hosts.push(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => {
    root.render(h(DesktopAiSettings, { door: "local" }));
  });
  /* One more turn: the pane reads its status in an effect, so the first render is always the
     "asking the mail engine" frame and every assertion belongs after the answer has landed. */
  await act(async () => { await Promise.resolve(); });
  return el;
}

const OK_PROBE: AiProbeReport = { ok: true, models: ["llama", "llama3"], reason: null, detail: null, at: new Date().toISOString() };

describe("the model pane's Test connection reports to the person who pressed it", () => {
  it("puts the verdict with the button, not only at the top of the pane", async () => {
    const el = await mount(OK_PROBE);

    const button = [...el.querySelectorAll("button")].find((b) => b.textContent === "Test connection");
    expect(button, "the Test connection button is not on this pane").toBeTruthy();

    await act(async () => {
      button!.click();
    });

    /* THE CLAIM. Somewhere at or after the control there is now a sentence about what happened.
       "After" is the whole assertion: the pane has always rendered a verdict ABOVE, behind the
       provider's fields, and that is the arrangement that reads as a dead button. */
    const verdicts = [...el.querySelectorAll("p")].filter((p) => (p.textContent ?? "").includes("Answered"));
    expect(verdicts.length, "pressing Test connection produced no sentence anywhere").toBeGreaterThan(0);

    const atControl = verdicts.some((p) => {
      const rel = button!.compareDocumentPosition(p);
      return (rel & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 || button!.parentElement?.contains(p) === true;
    });
    expect(
      atControl,
      "the only answer to Test connection renders above the button, behind the provider's own " +
        "fields — from the chair, pressing it changes nothing",
    ).toBe(true);
  });

  it("answers every outcome the endpoint can produce with its own sentence", async () => {
    /* Claim-pinned: a verdict surface is worth having only if the verdicts differ. `probeLine` is
       the one place these are worded, so this is where they are held apart. The success line
       carries the model COUNT — the fact that makes "it works" checkable rather than reassuring. */
    const at = new Date().toISOString();
    const line = (p: Partial<AiProbeReport>): string =>
      probeLine({ ok: false, models: [], reason: null, detail: null, at, ...p }) ?? "";

    const sentences = [
      line({ ok: true, models: ["a", "b"] }),
      line({ reason: "unreachable" }),
      line({ reason: "timeout" }),
      line({ reason: "unauthorized" }),
      line({ reason: "model_absent" }),
      line({ reason: "bad_response" }),
      line({ reason: "credential" }),
      line({ reason: "internal" }),
    ];

    for (const s of sentences) expect(s.length, "an outcome has no sentence at all").toBeGreaterThan(0);
    expect(
      new Set(sentences).size,
      `two outcomes share a sentence, so the pane cannot tell them apart: ${sentences.join(" | ")}`,
    ).toBe(sentences.length);

    // The success line names how many models the endpoint has — the checkable half.
    expect(sentences[0]).toContain("2");
  });
});
