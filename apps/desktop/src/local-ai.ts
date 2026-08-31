/**
 * THE MODEL THIS INSTALL USES, IF IT USES ONE — the window's half of the engine's AI surface.
 *
 * A standalone install has no account, no subscription and nothing metered, so the two AI features
 * it has — a routing suggestion for a first-contact sender, and a reply draft — run against a model
 * its owner supplies. Three ways to supply one: an Anthropic key you hold, an OpenAI key you hold,
 * or a model server running on this machine. And one honest fourth state, nothing configured, which
 * is not an error: rules-only routing is the product's floor and a complete mail organizer without
 * a model.
 *
 * ── THE SECRET GOES DOWN THE PIPE, NEVER THROUGH THE SHELL ──────────────────────────────────
 *
 * An API key is a credential and follows the rule every other credential here follows: it is the
 * BODY of a request addressed to the engine, over {@link bridgeFetch}, exactly as the mailbox
 * password is. It is never an argument to a native command, never held in the shell's memory and
 * never written to the shell's settings file. The engine seals it under the key this install holds
 * in the operating system's keystore, and nothing — not this module, not the pane above it — can
 * read it back: the status carries `hasKey` and that is the whole of what is said about it.
 *
 * ── AND THE ENGINE IS THE ONE THAT DECIDES ──────────────────────────────────────────────────
 *
 * Everything below is a read or a write of state the engine owns. Whether a provider is usable,
 * where message content would go, which models the endpoint actually has — all of it comes back
 * from the engine, because the engine is the thing that would do it. A window that derived
 * "stays on this machine" from a provider name would go on saying it after the engine had started
 * sending mail elsewhere.
 */

import { bridgeFetch } from "./bridge-fetch.js";

/** Where the engine serves this install's own AI settings. Root-relative, like every path here. */
const AI_PATH = "/local/ai";

export type AiProviderKind = "anthropic" | "openai" | "ollama";

/** Why the chosen provider cannot answer right now. The engine's word; the pane renders it. */
export type AiUnavailableReason =
  | "not_configured"
  | "key_absent"
  | "key_unreadable"
  | "unverified"
  | "unreachable";

/** How a verification failed. Never free text — the sentence is composed here, from this. */
export type AiProbeFailure =
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "model_absent"
  | "bad_response"
  | "credential"
  | "internal";

/** The last verification of the configuration now in force. */
export interface AiProbeReport {
  ok: boolean;
  reason: AiProbeFailure | null;
  /** A short sentence from the endpoint's own refusal. Never a secret. */
  detail: string | null;
  /** The model names the endpoint reported. */
  models: string[];
  at: string;
}

/** One hosted vendor's half. `hasKey` is the whole of what is ever said about the key. */
export interface HostedAiSettings {
  classifyModel: string;
  draftModel: string;
  hasKey: boolean;
}

export interface LocalAiSettings {
  provider: AiProviderKind | null;
  anthropic: HostedAiSettings;
  openai: HostedAiSettings;
  ollama: { baseUrl: string; classifyModel: string; draftModel: string };
}

export interface LocalAiStatus {
  provider: AiProviderKind | null;
  /** True only when the chosen provider was verified against the settings now in force. */
  available: boolean;
  unavailableReason: AiUnavailableReason | null;
  /** WHERE MESSAGE CONTENT GOES, as the engine states it rather than as the window infers it. */
  contentGoesTo: "anthropic" | "openai" | "this_machine" | null;
  settings: LocalAiSettings;
  probe: AiProbeReport | null;
  /**
   * Whether this install can store a secret at all. False when the shell supplied no durable key,
   * and the pane must not offer a key field it would have to refuse.
   */
  canStoreKey: boolean;
}

/** What a write may carry. `apiKey` travels one way and is never returned. */
export interface LocalAiWrite {
  provider?: AiProviderKind | null;
  anthropic?: { classifyModel?: string; draftModel?: string; apiKey?: string };
  openai?: { classifyModel?: string; draftModel?: string; apiKey?: string };
  ollama?: { baseUrl?: string; classifyModel?: string; draftModel?: string };
}

/** The engine's error envelope. */
interface WireError {
  error?: { code?: string; message?: string };
}

/**
 * The engine's own sentence for a refusal, or a plain one when it did not compose one.
 *
 * Its words and not ours, every time. The engine already says "this install has no durable key, so
 * an API key cannot be stored on this machine" and "a stored API key exists and this install's key
 * does not open it"; each is a different, actionable fact written by the code that made the
 * decision, and a second taxonomy here is how somebody gets told the wrong reason.
 */
async function refusal(res: Response): Promise<Error> {
  let said: string | undefined;
  try {
    said = ((await res.json()) as WireError).error?.message;
  } catch {
    /* Not JSON, or an empty body. The status is all there is. */
  }
  return new Error(said ?? `the mail engine answered ${res.status}`);
}

