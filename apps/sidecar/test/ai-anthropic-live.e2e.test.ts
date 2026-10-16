import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_SHAPES, anthropicKey } from "../../../test/support/fixture-credentials.js";
import { freshDataDir } from "./_datadir.js";
import { CLASSIFY_DESTINATIONS, SCREEN_DESTINATIONS, StaticKeyProvider } from "@trafficflow/core/mail";
import type { ClassifierInput } from "@trafficflow/core/mail";
import { ANTHROPIC_BASE, DEFAULT_ANTHROPIC_MODELS } from "@trafficflow/core/ai-transports";
import { AI_STORE_FILE, createLocalAi, type LocalAi } from "../src/ai-provider.js";
import { createSidecarLog } from "../src/log.js";

/**
 * A REAL API KEY, A REAL VENDOR, AND THE ANSWER THAT COMES BACK — the hosted twin of
 * `ai-ollama-live.e2e.test.ts`.
 *
 * Every other test of this provider drives a RECORDED transport. That instrument is the right one
 * for "what bytes would leave this machine" — the address, the headers, the schema — and it is
 * worth nothing for the claim a person actually relies on when they paste a key into the settings
 * pane: that the key is accepted, the models named by default exist, and the answer that comes back
 * survives coercion into something the Screener and the composer can act on. A recorded transport
 * always answers, and answers exactly what it was told to.
 *
 * The two halves that only a live key can establish:
 *
 *  · **The defaults are real.** {@link DEFAULT_ANTHROPIC_MODELS} names a dated classify snapshot
 *    and an undated draft alias. Those are ids at a vendor, not values in this repository, and a
 *    fresh install asks for them by name at its first verification. A model id that has been
 *    retired makes every new install fail its very first Save with `model_absent`, and no recorded
 *    test in this package can see it — the fake answers 200 to whatever it is asked for.
 *  · **The failure states are the vendor's, not ours.** `unauthorized` and `model_absent` are
 *    mapped from real status codes here rather than from ones a fake was told to return.
 *
 * ── IT IS OUT-OF-SUITE BY CONSTRUCTION, AND THAT IS THE EGRESS RULE RATHER THAN A PREFERENCE ─
 *
 * `test/setup/no-external-network.ts` blocks every non-loopback destination for the whole suite —
 * The "Testing bar" invariant, "the test suite performs zero external requests" — and its own header says the answer
 * for a test that needs a remote host is an injected transport, not an exception. That rule is not
 * weakened here and must not be: it is what stops a future route test mailing a real person from a
 * green run. It is also why the sibling Ollama file can be an ordinary suite member and this one
 * cannot — a model on `127.0.0.1` is loopback, and `api.anthropic.com` is the internet.
 *
 * So this file runs under `vitest.live.config.ts`, which is the root config with that one setup
 * entry removed and nothing else changed. Under the DEFAULT config it detects the guard and skips,
 * rather than failing: a red that only means "you ran it the ordinary way" trains people to ignore
 * reds.
 *
 * ── AND A SKIP MUST NOT LOOK LIKE A PASS ────────────────────────────────────────────────────
 *
 * Both gates skip through `ctx.skip()` — never a bare `return`, which vitest records as a passed
 * test. That distinction is a standing warning in this codebase and the sibling Ollama file got it
 * wrong once already: four green ticks and no model contacted.
 *
 * To run it:
 *
 * ```
 * OHMAIL_E2E_ANTHROPIC_KEY=sk-ant-… \
 *   pnpm vitest run --config vitest.live.config.ts apps/sidecar/test/ai-anthropic-live.e2e.test.ts
 * ```
 *
 * ── IT SPENDS MONEY, SO IT SPENDS AS LITTLE AS POSSIBLE ─────────────────────────────────────
 *
 * Three billable calls: one screening question, one routing question, one draft — the three
 * inference paths this provider has, one call each. Everything else here is a verification, and a
 * verification is deliberately free: it lists models and asks for one by name, which is why the
 * settings pane can run one on every Save without charging for it.
 *
 * ── THE KEY IS NEVER PRINTED, NEVER ASSERTED ON, AND NEVER WRITTEN DOWN BY THIS FILE ────────
 *
 * It is read from the environment into one constant, handed to the provider, and the only thing
 * said about it afterwards is whether the endpoint accepted it. The on-disk assertion below reads
 * the store file to prove the key is NOT in it in the clear — the one place this file touches the
 * secret's representation, and it is there to falsify a claim the settings pane makes in prose.
 */

