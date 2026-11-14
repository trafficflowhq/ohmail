/**
 * THE PARTITION ABOVE THE PANES: whose mail this is, and where each letter is presented. What stands above every
 * pane derives it once per mounted frame and provides it here; a place reads it with `usePartition()`. The mirror as
 * the lists present it is composed from it once, beside it, and read with `usePresented()`
 * (`@ohmail/app-logic/reading`).
 */
import { createContext, useContext, useEffect, useMemo, useState, type Context } from "react";
import {
  consentPartition,
  widestWindowOf,
  type ConsentPartition,
  type EntityReader,
  type OhmailEngine,
} from "@ohmail/client-engine";
import { ownAddressesOf, type MailboxFacts } from "../mail-state/mail-state.js";
import {
  firstImportsKey,
  firstImportsOf,
  shellConsentOptions,
  type FirstImports,
  type ShellConsentFacts,
} from "../press/consent-options.js";
import { readBootCache, writeBootCache } from "../session/boot-cache.js";
import { mirrorOwnerOf } from "../session/sync-scheduler.js";

/**
 * What the one derivation answers.
 *
 * A reader MAY RELY ON: one record per mounted frame, of the frame's own scope, the same object while none of its
 * three members changed; every list, count and press of the frame reads these same three, so no two parts place one
 * letter two ways.
 *
 * A reader MAY NEVER: derive them a second time (a second derivation tells the engine its cutline twice and can
 * disagree with the lists); partition the lists' mirror itself, or compose the presented mirror itself (it is read,
 * with `usePresented()`); keep a member where it outlives the frame's mount; or read the context with a
 * fallback of its own. An empty list of own addresses turns the account's own mail into a stranger's, so no record
 * is no answer, and `usePartition` throws.
 */
export interface Partition {
  /**
   * The account's own addresses, in the mail server's order and case, never folded: off the mailbox facts, or the
   * device's remembered copy of them until the facts answer. Empty only while neither is known. The same array
   * while the set is the same.
   */
  readonly ownAddresses: readonly string[];
  /** Each mailbox's first-import stamp by its id, `null` while its import runs. `undefined` until the facts answer. */
  readonly firstImportDoneAt: FirstImports | undefined;
  /**
   * Where each letter is presented: the consent partition the lists are drawn with. `null` in the demo alone,
   * whose invented world is not partitioned; never `null` for "not known yet" (before the consent row answers, the
   * partition runs on the rules alone).
   */
  readonly consentView: ConsentPartition | null;
}

/** Filled by what stands above the panes, once per mounted frame. Read it with {@link usePartition}. */
export const PartitionContext: Context<Partition | null> = createContext<Partition | null>(null);

/** The partition of this frame. Throws where none stands above: nothing is placed on a guessed list of addresses. */
export function usePartition(): Partition {
  const partition = useContext(PartitionContext);
  if (partition === null) throw new Error("usePartition: no partition stands above (PartitionContext)");
  return partition;
}

/** The `boot-cache.ts` scope for the account's own addresses. See `ownAddresses` below. */
const OWN_ADDRESSES_BOOT_SCOPE = "own-addresses";

/**
 * The memo key for {@link ShellInner}'s `ownAddresses` — see there for why
 * the addresses and not the facts row. Sorted and lower-cased so the same
 * set in a different order, or with different server casing, is one key.
 * JSON, never a join character: a literal NUL join once made `file` report
 * this source as `data` and every grep-family tool skip it in silence.
 * JSON escapes its own delimiters, so no two distinct lists can produce
 * one string, and every byte of the result is printable.
 */
function ownAddressKey(
  facts: ReadonlyArray<Pick<MailboxFacts, "address" | "addressIsOwn">> | null,
  remembered: readonly string[] | null,
): string {
  const list = (facts ? ownAddressesOf(facts) : null) ?? remembered ?? [];
  return JSON.stringify([...list].map((a) => a.trim().toLowerCase()).sort());
}

