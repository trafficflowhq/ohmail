/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";
import { ManagedServiceContext } from "../../webapp/app/shell/managed-service";
import { desktopFiler } from "../../webapp/app/shell/mail-state";
import { DOOR_COPY } from "../src/door-copy.js";
import { CLOUD_URL, flavorOf, isManagedDoor } from "../src/doors.js";
import { cloudSessionNotice } from "../src/cloud-session.js";
import { DesktopAbout } from "../src/DesktopAbout.js";
import { DesktopSettings } from "../src/DesktopSettings.js";
import { DesktopScreening } from "../src/DesktopScreening.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * A DOOR IS NAMED BY THE SERVER IT READS. The self-hosted door records no flavor — only the paired
 * door writes one — so every door sentence read it as the managed service: Settings → Desktop said
 * "ohmail Cloud", About "An ohmail Cloud account" and "our servers", the rail "ohmail Cloud could not
 * be reached" and the Screener's offline notes "your ohmail Cloud account", all about somebody's own
 * server. The origin decides, by the shell's own rule; the managed origin keeps its words (control).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } };

const door = (cloudUrl: string | undefined, over: Partial<EngineStatus> = {}): EngineStatus => ({
  state: "serving", mode: "cloud", credentialState: "ready", address: "me@ohmail.test", mailboxId: "mbx-1",
  ...(cloudUrl === undefined ? {} : { cloudUrl }), ...over,
} as EngineStatus);
const MANAGED = door(CLOUD_URL);
const SELF_HOSTED = door("https://mail.example.com");
const GERMAN = fillFrom(en as never, de as never) as never;

let hostEl: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  hostEl?.remove();
  hostEl = null;
  setActiveCatalog(DEFAULT_LOCALE, null);
  delete host.__TAURI_INTERNALS__;
});

async function render(node: React.ReactNode, locale: "en" | "de" = "en"): Promise<string> {
  if (locale === "de") setActiveCatalog("de", GERMAN);
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "en" ? en : de) as never, timeZone: "UTC", children: node,
    }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return hostEl.textContent ?? "";
}

describe("which server a cloud door reads — the origin, by the shell's rule", () => {
  it("names each door, and a door with no readable origin keeps the shipped answer", () => {
    expect(flavorOf(MANAGED)).toBe("managed");
    expect(flavorOf(door("https://API.ohmail.app./"))).toBe("managed");
    expect(flavorOf(SELF_HOSTED)).toBe("selfhost");
    expect(flavorOf(door("https://mail.example.com", { flavor: "desktop-host" }))).toBe("desktop-host");
    expect(flavorOf(door(undefined))).toBe("unknown");
    expect(isManagedDoor(MANAGED)).toBe(true);
    expect(isManagedDoor(door(undefined))).toBe(true);
    expect(isManagedDoor(SELF_HOSTED)).toBe(false);
    expect(isManagedDoor(door("https://desk.example", { flavor: "desktop-host" }))).toBe(false);
    expect(isManagedDoor({ state: "serving", mode: "local" } as EngineStatus)).toBe(false);
  });

  /* The Mailboxes pane's heading keys on the same reading: a real self-hosted door now reaches its
     "Mailboxes on this server" row, which a flavor no door writes kept out of reach. */
  it("the Mailboxes pane files a self-hosted door as the server", () => {
    expect(desktopFiler("cloud", flavorOf(SELF_HOSTED))).toBe("server");
    expect(desktopFiler("cloud", flavorOf(MANAGED))).toBe("cloud");
  });
});

describe("Settings → Desktop and About name the door by its server", () => {
  const settings = (status: EngineStatus) => h(DesktopSettings, {
    status, session: "live", sealFailed: false,
    onStatus: () => undefined, onSwitchDoor: () => undefined, onSignIn: () => undefined,
  });

  it("CONTROL — the managed door is ohmail Cloud in both panes", async () => {
    expect(await render(settings(MANAGED))).toContain(DOOR_COPY.doorCloudName);
    await act(async () => { root!.unmount(); });
    const about = await render(h(DesktopAbout, { status: MANAGED }));
    expect(about).toContain(DOOR_COPY.aboutDoorCloudValue);
    expect(about).toContain(DOOR_COPY.aboutDoorCloudWhy);
    expect(about).toContain(DOOR_COPY.aboutLinksCloud);
  });

  it.each(["en", "de"] as const)("%s: a self-hosted door is the person's server, never ohmail Cloud", async (locale) => {
    const pane = await render(settings(SELF_HOSTED), locale);
    expect(pane).toContain(DOOR_COPY.doorServerNamed);
    expect(pane).not.toMatch(/ohmail[ -]Cloud/);
    await act(async () => { root!.unmount(); });
    const about = await render(h(DesktopAbout, { status: SELF_HOSTED }), locale);
    expect(about).toContain(DOOR_COPY.aboutDoorServerValue);
    expect(about).toContain(DOOR_COPY.aboutDoorServerWhy);
    expect(about).toContain(DOOR_COPY.aboutLinksLocal);
    expect(about).not.toMatch(/ohmail[ -]Cloud/);
  });
});

describe("the rail and the Screener's offline notes name the door's server", () => {
  it("the rail's unreachable line", () => {
    const reading = { state: "unreachable", code: null, since: "2026-09-27T00:00:00.000Z" } as never;
    expect(cloudSessionNotice(reading)?.words.title).toBe(DOOR_COPY.cloudUnreachableTitle);
    expect(cloudSessionNotice(reading, false)?.words.title).toBe(DOOR_COPY.serverUnreachableTitle);
    expect(DOOR_COPY.serverUnreachableTitle).not.toMatch(/Cloud/);
  });

  /** The engine answers 503 for the preference: the hosted account cannot be reached. */
  function offlineEngine(): void {
    const meta = new TextEncoder().encode(JSON.stringify({ status: 503, statusText: "Service Unavailable", h: [] }));
    const out = new Uint8Array(4 + meta.byteLength);
    new DataView(out.buffer).setUint32(0, meta.byteLength, false);
    out.set(meta, 4);
    host.__TAURI_INTERNALS__ = { invoke: async (command) => {
      if (command === "engine_request") return out;
      throw new Error(`unexpected ${command}`);
    } };
  }

  it.each([true, false])("managed %s: the offline note names the account or the server", async (managed) => {
    offlineEngine();
    const text = await render(h(ManagedServiceContext.Provider, {
      value: managed, children: h(DesktopScreening, { door: "cloud" }),
    }));
    expect(text).toContain(managed ? en.desktopScreener.offlineNote : en.desktopScreener.offlineNoteServer);
    if (!managed) expect(text).not.toMatch(/Cloud/);
  });
});
