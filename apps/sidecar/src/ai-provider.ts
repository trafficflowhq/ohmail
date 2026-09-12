import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SensitivePayloadRefusal } from "@trafficflow/core/mail";
import type {
  ClassifierInput, ClassifierPort, ClassifierResult,
  DraftInput, DraftPort, DraftResult, KeyProvider,
} from "@trafficflow/core/mail";
import { ServiceError } from "@trafficflow/services/mail";
import { ClassifierFaultError } from "@trafficflow/worker/classifier-fault";
import { anthropicTransport, DEFAULT_ANTHROPIC_MODELS } from "./ai-anthropic.js";
import { ollamaTransport, DEFAULT_OLLAMA } from "./ai-ollama.js";
import { openaiTransport, DEFAULT_OPENAI_MODELS } from "./ai-openai.js";
import type { AiTransport, ProbeFailure, ProbeOutcome } from "./ai-transport.js";
import type { Diagnostic } from "./log.js";

/**
 * WHERE THIS INSTALL'S AI COMES FROM, AND WHAT HAPPENS WHEN IT COMES FROM NOWHERE.
 *
 * A standalone install has no account, no subscription and no metered allowance, so the two AI
 * features it has — a routing suggestion for a first-contact sender, and a reply draft — run
 * against a model the person using it supplies. Three ways to supply one:
 *
 *  · **An Anthropic API key you own.** Requests go to Anthropic, billed to your account.
 *  · **An OpenAI API key you own.** Requests go to OpenAI, billed to your account.
 *  · **A model running on this machine.** Message content stays on the machine.
 *
 * And one honest fourth state: **nothing configured**, which is not an error. Rules-only routing
 * is the product's floor and it is complete without a model — mail is still filed, first contact
 * is still held at the Screener, search still works. What changes is that the two features above
 * are plainly unavailable rather than quietly broken.
 *
 * ── THE KEY IS SEALED, NEVER STORED IN THE CLEAR, AND GOES NOWHERE BUT ITS OWN VENDOR ───────
 *
 * The shell holds one key for this install in the operating system's keystore (Keychain on
 * macOS, Credential Manager on Windows, the Secret Service on Linux) and hands it to this
 * process at launch. Every secret this install writes down is encrypted under that key before it
 * touches the disk — the mailbox password already is, and each provider's API key is stored the
 * same way, by the same code. There is one credential-at-rest design here and this does not add
 * a second.
 *
 * The two hosted providers hold SEPARATE keys under separate envelopes. They are credentials for
 * different accounts at different companies, and a single shared field would mean switching
 * provider silently sent one vendor's key to the other — a live credential delivered to a third
 * party by a dropdown.
 *
 * Consequences worth stating plainly, because they are what a person is entitled to know before
 * typing a key into an app:
 *
 *  · **No durable install key ⇒ the key is not stored at all.** Storage is refused rather than
 *    performed under a key that dies with the process, which would write down something the next
 *    launch could not read. {@link AiStatus.canStoreKey} reports this so an interface can say so
 *    before it offers the field.
 *  · **A key never leaves this machine except to the vendor it belongs to.** The Anthropic key is
 *    the `x-api-key` header on requests to `https://api.anthropic.com`; the OpenAI key is the
 *    `Authorization` header on requests to `https://api.openai.com`. Both hosts are literals in
 *    their own module that no setting can change, and neither key is sent anywhere else at any
 *    time — including to the other vendor.
 *  · **It is never read back.** Nothing returns the key to a caller — the status surface reports
 *    only that one is stored.
 *  · **It is never logged.** No call site here passes key material to the diagnostic channel,
 *    and the logger's field allow-list would drop it if one tried.
 *  · **It is never taken from the environment.** There is deliberately no fall-back to a process
 *    variable: an install that finds a key it was not given is an install that spends somebody
 *    else's money without being asked.
 *  · **Deleting the data directory removes it**, with everything else this install stored. The
 *    mailbox on your own server is untouched by that.
 *
 * ── WHY THE CONFIGURATION IS A FILE AND NOT A DATABASE ROW ────────────────────────────────────
 *
 * It is a property of the INSTALL, not of the mailbox: which machine can reach a model on
 * localhost, and which key this machine holds. It does not sync, it is not mail, and it has no
 * meaning on another device. The local database carries the mail-domain schema this app shares
 * with its hosted sibling, and a table only a laptop would ever write does not belong in it. So
 * it lives beside the database, in the same directory, sealed by the same key, and is removed by
 * the same deletion.
 *
 * ── A CAPABILITY IS NOT CLAIMED UNTIL IT HAS BEEN PROBED ─────────────────────────────────────
 *
 * "Available" means a request actually reached the endpoint and the configured models were
 * there — not that somebody filled in a form. Saving settings therefore CLEARS the verification,
 * and the features stay unavailable until one succeeds. That ordering is the point: an
 * unreachable model is a mistake to correct while somebody is looking at the settings, not a
 * failure to discover the next time they try to answer an email.
 */

