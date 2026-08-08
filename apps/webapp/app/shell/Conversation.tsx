"use client";

/**
 * THE CONVERSATION, RENDERED.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Threading reached the mirror and the reader never showed it: opening a message that was one
 * of three on its thread rendered one body and no thread count. The data half shipped; the UI
 * half was never in scope.
 *
 * ── ONE LIST, ONE DENSITY, ONE PLACE ─────────────────────────────────────────────────────
 *
 * A sibling renders as the Blanc `.hmail` card — the same card the Screener uses for held
 * mail, so "a message rendered inside another message" looks the same wherever the product
 * does it.
 *
 * There was a second density once: `variant="quote"`, a tighter `.reply-quoted`
 * block for `InlineReply`'s 190px scroller, with a `focusedId` marker because that copy
 * included the message being answered. Both are gone with that scroller. The pane now keeps
 * the conversation while the editor is open — a reply must not repeat the message that is
 * already on screen — so there is exactly one rendering of a sibling in the product and
 * this is it. A parameterised variant with one caller is a fork nobody is walking; if a
 * second surface ever needs its own density, it comes back with that surface, tested.
 *
 * ── BOTH SIDES OF THE THREAD ────────────────────────────────────────────────────────────
 *
 * This used to render a `ConversationLimit` note saying the user's own replies were not in
 * `messages` at all, because `Sent` was unwatched. The worker watches it now, so the note and the
 * string behind it are gone: they became false the moment the worker shipped, and a claim
 * that has stopped being true is not a caveat, it is an error.
 *
 * The residual limit is a HISTORY DEPTH, not a missing half: the worker ingests the newest
 * `DEFAULT_SENT_HISTORY_MESSAGES` (2 000) of Sent, so a conversation whose outbound half is
 * older than that still shows one side. It is not stated on screen — a permanent caveat on
 * every conversation, for a case that needs two thousand sent messages to reach, is noise —
 * and it is recorded beside the ingest constant that sets the depth instead.
 *
 * ── BOUNDING, AND WHY THERE IS NO ACCORDION ─────────────────────────────────────────────
 *
 * Every message on the thread renders in full. Not "the newest five and a count": a count
 * standing in for mail nobody can open is the collapse this product forbids outright, and it is
 * the
 * exact shape of the "N archived" placeholder this product refuses.
 *
 * ── AND "IN FULL" NOW MEANS THE MAIL, NOT ONE LINE OF IT ────────────────────────────────
 *
 * This header used to carry a paragraph deciding NOT to hydrate siblings — "siblings stay
 * snippets, the affordance is owed to whichever slice next has a reason to open one". That
 * decision is reversed, and what reversed it is what the column actually looked like: ordinary
 * business letters on a thread, each ending mid-word. Every one of them was behaving exactly as
 * designed, and the design was wrong. A snippet rendered inside full message anatomy does not
 * read as a preview — it reads as a mail that has been truncated, which is precisely the claim
 * `MessageBody` and `bodyOf` were built to stop the product making.
 *
 * The old argument was cost: "fetching a whole thread because one message was opened is
 * per-message billed reads for mail nobody asked to read". It does not survive contact with
 * the numbers. A conversation is a handful of messages, not a pile — the reader opened the
 * thread, so its members are the mail they DID ask for — and `OhmailEngine.hydrateBody`
 * already single-flights per message, skips anything it holds, and bounds the fan-out at
 * `MAX_CONCURRENT_BODIES`. The Screener preview hydrates a sender's entire held list through
 * the same call; a thread is smaller than that by an order of magnitude.
 *
 * ── AND THEY RENDER THROUGH THE SAME VIEWER AS THE FOCUSED MESSAGE ──────────────────────
 *
 * Not "the same text, plainer". The identical {@link MessageBody} component, so a sibling
 * inherits the sanitizer, the sandboxed frame, remote-content blocking, dark adaptation and
 * the reflow path with nothing re-implemented and nothing to keep in step. `BodyText`'s header
 * made this argument first — "the fix landing on the pane while the thread below it keeps
 * dumping raw text is a shape this repo has shipped five times" — and a viewer on the pane
 * above a column of plain-text dumps was that shape again, one level up.
 *
 * The snippet survives as ONE thing only: the LOADING state, which is what it always honestly
 * was. A body that fails to load says so and offers Retry, exactly as the focused message
 * does. Neither state may pass as the mail.
 *
 * PROTECTED MAIL IS UNMOVED. A protected sibling renders its label and no content, decided by
 * the same expression as before and BEFORE any body is consulted — see {@link ConversationEntries}.
 */
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import type { EngineMessage } from "@ohmail/client-engine";
import { MessageBody } from "../components/MessageBody";
import { BodyText } from "./BodyText";
import { displayTime, rowAddress, senderName } from "./format";
import { useMessageChrome } from "./message-chrome";

/**
 * A subject with its reply prefixes stripped, case-folded — used ONLY to decide whether an
 * entry's subject says anything the conversation's own heading did not.
 *
 * Without it a three-deep thread prints "Re: Quote for the north elevation" three times
 * under the h2 that already says it. Multilingual on purpose: the mailboxes this reads are
 * the customer's existing ones, so German (`AW:`, `WG:`) and Nordic (`SV:`, `VS:`) prefixes
 * are as likely as `Re:`. It never CHANGES a subject — a renamed branch of a thread still
 * prints its own heading, which is the case where the heading earns its space.
 */
const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|antw)\s*(?:\[\d+\])?\s*:\s*)+/i;

function subjectKey(subject: string): string {
  return subject.replace(REPLY_PREFIX, "").trim().toLowerCase();
}

