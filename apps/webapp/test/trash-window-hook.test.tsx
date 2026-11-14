/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { fireEvent, renderHook, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import {
  consentTransport, engineOver, setup as setupView, storeWith, teardown as teardownView,
} from "./_view-shell";
import type { TrashWindowItemWire, TrashWindowPageWire } from "../app/api-client";
import { useTrashWindow } from "@ohmail/app-logic/trash";
import { cloudWire, type TrashWire } from "../app/shell/trash-window";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const list = vi.fn<(opts?: { cursor?: string }) => Promise<TrashWindowPageWire>>();
const body = vi.fn<(m: string, u: number, v: string) => Promise<{ subject: string; text: string }>>();
/** The mock's mutable "is there a server" answer — the unsupported case flips it. */
const configured = { value: true };

vi.mock("../app/api-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../app/api-client")>();
  return {
    ...real,
    apiConfigured: () => configured.value,
    trashWindow: {
      list: (opts?: { cursor?: string }) => list(opts),
      body: (m: string, u: number, v: string) => body(m, u, v),
    },
  };
});

function item(uid: number, over: Partial<TrashWindowItemWire> = {}): TrashWindowItemWire {
  return {
    mailboxId: "mb1", uid, uidValidity: "77",
    subject: `trashed ${uid}`, from: { name: null, address: `s${uid}@example.invalid` },
    date: `2026-09-0${uid}${"T"}10:00:00.000Z`, messageIdHeader: `<mid-${uid}@x>`,
    seen: false, origin: "provider", ...over,
  };
}
const ok = (over: { reset?: boolean } = {}) => ({
  id: "mb1", address: "a@example.invalid", window: "ok" as const,
  ...(over.reset ? { reset: true } : {}),
});
const pageWire = (
  items: TrashWindowItemWire[], nextCursor: string | null, over: { reset?: boolean } = {},
): TrashWindowPageWire => ({ mailboxes: [ok(over)], items, nextCursor });

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  list.mockReset();
  body.mockReset();
  body.mockResolvedValue({ subject: "s", text: "the body" });
  configured.value = true;
});

async function mountRegisteredTrash(wire?: TrashWire) {
  const { MailShell } = await import("./_mail-shell");
  window.location.hash = "#/trash";
  const engine = engineOver(await storeWith([]));
  vi.spyOn(engine, "trashAvailable").mockReturnValue(true);
  vi.spyOn(engine, "listTrash").mockResolvedValue({ state: "ready", items: [], nextCursor: null });
  const mutate = vi.spyOn(engine, "mutate");
  const restore = vi.spyOn(engine, "restoreFromTrash");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const frame = createRoot(container);
  await act(async () => frame.render(
    h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(MailShell, { engine, consentTransport, ...(wire === undefined ? {} : { trashWire: wire }) }),
      }) }),
    }),
  ));
  await settle();
  const view = within(container);
  return {
    view,
    container,
    mutate,
    restore,
    async close() {
      await act(async () => frame.unmount());
      container.remove();
    },
  };
}

async function expectUnsupportedWithoutRequests() {
  configured.value = false;
  const fetch = vi.fn().mockRejectedValue(new Error("unexpected network request"));
  vi.stubGlobal("fetch", fetch);
  try {
    const probe = renderHook(() => useTrashWindow(true, "none"));
    try {
      await settle();
      expect(probe.result.current.supported).toBe(false);
      expect(probe.result.current.phase).toBe("failed");
    } finally {
      probe.unmount();
    }

    const frame = await mountRegisteredTrash();
    try {
      expect(frame.container.textContent).toContain(messages.trash.emptyTitle);
      expect(frame.view.queryByRole("region", { name: messages.trash.liveHead })).toBeNull();
      expect(frame.view.queryByText(messages.trash.liveFailed)).toBeNull();
      expect(frame.view.queryByText(messages.trash.liveEmpty)).toBeNull();
      expect(list).not.toHaveBeenCalled();
      expect(body).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(frame.mutate).not.toHaveBeenCalled();
      expect(frame.restore).not.toHaveBeenCalled();
    } finally {
      await frame.close();
    }
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("the window's first page", () => {
  beforeEach(setupView);
  afterEach(teardownView);

  it("with no server behind the build it asks NOTHING and rests on failed", expectUnsupportedWithoutRequests);
});

describe("the host wire — the desktop's door", () => {
  beforeEach(setupView);
  afterEach(teardownView);

  it("THE DEFECT, MEASURED: no wire and no Cloud client means not supported and NOTHING asked", expectUnsupportedWithoutRequests);

  it("ONE DOOR: with a wire handed in, the Cloud client is never touched — not even when configured", async () => {
    configured.value = true;
    const wireList = vi.fn<TrashWire["list"]>()
      .mockResolvedValueOnce(pageWire([item(2)], "cursor-2"))
      .mockResolvedValueOnce(pageWire([item(1)], null));
    const wireBody = vi.fn<TrashWire["body"]>().mockResolvedValue({ subject: "s", text: "over the pipe" });
    list.mockResolvedValue(pageWire([item(3)], null));

    const fetch = vi.fn().mockRejectedValue(new Error("unexpected network request"));
    vi.stubGlobal("fetch", fetch);
    try {
      const frame = await mountRegisteredTrash({ list: wireList, body: wireBody });
      try {
        expect(frame.container.textContent).toContain(messages.trash.emptyTitle);
        expect(wireList.mock.calls).toEqual([[]]);
        expect(wireBody).not.toHaveBeenCalled();
        await act(async () => { fireEvent.click(frame.view.getByRole("button", { name: messages.trash.liveOlder })); });
        await settle();
        expect(wireList.mock.calls).toEqual([[], [{ cursor: "cursor-2" }]]);
        const rows = within(frame.view.getByRole("listbox", { name: messages.trash.liveHead }));
        expect(rows.getAllByRole("option").map((row) => row.dataset.id)).toEqual(["mb1:77:2", "mb1:77:1"]);
        await act(async () => { fireEvent.click(rows.getByRole("option", { name: /trashed 1/ })); });
        expect(await frame.view.findByText("over the pipe")).toBeTruthy();
        expect(wireList).toHaveBeenCalledTimes(2);
        expect(wireBody.mock.calls).toEqual([["mb1", 1, "77"]]);
        expect(frame.view.getByText(messages.trash.liveReadOnly)).toBeTruthy();
        expect(list).not.toHaveBeenCalled();
        expect(body).not.toHaveBeenCalled();
        expect(frame.mutate).not.toHaveBeenCalled();
        expect(frame.restore).not.toHaveBeenCalled();
      } finally {
        await frame.close();
      }

      const cloud = await mountRegisteredTrash(cloudWire);
      try {
        expect(list).toHaveBeenCalledTimes(1);
        const rows = within(cloud.view.getByRole("listbox", { name: messages.trash.liveHead }));
        await act(async () => { fireEvent.click(rows.getByRole("option", { name: /trashed 3/ })); });
        expect(await cloud.view.findByText("the body")).toBeTruthy();
        expect(body.mock.calls).toEqual([["mb1", 3, "77"]]);
        expect(cloud.mutate).not.toHaveBeenCalled();
        expect(cloud.restore).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await cloud.close();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