/** A cached address list an older build wrote degrades to "no cache", never to mixed types. */
function acceptAddressList(parsed: unknown): string[] | null {
  if (!Array.isArray(parsed)) return null;
  return parsed.every((x): x is string => typeof x === "string") ? parsed : null;
}

/**
 * What the one derivation is handed. Every field is required and none has a default: a forgotten `demo` would
 * partition the fixture world, and a forgotten `resolvedDemo` would carry one account's remembered addresses into it.
 */
export interface PartitionInput {
  engine: OhmailEngine;
  /** The mirror as it is: `engine.read()` from the caller's render, never read again here. */
  reader: EntityReader;
  /** The derived stamp the partition's memo is keyed on (`useDerivedVersion`). */
  derived: number;
  demo: boolean;
  /** The browser's own answer (`useResolvedDemoMode`): what a gate that reads or writes the device's copy asks. */
  resolvedDemo: boolean;
  now: Date;
  /** `GET /mailboxes`, or null while it has not answered. */
  facts: MailboxFacts[] | null;
  /** The consent row's fields the cutline is drawn with. */
  consent: ShellConsentFacts;
}

/**
 * THE ONE DERIVATION. What stands above the panes calls it once per mounted frame and provides its answer
 * ({@link PartitionContext}); nothing else calls it. It also tells the engine the cutline and each mailbox's Sent
 * folder, so the engine keeps and files by the same answers the lists are drawn with. Its one caller is handed the
 * addresses as the memo holds them (an array of its own, as the old shell's parts took it); a reader of the context
 * reads them through {@link Partition} and may not write.
 */
