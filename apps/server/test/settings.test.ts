import { describe, expect, it } from "vitest";
import { loadSettings, type Settings, type SettingsDoorInput } from "../src/settings.js";
import { chosenFor } from "../src/differences.js";
import { MANAGED_ENV, PLAIN_ENV, PROCESS_DOOR, STORAGE_TRIO, dbUrl, env, fixture, functionDoor } from "./_envs.js";
import { KEY_RING_RETIRED } from "../../../test/support/key-ring-env.js";
import { anthropicKey } from "../../../test/support/fixture-credentials.js";

/**
 * THE SETTINGS MODULE: one loader for every door. Which service a configuration is, what refuses
 * the start, and that nothing a hosting platform sets in the environment changes either.
 */

const refusal = (e: NodeJS.ProcessEnv, door: SettingsDoorInput = PROCESS_DOOR): string => {
  try {
    loadSettings(e, door);
  } catch (err) {
    return (err as Error).message;
  }
  return "";
};

/**
 * A settings object without its functions, so two loads compare by value; and without the
 * organizer's install id, which has a case of its own below.
 */
const shape = (s: Settings): unknown => ({ ...s, keyRing: { ...s.keyRing, provider: null }, installId: null });

describe("a configuration says which service it is by the name that leads it", () => {
  it("OHMAIL_ORIGIN is a self-hosted server; DATABASE_URL_POOLED is the managed service", () => {
    expect(loadSettings(env(PLAIN_ENV), PROCESS_DOOR).managed).toBe(false);
    expect(loadSettings(env(MANAGED_ENV), functionDoor()).managed).toBe(true);
    // The managed service on a long-running process is the same configuration behind another door.
    expect(loadSettings(env(MANAGED_ENV), PROCESS_DOOR).managed).toBe(true);
  });

  it("both leads refuse, and neither: a configuration that lost its lead never starts as the other service", () => {
    const both = refusal(env(PLAIN_ENV, MANAGED_ENV));
    expect(both).toContain("OHMAIL_ORIGIN");
    expect(both).toContain("DATABASE_URL_POOLED");
    const lost = refusal(env(MANAGED_ENV, { DATABASE_URL_POOLED: undefined, TF_AUTH_ORIGINS: "https://ohmail.app" }));
    expect(lost).toContain("missing required env var");
    expect(lost).toContain("DATABASE_URL_POOLED");
    expect(lost).toContain("OHMAIL_ORIGIN");
  });

  it("a refusal names variables and never a value", () => {
    const m = refusal(env(PLAIN_ENV, { DATABASE_URL_POOLED: dbUrl("runtime", "pooler.example") }));
    expect(m).not.toContain("runtime");
    expect(m).not.toContain("pooler.example");
  });

  it.each(["TF_AUTH_ORIGINS", "TF_RP_ID"])("a refused %s names the variable and never its value", (name) => {
    // A connection string pasted into the wrong variable: the function door publishes this text on /health.
    const pasted = dbUrl("pasted", "db.example.com:6543");
    for (const door of [functionDoor("production"), PROCESS_DOOR]) {
      const m = refusal(env(MANAGED_ENV, { [name]: pasted }), door);
      expect(m).toContain("TF_AUTH_ORIGINS");
      expect(m).toContain("TF_RP_ID");
      for (const part of ["pasted", "db.example.com", "6543", "postgres:"]) expect(m, part).not.toContain(part);
    }
    // A pair that does not fit together is refused by the same sentence.
    const apart = refusal(env(MANAGED_ENV, { TF_AUTH_ORIGINS: "https://mail.example.org", TF_RP_ID: "example.net" }), functionDoor());
    expect(apart).toContain("TF_AUTH_ORIGINS");
    expect(apart).not.toContain("example.org");
    expect(apart).not.toContain("example.net");
  });
});

