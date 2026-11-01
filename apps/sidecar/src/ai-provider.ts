import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelDeclinedError, SensitivePayloadRefusal } from "@trafficflow/core/mail";
import type {
  ClassifierInput, ClassifierPort, ClassifierResult,
  DraftInput, DraftPort, DraftResult, KeyProvider,
} from "@trafficflow/core/mail";
import { ServiceError } from "@trafficflow/services/mail";
import { ClassifierFaultError } from "@trafficflow/worker/classifier-fault";
import {
  anthropicTransport, DEFAULT_ANTHROPIC_MODELS,
  customLocalTransport, DEFAULT_CUSTOM_LOCAL,
  ollamaTransport, DEFAULT_OLLAMA,
  openaiTransport, DEFAULT_OPENAI_MODELS, opencodeGoTransport, OPENCODE_GO_MODEL_IDS,
} from "@trafficflow/core/ai-transports";
import type { AiTransport, ProbeFailure, ProbeOutcome } from "@trafficflow/core/ai-transports";
import { writeAtomicFile } from "./fs-atomic.js";
import type { Diagnostic } from "./log.js";
import { cadenceDue, stampNow, type CadenceClocks, type CadenceStamp } from "./pass-cadence.js";

/**
 * Where this install's AI comes from, and what happens when it comes from nowhere. The standalone
 * install provides no model allowance of its own. Existing inference providers are an Anthropic
 * key, an OpenAI key, a model on this machine, or the user's OpenCode Go key; Go account-managed usage
 * is outside Ohmail. Its config probe does not test inference or quota. NOTHING CONFIGURED is not an error (rules-only
 * is the floor). Each key is sealed
 * under the OS keystore key the shell hands over, never in the clear,
 * in separate envelopes per vendor, sent nowhere but its own vendor: no durable key ⇒ not stored
 * ({@link AiStatus.canStoreKey}), never read back, logged, from the environment, and removed with the
 * data directory. The config is an install-scoped FILE, and a capability is not claimed until PROBED.
 */

export type AiProviderKind = "anthropic" | "openai" | "ollama" | "opencode-go" | "custom-local";

/**
 * The providers that carry a stored API key.
 *
 * Named as a set rather than written out at each site, because every rule that matters here is a
 * rule about THIS set: a key is required, the destination is fixed, and the `key_absent` and
 * `key_unreadable` states are reachable. Adding a provider means the branches below follow from
 * this set rather than from a list somebody remembered to extend.
 */
const KEYED_PROVIDERS = ["anthropic", "openai", "opencode-go"] as const;
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

/** Requests go to a custom OpenAI/Anthropic-compatible local runtime endpoint. */
export interface CustomLocalSettings {
  /** e.g. `http://127.0.0.1:1235/v1`. Narrowed to an http(s) URL when it is saved. */
  baseUrl: string;
  classifyModel: string;
  draftModel: string;
  hasKey: boolean;
}

/** The settings as an interface renders them — no secret, in either direction. */
export interface LocalAiSettings {
  provider: AiProviderKind | null;
  anthropic: HostedSettings & { hasKey: boolean };
  openai: HostedSettings & { hasKey: boolean };
  /** Desktop-only provider settings; the phone's offline stub intentionally omits this block. */
  opencodeGo?: HostedSettings & { hasKey: boolean };
  ollama: OllamaSettings;
  customLocal?: CustomLocalSettings;
}

