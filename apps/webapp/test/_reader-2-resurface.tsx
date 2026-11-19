/** The reader's Resurface menu reads the account's hour from the frame. Its actions and saved hours share one ordered log. */
import type { EngineMessage } from "@ohmail/wire";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { ListVisit } from "@ohmail/app-logic/reading";
import { useRoomResurface } from "../../../packages/app/src/frame/room.js";
import { freshRecord, letter, mountReader } from "../../../packages/app/test/reader/support/mail.js";

export interface ResurfaceWorld {
  /** Every action the chooser dispatched and every hour it asked to keep, in the order they happened. */
  readonly log: string[];
}

/**
 * The chooser's letter open in the new reader. `stored`: the account's hour (null: none); `canStore: false`: a door
 * that cannot keep one (the room is handed no `store`).
 */
export function mountResurface(opts: { stored?: string | null; canStore?: boolean; message?: Partial<EngineMessage> } = {}): ResurfaceWorld {
  const log: string[] = [];
  const store =
    opts.canStore === false ? null : vi.fn(async (hhmm: string) => void log.push(`remember:${hhmm}`));

  const resurface = { stored: opts.stored ?? null, store };
  function Shell({ children }: { children: ReactNode }) {
    useRoomResurface(resurface);
    return <>{children}</>;
  }
  const visit: ListVisit = {
    openId: "m1",
    unread: false,
    readSet: [],
    act: (action) => void log.push(String(action)),
    wiring: {
      look: "tint",
      record: freshRecord(),
      onRead: vi.fn(),
      onEnter: vi.fn(),
      onMarkUnread: vi.fn(),
    },
    step: {
      up: { disabled: true, run: vi.fn(), label: "Previous message" },
      down: { disabled: true, run: vi.fn(), label: "Next message" },
    },
  };
  mountReader({
    letters: [letter("m1", opts.message as never)],
    open: "m1",
    meeting: { visit, blank: null },
    host: { above: Shell },
  });
  return { log };
}

/** Opens the chooser from the reader's panel. */
export function openResurface(): void {
  fireEvent.click(screen.getByRole("button", { name: "Resurface" }));
}

/** The chooser's time field. */
export function resurfaceTime(): HTMLInputElement {
  return screen.getByLabelText("Time", { selector: "input" }) as HTMLInputElement;
}

/** The instant of the one dated resurface the chooser dispatched. */
export function bookedIn(log: readonly string[]): string | undefined {
  return log.find((l) => l.startsWith("resurface:"))?.slice("resurface:".length);
}

/** Sets the platform's zone for the reader's `readerZone()`; returns the undo. */
export function zoneIs(zone: string): () => void {
  const was = process.env.TZ;
  process.env.TZ = zone;
  return () => {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  };
}
