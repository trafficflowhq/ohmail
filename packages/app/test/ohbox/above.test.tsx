/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { OhboxModelContext, useOhboxModel, type OhboxListModel } from "@ohmail/app-logic/ohbox";
import { useListBlank, useListVisit, type ListVisit } from "@ohmail/app-logic/reading";
import { EngineContext } from "@ohmail/app-logic/engine";
import { SYNC_BOOTSTRAPPING, SYNC_SETTLED, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import { Frame } from "../../src/frame/Frame.js";
import { MailGround } from "../../src/mail/index.js";
import { OhboxAbove, blankOf, ohboxPlace, useOhboxBeside } from "../../src/ohbox/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, letter, WORDS as MAIL_WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import { beside, WORDS } from "./ohbox-world.js";

/** The letters' sender, admitted by a rule: the partition presents a decided sender's mail in the Ohbox. */
const ADMITTED = {
  "rule:r1": {
    id: "r1",
    kind: "sender",
    match: "ben@kiln.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

afterEach(cleanup);

const words = (key: string, values?: Record<string, unknown>): string =>
  values ? `${key} ${JSON.stringify(values)}` : key;
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) as never[];
const step = { disabled: false, run: () => {}, label: "" };

describe("what stands above the Ohbox's columns", () => {
  it("the blank says nothing with no rows, withholds the count until it may, then the count, then All read", () => {
    expect(blankOf({ all: [], mayState: true, unreadIds: [] }, words)).toBeNull();
    expect(blankOf({ all: rows(2), mayState: false, unreadIds: ["m0"] }, words)).toEqual({
      label: "blank.none",
      hot: false,
    });
    expect(blankOf({ all: rows(2), mayState: true, unreadIds: ["m0"] }, words)).toEqual({
      label: 'blank.unread {"count":1}',
      hot: true,
    });
    expect(blankOf({ all: rows(2), mayState: true, unreadIds: [] }, words)).toEqual({
      label: "blank.clear",
      hot: false,
    });
  });

  it("stands the model, the words beside it and the meeting the reading column reads", () => {
    const visit: ListVisit = {
      openId: "a",
      unread: true,
      wiring: {} as ListVisit["wiring"],
      readSet: [],
      act: () => {},
      step: { up: step, down: step },
    };
    const model = { all: rows(1), mayState: true, unreadIds: ["m0"], visit } as unknown as OhboxListModel;
    const seen: Record<string, unknown> = {};
    function Reads() {
      seen.model = useOhboxModel();
      seen.beside = useOhboxBeside();
      seen.visit = useListVisit("a");
      seen.blank = useListBlank();
      return null;
    }
    const side = beside({ marked: [], bulk: [], went: [], pulled: 0, markedAll: [] });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="UTC">
        <OhboxAbove model={model} beside={side}>
          <Reads />
        </OhboxAbove>
      </TextProvider>,
    );
    expect(seen.model).toBe(model);
    expect(seen.beside).toBe(side);
    expect(seen.visit).toBe(visit);
    expect(seen.blank).toEqual({ label: "1 unread", hot: true });
  });

  it("with nothing above, the list's model is asked of nobody and throws", () => {
    function Lost() {
      useOhboxModel();
      return null;
    }
    expect(() =>
      render(
        <OhboxModelContext.Provider value={null}>
          <Lost />
        </OhboxModelContext.Provider>,
      ),
    ).toThrow(/no model above it/);
  });

  it("the rail's count is the engine's unread letters, withheld until the Ohbox may state it", () => {
    /* The count reads the mail ground (the presented mirror, the mail state), never the list's own model: the
       entry is drawn here while the Ohbox's columns are not on screen. */
    const mail = fakeMail([letter("m0"), letter("m1"), letter("m2", { unread: false })], [], {}, ADMITTED);
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      address: fakeAddress("#/history"),
      places: {
        ohbox: ohboxPlace,
        history: {
          id: "history",
          body: "history",
          rail: null,
          panes: { kind: "wide", Wide: () => <p>History</p> },
        },
      },
      above: MailGround,
    });
    const over = (sync: SyncStatus) => (
      <EngineContext.Provider value={{ engine: mail.engine, demo: false, serverDemo: false, sync }}>
        <TextProvider locale="en" messages={MAIL_WORDS.en} timeZone="Europe/Zurich">
          <Frame host={host} />
        </TextProvider>
      </EngineContext.Provider>
    );
    const page = render(over(SYNC_BOOTSTRAPPING));
    const entry = () => screen.getByRole("button", { name: /^Ohbox/ }).getAttribute("aria-label");
    expect(entry(), "a count stated before the Ohbox may").toBeNull();
    page.rerender(over(SYNC_SETTLED));
    expect(entry()).toBe("Ohbox 2");
    /* In the demo's rail and dock only the Screener's count is hot (somebody is waiting): the Ohbox's is quiet. */
    expect(screen.getByText("2").hasAttribute("data-hot"), "the Ohbox's count is drawn hot").toBe(false);
    act(() => {
      mail.patch("m0", { unread: false });
      mail.patch("m1", { unread: false });
    });
    expect(entry()).toBeNull();
  });
});
