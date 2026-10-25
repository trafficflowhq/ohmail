/**
 * ═══ THE PHONE COMPOSER'S ATTACHMENTS — the admit rule, the shared bound, the send lock, the
 * wire (PHONE-COMPOSE-HAS-NO-ATTACHMENTS; THE cap discrepancy) ═════════════════════════════
 *
 * Three layers, each asked where it is real:
 *  · the PURE rules (`src/compose/attach.ts`) — the admit pipeline mirrored from the webapp's
 *    `ComposeAttach` (cap → duplicate → notes), the needs-content predicate mirrored from the
 *    webapp's `sendNeedsContent`, and the cap read from the ONE shared bound
 *    (`composeAttachCap`, `@ohmail/client-engine` — the same function the web form renders);
 *  · the WIRING (`src/ui/MessageActions.tsx`, read as text — this workspace has no RN
 *    renderer): the sheet judges the shared predicate, the Send press on a content-less reply
 *    says the sentence, both send arms carry the files, the pickers live behind the native twin;
 *  · the WIRE (the loopback mail server, the same `bootEngine` composition the app runs): an
 *    attachment-only reply SENDS with the files base64 on `POST /drafts/:id/send` (they ride
 *    the send, not the draft — the adapter's own contract), and an empty reply refuses with
 *    NOTHING on the wire.
 *
 * ── MUTATIONS WATCHED (each parked and restored through `mutation-control.sh`) ──────────────
 *  · `attach-cap.ts`: `bounds.push(composeAttachBudgetFor(mailboxMax))` → `bounds.push(mailboxMax)`
 *    ⇒ the announced-SIZE rows RED (the face value is not a raw-byte budget);
 *  · `attach.ts`: `phoneSendNeedsContent` back to the body-only rule (`&& o.attachmentCount === 0`
 *    dropped) ⇒ the attachment-is-content rows RED;
 *  · `attach.ts`: the duplicate identity narrowed to filename alone ⇒ the same-name-different-bytes
 *    row RED;
 *  · `world.tsx`: the by-reference binding re-declared as the five-arg lambda it used to be ⇒ the
 *    wire cases RED — THE DEFECT reproduced: the facade dropped `attachments` silently, the
 *    sheet showed the row, the wire carried nothing, and an attachment-only press was a silent
 *    no-op. The wire cases below therefore drive the app's own chain (`stableActions` over the
 *    live actions — the world facade contributes no code for these two verbs any more), never the
 *    live layer alone, which is the double that answered differently;
 *  · `attach.ts`: the empty-bytes belt dropped from `admitPicked` ⇒ the bytes-absent row RED.
 *  · `attach.ts`: the `nameFromPick` arm dropped from the duplicate identity ⇒ the re-picked
 *    photo row RED (each pick names the same picture anew, so it was listed twice).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
/* @reads: apps/mobile/src/ui/MessageActions.tsx apps/mobile/src/state/world.tsx apps/mobile/src/compose/attach-native.ts
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */

  COMPOSE_ATTACH_MAX_TOTAL_BYTES,
  composeAttachBudgetFor,
  composeAttachCap,
} from "@ohmail/client-engine";
import {
  admitPicked,
  base64SizeBytes,
  phoneAttachCap,
  phoneSendNeedsContent,
  photoName,
  pickerGaveNoName,
  toComposeAttachments,
  type PhoneComposeAttachment,
} from "../src/compose/attach";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import type { PhoneMailbox } from "../src/net/mailboxes";
import { sayArg } from "../src/refusal";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import { liveActions, stableActions, type LiveWorldActions } from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer, ruleDto } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSER = readFileSync(join(APP, "src/ui/MessageActions.tsx"), "utf8");

const MIB = 1024 * 1024;

/** One picked file of an exact size — base64 of `n` bytes, so the accounting is the real one. */
function picked(filename: string, n: number, fill = "a"): PhoneComposeAttachment {
  const contentBase64 = Buffer.alloc(n, fill).toString("base64");
  return { filename, contentType: "application/octet-stream", contentBase64, sizeBytes: n };
}

