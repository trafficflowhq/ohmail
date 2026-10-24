import { describe, expect, it } from "vitest";
import {
  attachmentBudgetFor, effectiveAttachmentCap, sendSurfaceFor,
  SEND_ATTACHMENT_MAX_TOTAL_BYTES, SEND_MIME_ENVELOPE_BYTES, SEND_STAGED_OBJECT_MAX_BYTES,
  SEND_UNMEASURED_MESSAGE_BYTES, FORWARD_MAX_TOTAL_BYTES,
} from "@trafficflow/services/mail";
import { COMPOSE_FORWARD_MAX_TOTAL_BYTES, SEND_INLINE_MAX_TOTAL_BYTES } from "@ohmail/client-engine";
import {
  composeAttachCap,
  COMPOSE_ATTACH_MAX_TOTAL_BYTES,
  COMPOSE_ATTACH_STAGED_SURFACE_BYTES,
  COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES,
} from "../apps/webapp/app/components/ComposeAttach";

/**
 * ═══ THE FORM'S PROMISE AND THE SEND'S REFUSAL ARE ONE RULE ════════════════════════════════
 *
 * `SendService.effectiveAttachmentCap` is what refuses a send; `composeAttachCap` is what the
 * compose surface states and admits against. They are two implementations by necessity — the
 * form ships in a client bundle that may not import a server package — and two implementations
 * of one rule is exactly the drift this file exists to catch. The invariant, stated at
 * `ComposeAttach`'s render site: a number stated that the send would refuse is a claim the
 * product cannot keep, and a refusal below the promise wastes a composed message. So the two
 * functions are compared VALUE FOR VALUE over the whole input lattice — the constants, the
 * `null`/`undefined` distinction on the surface side, `SIZE 0`, and the non-finite garbage.
 *
 * ── WHY THIS LIVES IN THE REPOSITORY'S OWN test/ DIRECTORY ─────────────────────────────────
 *
 * Neither workspace may hold it. The form is published with the desktop client in BOTH publish
 * variants, and the send rule ships only with the engine-bearing one — so a published test that
 * imports the services package names a module the client-half mirror does not contain, and the
 * publish's import-closure gate refuses the push (it did; this file is the resolution). The
 * webapp's own test directory typechecks and cannot resolve a package it does not depend on.
 * A guard that spans two workspaces belongs to the repository, which is what this directory is
 * for — its imports resolve through the suite's alias table, and the directory is never
 * published.
 *
 * The other halves of this slice's guard rail stay where their subjects are:
 * `apps/desktop/test/desktop-attach-cap.test.ts` asserts the window's door-gated declaration
 * from source and the probe's `SIZE` forwarding; `apps/webapp/test/compose-attach-cap.test.tsx`
 * holds the form rule's own semantics; `compose-attach-surface.test.tsx` drives the number
 * through the whole client at both attach surfaces.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · make `composeAttachCap` read a `null` surface as "not declared" → the matrix goes red on
 *    every (null, usable-SIZE) pair;
 *  · make it read an unmeasured SIZE as "unbounded" under a null surface → red on (null, null);
 *  · move either constant → the constants case goes red before any lattice pair does.
 */

const MIB = 1024 * 1024;

/**
 * ══ AN ANNOUNCED `SIZE` BOUNDS THE ENCODED MESSAGE, NOT THE FILES ═════════════════════════════
 *
 * RFC 1870's `SIZE` is the largest MESSAGE the submission server will accept, and a message is the
 * MIME document — headers, boundaries, and every attachment base64-encoded. Attachment bytes are
 * counted RAW on both sides of this comparison, so reading the announcement as a raw-byte budget
 * overshoots by the whole encoding expansion: base64 is four characters per three bytes, and the
 * transfer encoding wraps at 76 characters with a CRLF, so 25 MB of files is about 34 MB of
 * message. A form that promised the face value would let somebody attach 25 MB to a server that
 * said 25 MB and have their own provider bounce it after the wait.
 *
 * This mattered to nothing while every mailbox fell back to the strict 3 MB constant — 3 MB
 * encodes to about 4 MB and no provider's announcement is that small. It matters the moment real
 * announcements are learned, which is what made it worth fixing rather than noting.
 */
