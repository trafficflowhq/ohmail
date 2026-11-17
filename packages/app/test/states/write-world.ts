/**
 * THE WORLD OF WRITE'S STATES PAGE: the letters, people, files and sends the reference draws, as plain data, and
 * what each address word sets in the composition. Nothing here sends, keeps or asks anything: the page's
 * composition is a double that holds the letter in memory, as the shell's would hold it on screen.
 */
import type { ComposeFields } from "@ohmail/app-logic/writing/compose";
import type { SendState } from "@ohmail/app-logic/writing/mail-send";
import type { FromOption } from "@ohmail/client-engine";

/* The reference is drawn on Tuesday 10 November 2026, a morning in Zurich. */
export const NOW = new Date(Date.UTC(2026, 10, 10, 9, 12));

export const MILA = "mb-mila";
export const HELLO = "mb-hello";
export const FROM_OPTIONS: readonly FromOption[] = [
  { id: MILA, address: "mila@lichtgrat.example", sendable: true, connected: true, maxMessageBytes: null },
  { id: HELLO, address: "hello@milabrunner.example", sendable: true, connected: true, maxMessageBytes: null },
] as unknown as readonly FromOption[];

export const SIGNATURE = "Mila Brunner\nLichtgrat · Winterthur";

const NADJA = "Nadja Lehner <nadja@erdton-atelier.example>";
const CARLA = "Carla Meier <carla@wintermarkt-lind.example>";
const GLAZE_SUBJECT = "Re: Would you teach the December glaze evening?";
const GLAZE_TEXT =
  "Yes, gladly. The 17th suits me better. I would bring the matte white and two test tiles per person, and";
const MARKS_TEXT =
  "Would you teach the December glaze evening?\nYes, gladly. The 17th suits me better. I would bring\nthe matte white\ntwo test tiles per person";
const MARKS_HTML =
  "<blockquote><p>Would you teach the December glaze evening?</p></blockquote><p>Yes, gladly. The <strong>17th</strong> suits me better. I would bring</p><ul><li><p>the matte white</p></li><li><p>two test tiles per person</p></li></ul>";
export const TYPED =
  "could we have a second table on saturday? bringing the matte white bowls too setting up from 8, is that ok";
export const DRAFTED =
  "Hi Carla\n\nCould we have a second table on Saturday? We are bringing the matte white bowls as well. We would set up from 8:00, if that is all right with you.\n\nThank you,\nMila";

const fields = (f: Partial<ComposeFields>): ComposeFields => ({
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
  html: "",
  fromMailboxId: null,
  attachments: [],
  forwardOf: null,
  ...f,
});

const glaze = fields({ to: NADJA, subject: GLAZE_SUBJECT, body: GLAZE_TEXT });
const talk = {
  subject: "Fwd: Your talk is on the programme",
  forwardOf: "talk-programme",
};
const PEOPLE_MANY = [
  "Flurina Caduff <flurina@haldenlicht.example>",
  "Anna Odermatt <anna@gartenlokal-rosa.example>",
  "Carla Meier <carla@wintermarkt-lind.example>",
  "Tim Berger <tim@gassenblatt.example>",
  "Reto Frei <reto@alpmail.example>",
];

