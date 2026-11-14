/** Mount the frame notice slot with the mailbox notices in either language. */
import { act, render } from "@testing-library/react";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import type { GapLettersWire } from "../../../packages/app/src/host/index.js";
import { mailboxesNotices } from "../../../packages/app/src/mailboxes/pane/notices.js";
import { TextProvider } from "../../../packages/app/src/text/index.js";
import frame from "../../../packages/app/messages/frame.en.json" with { type: "json" };
import mailboxes from "../../../packages/app/messages/mailboxes.en.json" with { type: "json" };
import frameDe from "../../../packages/app/messages/frame.de.json" with { type: "json" };
import mailboxesDe from "../../../packages/app/messages/mailboxes.de.json" with { type: "json" };
import { fakeHost, NO_ENGINE } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";

export interface MountedSlot {
  readonly el: HTMLElement;
  /** The notice blocks the slot draws in front (a status that names its place). */
  blocks(): HTMLElement[];
}

export async function mountNoticeSlot(o: {
  facts: readonly MailboxFacts[];
  gapLetters: GapLettersWire;
  locale?: "en" | "de";
}): Promise<MountedSlot> {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  const facts = o.facts;
  const notice = mailboxesNotices(() => ({ state: { key: "ready" }, refresh: () => {}, mailboxes: facts }));
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    address: fakeAddress("#/ohbox"),
    places: { ohbox: { id: "ohbox", body: "ohbox", rail: null, panes: { kind: "wide", Wide: () => null } } },
    features: { mailboxes: { name: "mailboxes", render: () => null, notice } },
    wires: { gapLetters: o.gapLetters },
  });
  let el!: HTMLElement;
  await act(async () => {
    el = render(
      <TextProvider
        locale={o.locale ?? "en"}
        messages={(o.locale === "de" ? { ...mailboxesDe, ...frameDe } : { ...mailboxes, ...frame }) as never}
        timeZone="UTC"
      >
        <Frame host={made.host} />
      </TextProvider>,
    ).container;
  });
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
  return {
    el,
    blocks: () => [...el.querySelectorAll<HTMLElement>("[role='status'][data-place]")],
  };
}