export type AiProviderKind = "anthropic" | "openai" | "ollama";

/**
 * The two providers that carry a stored API key.
 *
 * Named as a set rather than written out at each site, because every rule that matters here is a
 * rule about THIS set: a key is required, the destination is a literal, and the `key_absent` and
 * `key_unreadable` states are reachable. A fourth provider joins the set or it does not, and the
 * branches below follow from that rather than from a list somebody remembered to extend.
 */
const KEYED_PROVIDERS = ["anthropic", "openai"] as const;
export type KeyedProviderKind = (typeof KEYED_PROVIDERS)[number];

export function isKeyedProvider(p: AiProviderKind | null): p is KeyedProviderKind {
  return p !== null && (KEYED_PROVIDERS as readonly string[]).includes(p);
}

/** Requests go to a hosted vendor under the account holder's own key. */
export interface HostedSettings {
  /** The model that answers routing suggestions — one call per first-contact sender. */
  classifyModel: string;
  /** The model that writes reply drafts — one call per draft requested. */
  draftModel: string;
}

/** Kept as the name the settings surface has always used for the Anthropic half. */
export type AnthropicSettings = HostedSettings;

/** Requests go to a model server on this machine (or one the person names). */
export interface OllamaSettings {
  /** e.g. `http://127.0.0.1:11434`. Narrowed to an http(s) origin when it is saved. */
  baseUrl: string;
  classifyModel: string;
  draftModel: string;
}

/** The settings as an interface renders them — no secret, in either direction. */
export interface LocalAiSettings {
  provider: AiProviderKind | null;
  anthropic: HostedSettings & { hasKey: boolean };
  openai: HostedSettings & { hasKey: boolean };
  ollama: OllamaSettings;
}

/** What a settings write may carry. `apiKey` is accepted, sealed, and never read back. */
export interface LocalAiSettingsInput {
  provider?: unknown;
  anthropic?: { classifyModel?: unknown; draftModel?: unknown; apiKey?: unknown };
  openai?: { classifyModel?: unknown; draftModel?: unknown; apiKey?: unknown };
  ollama?: { baseUrl?: unknown; classifyModel?: unknown; draftModel?: unknown };
}

/** Why the chosen provider cannot answer right now. Machine-readable; an interface renders it. */
export type AiUnavailableReason =
  /** No provider chosen. Rules-only, which is the product's floor and not a fault. */
  | "not_configured"
  /** A key-carrying provider is chosen and no key is stored for THAT provider. */
  | "key_absent"
  /** A key is stored and this install's key does not open it — enter it again to re-seal. */
  | "key_unreadable"
  /** Settings changed, or were never verified, and the endpoint has not answered since. */
  | "unverified"
  /** The last verification failed. {@link AiStatus.probe} says how. */
  | "unreachable";

/** The last verification of the configuration now in force. */
export interface AiProbeReport {
  ok: boolean;
  reason: ProbeFailure | null;
  /** A short sentence for a person, from the endpoint's own refusal. Never a secret. */
  detail: string | null;
  /** Model names the endpoint reported. Populates the model pickers. */
  models: string[];
  at: string;
}

export interface AiStatus {
  provider: AiProviderKind | null;
  /** True only when the chosen provider was verified against the settings now in force. */
  available: boolean;
  unavailableReason: AiUnavailableReason | null;
  /**
   * WHERE MESSAGE CONTENT GOES under the current choice, as a value rather than as prose.
   *
   * The settings surface has to tell somebody what they are agreeing to, and deriving that from
   * a provider name in the interface would put the claim in a second place — where it can go on
   * saying "stays on this machine" after the engine has started sending it elsewhere. The engine
   * states it, because the engine is the thing that does it.
   */
  contentGoesTo: "anthropic" | "openai" | "this_machine" | null;
  settings: LocalAiSettings;
  probe: AiProbeReport | null;
  /**
   * Whether this install can store a secret at all. False when the shell supplied no durable
   * key — an interface must not offer a key field that would have to be refused.
   */
  canStoreKey: boolean;
}