/** A mailbox row with only the fields the cap reads. */
function box(id: string, smtpMaxSizeBytes: number | null): PhoneMailbox {
  return {
    id, address: `${id}@fake.test`, organizerRole: null, organizeConsentedAt: null,
    organizedBy: null,
    organizedByThisInstall: false, organizerState: null, status: null, junkFolder: null,
    smtpMaxSizeBytes, firstSyncStopFolder: null,
  };
}

describe("the cap is the ONE shared bound — composeAttachCap of the mailbox's announced SIZE", () => {
  it("a probed mailbox reads the SHARED rule — and the phone's undeclared surface keeps the strict arm", () => {
    const announced = 50 * MIB;
    const cap = phoneAttachCap([box("mb-1", announced)], "mb-1");
    // Value for value against the client-engine rule the web form renders — one bound,.
    expect(cap).toBe(composeAttachCap(announced));
    // The phone declares NO surface (its send rides one JSON request), so a generous
    // announcement is bounded by the strict constant — the min is the point, both directions:
    // the same rule gives the web its 40 MiB staged surface and this phone its 3 MiB one.
    expect(composeAttachBudgetFor(announced)).toBeGreaterThan(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(cap).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("an unprobed or unknown mailbox falls to the strict constant, never to unbounded", () => {
    expect(phoneAttachCap([box("mb-1", null)], "mb-1")).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(phoneAttachCap([], "mb-9")).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(phoneAttachCap([box("mb-1", 50 * MIB)], null)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("a stingy announcement binds BELOW the constant — the min is the point", () => {
    const announced = 2 * MIB;
    expect(phoneAttachCap([box("mb-1", announced)], "mb-1")).toBe(composeAttachBudgetFor(announced));
    expect(phoneAttachCap([box("mb-1", announced)], "mb-1")).toBeLessThan(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });
});

describe("the admit pipeline — cap, then duplicate, in pick order", () => {
  it("admits under the cap in pick order and refuses the file that would cross it", () => {
    const cap = 10_000;
    const out = admitPicked([picked("a.bin", 4000)], [picked("b.bin", 4000), picked("c.bin", 4000)], cap);
    expect(out.next.map((f) => f.filename)).toEqual(["a.bin", "b.bin"]);
    expect(out.overCap).toBe(1);
    expect(out.duplicates).toEqual([]);
  });

  it("the cap binds DURING the walk — a refused file frees no room and blocks no smaller one", () => {
    const cap = 10_000;
    const out = admitPicked([], [picked("big.bin", 11_000), picked("small.bin", 9000)], cap);
    expect(out.next.map((f) => f.filename)).toEqual(["small.bin"]);
    expect(out.overCap).toBe(1);
  });

  it("a re-picked file is a SKIP, not a second row — the web's identity, name AND bytes", () => {
    const a = picked("a.bin", 100, "a");
    const out = admitPicked([a], [picked("a.bin", 100, "a"), picked("a.bin", 100, "b")], 10_000);
    // Same name, same bytes: skipped and named. Same name, DIFFERENT bytes: a real second file.
    expect(out.duplicates).toEqual(["a.bin"]);
    expect(out.next).toHaveLength(2);
  });

  it("a picked file with NO BYTES is refused the row at pick time — never sent without them", () => {
    // The device-shaped control the lane asked for: a picker that hands a name and a size
    // but an empty base64 (a broken read) must not produce a row that later sends nothing.
    const ghost: PhoneComposeAttachment = {
      filename: "photo.png", contentType: "image/png", contentBase64: "", sizeBytes: 4096,
    };
    const out = admitPicked([], [ghost, picked("real.png", 100)], 10_000);
    expect(out.next.map((f) => f.filename)).toEqual(["real.png"]);
    expect(out.unreadable).toBe(1);
  });

  it("the mutation's shape strips the admit weight, and an empty list is ABSENT — the wire stays byte-identical", () => {
    expect(toComposeAttachments([])).toBeUndefined();
    const [one] = toComposeAttachments([picked("a.bin", 3)])!;
    expect(Object.keys(one!).sort()).toEqual(["contentBase64", "contentType", "filename"]);
  });

  it("base64 accounting matches the decoded size at every padding", () => {
    for (const n of [0, 1, 2, 3, 4, 100]) {
      expect(base64SizeBytes(Buffer.alloc(n, 7).toString("base64")), String(n)).toBe(n);
    }
  });
});

describe("a picked photo keeps a real name, never the picker's media number", () => {
  const at = new Date("2026-10-23T21:44:05Z");
  it("a bare number or a cache UUID becomes 'Photo <date>' in the reader's zone; a real name is kept", () => {
    expect(photoName("19.jpg", "image/jpeg", at, "Europe/Zurich", new Set())).toBe("Photo 2026-10-23 23.44.05.jpg");
    expect(photoName("1000000033", "image/png", at, "UTC", new Set())).toBe("Photo 2026-10-23 21.44.05.png");
    expect(photoName("5C8E3F7A-12AB-4ABC-9DEF-0123456789AB.jpeg", "image/heic", at, "UTC", new Set()))
      .toBe("Photo 2026-10-23 21.44.05.heic");
    expect(photoName(null, "image/jpeg", at, "UTC", new Set())).toBe("Photo 2026-10-23 21.44.05.jpg");
    expect(photoName("", null, at, "UTC", new Set())).toBe("Photo 2026-10-23 21.44.05.jpg");
    expect(photoName("r9-photo.jpg", "image/jpeg", at, "UTC", new Set())).toBe("r9-photo.jpg");
    expect(photoName("IMG_2041.HEIC", "image/heic", at, "UTC", new Set())).toBe("IMG_2041.HEIC");
  });

  it("a second photo of the same name in one pick gets ' (2)', and German says 'Foto'", () => {
    const taken = new Set(["Photo 2026-10-23 21.44.05.jpg", "beach.jpg"]);
    expect(photoName("20.jpg", "image/jpeg", at, "UTC", taken)).toBe("Photo 2026-10-23 21.44.05 (2).jpg");
    expect(photoName("beach.jpg", "image/jpeg", at, "UTC", taken)).toBe("beach (2).jpg");
    try {
      setActiveLocale("de");
      expect(photoName("19", "image/jpeg", at, "UTC", new Set())).toBe("Foto 2026-10-23 21.44.05.jpg");
    } finally {
      resetLocaleRegisterForTests();
    }
  });

  it("the same photo picked again is 'Already attached', though the pick clock named it anew", () => {
    // What Android's picker hands twice for one picture: the media number and the same bytes.
    // The name is made at each pick, so it differs; the bytes are the identity then.
    const bytes = Buffer.alloc(300, "p").toString("base64");
    const row = (at: Date, taken: ReadonlySet<string> = new Set()): PhoneComposeAttachment => ({
      filename: photoName("19.jpg", "image/jpeg", at, "UTC", taken),
      contentType: "image/jpeg",
      contentBase64: bytes,
      sizeBytes: 300,
      ...(pickerGaveNoName("19.jpg") ? { nameFromPick: true as const } : {}),
    });
    const first = row(new Date("2026-10-23T21:44:05Z"));
    const again = row(new Date("2026-10-23T21:44:31Z"));
    expect(again.filename, "the premise: the second pick is named anew").not.toBe(first.filename);
    const out = admitPicked([first], [again], 10_000);
    expect(out.next).toHaveLength(1);
    expect(out.duplicates).toEqual(["Photo 2026-10-23 21.44.05.jpg"]);
    // A different picture with a made-up name is a real second file, and a real name is a name.
    const other = { ...again, contentBase64: Buffer.alloc(300, "q").toString("base64") };
    expect(admitPicked([first], [other], 10_000).next).toHaveLength(2);
    expect(pickerGaveNoName("IMG_2041.HEIC")).toBe(false);
    expect(pickerGaveNoName("1000000033")).toBe(true);
    expect(pickerGaveNoName(null)).toBe(true);
  });

  it("the native twin marks a photo it named, so the re-pick check can read it", () => {
    const native = readFileSync(join(APP, "src/compose/attach-native.ts"), "utf8");
    expect(native).toContain("pickerGaveNoName(asset.fileName) ? { ...row, nameFromPick: true } : row");
  });
});

describe("the send lock — the webapp's sendNeedsContent, mirrored", () => {
  it("empty body AND no attachments is the one refused state; an attachment IS content", () => {
    expect(phoneSendNeedsContent({ forward: false, body: "", attachmentCount: 0 })).toBe(true);
    expect(phoneSendNeedsContent({ forward: false, body: "   ", attachmentCount: 0 })).toBe(true);
    expect(phoneSendNeedsContent({ forward: false, body: "Thanks!", attachmentCount: 0 })).toBe(false);
    expect(phoneSendNeedsContent({ forward: false, body: "", attachmentCount: 1 })).toBe(false);
    // A forward's content is the forwarded message itself — the standing exemption.
    expect(phoneSendNeedsContent({ forward: true, body: "", attachmentCount: 0 })).toBe(false);
  });
});

describe("the sheet's wiring (source, not render — this workspace has no RN renderer)", () => {
  it("judges the shared predicate and hands both send arms the files", () => {
    expect(COMPOSER).toContain("phoneSendNeedsContent({ forward, body, attachmentCount: attachments.length })");
    /* ALL THREE send arms are handed the same `files` — a fourth compose mode added without
       them would attach nothing and say nothing, which is the shape this pin exists for. The
       trailing `andDone` is Send + Done's flag and is pinned WITH the files, in one literal per
       arm: what this measures is that the same call carries both, so a widening that dropped
       `files` from one arm is still the red it always was. `sendNew` has no source to finish,
       so it carries no flag. */
    expect(COMPOSER).toContain("w.actions.sendForward(m!.id, recipients ?? [], body, sigText, files, andDone, forwardConfirmed, draftId,");
    expect(COMPOSER).toContain("forwardPlan?.wire !== undefined ? { forwardParts: forwardPlan.wire } : {}, baseFor(base.current, draftId), waitedFor(base.current, draftId))");
    expect(COMPOSER).toContain('w.actions.sendReply(m!.id, body, mode === "replyAll", sigText, sendAt, files, andDone, draftId)');
    expect(COMPOSER).toContain("w.actions.sendNew(sendFrom, recipients ?? [], subject, body, sigText, sendAt, files, draftId, sendCopies ?? undefined, baseFor(base.current, draftId), waitedFor(base.current, draftId))");
  });

  it("a Send that lacks only content stays pressable and the press earns the sentence", () => {
    /* The press is still THERE and still earns the sentence; what changed is how the
       unavailable case is expressed — `disabled` rather than a missing handler, which took
       the button role off the control (measured on the Duo). */
    /* RE-DERIVED: the press reads one act (`sendPressAct`, driven in
       `send-press-after-unverified.test.ts`), whose content-only arm is still this sentence. */
    expect(COMPOSER).toContain('disabled={pressAct === "none"}');
    expect(COMPOSER).toContain("onPress={() => press(pressAct)}");
    expect(COMPOSER).toContain('else if (act === "needContent") setNeedNote(true);');
    expect(COMPOSER).toContain("needNote && needsContent ? (");
    expect(COMPOSER).toContain("{Copy.composeNeedContent}");
  });

  it("the cap on screen is the cap the admit rule refuses against, from the shared bound", () => {
    // The cap is read from the mailbox this composer SENDS FROM — an opened draft's own, the
    // parent's for a reply or forward, the engine's compose-from fallback for a mail with no parent,
    // or the sender standing in for a draft's mailbox that cannot send (`compose-sender.ts`).
    expect(COMPOSER).toContain("const mailboxId = draft?.mailboxId ?? m?.mailboxId ?? w.mailboxes.sendingId;");
    expect(COMPOSER).toContain("const sendFrom = sender?.sendFrom ?? mailboxId;");
    expect(COMPOSER).toContain('const attachCap = phoneAttachCap(w.mailboxes.rows, sendFrom ?? "")');
    expect(COMPOSER).toContain("{Copy.attachCap(sizeLabel(attachCap))}");
    // Admitted AFTER the shrink (`compose-attach-shrinks-photos.test.ts`), against the same cap.
    expect(COMPOSER).toContain("admitPicked(attachments, picked, attachCap)");
  });

  it("the pickers live behind the native twin, and every attachment row offers its remove", () => {
    expect(COMPOSER).toContain('from "../compose/attach-native"');
    expect(COMPOSER).toContain("Copy.attachRemove(file.filename)");
    // The picker's own refusal is SAID, never a press that does nothing.
    expect(COMPOSER).toContain("Copy.attachUnavailable");
  });
});

/* ── the wire — the same bootEngine composition the app runs, against the loopback server ──── */

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
  fake.addMessage(dto("m1", { subject: "Welcome" }));
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  const actions: LiveWorldActions = liveActions({
    engine: boot.engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid: deps.uuid,
    zone: "UTC",
  });
  /* THE APP'S OWN CHAIN, minus React: the sheet presses `stableActions(() => backend)`, and the
     world facade binds sendReply/sendForward BY REFERENCE (pinned below) — so this facade is the
     whole path between the press and the live layer. Driving `actions` directly was the double
     that answered differently: it was green while the facade dropped the attachments argument. */
  const world = stableActions(() => actions as never);
  return { fake, boot, actions, world, toasts };
}

const wire = (fake: ReturnType<typeof mailServer>, method: string, path: string) =>
  fake.seen.filter((r) => r.method === method && r.url === path);

describe("the world facade cannot drop the attachments argument", () => {
  it("binds both send verbs BY REFERENCE — a re-declared positional lambda is the measured defect", () => {
    const world = readFileSync(join(APP, "src/state/world.tsx"), "utf8");
    expect(world).toContain("sendReply: acts.sendReply,");
    expect(world).toContain("sendForward: acts.sendForward,");
    // The old shape stays gone: the five-arg lambda dropped the sixth argument in silence.
    expect(world).not.toMatch(/sendReply: \(id, body, all, sig, sendAt\) =>/);
  });
});

describe("attachments on the real wire — they ride the SEND, and an empty message never dials", () => {
  it("an attachment-only reply sends: base64 on POST /drafts/:id/send, blank body admitted", async () => {
    const { fake, boot, world } = await scene();
    const file = picked("receipt.pdf", 48);
    const result = await world.sendReply("m1", "", false, null, null, toComposeAttachments([file]));
    expect(result.outcome).toBe("sent");
    const sends = wire(fake, "POST", "/drafts/d-1/send");
    expect(sends).toHaveLength(1);
    const body = JSON.parse(sends[0]!.body) as {
      attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>;
    };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments![0]!.filename).toBe("receipt.pdf");
    expect(body.attachments![0]!.contentBase64).toBe(file.contentBase64);
    boot.store.close();
    fake.server.close();
  });

  it("an empty reply — no body, no attachments — refuses with NOTHING on the wire", async () => {
    const { fake, boot, world, toasts } = await scene();
    expect((await world.sendReply("m1", "   ", false)).outcome).toBe("failed");
    expect(wire(fake, "POST", "/drafts")).toHaveLength(0);
    // …and the refusal is TOLD: this belt returns before `sent()`'s toast site, and a refusal
    // that renders nothing is the silent no-op, one layer down.
    expect(toasts).toContain(Copy.composeNeedContent);
    boot.store.close();
    fake.server.close();
  });

  it("a forward carries its files beside the note", async () => {
    const { fake, boot, world } = await scene();
    const file = picked("notes.txt", 12);
    const result = await world.sendForward(
      "m1", [{ name: null, address: "peer@fake.test" }], "See attached.", null,
      toComposeAttachments([file]),
    );
    expect(result.outcome).toBe("sent");
    const sends = wire(fake, "POST", "/drafts/d-1/send");
    expect(sends).toHaveLength(1);
    const body = JSON.parse(sends[0]!.body) as { attachments?: Array<{ filename: string }> };
    expect(body.attachments?.map((a) => a.filename)).toEqual(["notes.txt"]);
    boot.store.close();
    fake.server.close();
  });
});