/** The letter on screen at the address's `state` (and `from`, `support`). */
export function letterOf(q: URLSearchParams): ComposeFields {
  const state = q.get("state") ?? "blank";
  if (q.get("from") === "mailto")
    return fields({
      to: "bestellung@tonwerk-supply.example",
      subject: "Order: 25 kg stoneware, white",
      body: "Hello\n\nPlease send 25 kg of the white stoneware to the studio in Winterthur.\n\nMila Brunner",
    });
  if (q.get("support") === "1") return fields({ to: "support@ohmail.example", subject: "Help with ohmail" });
  if (state === "blank" || state === "suggest" || state === "draft-none" || state === "draft-ask")
    return fields({});
  if (state === "marks") return { ...glaze, body: MARKS_TEXT, html: MARKS_HTML };
  if (state === "refused") return { ...glaze, to: `${NADJA}, petra@makersfest` };
  if (state === "many") return fields({ ...talk, to: PEOPLE_MANY.join(", ") });
  if (state === "chips")
    return fields({
      ...talk,
      to: PEOPLE_MANY.slice(2).join(", "),
      cc: "Giulia Ferrari <giulia@terracotta-milano.example>",
    });
  if (state === "forward")
    return fields({
      to: "Lea Brunner <lea@brunner-familie.example>",
      subject: "Fwd: Photos from the ridge",
      forwardOf: "ridge-photos",
    });
  if (state.startsWith("draft-") && state !== "draft-made" && state !== "draft-drafting")
    return fields({ to: CARLA, subject: "A second table on Saturday", body: TYPED });
  if (state === "draft-made" || state === "draft-drafting")
    return fields({ to: CARLA, subject: "A second table on Saturday", body: DRAFTED });
  return glaze;
}

/** A forward's files as the composition plans them, at `state` and `line`. */
export function forwardRowsOf(state: string): { id: string; filename: string; sizeBytes: number }[] {
  if (state === "forward")
    return [
      { id: "p1", filename: "grat-01.jpg", sizeBytes: 2_516_582 },
      { id: "p2", filename: "grat-02.jpg", sizeBytes: 2_202_010 },
      { id: "p3", filename: "grat-03.jpg", sizeBytes: 2_936_013 },
    ];
  if (state === "many" || state === "chips")
    return [
      { id: "t1", filename: "Speaker-Info.pdf", sizeBytes: 1_258_291 },
      { id: "t2", filename: "Main-hall.jpg", sizeBytes: 880_640 },
      { id: "t3", filename: "Running-order.txt", sizeBytes: 2_048 },
      { id: "t4", filename: "Slide-template.pptx", sizeBytes: 4_823_450 },
    ];
  return [];
}

/** The send the address names (`state=sending`, `send=…`, `draft=…`), and the line the shell says for it. */
export interface Said {
  readonly send: SendState;
  readonly line: { readonly tone: "pending" | "warn" | "error"; readonly key: string } | null;
  /** The send held as not confirmed: its row. */
  readonly held: string | null;
  /** A send this letter cannot see the end of. */
  readonly locked: boolean;
}

const failed = (key: string, code?: string): Said => ({
  send: { phase: "failed", ...(code ? { code } : {}) },
  line: { tone: "error", key },
  held: null,
  locked: false,
});

