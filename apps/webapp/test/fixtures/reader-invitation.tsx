import type { PropsWithChildren } from "react";
import type { EngineMessage } from "@ohmail/wire";
import { DoorsContext } from "@ohmail/app-logic/reader/doors";
import { letterBody } from "@ohmail/app/reader/body";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { letterOf, mountLetters } from "../_reader-1-letters";
import { ReaderInvitation } from "../../app/components/ReaderInvitation";
import { fillFrom } from "../../app/shell/locale";
import en from "../../messages/en.json";
import de from "../../messages/de.json";

const catalogs = { en, de: fillFrom(en, de) as AbstractIntlMessages };
const doors = { files: undefined, pictures: undefined };

/** The mounted Reader with an exact body record and no attachment door. File-backed invitations use live adapters. */
export function mountInvitationLetter(
  letter: EngineMessage,
  body: { text: string; html?: string; state?: "full" | "snippet" | "loading" },
  { locale = "en", sibling = false }: { locale?: "en" | "de"; sibling?: boolean } = {},
) {
  const first = { ...letter, snippet: body.text, ...(sibling ? { threadId: "invitation-thread" } : {}) };
  const second = {
    ...first, id: "next-in-thread", subject: "A reply to the invitation", snippet: "Thanks for the invitation.",
    invitationWithoutEvent: false, date: "2026-10-21T09:00:00Z",
  };
  const letters = sibling ? [first, second] : [first];
  const state = body.state ?? "full";
  const bodies = state === "snippet" ? {} : {
    [first.id]: state === "loading" ? { state: "loading" } : { state: "ready", text: body.text, html: body.html ?? null },
  };
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <NextIntlClientProvider locale={locale} messages={catalogs[locale]} timeZone="UTC">
        <DoorsContext.Provider value={doors}>{children}</DoorsContext.Provider>
      </NextIntlClientProvider>
    );
  }
  const { view } = mountLetters({
    letters, open: sibling ? second.id : first.id, bodies, lang: locale, wrapper: Wrapper,
    parts: { body: letterBody, invitation: ReaderInvitation },
  });
  const element = letterOf(first.id);
  if (element === null) throw new Error("The Reader did not draw the invitation's letter");
  return { element, unmount: view.unmount };
}
