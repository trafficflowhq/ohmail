import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoveryRequestFor, passwordLabelKey, portMeansImplicitTls, presetForAddress, providerById, readDiscovery,
  serverGuessFor,
} from "../src/providers.js";

/**
 * ONE providers.ts BRANCH PER CORPUS PROVIDER, with a recorded server behind it. The corpus is the
 * core replay's (`probe-shapes.mjs` writes it); every shape in it records the endpoint it dialled.
 */
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../core/test/adapters/provider-shapes");
interface Shape {
  provider: string;
  presetId: string;
  source: { kind: string };
  endpoint: { host: string; port: number; tls: "implicit" | "starttls" | "none" } | null;
}
const shapeOf = (name: string): Shape => JSON.parse(readFileSync(join(CORPUS_DIR, `${name}.shape.json`), "utf8")) as Shape;

const BRANCHES: Record<string, string> = {
  greenmail: "the generic entry: portMeansImplicitTls over the recorded port",
  dovecot: "the generic entry: portMeansImplicitTls over the recorded port",
  infomaniak: "the infomaniak preset's IMAP endpoint",
  gmail: "the gmail preset's IMAP endpoint",
};

describe("providers.ts against the recorded provider shapes", () => {
  const names = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".shape.json")).map((f) => f.replace(/\.shape\.json$/, "")).sort();

  it("every corpus shape names the providers.ts branch it covers", () => {
    expect(names).toEqual(Object.keys(BRANCHES).sort());
    for (const n of names) expect(providerById(shapeOf(n).presetId).id, `${n}: presetId is not a preset`).toBe(shapeOf(n).presetId);
  });

  it("every corpus shape is a recording and names the endpoint it dialled", () => {
    expect(names.filter((n) => shapeOf(n).endpoint === null || shapeOf(n).source.kind !== "recorded")).toEqual([]);
  });

  for (const n of Object.keys(BRANCHES)) {
    const shape = shapeOf(n);
    it(`${n}: ${BRANCHES[n]}`, () => {
      const preset = providerById(shape.presetId);
      if (shape.endpoint === null) throw new Error(`${n}: no recorded endpoint`);
      expect(portMeansImplicitTls(shape.endpoint.port)).toBe(shape.endpoint.tls === "implicit");
      if (preset.manual) {
        expect(shape.endpoint.host).toBe("loopback");
        return;
      }
      expect(shape.endpoint).toEqual({
        host: preset.imap.host, port: preset.imap.port, tls: preset.imap.secure ? "implicit" : "starttls",
      });
    });
  }
});

describe("the presets an address or a domain lookup suggests", () => {
  it("WEB.DE, t-online and bluewin addresses pre-fill their own servers", () => {
    expect(presetForAddress("info@web.de")?.id).toBe("webde");
    expect(presetForAddress("Hello@T-Online.de")?.id).toBe("tonline");
    expect(presetForAddress("contact@bluewin.ch")?.id).toBe("bluewin");
    expect(serverGuessFor("info@web.de")).toEqual({
      imapHost: "imap.web.de", imapPort: "993", imapTls: true, smtpHost: "smtp.web.de", smtpPort: "587", from: "webde",
    });
  });

  it("the lookup is sent the domain, never the part before the @", () => {
    expect(discoveryRequestFor(" Lena.Meier@Praxis-Sonnhalde.CH ")).toEqual({ domain: "praxis-sonnhalde.ch" });
    expect(JSON.stringify(discoveryRequestFor("lena.meier@praxis-sonnhalde.ch"))).not.toContain("lena");
    expect(discoveryRequestFor("lena.meier")).toBeNull();
    expect(discoveryRequestFor("lena@")).toBeNull();
  });

  it("an answer is read field by field: a named preset, Proton only when true, a server only when whole", () => {
    expect(readDiscovery({ preset: "gmail", proton: false, imap: null, smtp: null }))
      .toEqual({ preset: providerById("gmail"), proton: false, imap: null, smtp: null });
    const server = { host: "mail.atelier-vogel.ch", port: 993, secure: true };
    expect(readDiscovery({ preset: "imap", proton: "yes", imap: server, smtp: { host: "", port: 587, secure: false } }))
      .toEqual({ preset: null, proton: false, imap: server, smtp: null });
    expect(readDiscovery({ preset: "a-newer-provider", proton: true, imap: { ...server, port: "993" }, smtp: { ...server, port: 70000 } }))
      .toEqual({ preset: null, proton: true, imap: null, smtp: null });
    for (const bad of [null, "gmail", 42, ["gmail"]]) expect(readDiscovery(bad)).toBeNull();
  });

  it("the password field says app password exactly where the preset takes one", () => {
    expect(passwordLabelKey(providerById("yahoo"))).toBe("passwordApp");
    expect(passwordLabelKey(providerById("gmx"))).toBe("passwordPlain");
    expect(passwordLabelKey(providerById("tonline"))).toBe("passwordPlain");
    expect(passwordLabelKey(providerById("imap"))).toBe("passwordPlain");
  });
});
