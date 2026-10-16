/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import messages from "../../webapp/messages/en.json";
import type { DraftReplyWire } from "../../webapp/app/shell/draft-reply";
import { BearerManager } from "../src/host-client/bearer.js";
import { HostGate } from "../src/host-client/HostGate.js";

/**
 * DRAFT REPLY ON A PAIRED BROWSER. `HostGate` handed the shared shell no draft wire, so the control
 * fell back to this artifact's refusing Cloud stub and said "Drafting needs a connected account."
 * The host serves both routes out of `localRoutes`; this file measures that the gate hands in a
 * wire, that its two calls ride the bearer door, and that a missing model names the host computer.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let shellProps: Record<string, unknown> | null = null;
vi.mock("../../webapp/app/shell/AppShell", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/AppShell")>(
    "../../webapp/app/shell/AppShell",
  );
  return {
    ...real,
    AppShell: (props: Record<string, unknown>) => {
      shellProps = props;
      return null;
    },
  };
});

interface Sent { url: string; init: { method?: string; headers?: Record<string, string> } | undefined }
let sent: Sent[];
let root: Root | null = null;
let hostEl: HTMLDivElement | null = null;

beforeEach(() => {
  sent = [];
  shellProps = null;
  window.localStorage.clear();
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error("the page opened a socket of its own");
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
});

function answer(url: string): Response {
  const body = url === "/messages/m1/draft" ? { draftId: "d1" }
    : url === "/drafts/d1" ? { body: "Thursday works.", html: null }
      : { mailboxes: [], items: [], nextCursor: null };
  return new Response(JSON.stringify(body), {
    status: url === "/messages/m1/draft" ? 202 : 200, headers: { "content-type": "application/json" },
  });
}

async function draftWire(): Promise<DraftReplyWire | undefined> {
  const bearer = new BearerManager({
    storage: window.localStorage,
    fetchImpl: (async (url: string, init?: unknown) => {
      sent.push({ url, init: init as Sent["init"] });
      return answer(url);
    }) as never,
  });
  bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: h(HostGate, { bearer }),
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(shellProps, "the gate did not mount the shared shell on a live pairing").not.toBeNull();
  return shellProps!.draftReplyWire as DraftReplyWire | undefined;
}

describe("the paired browser's draft reply", () => {
  it("the gate hands the shell a draft wire that names the host for a missing model", async () => {
    const wire = await draftWire();
    expect(wire, "no draftReplyWire: Draft reply says it needs a connected account").toBeDefined();
    expect(wire!.configured()).toBe(true);
    expect(wire!.noModel).toBe("noModelHost");
    expect(messages.draftReply.noModelHost).toContain("Settings → Desktop");
  });

  it("both calls ride the bearer door, the purchase with its key", async () => {
    const wire = (await draftWire())!;
    sent = [];
    expect(await wire.create("m1", "key-1")).toEqual({ draftId: "d1" });
    expect(await wire.read("d1")).toEqual({ body: "Thursday works.", html: null });

    expect(sent.map((s) => [s.init?.method ?? "GET", s.url])).toEqual([
      ["POST", "/messages/m1/draft"],
      ["GET", "/drafts/d1"],
    ]);
    expect(sent[0]!.init?.headers?.["Idempotency-Key"]).toBe("key-1");
    for (const s of sent) expect(s.init?.headers?.authorization, s.url).toBe("Bearer a1");
  });

  it("the host's route table serves both", () => {
    expect(read("packages/api/src/routes/desktop-host.ts")).toContain("...localRoutes,");
    const local = read("packages/api/src/routes/local.ts");
    expect(local).toContain("...messageRoutes,");
    expect(local).toContain("...draftsRoutes,");
    expect(read("packages/api/src/routes/messages.ts")).toMatch(/method: "POST",\s*pattern: "\/messages\/:id\/draft"/);
    expect(read("packages/api/src/routes/drafts.ts")).toMatch(/method: "GET",\s*pattern: "\/drafts\/:id"/);
  });
});
