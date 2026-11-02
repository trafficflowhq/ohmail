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
  PHONE_SEND_MAX_TOTAL_BYTES,
  admitPicked,
  base64SizeBytes,
  forwardCaps,
  phoneAttachCap,
  phoneSendSurface,
  readWithin,
  sessionSendSurface,
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
import { DE } from "../src/copy.de";
import { phoneUploadAdmits } from "../src/engine/boot";
import { connectProfile, helloReader, type PairingEnv } from "../src/net/pairing";
import { BearerRegistry } from "../src/net/bearer-registry";
import { ServerProfileStore } from "../src/state/servers";
import { failedSendLine } from "../src/ui/send-failed";
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
    organizedByThisInstall: false, organizerState: null, status: null, junkFolder: null, sentFolder: null,
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

describe("a phone carries more than the hosted request body where its send can", () => {
  it("names a surface per door: its own engine, a desktop host, a self-host server, Cloud with staging", () => {
    expect(phoneSendSurface({ standalone: true, flavor: null, staging: null })).toBe(PHONE_SEND_MAX_TOTAL_BYTES);
    expect(phoneSendSurface({ standalone: false, flavor: "desktop-host", staging: null })).toBe(PHONE_SEND_MAX_TOTAL_BYTES);
    expect(phoneSendSurface({ standalone: false, flavor: "selfhost", staging: false })).toBe(PHONE_SEND_MAX_TOTAL_BYTES);
    expect(phoneSendSurface({ standalone: false, flavor: "managed", staging: true })).toBe(PHONE_SEND_MAX_TOTAL_BYTES);
    // Cloud without staging armed, or not answered yet, and a door this build does not know: the strict bound.
    expect(phoneSendSurface({ standalone: false, flavor: "managed", staging: false })).toBeUndefined();
    expect(phoneSendSurface({ standalone: false, flavor: "managed", staging: null })).toBeUndefined();
    expect(phoneSendSurface({ standalone: false, flavor: "elsewhere", staging: true })).toBeUndefined();
  });

  it("a 4 MiB file attaches on the phone's own engine and is refused on Cloud without staging", () => {
    const mailboxes = [box("mb-1", null)];
    const four = [picked("talk.pdf", 4 * MIB)];
    const own = phoneAttachCap(mailboxes, "mb-1", phoneSendSurface({ standalone: true, flavor: null, staging: null }));
    expect(admitPicked([], four, own).overCap).toBe(0);
    const cloud = phoneAttachCap(mailboxes, "mb-1", phoneSendSurface({ standalone: false, flavor: "managed", staging: false }));
    expect(cloud).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(admitPicked([], four, cloud).overCap).toBe(1);
    // A forward's own files follow the same surface.
    expect(forwardCaps(mailboxes, "mb-1", PHONE_SEND_MAX_TOTAL_BYTES).phone).toBe(own);
  });

  it("a mailbox's small SIZE still binds under the larger surface", () => {
    const cap = phoneAttachCap([box("mb-1", 2 * MIB)], "mb-1", PHONE_SEND_MAX_TOTAL_BYTES);
    expect(cap).toBe(composeAttachBudgetFor(2 * MIB));
  });

  it("a file past the room left is not read at all", () => {
    expect(readWithin(5 * MIB, 4 * MIB)).toBe(false);
    expect(readWithin(4 * MIB, 4 * MIB)).toBe(true);
    // A picker that says no size is read, and the cap judges the bytes.
    expect(readWithin(null, 4 * MIB)).toBe(true);
    expect(readWithin(undefined, 1)).toBe(true);
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
    expect(COMPOSER).toContain('w.actions.sendReply(m!.id, body, mode === "replyAll", sigText, sendAt, files, andDone, draftId,\n          baseFor(base.current, draftId), waitedFor(base.current, draftId))');
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
    // parent's for a reply or forward, the resolved From for a mail with no parent, or the sender
    // standing in for a draft's mailbox that cannot send (`compose-sender.ts`).
    expect(COMPOSER).toContain("const mailboxId = sender !== null ? sender.keepFrom : draft?.mailboxId ?? m?.mailboxId ?? w.mailboxes.sendingId;");
    expect(COMPOSER).toContain("const sendFrom = sender?.sendFrom ?? mailboxId;");
    expect(COMPOSER).toContain('const attachCap = phoneAttachCap(w.mailboxes.rows, sendFrom ?? "", sendSurface)');
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

/* A Cloud phone stages a file past the inline body; the bearer never leaves its origin. */
describe("a Cloud phone stages a large file, sent once, with no credential on the upload", () => {
  const peerTo = [{ name: null, address: "peer@fake.test" }];
  async function cloudScene(grant: (n: number) => string) {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
    fake.addMessage(dto("m1", { subject: "Welcome" }));
    fake.setStaging(grant);
    const bearerSaw: string[] = [];
    const puts: Array<{ url: string; headers: Record<string, string> }> = [];
    /* The plain transport: storage answers here, everything else goes to the loopback. */
    const plain = async (url: string, init?: RequestInit): Promise<Response> => {
      if (!url.startsWith(origin)) {
        puts.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response("", { status: 200 });
      }
      return globalThis.fetch(url, init);
    };
    /* The bearer manager's shape: it stamps the live token on whatever it is handed. */
    const bearer = async (url: string, init?: RequestInit): Promise<Response> => {
      bearerSaw.push(url);
      const headers = { ...Object.fromEntries(new Headers(init?.headers).entries()), authorization: "Bearer live-token" };
      return plain(url, { ...init, headers });
    };
    const boot = await bootEngine({ ...deps, fetch: plain }, {
      origin, accountId: "acct-1", stageAttachments: true,
      auth: { headers: () => ({ authorization: "Bearer live-token" }), fetch: bearer },
    });
    if (boot.kind !== "ready") throw new Error("boot refused");
    await boot.verifyIdentity();
    await boot.engine.start();
    const toasts: string[] = [];
    const actions = liveActions({ engine: boot.engine, toast: (m) => toasts.push(sayArg(m)), uuid: deps.uuid, zone: "UTC" });
    return { fake, boot, actions, toasts, puts, bearerSaw };
  }

  it("a 4 MiB file is minted, PUT without the bearer, and sent by reference once", async () => {
    const c = await cloudScene((n) => `https://storage.fake.test/o/${n}?token=t`);
    const res = await c.actions.sendNew("mb-1", peerTo, "Big", "", null, null, [picked("talk.pdf", 4 * MIB)]);
    expect(res.outcome).toBe("sent");
    expect(c.puts.map((p) => p.url)).toEqual(["https://storage.fake.test/o/1?token=t"]);
    expect(c.puts[0]!.headers.authorization).toBeUndefined();
    expect(c.bearerSaw.filter((u) => u.startsWith("https://storage.fake.test/"))).toEqual([]);
    const sends = c.fake.seen.filter((r) => r.method === "POST" && /\/drafts\/[^/]+\/send$/.test(r.url));
    expect(sends).toHaveLength(1);
    const body = JSON.parse(sends[0]!.body) as { stagedAttachmentIds?: string[]; attachments?: unknown };
    expect(body.stagedAttachmentIds).toEqual(["ticket-1"]);
    expect(body.attachments).toBeUndefined();
    c.boot.store.close();
    c.fake.server.close();
  });

  it("an http or address-literal grant is refused with nothing PUT and nothing sent", async () => {
    for (const grant of ["http://storage.fake.test/o/1", "https://10.0.0.5/o/1", "https://[::1]/o/1", "https://u:p@storage.fake.test/o/1"]) {
      const c = await cloudScene(() => grant);
      const res = await c.actions.sendNew("mb-1", peerTo, "Big", "", null, null, [picked("talk.pdf", 4 * MIB)]);
      expect(res.outcome, grant).toBe("failed");
      expect(res.failure, grant).toBe("replyStagingRefused");
      expect(c.puts, grant).toEqual([]);
      expect(c.fake.seen.some((r) => /\/send$/.test(r.url)), grant).toBe(false);
      c.boot.store.close();
      c.fake.server.close();
    }
  });

  it("3 MiB or less stays inline: no mint, the bytes on the send", async () => {
    const c = await cloudScene((n) => `https://storage.fake.test/o/${n}`);
    expect((await c.actions.sendNew("mb-1", peerTo, "Small", "", null, null, [picked("a.bin", 3 * MIB)])).outcome).toBe("sent");
    expect(c.fake.seen.filter((r) => r.url === "/attachments/staging")).toEqual([]);
    expect(c.puts).toEqual([]);
    c.boot.store.close();
    c.fake.server.close();
  });

  it("admits only an https grant on a named host with no credentials in it", () => {
    expect(phoneUploadAdmits("https://storage.example.org/o/1?token=t")).toBe(true);
    for (const url of ["http://storage.example.org/o/1", "https://127.0.0.1/o", "https://localhost/o", "https://storage/o",
      "https://a:b@storage.example.org/o", "not a url"]) expect(phoneUploadAdmits(url), url).toBe(false);
  });

  it("each staging refusal has its own sentence in both languages", () => {
    for (const kind of ["replyStagingRefused", "replyStagingUnreachable", "replyStagingFailed"] as const) {
      expect(failedSendLine(kind, null, true)).toBe(Copy[kind]);
      expect(DE[kind].length).toBeGreaterThan(0);
      expect(DE[kind]).not.toBe(Copy[kind]);
    }
    expect(Copy.replyTooLarge).toMatch(/file/);
  });
});

/* The session the app builds from a stored profile: its door decides staging, its /hello arms it. */
describe("a session built from its profile stages only on Cloud, and only where /hello armed it", () => {
  const peerTo = [{ name: null, address: "peer@fake.test" }];
  async function profileScene(flavor: "managed" | "selfhost", hello: Record<string, unknown> | null) {
    const fake = mailServer();
    const origin = await listen(fake.server);
    fake.addRule(ruleDto("r-allow", "sender", "sender@fake.test", "INBOX"));
    fake.addMessage(dto("m1", { subject: "Welcome" }));
    fake.setHello(hello);
    fake.setStaging((n) => `https://storage.fake.test/o/${n}`);
    const puts: Array<{ url: string; headers: Record<string, string> }> = [];
    const bearerSaw: string[] = [];
    const plain = async (url: string, init?: RequestInit): Promise<Response> => {
      if (!url.startsWith(origin)) {
        puts.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return new Response("", { status: 200 });
      }
      return globalThis.fetch(url, init);
    };
    const kv = new Map<string, string>();
    const profiles = new ServerProfileStore({
      get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v), remove: async (k) => void kv.delete(k),
    });
    const env: PairingEnv = {
      profiles, engineDeps: { ...deps, fetch: plain }, bearers: new BearerRegistry(),
      fetchImpl: async (url, init) => { bearerSaw.push(url); return plain(url, init as RequestInit | undefined); },
    };
    const row = await profiles.add({ origin, flavor, accountId: "acct-1", refreshToken: "ref-1", apiBase: origin });
    const out = await connectProfile(env, row);
    if (out.kind !== "connected") throw new Error("connect refused");
    await out.session.verifyIdentity();
    await out.session.engine.start();
    const said = helloReader(out.session);
    await said.settled();
    const cap = phoneAttachCap([box("mb-1", null)], "mb-1", sessionSendSurface(out.session, said));
    const actions = liveActions({ engine: out.session.engine, toast: () => undefined, uuid: deps.uuid, zone: "UTC" });
    const done = () => { out.session.store.close(); fake.server.close(); };
    return { fake, cap, actions, puts, bearerSaw, done };
  }
  const minted = (fake: ReturnType<typeof mailServer>) => fake.seen.filter((r) => r.url === "/attachments/staging");
  const sends = (fake: ReturnType<typeof mailServer>) => fake.seen.filter((r) => r.method === "POST" && /\/drafts\/[^/]+\/send$/.test(r.url));

  it("Cloud with staging armed: a 4 MiB file is admitted, minted, PUT with no credential, and sent once", async () => {
    const c = await profileScene("managed", { staging: true });
    const four = [picked("talk.pdf", 4 * MIB)];
    expect(admitPicked([], four, c.cap).overCap).toBe(0);
    expect((await c.actions.sendNew("mb-1", peerTo, "Big", "", null, null, four)).outcome).toBe("sent");
    expect(minted(c.fake)).toHaveLength(1);
    expect(c.puts.map((p) => p.url)).toEqual(["https://storage.fake.test/o/1"]);
    expect(c.puts[0]!.headers.authorization).toBeUndefined();
    expect(c.bearerSaw.filter((u) => u.startsWith("https://storage.fake.test/"))).toEqual([]);
    expect(sends(c.fake)).toHaveLength(1);
    c.done();
  });

  it("Cloud with staging off, or no /hello at all: the 3 MiB bound", async () => {
    for (const hello of [{ staging: false }, null]) {
      const c = await profileScene("managed", hello);
      expect(c.cap, JSON.stringify(hello)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
      expect(admitPicked([], [picked("talk.pdf", 4 * MIB)], c.cap).overCap).toBe(1);
      c.done();
    }
  });

  it("a self-host server takes the 4 MiB file inline: no mint, no PUT", async () => {
    const c = await profileScene("selfhost", { staging: true });
    const four = [picked("talk.pdf", 4 * MIB)];
    expect(admitPicked([], four, c.cap).overCap).toBe(0);
    expect((await c.actions.sendNew("mb-1", peerTo, "Big", "", null, null, four)).outcome).toBe("sent");
    expect(minted(c.fake)).toEqual([]);
    expect(c.puts).toEqual([]);
    const body = JSON.parse(sends(c.fake)[0]!.body) as { attachments?: unknown[]; stagedAttachmentIds?: unknown };
    expect(body.attachments).toHaveLength(1);
    expect(body.stagedAttachmentIds).toBeUndefined();
    c.done();
  });
});
