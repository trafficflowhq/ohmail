/** @vitest-environment jsdom */
/**
 * A SIZED PICTURE IS NOT A TRACKER BECAUSE ITS URL CARRIES A QUERY.
 *
 * A 120×120 picture at `…/p.png?w=120` (an image server's size parameter) was labelled "Tracker
 * blocked" and never shown, with no load offer, because the beacon rule took any `.png?`/`.gif?`
 * for a beacon. The rule now takes only a tracker's own evidence: a declared 1×1/0×0 size, a
 * beacon path or a per-recipient key. Driven through the real `MessageBody` behind the real
 * `useRemoteImages`, in both image modes, with two beacon shapes as controls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { COPY, MessageBody } from "../app/components/MessageBody";
import type { BlockNotice } from "../app/components/BlockNotice";
import { DEFERRED_SRC_ATTR } from "../app/components/proxied-images";
import { useRemoteImages } from "../app/shell/remote-images";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const SIZED = "https://images.example/p.png?w=120";
const PIXEL_GIF = "https://t.example/b.gif?u=abc";
const WF_OPEN = "https://t.example/wf/open?u=abc";
/* A declared canvas keeps the message in its FRAME, where the fetching positions can be read. */
const canvas = (inner: string) => `<table width="600"><tr><td><p>hello</p>${inner}</td></tr></table>`;
const SIZED_LETTER = canvas(`<img src="${SIZED}" width="120" height="120" alt="a picture">`);
const BEACONS = canvas(`<img src="${PIXEL_GIF}" width="1" height="1"><img src="${WF_OPEN}">`);

let loadRemoteCalls: string[] = [];
vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    API_BASE: "/api",
    apiConfigured: () => true,
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    privacy: {
      loadRemote: async (id: string) => { loadRemoteCalls.push(id); return { remoteContent: "loaded" }; },
    },
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let notice: BlockNotice | null | undefined;

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  notice = undefined;
  loadRemoteCalls = [];
});

interface Opts { mode: "auto" | "manual"; loadPixels?: boolean; withNotice?: boolean }

/** The pane's four lines over the real consent hook, as `remote-images.test.tsx` mounts them. */
function Harness({ messageId, html, mode, loadPixels = false, withNotice = false }: Opts & { messageId: string; html: string }) {
  const chrome = useRemoteImages({ onFailed: () => {}, mode, loadPixels });
  return h(MessageBody, {
    text: "plain",
    html,
    remoteLoaded: (chrome?.auto ?? false) || (chrome?.consented(messageId) ?? false),
    imageProxy: chrome ? chrome.proxyFor(messageId) : null,
    onLoadRemote: chrome && !chrome.auto ? () => chrome.consent(messageId) : undefined,
    loadTrackingPixels: chrome?.loadPixels ?? false,
    ...(withNotice ? { onNotice: (n: BlockNotice | null) => { notice = n; } } : {}),
  });
}

async function mount(html: string, opts: Opts): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(Harness, { messageId: "msg-1", html, ...opts })); });
  await settle();
  return host;
}

function frameDoc(el: HTMLDivElement): Document {
  const frame = el.querySelector("iframe");
  expect(frame, "no message frame was rendered").toBeTruthy();
  return new DOMParser().parseFromString(frame!.getAttribute("srcdoc") ?? "", "text/html");
}

/** The sender urls the frame will fetch through the proxy once it loads (parked, `proxied-images.ts`). */
function proxiedOnOpen(el: HTMLDivElement): string[] {
  return [...frameDoc(el).querySelectorAll("img")]
    .map((img) => img.getAttribute(DEFERRED_SRC_ATTR) ?? img.getAttribute("src") ?? "")
    .filter((s) => /^https?:\/\//i.test(s))
    .map((s) => new URL(s).searchParams.get("u") ?? s);
}

const thePicture = (el: HTMLDivElement): Element | null => frameDoc(el).querySelector('img[alt="a picture"]');

const showButton = (el: HTMLDivElement): HTMLButtonElement | null =>
  [...el.querySelectorAll("button")].find((b) => /show images/i.test(b.textContent ?? "")) ?? null;

async function click(node: Element): Promise<void> {
  await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

describe("a sized picture with a size query is a picture", () => {
  it("manual mode: said as a remote image, offered, and loaded through the proxy on the press", async () => {
    const el = await mount(SIZED_LETTER, { mode: "manual" });
    const said = el.querySelector(".mb-bar-text")?.textContent ?? "";
    expect(said, "the sized picture was called a tracking pixel").not.toContain(COPY.pixelOnly);
    expect(said).toContain(COPY.blockedOne);
    const button = showButton(el);
    expect(button, "the sized picture has no way to be loaded").toBeTruthy();
    await click(button!);
    expect(loadRemoteCalls).toEqual(["msg-1"]);
    expect(proxiedOnOpen(el), "the press did not load the sized picture").toEqual([SIZED]);
  });

  it("manual mode: the host's notice is the images caption, not the tracker caption", async () => {
    await mount(SIZED_LETTER, { mode: "manual", withNotice: true });
    expect(notice?.kind, "the host was told a tracker was blocked").toBe("images");
    expect(notice?.caption).toBe(COPY.imagesCaption);
  });

  it("auto mode: the picture is on screen at open, unmarked, and nothing is said", async () => {
    const el = await mount(SIZED_LETTER, { mode: "auto" });
    expect(proxiedOnOpen(el), "images-by-default left the sized picture blank").toEqual([SIZED]);
    expect(thePicture(el)?.hasAttribute("data-ohmail-pixel"), "the picture is marked a pixel").toBe(false);
    expect(el.querySelector(".mb-bar-text")?.textContent ?? "").not.toContain(COPY.pixelOnly);
  });
});

describe("CONTROLS: the two beacon shapes stay trackers", () => {
  it("a declared 1×1 `.gif?` and an unsized `/wf/open?` are never fetched, in either mode", async () => {
    for (const mode of ["auto", "manual"] as const) {
      const el = await mount(canvas(`<img src="${SIZED}" width="120" height="120">`) + BEACONS, { mode });
      if (mode === "manual") await click(showButton(el)!);
      const fetched = proxiedOnOpen(el);
      expect(fetched, `${mode}: the declared 1×1 was fetched`).not.toContain(PIXEL_GIF);
      expect(fetched, `${mode}: the /wf/open beacon was fetched`).not.toContain(WF_OPEN);
      expect(fetched, `${mode}: the picture beside them did not load`).toContain(SIZED);
      expect(frameDoc(el).querySelectorAll("img[data-ohmail-pixel]").length, `${mode}: pixel marks`).toBe(2);
      await act(async () => { root!.unmount(); });
      root = null;
      host?.remove();
    }
  });

  it("a letter of beacons alone is said as a tracker, with the tracker caption", async () => {
    await mount(BEACONS, { mode: "auto", withNotice: true });
    expect(notice?.kind).toBe("pixel");
    expect(notice?.caption).toBe(COPY.pixelCaption);
  });

  it("a labelled image is still loadable: with the pixel switch off both beacons ride the proxy", async () => {
    const el = await mount(BEACONS, { mode: "auto", loadPixels: true });
    expect(proxiedOnOpen(el).sort()).toEqual([PIXEL_GIF, WF_OPEN].sort());
  });
});
