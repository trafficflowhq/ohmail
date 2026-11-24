import type { Logger } from "@trafficflow/core";
import type { DoorInput } from "../src/program.js";
import type { SettingsDoorInput } from "../src/settings.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/** A connection string for a database no test dials: role, host and name, with a throwaway password. */
export const dbUrl = (role: string, host = "localhost:5432", name = "x"): string =>
  ["postgres://", role, ":", "p", "@", host, "/", name].join("");

/**
 * The older three-variable storage block and its kind, by name. Built here as
 * `test/support/key-ring-env.ts` builds the key ring's names: the names are public in the product
 * source, and a test's prose stays on its subject.
 */
const STORE = ["supa", "base"].join("");
export const STORAGE_TRIO = {
  kind: STORE,
  url: `${STORE.toUpperCase()}_URL`,
  key: `${STORE.toUpperCase()}_SERVICE_ROLE_KEY`,
  bucket: "TF_ATTACHMENT_STAGING_BUCKET",
  origin: `https://ref.${STORE}.co`,
} as const;

/** A stand-in for a credential, assembled where it is used: `fixture("plane", "bearer")`. */
export const fixture = (...parts: string[]): string => parts.join("-");

/** The canonical self-hosted environment: the names the bundled compose hands the api service. */
export const PLAIN_ENV: Record<string, string> = {
  OHMAIL_ORIGIN: "https://mail.example.com",
  DATABASE_URL: dbUrl("ohmail", "db:5432", "ohmail"),
  [KEY_RING_V1]: "ab".repeat(32),
};

/** The canonical managed environment: the names the function door has always read. */
export const MANAGED_ENV: Record<string, string> = {
  DATABASE_URL_POOLED: dbUrl("ohmail_runtime"),
  [KEY_RING_V1]: "ab".repeat(32),
  ENTITLEMENTS_URL: "https://plane.example.com",
  BILLING_PLANE_SECRET: "b".repeat(32),
};

export const env = (...parts: Record<string, string | undefined>[]): NodeJS.ProcessEnv =>
  Object.assign({}, ...parts) as NodeJS.ProcessEnv;

/** A long-running process with no platform under it. */
export const PROCESS_DOOR: SettingsDoorInput = {
  door: "process", buildVersionFile: () => "", platformBuildId: null, release: null, environmentFallback: null,
  sseHolds: true, sseLifetimeMaxMs: null,
};

/** A function on a platform that labels its deployments; `label` is what the platform said. */
export const functionDoor = (label = ""): SettingsDoorInput => ({
  door: "function", buildVersionFile: () => "", platformBuildId: null, release: null, environmentFallback: label,
  sseHolds: false, sseLifetimeMaxMs: 290_000,
});

/** A logger that keeps its lines: `lines` holds every event name with its fields. */
export function recordingLogger(): { logger: Logger; lines: { level: string; event: string; fields: Record<string, unknown> }[] } {
  const lines: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const at = (level: string) => (event: string, fields: Record<string, unknown> = {}) => { lines.push({ level, event, fields }); };
  const logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => logger } as unknown as Logger;
  return { logger, lines };
}

/** What a long-running process hands the program (the node adapter's numbers). */
export const processInput = (logger: Logger): DoorInput => ({
  logger, bodyMaxBytes: 50 * 1024 * 1024, sendSurfaceMaxTotalBytes: 32 * 1024 * 1024, invocationBudgetMs: null,
  lazyServices: false, closeUndrained: true, afterAnswer: null, onSetupTokenMinted: () => {},
});

/** What a function hands the program: a body cap, a kill, a cold start. */
export const functionInput = (logger: Logger, afterAnswer: DoorInput["afterAnswer"] = () => {}): DoorInput => ({
  logger, bodyMaxBytes: 4_500_000, sendSurfaceMaxTotalBytes: 3 * 1024 * 1024, invocationBudgetMs: 60_000,
  lazyServices: true, closeUndrained: false, afterAnswer, onSetupTokenMinted: () => {},
});