describe("a name of the managed service beside OHMAIL_ORIGIN refuses the start", () => {
  /* None of these is in a self-hosted file. Each is a sign of a managed configuration that was given
     the server's own lead: read as a self-hosted server it would migrate, meter nothing and ask no
     verified address, with the name ignored. */
  it.each([
    "TF_AUTH_ORIGINS", "TF_RP_ID", "TF_COOKIE_HOSTS", "DATABASE_URL_ADMIN", "TF_ADMIN_SECRET", "CRON_SECRET",
    "TF_PUBLIC_SIGNUP", "TF_INVITE_CODES",
  ])("%s", (name) => {
    const m = refusal(env(PLAIN_ENV, { [name]: `value-of-${name}` }));
    expect(m).toContain(`${name} is set beside OHMAIL_ORIGIN`);
    expect(m).toContain("DATABASE_URL_POOLED");
    expect(m).not.toContain("value-of");
    // Emptied is not set: a compose file may hand every name through.
    expect(loadSettings(env(PLAIN_ENV, { [name]: " " }), PROCESS_DOOR).managed).toBe(false);
  });

  it("names every one that is set, and leaves the two a self-hosted file may carry", () => {
    const m = refusal(env(PLAIN_ENV, { TF_ADMIN_SECRET: "a".repeat(32), CRON_SECRET: "c".repeat(32) }));
    expect(m).toContain("TF_ADMIN_SECRET, CRON_SECRET are set beside OHMAIL_ORIGIN");
    const carried = { DATABASE_URL_SESSION: dbUrl("ohmail", "db:5432", "ohmail"), ANTHROPIC_API_KEY: anthropicKey("selfhost") };
    expect(loadSettings(env(PLAIN_ENV, carried), PROCESS_DOOR).managed).toBe(false);
  });
});

describe("the entitlements pair is one marker", () => {
  const unmetered = env(MANAGED_ENV, { ENTITLEMENTS_URL: undefined, BILLING_PLANE_SECRET: undefined });

  it("both present meters; neither is the managed service unmetered", () => {
    expect(loadSettings(env(MANAGED_ENV), functionDoor()).entitlements?.address.origin).toBe("https://plane.example.com");
    expect(loadSettings(unmetered, functionDoor()).entitlements).toBeNull();
  });

  it("the bearer without the address refuses the start, an emptied bearer included", () => {
    for (const secret of ["b".repeat(32), ""]) {
      const m = refusal(env(unmetered, { BILLING_PLANE_SECRET: secret }), functionDoor());
      expect(m, `secret ${secret === "" ? "set empty" : "set"}`).toContain("BILLING_PLANE_SECRET is set without ENTITLEMENTS_URL");
      expect(m).not.toContain("bbbb");
    }
  });

  it("the address without the bearer refuses, and so does a short bearer", () => {
    const m = refusal(env(unmetered, { ENTITLEMENTS_URL: "https://plane.example.com" }), functionDoor());
    expect(m).toContain("ENTITLEMENTS_URL");
    expect(m).toContain("BILLING_PLANE_SECRET");
    expect(refusal(env(MANAGED_ENV, { BILLING_PLANE_SECRET: "short" }), functionDoor())).toContain("at least 24");
  });

  it("a self-hosted server meters nothing: either name beside OHMAIL_ORIGIN refuses", () => {
    expect(refusal(env(PLAIN_ENV, { ENTITLEMENTS_URL: "https://plane.example.com" }))).toContain("ENTITLEMENTS_URL is set beside OHMAIL_ORIGIN");
    expect(refusal(env(PLAIN_ENV, { BILLING_PLANE_SECRET: "" }))).toContain("BILLING_PLANE_SECRET is set beside OHMAIL_ORIGIN");
  });

  it.each([
    ["the service's own AI key", { ANTHROPIC_API_KEY: anthropicKey("unmetered") }, "ANTHROPIC_API_KEY"],
    ["open sign-up", { TF_PUBLIC_SIGNUP: "1" }, "TF_PUBLIC_SIGNUP"],
  ])("without the pair, %s refuses the start: nothing would count what it costs", (_what, costly, name) => {
    // Under every label and behind either door: a managed deployment that lost both names must not
    // serve unlimited mailboxes and AI on the service's key.
    for (const door of [functionDoor("production"), functionDoor("preview"), PROCESS_DOOR]) {
      const m = refusal(env(unmetered, costly), door);
      expect(m).toContain(`${name} is set without ENTITLEMENTS_URL and BILLING_PLANE_SECRET`);
      expect(m).not.toContain(anthropicKey("unmetered"));
    }
    expect(loadSettings(env(MANAGED_ENV, costly), functionDoor("production")).entitlements).not.toBeNull();
  });

  it("without the pair, what costs nothing still loads: no key, and sign-up by invite", () => {
    expect(loadSettings(env(unmetered, { TF_PUBLIC_SIGNUP: "0", ANTHROPIC_API_KEY: " " }), functionDoor("production")).entitlements).toBeNull();
  });
});

