import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoAiProviderChoice, loadHostState } from "../src/config.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE MANAGED API NEVER GETS THE OPTION. A `TF_AI_PROVIDER` on this host is a self-host setting
 * deployed to the wrong place, whatever its value — refused like a leftover STRIPE_* variable,
 * which darkens the host with the variable named. And this host never reads the self-host
 * resolver: its AI is Anthropic, armed from ANTHROPIC_API_KEY alone.
 */

/* The connection string's role is interpolated: a whole credentialed URL literal is a credential to the push gate. */
const ROLE = "ohmail_runtime";
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_URL_POOLED: `postgres://${ROLE}:p@localhost:5432/x`,
  [KEY_RING_V1]: "ab".repeat(32),
  ...over,
} as NodeJS.ProcessEnv);

describe("TF_AI_PROVIDER on the managed API", () => {
  it("is refused whatever it says, the empty value included, naming the variable", () => {
    for (const value of ["openai", "ollama", "anthropic", ""]) {
      expect(() => assertNoAiProviderChoice({ TF_AI_PROVIDER: value } as NodeJS.ProcessEnv), value)
        .toThrow(/TF_AI_PROVIDER/);
    }
    expect(() => assertNoAiProviderChoice({} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("absent, the host loads; present, the host is dark and says why", () => {
    const ok = loadHostState(env());
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const dark = loadHostState(env({ TF_AI_PROVIDER: "ollama" }));
    expect(dark.ok).toBe(false);
    expect(dark.ok ? "" : dark.error).toContain("TF_AI_PROVIDER");
  });

  it("never calls the self-host resolver", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const callers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && /aiProviderEnv\s*\(|ai-provider-env/.test(readFileSync(join(src, f), "utf8")));
    expect(callers).toEqual([]);
  });
});