/** How deep this conversation is. */
export function ConversationHead({ count }: { count: number }) {
  const t = useTranslations("reply");
  return <p className="conv-head num">{t("conversationCount", { count })}</p>;
}

export function ConversationEntries({
  messages,
  threadSubject,
  now,
}: {
  /**
   * The entries to render, OLDEST FIRST — the SIBLINGS only. The opened message keeps the
   * full message anatomy and is rendered by `MessagePane` itself, between the two halves of
   * this list, which is what makes "which one am I reading" answerable without a legend.
   */
  messages: EngineMessage[];
  /** The subject already on screen as the message's own heading — see `subjectKey`. */
  threadSubject?: string;
  now: Date;
}) {
  const t = useTranslations("reply");
  /** Hydration state copy, shared with the pane, the Reads cards and the Screener preview. */
  const tb = useTranslations("body");
  const chrome = useMessageChrome();
  const { hydrateBody } = chrome;

  /**
   * ── THE HYDRATION EFFECT USED TO LIVE HERE, AND THAT IS WHY IT WAS TWO REQUESTS ─────────
   *
   * It was a loop calling `hydrateBody` per sibling from this component's own `useEffect`, and
   * it was wrong twice over. A loop is N requests through a four-wide limiter, so the tail of a
   * thread did not begin loading until a whole round trip had finished. And THIS COMPONENT IS
   * MOUNTED TWICE per thread — `MessagePane` renders the siblings above the opened message and
   * the siblings below it as two lists — so even the batched form asked twice, once for each
   * half, for one act of opening one conversation.
   *
   * The ask therefore belongs where the whole conversation is known, which is `MessagePane`.
   * This component renders what it is given and asks for nothing.
   */

  if (messages.length === 0) return null;
  const alreadySaid = threadSubject ? subjectKey(threadSubject) : null;

  return (
    <>
      {messages.map((m) => {
        /**
         * DECIDED FIRST, AND NO BODY IS CONSULTED INSIDE IT. The same expression `MessagePane`
         * uses for the focused message, and it is checked before `bodyOf` is called at all, so a
         * protected sibling renders its label and no content whatever the mirror happens to hold.
         */
        const isProtected = m.protected != null;
        const body = isProtected ? null : chrome.bodyOf(m);
        return (
          <article key={m.id} className="hmail" data-conv-id={m.id}>
            <div className="hm-line">
              <b>{senderName(m)}</b>
              {rowAddress(m) ? <span className="addr">{rowAddress(m)}</span> : null}
              {/* A message with no `Date:` header has no stamp, and this rendered the
                  slot anyway: an empty `.t` element with the row's stamp styling and nothing
                  in it. `MessageRow` already guards the same slot the same way. */}
              {displayTime(m, now) ? <span className="t num">{displayTime(m, now)}</span> : null}
            </div>
            {alreadySaid === subjectKey(m.subject) ? null : <h3>{m.subject}</h3>}
            {isProtected || body === null ? (
              <div className="hm-body">
                <BodyText text={t("quotedProtected")} />
              </div>
            ) : (
              <>
                {/* THE SAME VIEWER THE FOCUSED MESSAGE USES — see the header. `hm-rich` widens
                    the slot to the app's mail measure: `.hm-body`'s 62ch is a measure for a
                    line of preview prose, and an html mail rendered inside it would sit in a
                    column narrower than the one the same mail gets when it is the message you
                    opened. */}
                <div className="hm-body hm-rich">
                  {/* `remoteLoaded` is the same three-term OR the focused message uses, and it
                      has to be the same one: a sibling that kept the "Show images" button while
                      the message above it rendered its pictures would be two answers to one
                      account setting, on one screen. See `MessagePane`. */}
                  <MessageBody
                    messageId={m.id}
                    text={body.text}
                    html={body.html}
                    remoteLoaded={
                      body.loadedRemoteContent ||
                      (chrome.remoteImages?.auto ?? false) ||
                      (chrome.remoteImages?.consented(m.id) ?? false)
                    }
                    imageProxy={chrome.remoteImages ? chrome.remoteImages.proxyFor(m.id) : null}
                    onLoadRemote={
                      chrome.remoteImages && !chrome.remoteImages.auto
                        ? () => chrome.remoteImages!.consent(m.id)
                        : undefined
                    }
                  />
                </div>
                {/* WHAT THE TEXT ABOVE IS, whenever it is not the mail — AND `snippet` IS ONE OF
                    THOSE. It used to say nothing here, on the argument that the effect above has
                    already asked so it is a sub-frame state and a sentence that flashes for one
                    frame is noise. The premise was false where it mattered: the loading marker
                    was written when a fetch DEPARTED, departures are capped at four, and every
                    sibling past the cap therefore rendered a mid-word truncation of the mail with
                    nothing saying more was coming. The engine writes the marker at enqueue now,
                    and this branch is the half of the fix that does not depend on that: this
                    component hydrates exactly what it renders, so a snippet at rest here is a
                    defect, and "still coming" is the honest thing to say about it.
                    `failed` carries the way out — the pane's own dead end, reached from the
                    other side. */}
                {body.state === "loading" || body.state === "snippet" ? (
                  <p className="hm-state">{tb("loading")}</p>
                ) : null}
                {body.state === "failed" ? (
                  <p className="hm-state warn">
                    {tb("failed")}{" "}
                    <Button variant="ghost" onClick={() => hydrateBody(m.id, { retry: true })}>
                      {tb("retry")}
                    </Button>
                  </p>
                ) : null}
              </>
            )}
          </article>
        );
      })}
    </>
  );
}