describe("no platform's own name decides anything", () => {
  /* What a hosting platform sets in a process's environment, for three of them: once as its
     production deployment, once as anything else. Either would move a default it leaked into. */
  const PLATFORM = {
    VERCEL: "1", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "0123abc", VERCEL_REGION: "fra1",
    RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_SERVICE_NAME: "api", RAILWAY_GIT_COMMIT_SHA: "0123abc",
    FLY_APP_NAME: "api", NODE_ENV: "production",
  };
  const PLATFORM_PREVIEW = {
    ...PLATFORM, VERCEL_ENV: "preview", RAILWAY_ENVIRONMENT_NAME: "staging", NODE_ENV: "development",
  };

  /* A bootstrap invite set loads only where the deployment's label is not production, so these
     two reach the branch that reads the label: a platform's word must not move it either way. */
  const INVITES = { TF_INVITE_CODES: "first-boot" };

  it.each([
    ["a self-hosted server", PLAIN_ENV, PROCESS_DOOR],
    ["the managed service behind a function", MANAGED_ENV, functionDoor("preview")],
    ["the managed service as a process", MANAGED_ENV, PROCESS_DOOR],
    ["the managed service behind a function, with bootstrap invites", { ...MANAGED_ENV, ...INVITES }, functionDoor("preview")],
    ["the managed service as a process its operator labels staging, with bootstrap invites", { ...MANAGED_ENV, ...INVITES, TF_ENV: "staging" }, PROCESS_DOOR],
  ])("%s loads the same settings and makes the same choices with a platform's variables set", (_n, base, door) => {
    const bare = loadSettings(env(base), door);
    for (const platform of [PLATFORM, PLATFORM_PREVIEW]) {
      const hosted = loadSettings(env(base, platform), door);
      expect(shape(hosted)).toEqual(shape(bare));
      expect(chosenFor(hosted.managed)).toEqual(chosenFor(bare.managed));
    }
  });

  it("the organizer's install id is the worker's own derivation, and TF_ENV pins it on any platform", () => {
    // The API and the organizer must name one install to a mailbox, so both call one function
    // (`resolveCloudInstallId`). It reads the worker platform's environment name where TF_ENV is
    // unset: the one value here that follows a platform's variable. An operator's TF_ENV wins.
    const pinned = env(MANAGED_ENV, { TF_ENV: "production" });
    expect(loadSettings(env(pinned, PLATFORM_PREVIEW), PROCESS_DOOR).installId).toBe(loadSettings(pinned, PROCESS_DOOR).installId);
    expect(loadSettings(env(MANAGED_ENV, { TF_ORGANIZER_INSTALL_ID: "cloud-a" }, PLATFORM_PREVIEW), PROCESS_DOOR).installId)
      .toBe(loadSettings(env(MANAGED_ENV, { TF_ORGANIZER_INSTALL_ID: "cloud-a" }), PROCESS_DOOR).installId);
  });

  it("a platform's production label on a self-hosted configuration changes no refusal", () => {
    // A label beside the build is reported on a self-hosted server, with or without the platform's word.
    const labelled = env(PLAIN_ENV, { TF_BUILD_VERSION: "v-test" });
    const bare = loadSettings(labelled, PROCESS_DOOR);
    const hosted = loadSettings(env(labelled, PLATFORM), PROCESS_DOOR);
    expect(hosted.managed).toBe(false);
    expect(hosted.build).toEqual(bare.build);
    expect(bare.build.error).toContain("TF_BUILD_VERSION");
    expect(refusal(env(PLAIN_ENV, PLATFORM, { TF_STORAGE_KIND: "nope" }))).toBe(refusal(env(PLAIN_ENV, { TF_STORAGE_KIND: "nope" })));
  });

  it("the managed strict branch is chosen by what the door hands in, never by the environment", () => {
    const noIdentity = env(MANAGED_ENV);
    // The door says production: a deployment that cannot say which build it is, is refused on /health.
    expect(loadSettings(noIdentity, functionDoor("production")).build.error).toContain("no build identity");
    // The same environment with the platform's variable set, and a door that says nothing: not strict.
    expect(loadSettings(env(noIdentity, { VERCEL_ENV: "production" }), functionDoor("")).build.error).toBeNull();
    // A door with no platform label: the operator's own label decides, and it is production unless said.
    expect(loadSettings(noIdentity, PROCESS_DOOR).build.error).toContain("no build identity");
    expect(loadSettings(env(noIdentity, { TF_ENV: "staging" }), PROCESS_DOOR).build.error).toBeNull();
  });

  it("a bootstrap invite set is refused in production: the door's label, or TF_ENV, which is production unless said", () => {
    const refused = "TF_INVITE_CODES is set on a PRODUCTION deployment";
    for (const [e, door] of [
      [env(MANAGED_ENV, INVITES), functionDoor("production")],
      [env(MANAGED_ENV, INVITES), functionDoor("")],
      [env(MANAGED_ENV, INVITES), PROCESS_DOOR],
      // The operator's own label is read before the door's.
      [env(MANAGED_ENV, INVITES, { TF_ENV: "production" }), functionDoor("preview")],
      // A platform's variable that says otherwise loosens nothing.
      [env(MANAGED_ENV, INVITES, PLATFORM_PREVIEW), functionDoor("production")],
      [env(MANAGED_ENV, INVITES, PLATFORM_PREVIEW), PROCESS_DOOR],
      // An acknowledgement that is not the same value is none.
      [env(MANAGED_ENV, INVITES, { TF_INVITE_BOOTSTRAP_ACK: "another" }), functionDoor("production")],
    ] as const) {
      const m = refusal(e, door);
      expect(m).toContain(refused);
      expect(m).not.toContain("first-boot");
    }
  });

  it("the set loads with the matching acknowledgement, and under a label that is not production", () => {
    const codes = (e: NodeJS.ProcessEnv, door: SettingsDoorInput) => [...loadSettings(e, door).origin.authConfig.inviteCodes];
    expect(codes(env(MANAGED_ENV, INVITES, { TF_INVITE_BOOTSTRAP_ACK: "first-boot" }), functionDoor("production"))).toEqual(["first-boot"]);
    expect(codes(env(MANAGED_ENV, INVITES, { TF_INVITE_BOOTSTRAP_ACK: "first-boot" }), PROCESS_DOOR)).toEqual(["first-boot"]);
    expect(codes(env(MANAGED_ENV, INVITES), functionDoor("preview"))).toEqual(["first-boot"]);
    expect(codes(env(MANAGED_ENV, INVITES, { TF_ENV: "staging" }), PROCESS_DOOR)).toEqual(["first-boot"]);
    // A platform's production word tightens nothing either.
    expect(codes(env(MANAGED_ENV, INVITES, PLATFORM), functionDoor("preview"))).toEqual(["first-boot"]);
    expect(codes(env(MANAGED_ENV), functionDoor("production"))).toEqual([]);
  });

  it("the platform's build id and label reach the settings only as door inputs", () => {
    const s = loadSettings(env(MANAGED_ENV), { ...functionDoor("preview"), platformBuildId: "sha-from-the-door" });
    expect(s.build).toMatchObject({ version: "sha-from-the-door", source: "platform", error: null });
    expect(s.environment).toBe("preview");
    expect(loadSettings(env(MANAGED_ENV, { TF_ENV: "staging" }), functionDoor("preview")).environment).toBe("staging");
    expect(loadSettings(env(MANAGED_ENV), functionDoor("")).environment).toBe("production");
  });
});