describe("the announced SIZE is converted to a budget for RAW attachment bytes", () => {
  it("the expansion is derived, not guessed — 4/3 for base64, 78/76 for the line breaks", () => {
    // 19/26 is exactly the inverse of (4/3)·(78/76). Stated here as the arithmetic rather than as
    // a decimal, so a reader can check it and a future change has to argue with the derivation.
    expect(26 * 4 * 78).toBe(19 * 3 * 76 * (26 * 4 * 78) / (19 * 3 * 76));
    const announced = 26_000_000 + SEND_MIME_ENVELOPE_BYTES;
    expect(attachmentBudgetFor(announced)).toBe(Math.floor((26_000_000 * 19) / 26));
    expect(attachmentBudgetFor(announced)).toBe(19_000_000);
  });

  it("re-encoding the budget fits back inside what the server announced", () => {
    for (const announced of [10 * MIB, 20 * MIB, 25 * MIB, 35_882_577, 50 * MIB, 70 * MIB]) {
      const raw = attachmentBudgetFor(announced);
      // What that many raw bytes actually becomes on the wire: base64, wrapped at 76.
      const b64 = Math.ceil(raw / 3) * 4;
      const encoded = b64 + Math.floor(b64 / 76) * 2;
      expect(encoded + SEND_MIME_ENVELOPE_BYTES, `announced ${announced}`)
        .toBeLessThanOrEqual(announced);
    }
  });

  it("a pathological announcement is a hard bound, never an absent one", () => {
    // A server announcing less than the envelope allowance accepts no attachment at all. The
    // budget stays POSITIVE so it keeps binding — a non-positive value is read as "not a ceiling"
    // by the rule below, which would make the stingiest server the most permissive one.
    expect(attachmentBudgetFor(1024)).toBeGreaterThan(0);
    expect(attachmentBudgetFor(1024)).toBeLessThan(1024);
  });

  it("the send and the form apply the conversion IDENTICALLY", () => {
    for (const announced of [10 * MIB, 25 * MIB, 35_882_577, 50 * MIB]) {
      expect(effectiveAttachmentCap(null, announced)).toBe(attachmentBudgetFor(announced));
      expect(composeAttachCap(announced, null)).toBe(attachmentBudgetFor(announced));
    }
  });

  it("an UNPROBED mailbox is the assumed provider SIZE, converted like an announcement", () => {
    // The 3 MB inline constant describes the hosted request body, not a mail server, and it refused
    // a 4 MB video on a server that takes it. Both sides assume the same announcement.
    expect(COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES).toBe(SEND_UNMEASURED_MESSAGE_BYTES);
    expect(effectiveAttachmentCap(null, null)).toBe(attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES));
    expect(composeAttachCap(null, null)).toBe(attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES));
    expect(composeAttachCap(null, null)).toBeGreaterThan(4 * MIB);
  });
});

/**
 * ══ THE STAGED SURFACE HAS A CEILING OF ITS OWN, AND IT IS NOT `null` ═════════════════════════
 *
 * Uploading straight to object storage removes the request-body limit; it does not remove every
 * limit. The staging bucket refuses an object over its configured per-object size, and that
 * refusal happens in the browser's PUT — after the mint has answered 201 and after the person has
 * waited. The client reports it as "an attachment could not be uploaded, try again", which is a
 * retry that can never succeed.
 *
 * So the hosted window declares the object ceiling as its SURFACE rather than `null`. Using a
 * per-object limit as a per-TOTAL bound is deliberately conservative and always correct: if the
 * total fits, every individual file fits.
 */
describe("the staged surface states the storage object ceiling", () => {
  it("the two literals are the same number — the mirror's premise, again", () => {
    expect(COMPOSE_ATTACH_STAGED_SURFACE_BYTES).toBe(SEND_STAGED_OBJECT_MAX_BYTES);
  });

  it("a generous provider is bounded by the bucket, a stingy one by itself", () => {
    const generous = attachmentBudgetFor(70 * MIB);
    expect(generous).toBeGreaterThan(SEND_STAGED_OBJECT_MAX_BYTES);
    expect(composeAttachCap(70 * MIB, COMPOSE_ATTACH_STAGED_SURFACE_BYTES))
      .toBe(SEND_STAGED_OBJECT_MAX_BYTES);
    expect(composeAttachCap(20 * MIB, COMPOSE_ATTACH_STAGED_SURFACE_BYTES))
      .toBe(attachmentBudgetFor(20 * MIB));
  });
});