const KEY = process.env.OHMAIL_E2E_ANTHROPIC_KEY ?? "";

/** Set once in `beforeAll`: the checks can actually reach the vendor. */
let live = false;
let why = "";

/**
 * A key shaped like a credential that no account owns.
 *
 * Long enough and clean enough to pass `readApiKey`'s shape check, so what it exercises is the
 * VENDOR's rejection rather than this package's input validation — which is asserted separately,
 * against a recorded transport, where it belongs.
 */
const WRONG_KEY = anthropicKey("ai-anthropic-live-wrong");

it("the wrong key has the vendor key's shape, so the vendor is what refuses it", () => {
  expect(WRONG_KEY).toMatch(FIXTURE_SHAPES.anthropic);
});

/**
 * TWO REASONS THIS CANNOT RUN, TOLD APART — because they need different things done about them.
 *
 * No key is somebody's environment; the egress guard is somebody's command line. Reporting both as
 * "skipped" without the reason sends a person to look for a key they already have.
 *
 * The guard is detected by ASKING IT, not by reading a config: a cheap unauthenticated `HEAD` at
 * the vendor either reaches the network or is rejected with `EXTERNAL_NETWORK_BLOCKED`. Inferring
 * it from `setupFiles` would be a second copy of the guard's own membership rule, and the copy
 * would go on saying "blocked" the day the entry is renamed.
 */
beforeAll(async () => {
  if (KEY === "") {
    why = "OHMAIL_E2E_ANTHROPIC_KEY is not set";
  } else {
    try {
      await fetch(`${ANTHROPIC_BASE}/v1/models`, {
        method: "HEAD",
        signal: AbortSignal.timeout(15_000),
      });
      live = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      why = message.includes("EXTERNAL_NETWORK_BLOCKED")
        ? "the suite's egress guard is installed — run with `--config vitest.live.config.ts`"
        : `nothing answered at ${ANTHROPIC_BASE}: ${message}`;
    }
  }
  if (!live) {
    // eslint-disable-next-line no-console
    console.warn(`[ai-anthropic-live] SKIPPING the live checks — ${why}`);
  }
});