describe("each of these is one setting, with a value for a plain server", () => {
  it("mail to customers: SMTP_URL or RESEND_API_KEY with MAIL_FROM; both, or half, refuses", () => {
    const smtp = { SMTP_URL: "smtp://mail.example.com:587", MAIL_FROM: "ohmail <no-reply@mail.example.com>" };
    const plain = loadSettings(env(PLAIN_ENV, smtp), PROCESS_DOOR).customerMail!;
    expect(plain.transport).toEqual({ kind: "smtp", url: smtp.SMTP_URL });
    // One origin is the whole of a self-hosted server: every link names it.
    expect(plain.links).toMatchObject({ appUrl: "https://mail.example.com", allowedOrigins: ["https://mail.example.com"], supportEmail: "no-reply@mail.example.com" });
    const resend = loadSettings(env(MANAGED_ENV, { RESEND_API_KEY: fixture("re", "fixture"), MAIL_FROM: smtp.MAIL_FROM }), functionDoor()).customerMail!;
    expect(resend.transport.kind).toBe("resend");
    expect(resend.links.allowedOrigins).toBeNull();
    // The way out of one mail vendor is the same setting's other value, on the managed service too.
    expect(loadSettings(env(MANAGED_ENV, smtp), functionDoor()).customerMail!.transport.kind).toBe("smtp");
    expect(loadSettings(env(PLAIN_ENV), PROCESS_DOOR).customerMail).toBeNull();
    expect(refusal(env(PLAIN_ENV, smtp, { RESEND_API_KEY: fixture("re", "fixture") }))).toContain("both set");
    expect(refusal(env(PLAIN_ENV, { SMTP_URL: smtp.SMTP_URL }))).toContain("PARTIALLY configured");
    expect(refusal(env(MANAGED_ENV, { RESEND_API_KEY: fixture("re", "fixture") }), functionDoor())).toContain("PARTIALLY configured");
    expect(refusal(env(PLAIN_ENV, { MAIL_FROM: smtp.MAIL_FROM }))).toContain("PARTIALLY configured");
  });

  it("storage: TF_STORAGE_KIND, with the older three-variable block alone still read as its kind", () => {
    const s3 = {
      TF_STORAGE_KIND: "s3", S3_ENDPOINT: "http://rustfs:9000", S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: fixture("id"), S3_SECRET_ACCESS_KEY: fixture("s3", "fixture"), S3_BUCKET: "ohmail-staging",
    };
    const serviceKey = fixture("service", "role");
    const trio = { [STORAGE_TRIO.url]: STORAGE_TRIO.origin, [STORAGE_TRIO.key]: serviceKey, [STORAGE_TRIO.bucket]: "staging" };
    expect(loadSettings(env(PLAIN_ENV, s3), PROCESS_DOOR).storage).toMatchObject({ kind: "s3", publicEndpoint: "https://mail.example.com" });
    expect(loadSettings(env(MANAGED_ENV, s3), functionDoor()).storage?.kind).toBe("s3");
    for (const [base, door] of [[PLAIN_ENV, PROCESS_DOOR], [MANAGED_ENV, functionDoor()]] as const) {
      expect(loadSettings(env(base, trio), door).storage).toEqual({ kind: STORAGE_TRIO.kind, url: STORAGE_TRIO.origin, serviceKey, bucket: "staging" });
      expect(refusal(env(base, { [STORAGE_TRIO.url]: STORAGE_TRIO.origin }), door)).toContain("PARTIALLY configured");
      expect(refusal(env(base, { S3_BUCKET: "b" }), door)).toContain("TF_STORAGE_KIND is not");
      expect(loadSettings(env(base), door).storage).toBeNull();
    }
  });

  it("the pager: a mail arm with no mailer refuses on both, and the scheduler's credential is the managed service's", () => {
    const armed = { TF_ALERT_SECRET: "s".repeat(32), TF_ALERT_EMAIL: "ops@example.com" };
    expect(refusal(env(PLAIN_ENV, armed))).toContain("TF_ALERT_EMAIL is set but this server has no mailer");
    expect(refusal(env(MANAGED_ENV, armed), functionDoor())).toContain("TF_ALERT_EMAIL is set but this server has no mailer");
    const cron = { TF_ALERT_SECRET: "s".repeat(32), CRON_SECRET: "c".repeat(32) };
    expect(loadSettings(env(MANAGED_ENV, cron), functionDoor()).alerts?.cronSecret).toBe("c".repeat(32));
    expect(loadSettings(env(PLAIN_ENV, { TF_ALERT_SECRET: "s".repeat(32) }), PROCESS_DOOR).alerts?.cronSecret).toBeNull();
    expect(refusal(env(PLAIN_ENV, cron))).toContain("CRON_SECRET is set beside OHMAIL_ORIGIN");
    expect(loadSettings(env(PLAIN_ENV, { TF_ALERT_SECRET: "short" }), PROCESS_DOOR).alerts).toBeNull();
  });

  it("the names a cookie is accepted on: the operator's one origin, or the managed compiled list", () => {
    expect(loadSettings(env(PLAIN_ENV), PROCESS_DOOR).origin.cookieHosts).toEqual(["mail.example.com", "localhost", "127.0.0.1", "[::1]", "::1"]);
    expect(loadSettings(env(MANAGED_ENV), functionDoor()).origin.cookieHosts).toEqual(["api.ohmail.app", "ohmail.app", "admin.ohmail.app"]);
    expect(refusal(env(MANAGED_ENV, { TF_COOKIE_HOSTS: "evil.example" }), functionDoor())).toContain("TF_COOKIE_HOSTS may only name");
  });

  it("the visitor's address: the proxies an operator names, none by default, on every door", () => {
    expect(loadSettings(env(PLAIN_ENV), PROCESS_DOOR).network.trustedProxies).toEqual([]);
    expect(loadSettings(env(PLAIN_ENV, { TF_TRUSTED_PROXIES: "proxy" }), PROCESS_DOOR).network.trustedProxies).toEqual(["proxy"]);
    expect(loadSettings(env(MANAGED_ENV, { TF_TRUSTED_PROXIES: "10.0.0.0/8" }), PROCESS_DOOR).network).toMatchObject({
      trustedProxies: ["10.0.0.0/8"], externalDoor: { door: "tls" },
    });
  });
});