const SENDS: Record<string, Said> = {
  failed: failed("statusFailed"),
  timeout: failed("statusTimeout", "send_timeout"),
  unreachable: failed("statusUnreachable", "send_unreachable"),
  busy: failed("statusBusy", "send_busy"),
  unsecured: failed("statusNotSecured", "send_not_secured"),
  login: failed("statusLoginRefused", "send_login_refused"),
  signin: failed("statusNotSignedIn", "mailbox_not_signed_in"),
  disabled: failed("statusMailboxDisabled", "mailbox_disabled"),
  toolong: failed("statusTooLong", "draft_too_large"),
  toolarge: failed("statusTooLarge", "payload_too_large"),
  staging: failed("statusStagingRefused", "staging_refused"),
  changed: failed("statusDraftChanged", "draft_changed"),
  unsavedfirst: failed("statusNotSavedFirst", "draft_not_saved_first"),
  unsaved: failed("statusDraftUnsaved", "draft_unsaved"),
  fwdgone: failed("statusForwardOriginalUnavailable", "forward_original_unavailable"),
  fwdall: failed("statusForwardPartsUnsupported", "forward_parts_unsupported"),
  fwdchanged: failed("statusForwardPartsChanged", "forward_parts_changed"),
  fwdmismatch: failed("statusAttachmentMismatch", "attachment_part_mismatch"),
  fwdmoved: failed("statusForwardSourceMoved", "forward_source_moved"),
  twice: {
    send: { phase: "duplicate" },
    line: { tone: "warn", key: "statusDuplicate" },
    held: null,
    locked: false,
  },
  twiceunsure: {
    send: { phase: "duplicate" },
    line: { tone: "warn", key: "statusDuplicateUnverified" },
    held: null,
    locked: false,
  },
  twicegoing: {
    send: { phase: "duplicate" },
    line: { tone: "pending", key: "statusDuplicatePending" },
    held: null,
    locked: false,
  },
  twicefrom: {
    send: { phase: "duplicate" },
    line: { tone: "warn", key: "statusDuplicateSent" },
    held: null,
    locked: false,
  },
  queued: {
    send: { phase: "queued" },
    line: { tone: "pending", key: "statusQueued" },
    held: null,
    locked: false,
  },
  accepted: {
    send: { phase: "queued", accepted: true },
    line: { tone: "pending", key: "statusSendingLong" },
    held: null,
    locked: false,
  },
  previous: {
    send: { phase: "idle", previous: true } as SendState,
    line: { tone: "pending", key: "statusPreviousSending" },
    held: null,
    locked: false,
  },
  slow: {
    send: { phase: "sending", since: NOW.getTime() - 60_000 },
    line: { tone: "pending", key: "statusSendingLong" },
    held: null,
    locked: false,
  },
};

const IDLE: Said = { send: { phase: "idle" }, line: null, held: null, locked: false };
const UNSURE: Said = {
  send: { phase: "unverified" },
  line: { tone: "warn", key: "statusUnverified" },
  held: "draft-glaze",
  locked: false,
};

export function saidOf(q: URLSearchParams): Said {
  const send = q.get("send");
  if (send !== null) return SENDS[send] ?? failed("statusFailed");
  const draft = q.get("draft");
  if (draft === "unsure" || draft === "checking" || draft === "interrupted" || draft === "unresolved")
    return UNSURE;
  if (draft === "lastsession") return { ...IDLE, locked: true };
  if (q.get("state") === "sending")
    return {
      send: { phase: "sending", since: Date.now() },
      line: { tone: "pending", key: "statusSending" },
      held: null,
      locked: false,
    };
  return IDLE;
}

/** The files the page picks at `state` and `note`, with their sizes as picked and as sent at each quality. */
export interface Pick {
  readonly name: string;
  readonly type: string;
  readonly bytes: number;
  /** The bytes sent at low, medium, high; a picture only. */
  readonly at?: readonly [number, number, number];
}
export const GRAT: readonly Pick[] = [
  { name: "grat-01.jpg", type: "image/jpeg", bytes: 2_516_582, at: [307_200, 730_112, 1_520_435] },
  { name: "grat-02.jpg", type: "image/jpeg", bytes: 2_202_010, at: [268_288, 638_976, 1_331_692] },
  { name: "grat-03.jpg", type: "image/jpeg", bytes: 2_936_013, at: [343_040, 850_944, 1_761_608] },
];
export const FILM: Pick = { name: "grat-film.mov", type: "video/quicktime", bytes: 26_214_400 };

/** The picks the page makes, in order, before the picture is taken. */
export function picksOf(q: URLSearchParams): (readonly Pick[])[] {
  const state = q.get("state");
  const note = q.get("note");
  if (state === "attach")
    return note === "attaching" ? [[GRAT[0]!], [{ ...FILM, bytes: 9_437_184 }]] : [[GRAT[0]!]];
  if (state === "files" || state === "quality" || state === "drop" || state === "look") return [GRAT];
  if (state === "toobig") return [GRAT, [FILM]];
  if (state === "twice") return [GRAT, [GRAT[0]!]];
  if (q.get("line") === "quality") return [[GRAT[0]!]];
  return [];
}