/** A real skip carrying the reason. Never a bare `return`; vitest reports that as a pass. */
function skipUnlessLive(ctx: { skip: (note?: string) => void }): void {
  if (!live) ctx.skip(why || "no live vendor");
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One install, its own data directory, its own sealing key. Returns the directory too. */
async function install(): Promise<{ ai: LocalAi; dir: string }> {
  const dir = await freshDataDir("ohmail-anthropic-live-");
  dirs.push(dir);
  const ai = await createLocalAi({
    dataDir: dir,
    keyProvider: new StaticKeyProvider({ 1: Buffer.alloc(32, 7) }),
    canStoreKey: true,
    log: createSidecarLog({ sink: () => undefined }),
    // Generous for the same reason the Ollama file is generous: a hosted model's latency is a
    // property of somebody else's service and the network in between, and a tight deadline here
    // would make a slow afternoon look like a product defect.
    timeoutMs: 120_000,
  });
  return { ai, dir };
}

/** Configured with the key and the SHIPPED DEFAULTS — the state a fresh install is in. */
async function configured(): Promise<{ ai: LocalAi; dir: string }> {
  const { ai, dir } = await install();
  const status = await ai.save({ provider: "anthropic", anthropic: { apiKey: KEY } });
  expect(
    status.probe?.ok,
    `probe failed: ${status.probe?.reason} ${status.probe?.detail ?? ""}`,
  ).toBe(true);
  expect(status.available).toBe(true);
  expect(status.contentGoesTo).toBe("anthropic");
  return { ai, dir };
}

const aStranger = (subject: string, snippet: string): ClassifierInput => ({
  from: { name: null, address: "stranger@example.test" },
  subject,
  snippet,
  headersDigest: "no list-id",
});

describe("a standalone install, an Anthropic key of your own, and a real answer", () => {
  /**
   * THE DEFAULTS A FRESH INSTALL ASKS FOR STILL EXIST AT THE VENDOR.
   *
   * Nothing else in this repository can establish this. The ids are checked by name, which is what
   * the probe itself does and is stricter than a list membership — an alias and a dated snapshot do
   * not both have to appear in one page of `/v1/models` for both to be valid.
   */
  it("verifies the shipped default models by name against the live vendor", async (ctx) => {
    skipUnlessLive(ctx);
    const { ai } = await configured();
    const status = ai.status();
    expect(status.probe?.models.length).toBeGreaterThan(0);
    expect(status.settings.anthropic.classifyModel).toBe(DEFAULT_ANTHROPIC_MODELS.classify);
    expect(status.settings.anthropic.draftModel).toBe(DEFAULT_ANTHROPIC_MODELS.draft);
    // eslint-disable-next-line no-console
    console.log(
      `[ai-anthropic-live] verified ${DEFAULT_ANTHROPIC_MODELS.classify} + `
      + `${DEFAULT_ANTHROPIC_MODELS.draft}; the key can see ${status.probe?.models.length} models`,
    );
  }, 180_000);

  /**
   * THE KEY IS SEALED ON DISK AND NEVER COMES BACK OUT — the pane's claim, falsified or not.
   *
   * The settings pane tells somebody, in prose, that what they type is "sealed under a key held in
   * this computer's keychain … never shown again, never written down in the clear". That is a claim
   * about bytes, so it is checked against bytes: the store file must not contain the key, and no
   * status this provider returns may carry it either.
   */
  it("seals the key on disk and never returns it", async (ctx) => {
    skipUnlessLive(ctx);
    const { ai, dir } = await configured();
    /**
     * ASSERTED AS BOOLEANS, and this is not a style choice.
     *
     * `expect(text).not.toContain(KEY)` prints BOTH operands when it fails — the expected substring
     * and the received value. So the one run that catches the regression this case exists for is
     * the run that writes a live billable API key into a terminal scrollback or a CI log, which is
     * a worse outcome than the leak it was checking for. The boolean form fails with
     * "expected true to be false" and carries nothing.
     */
    const onDisk = readFileSync(join(dir, AI_STORE_FILE), "utf8");
    expect(onDisk.includes(KEY), "the store file holds the key in the clear").toBe(false);
    expect(JSON.stringify(ai.status()).includes(KEY), "a status response carries the key").toBe(false);
    // What IS said about it, and the whole of it.
    expect(ai.status().settings.anthropic.hasKey).toBe(true);
  }, 180_000);

  /**
   * THE ROUTING QUESTION, which is NOT the screening question — a separate prompt and a separate
   * schema, from `@trafficflow/core/mail`.
   *
   * Worth its own billable call because the two can diverge at the vendor: a model that satisfies
   * the five-pile screening schema can still fail the taxonomy one, and background filing would
   * then throw on every message while a green suite said the key and the model were fine. This is
   * the path that runs unattended, so it is the one where a silent failure costs most.
   */
  it("answers the routing question, which is a different prompt and schema", async (ctx) => {
    skipUnlessLive(ctx);
    const { ai } = await configured();
    const result = await ai.classifier()!.classify(aStranger(
      "Your Paperbird weekly digest",
      "Twelve stories this week, including the one about the harbour crane.",
    ));
    expect(CLASSIFY_DESTINATIONS).toContain(result.destination);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.rationale).toBe("string");
    // eslint-disable-next-line no-console
    console.log(`[ai-anthropic-live] routed → ${result.destination} (confidence ${result.confidence})`);
  }, 180_000);

  /**
   * THE SCREENING QUESTION, answered by the vendor.
   *
   * Not "the answer is correct" — a routing judgement is not something to assert on, and a test
   * demanding a particular pile would be testing the model rather than the product. What is
   * asserted is everything the product is responsible for: a real answer comes back, it is one of
   * the five piles the Screener can act on, the confidence is in the range the interface renders,
   * and `spam` is derived from the destination rather than trusted alongside it.
   */
  it("answers the screening question with something the Screener can act on", async (ctx) => {
    skipUnlessLive(ctx);
    const { ai } = await configured();
    const classifier = ai.classifier();
    expect(classifier, "a verified provider must offer the request-path classifier").toBeDefined();

    const result = await classifier!.screen!(aStranger(
      "Your invoice #4417 is ready",
      "Thanks for your business. The invoice for August is attached and due on the 30th.",
    ));

    expect(SCREEN_DESTINATIONS).toContain(result.destination);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.rationale).toBe("string");
    expect(result.spam).toBe(result.destination === "ohmail/Quarantine");
    // eslint-disable-next-line no-console
    console.log(
      `[ai-anthropic-live] screened → ${result.destination} `
      + `(confidence ${result.confidence}) — ${result.rationale}`,
    );
  }, 180_000);

  it("writes a reply draft through the same key", async (ctx) => {
    skipUnlessLive(ctx);
    const { ai } = await configured();
    const drafted = await ai.drafter()!.draft({
      incoming: {
        subject: "Are you free Thursday?",
        from: "her@example.test",
        snippet: "Could we move our call to Thursday afternoon?",
      },
      context: { kbEntries: [], threadMessages: [] },
    });
    expect(typeof drafted.subject).toBe("string");
    expect(drafted.body.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[ai-anthropic-live] drafted → ${JSON.stringify(drafted.subject)}`);
  }, 180_000);

  /**
   * A KEY THE VENDOR REJECTS IS `unauthorized`, AND THE FEATURES GO ABSENT RATHER THAN THROWING.
   *
   * The state somebody is in the moment they mistype a key or have one revoked. Both halves matter:
   * the reason is named precisely enough to act on, and the ports are UNDEFINED — which is what
   * makes the route table answer its own `503` and the mail keep arriving on rules alone, rather
   * than a port that throws somewhere further in.
   *
   * Free: a rejected key never gets as far as a completion.
   */
  it("names a rejected key 'unauthorized' and withholds the features", async (ctx) => {
    skipUnlessLive(ctx);
    const { ai } = await install();
    const status = await ai.save({ provider: "anthropic", anthropic: { apiKey: WRONG_KEY } });

    expect(status.available).toBe(false);
    expect(status.probe?.ok).toBe(false);
    expect(status.probe?.reason).toBe("unauthorized");
    expect(ai.classifier()).toBeUndefined();
    expect(ai.drafter()).toBeUndefined();
    expect(ai.classifierForCycle()).toBeUndefined();
    // The vendor's own sentence reaches the settings surface, and it is not a secret.
    expect(typeof status.probe?.detail).toBe("string");
    // eslint-disable-next-line no-console
    console.log(`[ai-anthropic-live] rejected key → ${status.probe?.reason}: ${status.probe?.detail}`);
  }, 180_000);

  /**
   * A MODEL THE KEY CANNOT REACH IS `model_absent` — the hosted twin of "the model is not pulled".
   *
   * The realistic mistake is a typo in a model name, and it is indistinguishable from a working
   * configuration until the first message arrives. The verification moves that discovery to the
   * moment somebody is still looking at the settings, and it names the model it could not reach.
   */
  it("names a model the key cannot reach, without running inference", async (ctx) => {
    skipUnlessLive(ctx);
    const { ai } = await install();
    const status = await ai.save({
      provider: "anthropic",
      anthropic: {
        apiKey: KEY,
        classifyModel: "claude-not-a-real-model",
        draftModel: "claude-not-a-real-model",
      },
    });

    expect(status.available).toBe(false);
    expect(status.probe?.reason).toBe("model_absent");
    expect(status.probe?.detail).toContain("claude-not-a-real-model");
    expect(ai.classifier()).toBeUndefined();
  }, 180_000);
});
