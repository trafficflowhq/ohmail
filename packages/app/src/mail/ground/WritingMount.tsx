"use client";

/**
 * THE ONE COMPOSER, MOUNTED ABOVE THE PANES: the letter being written, the reply under a letter, the drafts' doors
 * and the ONE send machine of a mounted frame. `useShellCompose` is called here and nowhere else, over the inputs
 * the ground reads off its host, the frame and the pieces above (`writing-inputs.ts`, where nothing defaults). It
 * stands for the frame's life, above every place: a send pressed at one place is answered on the machine that sent
 * it wherever the person has walked since, and a walk never mounts a second composer, a second autosave or a second
 * send machine. Another scope mounts it again, with nothing of the first.
 *
 * WHAT IT PROVIDES, each once per frame:
 * - The composition as the screen `write` reads it (`useWriting()`, `useWriteBeside()`): the place `write`, the
 *   reader's reply sheet and the drafts read the same one.
 * - The reply that last settled (`useReplyDone()`): the Ohbox's one deliberate move, the answered row to Earlier.
 * - The composer's own record (`useComposer()`), for the parts that stand beside it over the one machine: the
 *   restart hold's relay, the notices that say a send's state, the drafts' doors.
 * - The release of a confirmed Send + Done (`useSendRelease()`), for every strip that offers Try again, and inside it
 *   the ONE mount of the list of the changes that did not go through (`UnsavedList`), whose Try again releases one.
 *
 * NOT HERE, and whose: the way to the place `write` from the rail, the dock and a key (the frame's and the mail
 * keys': they pass the compose door, `goCompose`, which this composer registers); the restart hold's relay and the
 * notices (the ground's feeders, beside this mount); the Drafts place.
 */
import { useMemo, useRef, type ReactNode } from "react";
import { useBrowserOnline } from "@ohmail/app-logic/session/browser-online";
import { ComposerContext, useComposer } from "@ohmail/app-logic/writing/composer-record";
import { useRecordWhileSame } from "@ohmail/app-logic/press/stable-callback";
import { optionsFromFacts } from "@ohmail/app-logic/writing/compose-from";
import { ReplyDoneContext } from "@ohmail/app-logic/writing/reply-done";
import { SendReleaseProvider } from "@ohmail/app-logic/writing/send-release";
import { useShellCompose } from "@ohmail/app-logic/writing/shell-compose";
import { writeBesideOf, writingOf } from "@ohmail/app-logic/writing/writing-of";
import { useConsent } from "@ohmail/app-logic/consent";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useScreenerBeside } from "../../screener/index.js";
import { WriteAbove, type WriteBeside, type Writing } from "../../write/index.js";
import { useWritingInputs } from "./writing-inputs.js";
import { UnsavedList } from "./UnsavedList.js";
import { fileSize } from "./writing-words.js";

export function WritingMount({ children }: { readonly children: ReactNode }): ReactNode {
  const inputs = useWritingInputs();
  /* The composer's record, held while no member moved (`useRecordWhileSame`), handed whole to its one context: a
     reader of `useComposer()` renders when a member moves, not at every render of this mount. */
  const compose = useRecordWhileSame(useShellCompose(inputs.composer));
  return (
    <ComposerContext.Provider value={compose}>
      <ReplyDoneContext.Provider value={compose.replyDone}>
        <SendReleaseProvider value={compose.releaseConfirmed}>
          <UnsavedList>
            <WritingOver inputs={inputs}>{children}</WritingOver>
          </UnsavedList>
        </SendReleaseProvider>
      </ReplyDoneContext.Provider>
    </ComposerContext.Provider>
  );
}

/** The composition as the screen `write` reads it, of the composer the context above holds. */
function WritingOver({
  inputs,
  children,
}: {
  readonly inputs: ReturnType<typeof useWritingInputs>;
  readonly children: ReactNode;
}): ReactNode {
  const { host } = useFrame();
  const consent = useConsent();
  const compose = useComposer();
  const { composer, engine, scope, replyTo, facts, lists, t } = inputs;
  /* The Screener's model stands above this mount: its run says whether the balance was last refused as empty. */
  const suggest = useScreenerBeside().suggest;
  /* The account's sendable addresses: empty while its mailboxes cannot be seen, never a guess. */
  const options = useMemo(() => (facts === null ? [] : optionsFromFacts(facts)), [facts]);
  /* Checked here against the screen's own port: what the composer's adapter answers is what `write` reads. */
  const writing: Writing = writingOf(compose, {
    engine,
    scope,
    replyTo,
    options,
    consent,
    drafts: lists.drafts,
    /* The balance was last refused as empty (the Screener's standing): the draft's price is not said, its notice is. */
    noCredits: suggest !== NONE && suggest.control.standing === "no_budget",
    t,
    presented: composer.presented,
  });
  /* What one send may carry and whether a draft's price is said are the host's own answers. */
  const ceiling = host.capabilities.sendCeiling;
  const metered = host.capabilities.service === "managed";
  const { pickFile } = host.device;
  /* The device's own network fact, read where it is said and asked at the press. */
  const online = useRef(true);
  online.current = useBrowserOnline();
  const beside: WriteBeside = useMemo(
    () => ({ ...writeBesideOf(engine, scope, ceiling, metered, fileSize, () => online.current), pickFile }),
    [engine, scope, ceiling, metered, pickFile],
  );
  return (
    <WriteAbove writing={writing} beside={beside}>
      {children}
    </WriteAbove>
  );
}