export function usePartitionOf({
  engine,
  reader,
  derived,
  demo,
  resolvedDemo,
  now,
  facts,
  consent,
}: PartitionInput): Partition & { readonly ownAddresses: string[] } {
  /**
   * The account's own addresses, from `GET /mailboxes` — passed explicitly,
   * not left to the default. `consentPartition` falls back to the mirror's
   * `mailbox` entities, and a live `/sync` feed carries none: an empty set
   * on exactly the surface that matters, so the user is not recognised as
   * themselves and their own mail (a note to self, a cross-account
   * forward) queues in their own Screener. The demo's mirror DOES hold
   * mailbox rows, so no fixture test could have shown this.
   */
  /**
   * …AND THE BOOT USES THE DEVICE'S COPY OF THAT ANSWER. `facts` is a round trip away on every
   * load, and a partition computed with an empty own-set for that interval would present the
   * user's own recent self-mail in their own Screener — the same boot-window defect the consent
   * cache below closes, on this input. So the addresses ride the same per-account boot cache:
   * written whenever `GET /mailboxes` has answered, read while `facts` is still null, keyed by
   * the remembered account id, and never applied over a live answer (`facts` wins the `??`).
   * An address list neither authorises nor loads anything — it only stops the account being
   * treated as a stranger to itself for the first round trip.
   */
  const [rememberedOwn, setRememberedOwn] = useState<string[] | null>(null);
  useEffect(() => {
    /* `resolvedDemo`, not `demo`: on a prerendered demo page the raw flag is false for one
       render, and this one carries a PREVIOUS account's remembered addresses into the fixtures
       world rather than issuing a request. */
    if (resolvedDemo) return;
    const owner = mirrorOwnerOf(engine);
    if (owner === null) return;
    if (facts) {
      writeBootCache(OWN_ADDRESSES_BOOT_SCOPE, owner, ownAddressesOf(facts));
      return;
    }
    const cached = readBootCache(OWN_ADDRESSES_BOOT_SCOPE, owner, acceptAddressList);
    if (cached !== null) setRememberedOwn(cached);
  }, [engine, resolvedDemo, facts]);
  /**
   * Keyed on the addresses, not the facts row. `consentView` depends on nothing else about a
   * mailbox, and keyed on `facts` it rebuilt the whole-mirror partition whenever ANY field
   * moved — `pendingMoves` decrements on every poll for hours on a fresh mailbox. A STRING of
   * the sorted, lower-cased addresses rather than the identity of `facts`: the provider's
   * equality gate stops the poll that learned nothing, this stops the poll that learned
   * something the partition does not care about. Sorted and lower-cased is the KEY only — the
   * value keeps the server's order and case; nothing downstream may see a folded address.
   */
  const ownAddresses = useMemo(
    () => (facts ? ownAddressesOf(facts) : null) ?? rememberedOwn ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownAddressKey(facts, rememberedOwn)],
  );
  /**
   * EACH MAILBOX'S FIRST-IMPORT STAMP, for the held-claim term (`firstImportsOf`). Keyed on the
   * stamps for `ownAddresses`' reason: the partition reads nothing else of a mailbox row here.
   */
  const firstImportDoneAt = useMemo(
    () => firstImportsOf(facts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [firstImportsKey(facts)],
  );
  /**
   * …AND THE ENGINE IS TOLD THE SAME CUTLINE THE PARTITION BELOW IS DRAWN WITH.
   *
   * A windowed mirror decides dormancy from the mail it kept, the server from the whole account,
   * and the dial offers 90, 180 and 365 days against a 90-day window — so two of its three rungs
   * put the cutline past the window. Past it a sender whose only mail the window evicted is
   * dormant here and active there: filed in History, never asked about. So the engine widens its
   * retention to cover the cutline (`maxRows` still decides the size), read from the SAME
   * `consent` fields the partition is keyed on, so the two cannot be measured differently.
   */
  // Each live read is a new object: the partition's memo and the cutline key on what the map SAYS.
  const screeningByMailboxKey = JSON.stringify(consent.screeningByMailbox ?? null);
  useEffect(() => {
    if (demo || !(consent.known || consent.standalone)) return;
    // Each mailbox's organizer's window where the server says (RULING-026): the reader's own row is inert.
    engine.setCutline(widestWindowOf(consent.screeningByMailbox)
      ?? { dormancyDays: consent.dormancyDays, scope: consent.screeningScope });
  }, [engine, demo, consent.known, consent.standalone, consent.dormancyDays, consent.screeningScope, screeningByMailboxKey]);
  // Each mailbox's recorded Sent folder, from the last answered read; the engine ignores a repeat.
  useEffect(() => {
    if (demo || facts === null) return;
    engine.setSentFolders(facts);
  }, [engine, demo, facts]);
  const consentView: ConsentPartition | null = useMemo(
    // The demo is not partitioned — consent derives from rules and the fixture world has none, so
    // the partition would empty the curated world into History. RULES NEVER WAIT FOR THE READ: until
    // the window is known (`GET /consent`, or the boot's CACHED last answer, `boot-cache.ts`) the
    // partition runs `rulesOnly` — a ruled sender is decided and their mail stays where the mailbox
    // has it (a DENY rule's on its shelf), an unruled one stays in its folder, nothing is cut to
    // History. With no partition at all a paired desktop whose read failed drew screened-out mail
    // in its Ohbox. The desktop (`consent.standalone`) has no stored window, so the default IS the
    // truth there.
    () =>
      demo
        ? null
        // One builder for the lists and a screening press's read-back (`consent-options.ts`).
        : consentPartition(reader, shellConsentOptions(consent, now, ownAddresses, firstImportDoneAt)),
    [
      demo, consent.known, consent.standalone, reader, derived, now, consent.dormancyDays,
      consent.screeningBaselineAt, consent.screeningScope, screeningByMailboxKey, ownAddresses, firstImportDoneAt,
      consent.foldersEnabled,
    ],
  );
  return useMemo(
    () => ({ ownAddresses, firstImportDoneAt, consentView }),
    [ownAddresses, firstImportDoneAt, consentView],
  );
}