describe("the two cap rules are the same rule", () => {
  it("the THREE constants are the same number — the mirror's premise", () => {
    expect(COMPOSE_ATTACH_MAX_TOTAL_BYTES).toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
    // THE NEW CONSUMER — the transport half. `SEND_INLINE_MAX_TOTAL_BYTES` is what the wire
    // client compares a send's total against to decide whether the bytes ride the request body or
    // go to object storage first; it lives in `@ohmail/client-engine` because that is the bundle
    // that makes the decision, and it is the same number for a reason the other two are not
    // merely stylistically related to: a client that staged at a HIGHER threshold than the server
    // refuses inline at would build a request nothing accepts, and one that staged at a LOWER
    // threshold would send small files through storage they do not need.
    expect(SEND_INLINE_MAX_TOTAL_BYTES).toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
  });

  it("the forwarded-files ceiling a composer states is the one the send refuses past", () => {
    expect(COMPOSE_FORWARD_MAX_TOTAL_BYTES).toBe(FORWARD_MAX_TOTAL_BYTES);
  });

  it("the STAGED surface is the uncapped one, so the form's promise is the mailbox's own", () => {
    // The slice's whole claim in three lines. `sendSurfaceFor` is what the send applies;
    // `composeAttachCap(mailbox, null)` is what the hosted form states now that its window can
    // stage. They have to agree, or the number on screen is one the send would refuse.
    const surface = sendSurfaceFor(SEND_ATTACHMENT_MAX_TOTAL_BYTES, { stagedAttachmentIds: ["t"] });
    expect(surface).toBe(null);
    expect(composeAttachCap(25 * MIB, surface)).toBe(effectiveAttachmentCap(surface, 25 * MIB));
    // The mailbox's own — as a budget for RAW bytes, not as the face value. The announcement is
    // about the encoded message; see the conversion's own describe above.
    expect(composeAttachCap(25 * MIB, surface)).toBe(attachmentBudgetFor(25 * MIB));
    expect(composeAttachCap(25 * MIB, surface)).toBeGreaterThan(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    // …and an unprobed mailbox is the assumed SIZE on BOTH sides, never unbounded.
    expect(composeAttachCap(null, surface)).toBe(effectiveAttachmentCap(surface, null));
    expect(effectiveAttachmentCap(surface, null)).toBe(attachmentBudgetFor(SEND_UNMEASURED_MESSAGE_BYTES));
  });

  it("value for value over the whole input lattice", () => {
    const surfaces: Array<number | null | undefined> = [
      undefined, null, SEND_ATTACHMENT_MAX_TOTAL_BYTES, 2 * MIB, 0, Number.NaN,
      22 * MIB, 32 * MIB, SEND_STAGED_OBJECT_MAX_BYTES,
    ];
    const mailboxes: Array<number | null | undefined> = [
      undefined, null, 0, Number.NaN, -5, Number.POSITIVE_INFINITY,
      1 * MIB, 2 * MIB, 3 * MIB, 25 * MIB, 35 * MIB,
    ];
    for (const surface of surfaces) {
      for (const mailbox of mailboxes) {
        expect(
          composeAttachCap(mailbox, surface),
          `composeAttachCap(mailbox=${String(mailbox)}, surface=${String(surface)})`,
        ).toBe(effectiveAttachmentCap(surface, mailbox));
      }
    }
  });

  it("the acceptance pair: uncapped surface follows a probed SIZE, and never 'unbounded'", () => {
    expect(composeAttachCap(25 * MIB, null)).toBe(attachmentBudgetFor(25 * MIB));
    expect(composeAttachCap(25 * MIB, null)).toBeGreaterThan(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(null, null)).toBe(composeAttachCap(SEND_UNMEASURED_MESSAGE_BYTES, null));
  });
});