/**
 * `404` MEANS "NOT ON THIS DOOR", and it is a state rather than a fault.
 *
 * The settings for a model of your own belong to a standalone install. An install pointed at a
 * hosted account has no such surface — the engine there mirrors an account whose AI is that
 * account's — so the route is simply not mounted and the pane says so instead of showing an error.
 */
const NOT_ON_THIS_DOOR = 404;

async function readStatus(res: Response): Promise<LocalAiStatus> {
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as LocalAiStatus;
}

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * What this install has configured, or `null` when this door has no local model at all.
 *
 * Reads no network and touches no endpoint: it is the stored settings and the last verification.
 */
export async function readAiStatus(): Promise<LocalAiStatus | null> {
  const res = await bridgeFetch(AI_PATH);
  if (res.status === NOT_ON_THIS_DOOR) return null;
  return readStatus(res);
}

/**
 * Replace the settings, and learn in the same round trip whether what was just saved works.
 *
 * The engine DISCARDS the previous verification on every write and runs a fresh one before it
 * answers, so the status that comes back is about the configuration now in force. That ordering is
 * the point: an unreachable model is a mistake to correct while somebody is looking at the
 * settings, not a failure to discover the next time they try to answer an email.
 *
 * Omitted fields keep their stored value, `apiKey` included — so changing a model does not require
 * re-typing a key.
 */
export async function saveAiSettings(write: LocalAiWrite): Promise<LocalAiStatus> {
  return readStatus(
    await bridgeFetch(AI_PATH, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(write) }),
  );
}

/** Forget the provider AND the stored key. Routing continues on rules alone. */
export async function clearAiProvider(): Promise<LocalAiStatus> {
  return readStatus(await bridgeFetch(AI_PATH, { method: "DELETE" }));
}

/**
 * Ask the endpoint whether it is really there, now.
 *
 * One cheap call and no completion: the engine authenticates by listing models and asking for one
 * by name, both free. A test-connection button that ran a completion would charge somebody for
 * pressing it.
 */
export async function verifyAiProvider(): Promise<LocalAiStatus> {
  return readStatus(await bridgeFetch(`${AI_PATH}/verify`, { method: "POST" }));
}

/**
 * WHERE MESSAGE CONTENT WOULD GO under the current choice, in a sentence.
 *
 * Derived from `contentGoesTo`, which the engine states, rather than from the provider name — the
 * two are the same today and the second one is the one that can quietly stop being true.
 */
export function contentDestination(status: LocalAiStatus): string {
  switch (status.contentGoesTo) {
    case "anthropic":
      return "Sender, subject and a short extract go to Anthropic, billed to your own account.";
    case "openai":
      return "Sender, subject and a short extract go to OpenAI, billed to your own account.";
    case "this_machine":
      return "Sender, subject and a short extract go to the model server you named. Nothing leaves this machine if that server is on it.";
    default:
      return "Nothing is sent anywhere. Mail is filed by rules alone, which is the whole product without a model.";
  }
}

/**
 * The vendor's own name, for a sentence a person reads.
 *
 * With two key-carrying providers, "no API key is stored" is ambiguous in exactly the situation
 * that needs precision — somebody who has a key saved for one vendor and has just switched to the
 * other. The provider comes from the status the engine sent, so the name and the state are one
 * fact rather than two that can disagree.
 */
function vendorName(provider: AiProviderKind | null): string {
  switch (provider) {
    case "anthropic": return "Anthropic";
    case "openai": return "OpenAI";
    default: return "The chosen provider";
  }
}

/** Why the configured provider cannot answer, for a person, or null when it can. */
export function unavailableLine(status: LocalAiStatus): string | null {
  switch (status.unavailableReason) {
    case null:
      return null;
    case "not_configured":
      return "No model is set up on this install.";
    case "key_absent":
      return `${vendorName(status.provider)} is chosen and no API key is stored.`;
    case "key_unreadable":
      return "A key is stored and this install's key does not open it. Enter it again to seal it afresh.";
    case "unverified":
      return "These settings have not been tested yet.";
    case "unreachable":
      return probeLine(status.probe) ?? "The model did not answer when it was last asked.";
    default:
      return null;
  }
}

/** What the last verification found, in a sentence, or null when there has not been one. */
export function probeLine(probe: AiProbeReport | null): string | null {
  if (!probe) return null;
  if (probe.ok) {
    return probe.models.length > 0
      ? `Answered, and has the models you named. ${probe.models.length} available.`
      : "Answered, and has the models you named.";
  }
  const why: Record<AiProbeFailure, string> = {
    unreachable: "Nothing answered at that address.",
    timeout: "It answered too slowly.",
    unauthorized: "The key was rejected.",
    model_absent: "It answered, and does not have one of the models you named.",
    bad_response: "It answered with something this app could not read.",
    credential: "No key could be produced for it.",
    internal: "Something on this side went wrong.",
  };
  const head = probe.reason ? why[probe.reason] : "It did not answer as required.";
  return probe.detail ? `${head} ${probe.detail}` : head;
}