/** What a settings write may carry. `apiKey` is accepted, sealed, and never read back. */
export interface LocalAiSettingsInput {
  provider?: unknown;
  anthropic?: { classifyModel?: unknown; draftModel?: unknown; apiKey?: unknown };
  openai?: { classifyModel?: unknown; draftModel?: unknown; apiKey?: unknown };
  opencodeGo?: { classifyModel?: unknown; draftModel?: unknown; apiKey?: unknown };
  ollama?: { baseUrl?: unknown; classifyModel?: unknown; draftModel?: unknown };
  customLocal?: {
    baseUrl?: unknown;
    model?: unknown;
    classifyModel?: unknown;
    draftModel?: unknown;
    apiKey?: unknown;
  };
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
   * WHERE MESSAGE CONTENT GOES, as a value rather than as prose: the engine states it because the
   * engine is the thing that does it, and a window deriving it from a provider name would go on
   * saying "stays on this machine" after the engine had started sending it elsewhere.
   *
   * OPTIONAL, three states. A value states the destination. `null` states that nothing is
   * configured, so nothing is sent anywhere. ABSENT states nothing, and no consumer may make a
   * sentence of it — the answer for a model server that is not this machine, where there is no
   * value for "a machine you named" and `this_machine` would be false.
   */
  contentGoesTo?: "anthropic" | "openai" | "opencode-go" | "this_machine" | null;
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

/** Custom local endpoint block with optional sealed or local dummy token. */
interface StoredCustomLocal {
  baseUrl: string;
  classifyModel: string;
  draftModel: string;
  keyEnc: string | null;
  keyVersion: number | null;
  localToken?: string | null;
}

/**
 * The file. `version` STAYS 1 though the shape grew: the OpenAI and OpenCode Go blocks are
 * additive, and the reader substitutes defaults for missing members, so older files load with no
 * migration. An older build ignores a block it does not know; an unknown provider selection falls
 * through its guard to `null`, landing on "nothing configured", the state that is explicitly not
 * an error. Bumping the number would claim a migration; there is none, and a version that moves
 * without one teaches the next reader to distrust the ones that do.
 */
interface StoredAi {
  version: 1;
  provider: AiProviderKind | null;
  anthropic: StoredHosted;
  openai: StoredHosted;
  /** Additive, including a blank model pair on files written before Go was introduced. */
  opencodeGo: StoredHosted;
  ollama: OllamaSettings;
  customLocal: StoredCustomLocal;
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
    opencodeGo: { classifyModel: "", draftModel: "", keyEnc: null, keyVersion: null },
    ollama: { ...DEFAULT_OLLAMA },
    customLocal: {
      ...DEFAULT_CUSTOM_LOCAL,
      keyEnc: null,
      keyVersion: null,
      localToken: null,
    },
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

function readOpenCodeGoModel(value: unknown, fallback: string, field: string): string {
  const model = readModel(value, fallback, field);
  if (model !== "" && !(OPENCODE_GO_MODEL_IDS as readonly string[]).includes(model)) {
    throw new ServiceError("invalid_request", 400, `${field} is not a supported OpenCode Go Chat Completions model`);
  }
  return model;
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

/**
 * An http(s) endpoint URL for a custom OpenAI/Anthropic-compatible runtime, preserving any API
 * prefix path (e.g. `http://127.0.0.1:1235/v1`) while rejecting query strings, fragments, and
 * embedded credentials.
 */
export function readCustomBaseUrl(value: unknown, fallback: string): string {
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
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return bad();
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/**
 * Whether an origin is on the computer the engine is running on.
 *
 * NARROW ON PURPOSE, because it decides a privacy claim rather than a route: anything not plainly
 * loopback is somewhere else, so a name that merely looks local (`box.lan`, `localhost.evil.test`)
 * does not earn "nothing leaves this machine", and a private LAN address is another machine too.
 * `URL.hostname` spells IPv6 with its brackets, so bare `::1` never arrives and is not tested for.
 */
export function originIsThisMachine(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

const PROVIDER_KINDS: readonly AiProviderKind[] = [
  "anthropic",
  "openai",
  "ollama",
  "opencode-go",
  "custom-local",
];

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

/**
 * An optional API key or local dummy token for a custom local runtime.
 * Accepts short dummy values (e.g. `"local"`, `"lm-studio"`) as well as empty strings.
 */
function readCustomApiKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ServiceError("invalid_request", 400, "apiKey must be a string");
  }
  const key = value.trim();
  if (key === "") return null;
  if (key.length > 512 || /\s/.test(key)) {
    throw new ServiceError("invalid_request", 400, "apiKey must not contain whitespace");
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
  /** What the fault cooldown is measured on; `performance.now()` when absent. */
  monotonic?: () => number;
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
  "opencode-go": "OpenCode Go",
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
  const monotonic = opts.monotonic ?? ((): number => performance.now());
  const clocks: CadenceClocks = { wall: opts.now ? () => now().getTime() : () => Date.now(), mono: monotonic };
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
      opencodeGo: hosted(parsed.opencodeGo, base.opencodeGo),
      ollama: {
        baseUrl: typeof parsed.ollama?.baseUrl === "string" ? parsed.ollama.baseUrl : base.ollama.baseUrl,
        classifyModel: typeof parsed.ollama?.classifyModel === "string"
          ? parsed.ollama.classifyModel : base.ollama.classifyModel,
        draftModel: typeof parsed.ollama?.draftModel === "string"
          ? parsed.ollama.draftModel : base.ollama.draftModel,
      },
      customLocal: {
        baseUrl: typeof parsed.customLocal?.baseUrl === "string"
          ? parsed.customLocal.baseUrl : base.customLocal.baseUrl,
        classifyModel: typeof parsed.customLocal?.classifyModel === "string"
          ? parsed.customLocal.classifyModel : base.customLocal.classifyModel,
        draftModel: typeof parsed.customLocal?.draftModel === "string"
          ? parsed.customLocal.draftModel : base.customLocal.draftModel,
        keyEnc: typeof parsed.customLocal?.keyEnc === "string" ? parsed.customLocal.keyEnc : null,
        keyVersion: typeof parsed.customLocal?.keyVersion === "number" ? parsed.customLocal.keyVersion : null,
        localToken: typeof parsed.customLocal?.localToken === "string" ? parsed.customLocal.localToken : null,
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
   * Write, atomically, readable only by this user — `fs-atomic.ts`, shared with the seal and the
   * LAN door's key. A half-written file here would read back as a missing provider on the next
   * launch, which is a silent downgrade to rules-only rather than an error anybody sees.
   */
  const persist = async (next: StoredAi): Promise<void> => {
    await mkdir(opts.dataDir, { recursive: true });
    await writeAtomicFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    store = next;
  };

  /**
   * The plaintext key for ONE hosted provider, or a typed refusal naming which state it is in.
   *
   * Takes the block rather than reading a fixed one off the store: hosted providers hold separate
   * credentials, and a helper that always reached for `s.anthropic` would send one vendor's key to
   * another as soon as the provider set grew.
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
  const blockFor = (s: StoredAi, kind: KeyedProviderKind): StoredHosted => {
    if (kind === "anthropic") return s.anthropic;
    if (kind === "openai") return s.openai;
    return s.opencodeGo;
  };

  const customLocalApiKey = async (block: StoredCustomLocal): Promise<string | null> => {
    if (block.keyEnc && block.keyVersion !== null) {
      try {
        return await opts.keyProvider.decrypt(block.keyEnc, block.keyVersion);
      } catch {
        return block.localToken ?? null;
      }
    }
    return block.localToken ?? null;
  };

  const transportFor = async (s: StoredAi): Promise<AiTransport> => {
    switch (s.provider) {
      case "ollama":
        return ollamaTransport({ ...s.ollama, fetchImpl: doFetch, timeoutMs });
      case "custom-local":
        return customLocalTransport({
          baseUrl: s.customLocal.baseUrl,
          classifyModel: s.customLocal.classifyModel,
          draftModel: s.customLocal.draftModel,
          apiKey: await customLocalApiKey(s.customLocal),
          fetchImpl: doFetch,
          timeoutMs,
        });
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
      case "opencode-go":
        return opencodeGoTransport({
          apiKey: await apiKey(s.opencodeGo, "opencode-go"),
          classifyModel: s.opencodeGo.classifyModel,
          draftModel: s.opencodeGo.draftModel,
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
    if (s.provider === "opencode-go" && (
      !s.opencodeGo.classifyModel
      || !s.opencodeGo.draftModel
      || !s.probe.models.includes(s.opencodeGo.classifyModel)
      || !s.probe.models.includes(s.opencodeGo.draftModel)
    )) return "unverified";
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
   * WHERE MESSAGE CONTENT GOES, as a total function of the STORED CONFIGURATION.
   *
   * Of the provider NAME it would be a lie in one case of four: the address beside `ollama` takes
   * any http(s) origin, so the name says "a model of your own" while the origin can be a server
   * on the internet. A `switch` with no default, so a fifth provider is a compile error here
   * rather than a silent `null` rendering as "nothing is sent anywhere". It returns the MEMBER
   * and not a value, because leaving the key off is one of the four answers.
   */
  const destinationOf = (s: StoredAi): Pick<AiStatus, "contentGoesTo"> => {
    switch (s.provider) {
      case "anthropic": return { contentGoesTo: "anthropic" };
      case "openai": return { contentGoesTo: "openai" };
      case "opencode-go": return { contentGoesTo: "opencode-go" };
      case "ollama": return originIsThisMachine(s.ollama.baseUrl) ? { contentGoesTo: "this_machine" } : {};
      case "custom-local": return originIsThisMachine(s.customLocal.baseUrl) ? { contentGoesTo: "this_machine" } : {};
      case null: return { contentGoesTo: null };
    }
  };

  const statusOf = (s: StoredAi): AiStatus => ({
    provider: s.provider,
    available: blockedBy(s) === null,
    unavailableReason: blockedBy(s),
    ...destinationOf(s),
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
      opencodeGo: {
        classifyModel: s.opencodeGo.classifyModel,
        draftModel: s.opencodeGo.draftModel,
        hasKey: s.opencodeGo.keyEnc !== null,
      },
      ollama: { ...s.ollama },
      customLocal: {
        baseUrl: s.customLocal.baseUrl,
        classifyModel: s.customLocal.classifyModel,
        draftModel: s.customLocal.draftModel,
        hasKey: s.customLocal.keyEnc !== null || (typeof s.customLocal.localToken === "string" && s.customLocal.localToken !== ""),
      },
    },
    probe: s.probe ? { ...s.probe, models: [...s.probe.models] } : null,
    canStoreKey: opts.canStoreKey,
  });

  /* The background fault gate. A model that stopped answering is a steady state on a personal
   * machine (a revoked key, a sleeping laptop, a quit local server), not an incident. The routing
   * pipeline RETHROWS a classifier fault on purpose — it holds the sync cursor so the message is
   * re-planned — which is right for a blip and catastrophic for a steady state (mail would stop
   * arriving). So after a few consecutive faults the port is WITHHELD for a cooldown, `planChange`
   * sees no classifier, and mail files on rules; the cooldown doubles to a ceiling and any success
   * resets it. A REFUSAL is not a fault — the outbound sensitivity sink throwing means the product
   * worked — and neither is a DECLINE, the model answering for one message: both are neutral. This is
   * NOT the hosted worker's breaker (that refunds a credit ledger this install lacks); what is shared
   * is the SHAPE — withhold the port, never wrap it in a throw. */
  let consecutiveFaults = 0;
  /** When the withhold began and for how long; over by `cadenceDue`, so a suspend ends it too. */
  let withheld: { at: CadenceStamp; forMs: number } | null = null;
  let cooldownMs = baseCooldownMs;

  const noteFault = (err: unknown): void => {
    if (err instanceof SensitivePayloadRefusal || err instanceof ModelDeclinedError) return;
    consecutiveFaults++;
    opts.log("ai_call_failed", {
      err,
      kind: store.provider ?? "none",
      consecutiveFaults,
      reason: "a model call failed during a background sync cycle",
    });
    if (consecutiveFaults < faultThreshold) return;
    // The withhold reads both clocks (`pass-cadence.ts`); the line states the wall-clock instant.
    withheld = { at: stampNow(clocks), forMs: cooldownMs };
    opts.log("ai_routing_unavailable", {
      kind: store.provider ?? "none",
      consecutiveFaults,
      cooldownMs,
      retryAt: now().getTime() + cooldownMs,
      reason: "consecutive model faults — routing continues on rules alone and mail keeps "
        + "arriving; the model is asked again after the cooldown",
    });
    cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
  };

  const noteSuccess = (): void => {
    consecutiveFaults = 0;
    withheld = null;
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
   * The request-path ports. A failure here reaches the person who asked for it. `screen` is present
   * here and deliberately ABSENT from the cycle port below: the Screener prefers `screen` and falls
   * back to `classify`, and that fallback is safe (the routing answer for a first-contact sender is
   * the gate, read as "hold") — which is exactly why a standalone install could take it for a whole
   * release without anything failing. `satisfies Required<ClassifierPort>` is the guard, because
   * `screen` is OPTIONAL on `ClassifierPort` and this object compiles with the method dropped while
   * the Screener falls back — a capability built, tested and unreachable. `Required<>` makes dropping
   * it a compile error, and `src` is one of the few things `tsconfig.json` actually typechecks.
   */
  const requestClassifier = {
    classify: classifyThrough,
    screen: screenThrough,
  } satisfies Required<ClassifierPort>;
  const requestDrafter: DraftPort = { draft: draftThrough };

  /**
   * The background port: the same call, counted, and its faults tagged. `ClassifierFaultError` is
   * what the sync loop matches BY CLASS to tell a model problem from a mailbox problem — without the
   * tag a failing model counts toward the mailbox's failure budget and can get a healthy mailbox
   * quarantined. It carries NO `screen`, and that is the guarantee rather than an omission: the
   * screening question is for senders at the gate, asked because a person pressed something, while
   * this port files LIVE MAIL automatically and its answer set must keep the gate in it. Absence is
   * stronger than a comment — `planChange` takes a `ClassifierPort` and could call either method, so
   * there is no argument or boolean that reaches the screening question from here.
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
        // and must not abort the batch, and the loop's own boundary is where it belongs. A decline
        // goes on unwrapped too, and the pipeline files that message as it would with AI off.
        if (err instanceof SensitivePayloadRefusal || err instanceof ModelDeclinedError) throw err;
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
        ? store.provider === "opencode-go"
          ? "OpenCode Go accepted the key for its configuration read and listed workspace models; inference was not tested"
          : "the configured provider answered and carries the configured models"
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
        opencodeGo: readApiKey(input.opencodeGo?.apiKey),
      };
      const key = keys.anthropic ?? keys.openai ?? keys.opencodeGo;
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
        parseModel: typeof readModel = readModel,
      ): Promise<StoredHosted> => {
        const sealed = supplied === null ? null : await opts.keyProvider.encrypt(supplied);
        return {
          classifyModel: parseModel(got?.classifyModel, held.classifyModel, "classifyModel"),
          draftModel: parseModel(got?.draftModel, held.draftModel, "draftModel"),
          keyEnc: sealed ? sealed.ciphertext : held.keyEnc,
          keyVersion: sealed ? sealed.keyVersion : held.keyVersion,
        };
      };
      const customKey = readCustomApiKey(input.customLocal?.apiKey);
      const sealCustomLocal = async (
        supplied: string | null,
        held: StoredCustomLocal,
        got: LocalAiSettingsInput["customLocal"],
      ): Promise<StoredCustomLocal> => {
        const sealed = supplied !== null && opts.canStoreKey
          ? await opts.keyProvider.encrypt(supplied)
          : null;
        const explicitClear = typeof got?.apiKey === "string" && got.apiKey.trim() === "";
        const classifyInput = got?.classifyModel ?? got?.model;
        const draftInput = got?.draftModel ?? got?.model;
        return {
          baseUrl: readCustomBaseUrl(got?.baseUrl, held.baseUrl),
          classifyModel: readModel(classifyInput, held.classifyModel, "classifyModel"),
          draftModel: readModel(draftInput, held.draftModel, "draftModel"),
          keyEnc: explicitClear ? null : sealed ? sealed.ciphertext : held.keyEnc,
          keyVersion: explicitClear ? null : sealed ? sealed.keyVersion : held.keyVersion,
          localToken: explicitClear
            ? null
            : supplied !== null && !opts.canStoreKey
              ? supplied
              : sealed
                ? null
                : (held.localToken ?? null),
        };
      };
      const next: StoredAi = {
        version: 1,
        provider,
        anthropic: await sealHosted(keys.anthropic, store.anthropic, input.anthropic),
        openai: await sealHosted(keys.openai, store.openai, input.openai),
        opencodeGo: await sealHosted(
          keys.opencodeGo, store.opencodeGo, input.opencodeGo, readOpenCodeGoModel,
        ),
        ollama: {
          baseUrl: readBaseUrl(input.ollama?.baseUrl, store.ollama.baseUrl),
          classifyModel: readModel(input.ollama?.classifyModel, store.ollama.classifyModel, "classifyModel"),
          draftModel: readModel(input.ollama?.draftModel, store.ollama.draftModel, "draftModel"),
        },
        customLocal: await sealCustomLocal(customKey, store.customLocal, input.customLocal),
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
      if (withheld !== null && !cadenceDue(withheld.at, withheld.forMs, clocks)) return undefined;
      return cycleClassifier;
    },
  };
}