/* ── the persisted shape ──────────────────────────────────────────────────────────────────── */

/** One hosted vendor's half of the file. `keyEnc`/`keyVersion` are the envelope; no plaintext. */
interface StoredHosted {
  classifyModel: string;
  draftModel: string;
  keyEnc: string | null;
  keyVersion: number | null;
}

/**
 * The file.
 *
 * ── `version` STAYS 1 THOUGH THE SHAPE GREW, AND THAT IS THE HONEST READING ──────────────────
 *
 * The `openai` block is purely ADDITIVE and the reader below already substitutes defaults for
 * every member it does not find, so a file written before this provider existed loads correctly
 * with no migration to run. The reverse is safe too: an older build reading a newer file ignores
 * the block it does not know, and `provider: "openai"` falls through its own guard to `null` —
 * which lands on "nothing configured", the state that is explicitly not an error.
 *
 * Bumping the number would claim there is a migration. There is not, and a version that moves
 * without one teaches the next reader to distrust the ones that do.
 */
interface StoredAi {
  version: 1;
  provider: AiProviderKind | null;
  anthropic: StoredHosted;
  openai: StoredHosted;
  ollama: OllamaSettings;
  probe: AiProbeReport | null;
}

export const AI_STORE_FILE = "ai-provider.json";

function emptyStore(): StoredAi {
  return {
    version: 1,
    provider: null,
    anthropic: {
      classifyModel: DEFAULT_ANTHROPIC_MODELS.classify,
      draftModel: DEFAULT_ANTHROPIC_MODELS.draft,
      keyEnc: null,
      keyVersion: null,
    },
    openai: {
      classifyModel: DEFAULT_OPENAI_MODELS.classify,
      draftModel: DEFAULT_OPENAI_MODELS.draft,
      keyEnc: null,
      keyVersion: null,
    },
    ollama: { ...DEFAULT_OLLAMA },
    probe: null,
  };
}

/** A model name a person typed. Narrow on purpose: it becomes part of a request body. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function readModel(value: unknown, fallback: string, field: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !MODEL_RE.test(value.trim())) {
    throw new ServiceError("invalid_request", 400, `${field} is not a model name`);
  }
  return value.trim();
}

/**
 * An http(s) origin, with any path, query and fragment discarded.
 *
 * Narrowed deliberately: this value selects where message content is sent, so anything that is
 * not a network origin is refused rather than normalised into something surprising.
 */
export function readBaseUrl(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  const bad = (): never => {
    throw new ServiceError("invalid_request", 400, "baseUrl must be an http or https URL");
  };
  if (typeof value !== "string") return bad();
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return bad();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return bad();
  return url.origin;
}

const PROVIDER_KINDS: readonly AiProviderKind[] = ["anthropic", "openai", "ollama"];

function isProviderKind(value: unknown): value is AiProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

function readProvider(value: unknown): AiProviderKind | null {
  if (value === null || value === undefined || value === "") return null;
  if (isProviderKind(value)) return value;
  throw new ServiceError(
    "invalid_request", 400,
    `provider must be one of ${PROVIDER_KINDS.map((p) => `'${p}'`).join(", ")}, or null`,
  );
}

/**
 * An API key, as a shape rather than as a secret.
 *
 * Checked for length and character class only — never for a prefix, because a key's format
 * belongs to whoever issues it and an app that hard-codes one turns a working key into a
 * rejected one on the day it changes. The value is not echoed under any outcome.
 */
function readApiKey(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ServiceError("invalid_request", 400, "apiKey must be a string");
  }
  const key = value.trim();
  if (key.length < 16 || key.length > 512 || /\s/.test(key)) {
    throw new ServiceError("invalid_request", 400, "apiKey does not look like an API key");
  }
  return key;
}

/* ── the live object ──────────────────────────────────────────────────────────────────────── */

export interface LocalAiOptions {
  /** Where the store file lives — the directory the local database is in. */
  dataDir: string;
  /**
   * The envelope this install seals secrets with. When the install has no durable key this
   * provider REFUSES rather than encrypting, and {@link LocalAiOptions.canStoreKey} is false.
   */
  keyProvider: KeyProvider;
  /** True when the shell supplied a durable key. Decided by the engine, reported by the status. */
  canStoreKey: boolean;
  log: Diagnostic;
  now?: () => Date;
  /** Injected for tests; production uses the platform's `fetch`. */
  fetchImpl?: typeof fetch;
  /** How long a model call or a verification may take. */
  timeoutMs?: number;
  /** Consecutive background faults before routing is withheld. */
  faultThreshold?: number;
  /** How long routing stays withheld after a trip, before the next attempt. Doubles, capped. */
  cooldownMs?: number;
}

