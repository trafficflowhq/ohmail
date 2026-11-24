// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoteImages } from "@ohmail/app-logic/reader/remote-images";
import { createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { OWNER_COOKIE } from "@ohmail/app-logic/storage/owner-cookie";
import { MailGround, mailReader } from "../../src/mail/index.js";
import type { ConsentWire, ImageWire } from "../../src/host/index.js";
import { letterBody } from "../states/reader-body-part.mjs";
import { letter, mountReader, WORDS } from "./support/mail.js";
import EN from "../../messages/reader.en.json" with { type: "json" };
import { DEFERRED_SRC_ATTR } from "../../../letter-body/src/proxied-images.js";

const picture = "https://pictures.example/p.png?w=120";
const gif = "https://pictures.example/b.gif?u=abc";
const beacon = "https://pictures.example/wf/open?u=abc";
const sized = `<img src="${picture}" alt="a picture" width="120" height="120">`;
const pixels = `<img src="${gif}" width="1" height="1"><img src="${beacon}">`;
const reader = mailReader({ body: letterBody, look: "none" });
const words = WORDS.en;

const origin = () => ({
  address: (id: string, url: string) => `${location.origin}/api/img?mid=${id}&u=${encodeURIComponent(url)}`,
  record: vi.fn(async (_id: string) => undefined),
});

function draw(content: string, images: ImageWire | "none" = origin()) {
  let answer!: (row: unknown) => void;
  const state = new Promise((resolve) => {
    answer = resolve;
  });
  const body = `<table width="600"><tr><td><p>Here is the picture.</p>${content}</td></tr></table>`;
  const row = letter("illustration");
  const { body: _, ...envelope } = row;
  const made = mountReader({
    letters: [envelope],
    open: row.id,
    words,
    rows: {
      "rule:admit": {
        id: "admit",
        kind: "sender",
        match: row.from.address,
        destination: "INBOX",
        priority: 0,
        enabled: true,
        provenance: "manual",
        stats: { hits: 0, demotions: 0, lastHitAt: null },
        createdAt: row.date,
        updatedAt: row.date,
      },
    },
    bodies: { [row.id]: { state: "ready", text: "Here is the picture.", html: body } },
    host: { above: MailGround, reader, wires: { images, consent: { state: () => state } as ConsentWire } },
  });
  return {
    ...made,
    answer: (automatic: boolean, allowPixels = false) =>
      act(async () =>
        answer({
          seedConfirmedAt: null,
          dormancyDays: 45,
          blockRemoteImagesAt: automatic ? null : "2026-01-01T00:00:00.000Z",
          loadTrackingPixelsAt: allowPixels ? "2026-01-01T00:00:00.000Z" : null,
        }),
      ),
  };
}

function content() {
  const frame = document.querySelector("iframe[srcdoc]");
  expect(frame, "the illustrated letter is on screen").toBeTruthy();
  return new DOMParser().parseFromString(frame!.getAttribute("srcdoc")!, "text/html");
}

function loads() {
  return [...content().images].flatMap((img) => {
    const src = img.getAttribute(DEFERRED_SRC_ATTR) ?? img.getAttribute("src") ?? "";
    if (!/^https?:/.test(src)) return [];
    const url = new URL(src);
    expect(url.origin).toBe(location.origin);
    expect(url.pathname).toBe("/api/img");
    expect(url.searchParams.get("mid")).toBe("illustration");
    return [url.searchParams.get("u")];
  });
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("pictures in an open letter", () => {
  it("offers the sized picture as a remote image and loads it only after the consent press", async () => {
    const wire = origin();
    const pane = draw(sized, wire);
    await pane.answer(false);
    fireEvent.click(screen.getByRole("button", { name: EN.mailBody.imagesCaption }));
    expect(screen.getByText(EN.mailBody.blockedOne)).toBeTruthy();
    expect(screen.queryByText(EN.mailBody.pixelOnly)).toBeNull();
    expect(loads()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Show images" }));
    await waitFor(() => expect(loads()).toEqual([picture]));
    expect(wire.record.mock.calls).toEqual([["illustration"]]);
  });

  it("loads the sized picture unmarked when the live account answer allows pictures", async () => {
    const pane = draw(sized);
    expect(loads()).toEqual([]);
    await pane.answer(true);
    await waitFor(() => expect(loads()).toEqual([picture]));
    expect(content().querySelector('img[alt="a picture"]')?.hasAttribute("data-ohmail-pixel")).toBe(false);
    expect(screen.queryByText(EN.mailBody.pixelCaption)).toBeNull();
    expect(screen.queryByText(EN.mailBody.imagesCaption)).toBeNull();
    expect(screen.queryByText(EN.mailBody.pixelOnly)).toBeNull();
  });

  it("keeps both beacons out while the ordinary picture loads in either image mode", async () => {
    for (const automatic of [true, false]) {
      const pane = draw(sized + pixels);
      await pane.answer(automatic);
      if (!automatic) fireEvent.click(screen.getByRole("button", { name: "Show images" }));
      await waitFor(() => expect(loads()).toEqual([picture]));
      expect(content().querySelectorAll("img[data-ohmail-pixel]")).toHaveLength(2);
      pane.view.unmount();
    }
  });

  it("loads both beacons through the letter's proxy when the account allows pixels", async () => {
    const pane = draw(pixels);
    await pane.answer(true, true);
    await waitFor(() => expect(loads().sort()).toEqual([gif, beacon].sort()));
  });

  it("uses the tracker caption when the letter contains only blocked beacons", async () => {
    const pane = draw(pixels);
    await pane.answer(true);
    expect(screen.getByRole("button", { name: EN.mailBody.pixelCaption })).toBeTruthy();
    expect(screen.queryByRole("button", { name: EN.mailBody.imagesCaption })).toBeNull();
    expect(loads()).toEqual([]);
  });

  it("waits for the account to be confirmed before recording a picture press", async () => {
    document.cookie = `${OWNER_COOKIE}=acct-1; path=/`;
    try {
      const wire = origin();
      const pane = draw(sized, wire);
      const gate = createSyncGate("acct-1");
      registerSyncGate(pane.mail.engine, gate);
      await pane.answer(false);
      expect(gate.identity()).toBe("unconfirmed");
      fireEvent.click(screen.getByRole("button", { name: "Show images" }));
      expect(wire.record).not.toHaveBeenCalled();
      expect(loads()).toEqual([]);
      gate.confirm("acct-1");
      fireEvent.click(screen.getByRole("button", { name: "Show images" }));
      await waitFor(() => expect(loads()).toEqual([picture]));
      expect(wire.record.mock.calls).toEqual([["illustration"]]);
    } finally {
      document.cookie = `${OWNER_COOKIE}=; path=/; max-age=0`;
    }
  });

  it("a late Show images answer and a second press on a stale page admit nothing for the next account", async () => {
    const store = (owner: string) => {
      document.cookie = `${OWNER_COOKIE}=${owner}; path=/`;
    };
    const owners: string[] = [];
    let release!: () => void;
    const wire = {
      ...origin(),
      record: async () => {
        owners.push(document.cookie.split("; ").find((x) => x.startsWith(`${OWNER_COOKIE}=`))!);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    try {
      store("acct-1");
      const pane = draw(sized, wire);
      const gate = createSyncGate("acct-1");
      gate.confirm("acct-1");
      registerSyncGate(pane.mail.engine, gate);
      await pane.answer(false);
      fireEvent.click(screen.getByRole("button", { name: "Show images" }));
      expect(owners).toEqual([`${OWNER_COOKIE}=acct-1`]);
      store("acct-2");
      expect(gate.identity()).toBe("contradicted");
      await act(async () => release());
      expect(loads()).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Show images" }));
      expect(owners).toEqual([`${OWNER_COOKIE}=acct-1`]);
      expect(loads()).toEqual([]);
    } finally {
      document.cookie = `${OWNER_COOKIE}=; path=/; max-age=0`;
    }
  });

  it("reports a refused picture press only to the account that made it", async () => {
    let refuse!: (error: Error) => void;
    const wire = {
      ...origin(),
      record: () =>
        new Promise<void>((_, reject) => {
          refuse = reject;
        }),
    };
    document.cookie = `${OWNER_COOKIE}=acct-1; path=/`;
    try {
      const pane = draw(sized, wire);
      const gate = createSyncGate("acct-1");
      gate.confirm("acct-1");
      registerSyncGate(pane.mail.engine, gate);
      await pane.answer(false);
      fireEvent.click(screen.getByRole("button", { name: "Show images" }));
      await act(async () => refuse(new Error("The current account could not save the choice.")));
      expect(
        screen
          .queryAllByRole("status")
          .map((node) => node.textContent)
          .join(" "),
      ).toContain("The current account could not save the choice");
      fireEvent.click(screen.getByRole("button", { name: "Show images" }));
      document.cookie = `${OWNER_COOKIE}=acct-2; path=/`;
      await act(async () => refuse(new Error("A refusal from the previous account.")));
      expect(
        screen
          .queryAllByRole("status")
          .map((node) => node.textContent)
          .join(" "),
      ).not.toContain("A refusal from the previous account");
      expect(loads()).toEqual([]);
    } finally {
      document.cookie = `${OWNER_COOKIE}=; path=/; max-age=0`;
    }
  });

  it("waits for the current host's answer when the picture wire changes", async () => {
    const owner = {};
    let release!: () => void;
    const receipt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const former = { ...origin(), record: vi.fn(() => receipt) };
    const current = origin();
    const { result, rerender } = renderHook<ReturnType<typeof useRemoteImages>, ImageWire>(
      (wire) =>
        useRemoteImages({
          wire,
          mode: "manual",
          loadPixels: false,
          consentOwner: () => owner,
          onFailed: vi.fn(),
        }),
      { initialProps: former },
    );
    act(() => result.current!.consent("illustration"));
    expect(former.record.mock.calls).toHaveLength(1);

    rerender(current);
    await act(async () => release());
    expect(result.current!.consented("illustration")).toBe(false);
    expect(current.record).not.toHaveBeenCalled();

    await act(async () => result.current!.consent("illustration"));
    expect(current.record.mock.calls).toEqual([["illustration"]]);
    expect(result.current!.consented("illustration")).toBe(true);
  });

  it("keeps pictures closed without a host wire, including after the live account answer", async () => {
    const pane = draw(sized, "none");
    expect(loads()).toEqual([]);
    await pane.answer(true);
    expect(loads()).toEqual([]);
    expect(screen.queryByRole("button", { name: "Show images" })).toBeNull();
  });
});