describe("a self-hosted server's switches mean nothing on the managed service", () => {
  it("both private-network switches read false there, whatever the environment holds", () => {
    const switches = { TF_PROBE_ALLOW_PRIVATE: "1", TF_PUSH_ALLOW_PRIVATE: "1" };
    expect(loadSettings(env(PLAIN_ENV, switches), PROCESS_DOOR).network).toMatchObject({ probeAllowPrivate: true, pushAllowPrivate: true });
    expect(loadSettings(env(MANAGED_ENV, switches), functionDoor()).network).toMatchObject({ probeAllowPrivate: false, pushAllowPrivate: false });
  });

  it("the provider choice and a retired key version: each is one service's and refuses on the other", () => {
    expect(refusal(env(MANAGED_ENV, { TF_AI_PROVIDER: "ollama" }), functionDoor())).toContain("TF_AI_PROVIDER");
    expect(refusal(env(PLAIN_ENV, { [KEY_RING_RETIRED]: "1" }))).toContain(KEY_RING_RETIRED);
    expect(refusal(env(MANAGED_ENV, { STRIPE_SECRET_KEY: "sk" + "_test_x" }), functionDoor())).toContain("STRIPE_SECRET_KEY");
  });
});

describe("the clocks' setting is off by default and refuses where it cannot hold", () => {
  const on = { TF_API_CLOCKS: "1", TF_ALERT_SECRET: "s".repeat(32) };

  it("off unless TF_API_CLOCKS is exactly 1", () => {
    expect(loadSettings(env(PLAIN_ENV), PROCESS_DOOR).clocks.inProcess).toBe(false);
    expect(loadSettings(env(PLAIN_ENV, { ...on, TF_API_CLOCKS: "true" }), PROCESS_DOOR).clocks.inProcess).toBe(false);
    expect(loadSettings(env(PLAIN_ENV, on), PROCESS_DOOR).clocks.inProcess).toBe(true);
    expect(loadSettings(env(MANAGED_ENV, on, { DATABASE_URL_SESSION: dbUrl("ohmail_runtime") }), PROCESS_DOOR).clocks.inProcess).toBe(true);
  });

  it("refuses on a function, without the routes' secret, and with no session to lead on", () => {
    expect(refusal(env(MANAGED_ENV, on), functionDoor())).toContain("runs per request");
    expect(refusal(env(PLAIN_ENV, { TF_API_CLOCKS: "1" }))).toContain("TF_ALERT_SECRET");
    expect(refusal(env(MANAGED_ENV, on), PROCESS_DOOR)).toContain("DATABASE_URL_SESSION");
  });
});