export interface LocalAi {
  /** What the settings surface renders. Never carries a secret. Reads no network and no disk. */
  status(): AiStatus;
  /** Persist settings, discard the old verification, verify, and report what happened. */
  save(input: LocalAiSettingsInput): Promise<AiStatus>;
  /** Forget the provider AND the stored key. */
  clear(): Promise<AiStatus>;
  /** Verify the configured endpoint now. Never throws for an endpoint's failure. */
  verify(): Promise<AiStatus>;
  /**
   * The drafting port for the REQUEST path, or `undefined` when no provider is verified.
   *
   * ABSENCE, not a port that throws, and the difference is the whole degradation story. The
   * route table already answers `503 drafter_unconfigured` for an absent drafter — one place
   * where "this install has no model" is expressed, in the vocabulary every host shares. A
   * present-but-failing port would move that answer somewhere else and give two names to one
   * state.
   */
  drafter(): DraftPort | undefined;
  /** The routing port for the REQUEST path (an explicit Screener suggestion). Same rule. */
  classifier(): ClassifierPort | undefined;
  /**
   * The routing port for ONE background sync cycle, or `undefined`.
   *
   * Resolve it once per cycle and never hold it: this is also the seam that WITHHOLDS routing
   * after repeated faults, and a wrapper held across that transition would keep calling a model
   * that is not answering. See {@link createLocalAi}'s fault gate for why withholding rather than
   * failing is the only safe shape here.
   */
  classifierForCycle(): ClassifierPort | undefined;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_FAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

/** The vendor's own name, for a sentence a person reads. Never used to choose a code path. */
const VENDOR_LABEL: Record<KeyedProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/**
 * The refusal every unconfigured or unverified model call raises.
 *
 * `which` NAMES THE VENDOR on the two credential states, and that is worth a parameter: with two
 * key-carrying providers, "no API key is stored" is ambiguous in exactly the situation somebody
 * needs it to be precise — a person who has a key saved for one vendor and has just switched to
 * the other. A single hard-coded vendor name in this string was correct while there was one
 * provider and would have become a wrong answer the moment there were two.
 */
function unavailable(reason: AiUnavailableReason, which?: KeyedProviderKind): ServiceError {
  const vendor = which ? VENDOR_LABEL[which] : "the chosen provider";
  const says: Record<AiUnavailableReason, string> = {
    not_configured: "no AI provider is configured on this install; routing runs on rules alone",
    key_absent: `no API key is stored for ${vendor} on this install`,
    key_unreadable: `a stored API key for ${vendor} exists and this install's key does not open `
      + "it; enter it again to re-seal it",
    unverified: "the configured AI provider has not answered a verification since it was last "
      + "changed",
    unreachable: "the configured AI provider did not answer its last verification",
  };
  return new ServiceError("ai_provider_unavailable", 503, says[reason], undefined, false);
}

export async function createLocalAi(opts: LocalAiOptions): Promise<LocalAi> {
  const now = opts.now ?? ((): Date => new Date());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const path = join(opts.dataDir, AI_STORE_FILE);
  const faultThreshold = Math.max(1, opts.faultThreshold ?? DEFAULT_FAULT_THRESHOLD);
  const baseCooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  /**
   * Read once at assembly and kept in memory thereafter.
   *
   * Every accessor below is synchronous because of it, and that is what lets the request path
   * decide presence-or-absence while it builds its dependency bag rather than inside a handler.
   */
  const readStore = async (): Promise<StoredAi> => {
    const base = emptyStore();
    let parsed: Partial<StoredAi>;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredAi>;
    } catch (err) {
      // A missing file is a first launch and is not worth a line. Anything else IS: the
      // configuration is unreadable, the features will report themselves unconfigured, and
      // somebody staring at "no provider" after setting one is owed the reason.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        opts.log("ai_settings_load_failed", {
          err,
          reason: "the stored AI provider settings could not be read, so this launch starts from "
            + "the defaults; saving again replaces the file",
        });
      }
      return base;
    }
    const p = parsed.probe;
    /** One hosted block, defaulted member by member — see {@link StoredAi} on why no migration. */
    const hosted = (got: Partial<StoredHosted> | undefined, fallback: StoredHosted): StoredHosted => ({
      classifyModel: typeof got?.classifyModel === "string" ? got.classifyModel : fallback.classifyModel,
      draftModel: typeof got?.draftModel === "string" ? got.draftModel : fallback.draftModel,
      keyEnc: typeof got?.keyEnc === "string" ? got.keyEnc : null,
      keyVersion: typeof got?.keyVersion === "number" ? got.keyVersion : null,
    });
    return {
      version: 1,
      provider: isProviderKind(parsed.provider) ? parsed.provider : null,
      anthropic: hosted(parsed.anthropic, base.anthropic),
      openai: hosted(parsed.openai, base.openai),
      ollama: {
        baseUrl: typeof parsed.ollama?.baseUrl === "string" ? parsed.ollama.baseUrl : base.ollama.baseUrl,
        classifyModel: typeof parsed.ollama?.classifyModel === "string"
          ? parsed.ollama.classifyModel : base.ollama.classifyModel,
        draftModel: typeof parsed.ollama?.draftModel === "string"
          ? parsed.ollama.draftModel : base.ollama.draftModel,
      },
      probe: p && typeof p.at === "string"
        ? {
            ok: p.ok === true,
            reason: typeof p.reason === "string" ? (p.reason as ProbeFailure) : null,
            detail: typeof p.detail === "string" ? p.detail : null,
            models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === "string") : [],
            at: p.at,
          }
        : null,
    };
  };

  let store: StoredAi = await readStore();

  /**
   * Write, atomically, readable only by this user.
   *
   * A `mode` on the write and a rename over the target. A half-written file here would read back
   * as a missing provider on the next launch, which is a silent downgrade to rules-only rather
   * than an error anybody sees.
   */
  const persist = async (next: StoredAi): Promise<void> => {
    await mkdir(opts.dataDir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
    store = next;
  };

  /**
   * The plaintext key for ONE hosted provider, or a typed refusal naming which state it is in.
   *
   * Takes the block rather than reading a fixed one off the store: the two hosted providers hold
   * separate credentials, and a helper that always reached for `s.anthropic` would send one
   * vendor's key to the other the moment a second provider existed.
   */
  const apiKey = async (block: StoredHosted, which: KeyedProviderKind): Promise<string> => {
    if (!block.keyEnc || block.keyVersion === null) throw unavailable("key_absent", which);
    try {
      return await opts.keyProvider.decrypt(block.keyEnc, block.keyVersion);
    } catch {
      // The thrown value is deliberately neither inspected nor logged: it comes from a provider
      // that also holds key material, and the only fact this branch needs is the one it has
      // already established — this install's key does not open that envelope.
      throw unavailable("key_unreadable", which);
    }
  };

  /** The credential block for a keyed provider. One place, so the pairing cannot be mismatched. */
  const blockFor = (s: StoredAi, kind: KeyedProviderKind): StoredHosted =>
    kind === "anthropic" ? s.anthropic : s.openai;

  const transportFor = async (s: StoredAi): Promise<AiTransport> => {
    switch (s.provider) {
      case "ollama":
        return ollamaTransport({ ...s.ollama, fetchImpl: doFetch, timeoutMs });
      case "anthropic":
        return anthropicTransport({
          apiKey: await apiKey(s.anthropic, "anthropic"),
          classifyModel: s.anthropic.classifyModel,
          draftModel: s.anthropic.draftModel,
          fetchImpl: doFetch,
          timeoutMs,
        });
      case "openai":
        return openaiTransport({
          apiKey: await apiKey(s.openai, "openai"),
          classifyModel: s.openai.classifyModel,
          draftModel: s.openai.draftModel,
          fetchImpl: doFetch,
          timeoutMs,
        });
      default:
        throw unavailable("not_configured");
    }
  };

  /** Why the chosen provider cannot answer, or null when it can. Reads no network. */
  const blockedBy = (s: StoredAi): AiUnavailableReason | null => {
    if (s.provider === null) return "not_configured";
    if (isKeyedProvider(s.provider) && !blockFor(s, s.provider).keyEnc) return "key_absent";
    if (!s.probe) return "unverified";
    if (!s.probe.ok) return "unreachable";
    return null;
  };

  /**
   * The refusal for a blocked state, with the vendor filled in when there is one to name.
   *
   * The reason and the provider are read from the SAME store snapshot, so the sentence cannot
   * name one vendor while the state was decided about another.
   */
  const refuse = (s: StoredAi, reason: AiUnavailableReason): ServiceError =>
    unavailable(reason, isKeyedProvider(s.provider) ? s.provider : undefined);

  /**
   * WHERE MESSAGE CONTENT GOES, as a total function of the provider.
   *
   * A `switch` with no default rather than a chain of ternaries: adding a fourth provider must be
   * a compile error here, not a silent `null` that renders as "nothing is sent anywhere" while
   * the engine sends it somewhere.
   */
  const destinationOf = (p: AiProviderKind | null): AiStatus["contentGoesTo"] => {
    switch (p) {
      case "anthropic": return "anthropic";
      case "openai": return "openai";
      case "ollama": return "this_machine";
      case null: return null;
    }
  };

  const statusOf = (s: StoredAi): AiStatus => ({
    provider: s.provider,
    available: blockedBy(s) === null,
    unavailableReason: blockedBy(s),
    contentGoesTo: destinationOf(s.provider),
    settings: {
      provider: s.provider,
      anthropic: {
        classifyModel: s.anthropic.classifyModel,
        draftModel: s.anthropic.draftModel,
        hasKey: s.anthropic.keyEnc !== null,
      },
      openai: {
        classifyModel: s.openai.classifyModel,
        draftModel: s.openai.draftModel,
        hasKey: s.openai.keyEnc !== null,
      },
      ollama: { ...s.ollama },
    },
    probe: s.probe ? { ...s.probe, models: [...s.probe.models] } : null,
    canStoreKey: opts.canStoreKey,
  });

  /* ── the background fault gate ────────────────────────────────────────────────────────────
   *
   * A model that has stopped answering is a steady state on a personal machine, not an incident:
   * a key gets revoked, a laptop sleeps, somebody quits the local model server. The routing
   * pipeline RETHROWS a classifier fault on purpose — it holds the sync cursor so the message is
   * re-planned rather than mis-filed — which is exactly right for a blip and catastrophic for a
   * steady state: mail would stop arriving until the model came back.
   *
   * So after a few consecutive faults the port is WITHHELD for a cooldown, `planChange` sees no
   * classifier at all, and mail files on rules — the product's floor, arriving normally, with a
   * suggestion missing. The cooldown doubles up to a ceiling so a long outage is not a retry
   * storm, and any success resets it.
   *
   * A REFUSAL IS NOT A FAULT. The outbound sensitivity sink throwing means the product worked:
   * mail carrying authentication material was kept off the wire. Counting that as a model
   * failure would let the arrival of such mail withhold routing for everything else, so it is
   * neutral here — it neither trips the gate nor clears an outage already accumulating.
   *
   * This is deliberately NOT the hosted worker's breaker, which is a different problem wearing a
   * similar name: that one exists to refund a credit ledger this install does not have, and it
   * lives in a module that is neither published with this engine nor free of the private model
   * half. What is shared is the SHAPE that matters — withhold the port, never wrap it in
   * something that throws — because that is the shape `planChange` is written against.
   */
  let consecutiveFaults = 0;
  let withheldUntilMs = 0;
  let cooldownMs = baseCooldownMs;

  const noteFault = (err: unknown): void => {
    if (err instanceof SensitivePayloadRefusal) return;
    consecutiveFaults++;
    opts.log("ai_call_failed", {
      err,
      kind: store.provider ?? "none",
      consecutiveFaults,
      reason: "a model call failed during a background sync cycle",
    });
    if (consecutiveFaults < faultThreshold) return;
    withheldUntilMs = now().getTime() + cooldownMs;
    opts.log("ai_routing_unavailable", {
      kind: store.provider ?? "none",
      consecutiveFaults,
      cooldownMs,
      retryAt: withheldUntilMs,
      reason: "consecutive model faults — routing continues on rules alone and mail keeps "
        + "arriving; the model is asked again after the cooldown",
    });
    cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
  };

  const noteSuccess = (): void => {
    consecutiveFaults = 0;
    withheldUntilMs = 0;
    cooldownMs = baseCooldownMs;
  };

  /* ── the ports ───────────────────────────────────────────────────────────────────────────── */

  const classifyThrough = async (input: ClassifierInput): Promise<ClassifierResult> => {
    const blocked = blockedBy(store);
    if (blocked) throw refuse(store, blocked);
    return (await transportFor(store)).classify(input);
  };

  const screenThrough = async (input: ClassifierInput): Promise<ClassifierResult> => {
    const blocked = blockedBy(store);
    if (blocked) throw refuse(store, blocked);
    return (await transportFor(store)).screen(input);
  };

  const draftThrough = async (input: DraftInput): Promise<DraftResult> => {
    const blocked = blockedBy(store);
    if (blocked) throw refuse(store, blocked);
    return (await transportFor(store)).draft(input);
  };

  /**
   * The request-path ports. A failure here reaches the person who asked for it.
   *
   * ── `screen` IS PRESENT HERE AND DELIBERATELY ABSENT FROM THE CYCLE PORT BELOW ──────────────
   *
   * The Screener's suggestion path prefers `screen` and falls back to `classify` when a port does
   * not carry it. The fallback is safe — the routing question's answer for a first-contact sender
   * is the gate, which reads as "hold" — which is exactly why a standalone install could go on
   * taking it for a whole release without anything failing: the person was told, at high
   * confidence, that the mail was where it already was. Carrying the method is what ends that.
   *
   * ── `satisfies Required<ClassifierPort>` IS THE GUARD, AND THIS IS THE LINE THAT NEEDS ONE ──
   *
   * Teaching both transports the second question is not enough on its own: `screen` is OPTIONAL on
   * `ClassifierPort`, so this object goes on compiling with the method dropped, the Screener goes
   * on falling back, and every transport-level test stays green while the tautology is back. That
   * is a capability built, tested and unreachable — the exact failure this change removes,
   * reintroduced in the one place nothing would look.
   *
   * `Required<>` removes the optionality for THIS assignment only, so dropping the method here is a
   * compile error rather than a silent downgrade. It is worth writing because it actually runs:
   * almost no test file in this repository is typechecked, but `tsconfig.json` includes `src`, so a
   * type-level assertion in this file is one of the few that is genuinely checked.
   */
  const requestClassifier = {
    classify: classifyThrough,
    screen: screenThrough,
  } satisfies Required<ClassifierPort>;
  const requestDrafter: DraftPort = { draft: draftThrough };

  /**
   * The background port: the same call, counted, and its faults tagged.
   *
   * `ClassifierFaultError` is what the sync loop matches BY CLASS to tell a model problem apart
   * from a mailbox problem. Without the tag a failing model counts toward the mailbox's own
   * failure budget and can get the mailbox marked broken — three unanswered model calls and a
   * perfectly healthy mailbox is quarantined. With it, "a model outage can never mark a mailbox
   * broken" holds whatever either threshold is tuned to.
   *
   * ── IT CARRIES NO `screen`, AND THAT IS THE GUARANTEE RATHER THAN AN OMISSION ───────────────
   *
   * The screening question exists for senders already waiting at the gate, asked because a person
   * pressed something. This port files LIVE MAIL, automatically, on a timer, and its answer set
   * must keep the gate in it: `ohmail/Screener` is removed from the screening answer set precisely
   * because it is the question being asked there, and a background pass that could not answer
   * "hold" would have to file every stranger somewhere.
   *
   * Absence is a stronger statement than a comment or a flag. `planChange` takes a `ClassifierPort`
   * and could call either method; there is no argument, no setting and no mistaken boolean that
   * reaches the screening question from here, because the method is not on the object.
   */
  const cycleClassifier: ClassifierPort = {
    async classify(input: ClassifierInput): Promise<ClassifierResult> {
      try {
        const result = await classifyThrough(input);
        noteSuccess();
        return result;
      } catch (err) {
        noteFault(err);
        // Rethrown UNWRAPPED, deliberately: a refusal at the sensitivity sink is message-scoped
        // and must not abort the batch, and the loop's own boundary is where it belongs.
        if (err instanceof SensitivePayloadRefusal) throw err;
        throw new ClassifierFaultError(err);
      }
    },
  };

  /**
   * Run the verification and record it. Never throws for an endpoint's failure — an unreachable
   * model is a state to render, not an exception to propagate out of a settings save.
   */
  const runVerify = async (): Promise<StoredAi> => {
    if (store.provider === null) {
      const cleared = { ...store, probe: null };
      await persist(cleared);
      return cleared;
    }
    let outcome: ProbeOutcome;
    try {
      outcome = await (await transportFor(store)).probe();
    } catch (err) {
      // The only throws that reach here are the two credential states, which are configuration
      // rather than connectivity. Both are already named by `blockedBy`, so the recorded
      // verification says exactly that instead of inventing a network reason.
      const reason: ProbeFailure = err instanceof ServiceError
        && err.code === "ai_provider_unavailable" ? "credential" : "internal";
      outcome = { ok: false, reason, detail: null, models: [] };
    }
    const probe: AiProbeReport = {
      ok: outcome.ok,
      reason: outcome.reason,
      detail: outcome.detail,
      models: outcome.models,
      at: now().toISOString(),
    };
    opts.log("ai_provider_verified", {
      kind: store.provider,
      ok: probe.ok,
      // The failure CLASS, never the endpoint's own message: a rejected request quotes the
      // request, and on one of these two paths the request carries an API key header. The
      // message is kept for the settings surface, where the person who typed the key reads it.
      state: probe.reason ?? "verified",
      count: probe.models.length,
      reason: probe.ok
        ? "the configured provider answered and carries the configured models"
        : "the configured provider did not answer as required; the AI features stay unavailable",
    });
    const next = { ...store, probe };
    await persist(next);
    // A configuration that has just been shown to work deserves a clean slate: an old outage
    // must not keep routing withheld after somebody has fixed the thing that caused it.
    if (probe.ok) noteSuccess();
    return next;
  };

  return {
    status() {
      return statusOf(store);
    },

    async save(input) {
      const provider = readProvider(input.provider);
      const keys = {
        anthropic: readApiKey(input.anthropic?.apiKey),
        openai: readApiKey(input.openai?.apiKey),
      };
      const key = keys.anthropic ?? keys.openai;
      if (key !== null && !opts.canStoreKey) {
        // Refused at the moment of the write, while the field is still on screen — the same rule
        // the mailbox password follows. A key sealed under a launch-scoped key would be garbage
        // by the time anything read it, and the failure would surface on some later launch as an
        // app that had silently stopped offering drafts.
        throw new ServiceError(
          "install_key_absent", 503,
          "this install has no durable key, so an API key cannot be stored on this machine. "
          + "Nothing was written down: a key that dies with the process would seal a secret the "
          + "next launch could not open.",
        );
      }
      /**
       * Seal each vendor's key under its OWN block. An omitted key keeps the stored one, so
       * changing a model does not require re-typing a key — and a key supplied for one vendor
       * never overwrites the other's, which is the mistake a single shared field would make
       * unavoidable.
       */
      const sealHosted = async (
        supplied: string | null,
        held: StoredHosted,
        got: { classifyModel?: unknown; draftModel?: unknown } | undefined,
      ): Promise<StoredHosted> => {
        const sealed = supplied === null ? null : await opts.keyProvider.encrypt(supplied);
        return {
          classifyModel: readModel(got?.classifyModel, held.classifyModel, "classifyModel"),
          draftModel: readModel(got?.draftModel, held.draftModel, "draftModel"),
          keyEnc: sealed ? sealed.ciphertext : held.keyEnc,
          keyVersion: sealed ? sealed.keyVersion : held.keyVersion,
        };
      };
      const next: StoredAi = {
        version: 1,
        provider,
        anthropic: await sealHosted(keys.anthropic, store.anthropic, input.anthropic),
        openai: await sealHosted(keys.openai, store.openai, input.openai),
        ollama: {
          baseUrl: readBaseUrl(input.ollama?.baseUrl, store.ollama.baseUrl),
          classifyModel: readModel(input.ollama?.classifyModel, store.ollama.classifyModel, "classifyModel"),
          draftModel: readModel(input.ollama?.draftModel, store.ollama.draftModel, "draftModel"),
        },
        // CLEARED, always. A verification is about a configuration, and this is a different one.
        probe: null,
      };
      await persist(next);
      noteSuccess();
      opts.log("ai_settings_saved", {
        kind: next.provider ?? "none",
        // Whether the provider NOW CHOSEN has a key, not whether any block holds one: a person
        // who has a key saved for the other vendor is not configured, and a log line saying
        // "key_stored" for them describes a different provider than the one it names.
        state: isKeyedProvider(next.provider) && blockFor(next, next.provider).keyEnc
          ? "key_stored" : "no_key",
        reason: "the AI provider settings were replaced; the previous verification was discarded "
          + "and the features stay unavailable until the endpoint answers again",
      });
      return statusOf(await runVerify());
    },

    async clear() {
      await persist(emptyStore());
      noteSuccess();
      opts.log("ai_settings_cleared", {
        reason: "the AI provider and any stored API key were removed from this install; routing "
          + "continues on rules alone",
      });
      return statusOf(store);
    },

    async verify() {
      return statusOf(await runVerify());
    },

    drafter() {
      return blockedBy(store) === null ? requestDrafter : undefined;
    },

    classifier() {
      return blockedBy(store) === null ? requestClassifier : undefined;
    },

    classifierForCycle() {
      if (blockedBy(store) !== null) return undefined;
      if (withheldUntilMs > now().getTime()) return undefined;
      return cycleClassifier;
    },
  };
}
