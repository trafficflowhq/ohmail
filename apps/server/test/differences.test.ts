import { afterEach, describe, expect, it } from "vitest";
import { apiRoutes, ALLOW_ANY_PROBE_HOST } from "@trafficflow/api";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { UNMETERED } from "@trafficflow/db";
import { OWED_COPY_CLOUD, OWED_COPY_SELF_HOST } from "@trafficflow/services";
import { DIFFERENCES, chosenFor } from "../src/differences.js";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { MANAGED_ENV, PLAIN_ENV, PROCESS_DOOR, dbUrl, env, fixture, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";
import { stripeTestKey } from "../../../test/support/fixture-credentials.js";
import { KEY_RING_RETIRED, KEY_RING_V1, keyRingVar } from "../../../test/support/key-ring-env.js";

/**
 * ONE PROGRAM, AND THE WHOLE LIST OF WHAT THE MANAGED SERVICE DOES DIFFERENTLY.
 *
 * Each line of `DIFFERENCES` is read here twice: as a value that differs, and through the loaded
 * settings or the built program under the canonical self-hosted environment (the bundled compose's
 * names) and the canonical managed one (the function door's names). A line that reads the same on
 * both is red.
 */

const open: Program[] = [];
afterEach(async () => { for (const p of open.splice(0)) await p.close(); });

/** A self-hosted server behind the process door. */
const plain = (extra: Record<string, string> = {}): Program => {
  const p = buildProgram(loadSettings(env(PLAIN_ENV, extra), PROCESS_DOOR), processInput(recordingLogger().logger));
  open.push(p);
  return p;
};
/** The managed service behind the function door; `label` is what the door's platform calls the deployment. */
const managed = (extra: Record<string, string | undefined> = {}, label = ""): Program => {
  const p = buildProgram(loadSettings(env(MANAGED_ENV, extra), functionDoor(label)), functionInput(recordingLogger().logger));
  open.push(p);
  return p;
};
/** The managed service as a long-running process: the same settings behind the other door. */
const managedProcess = (extra: Record<string, string | undefined> = {}): Program => {
  const p = buildProgram(loadSettings(env(MANAGED_ENV, extra), PROCESS_DOOR), processInput(recordingLogger().logger));
  open.push(p);
  return p;
};
const at = (path: string, origin: string): Request => new Request(`${origin}${path}`);
const plainDeps = (p: Program) => p.buildDeps(at("/hello", "https://mail.example.com"));
const managedDeps = (p: Program) => p.buildDeps(at("/hello", "https://api.ohmail.app"));
const patterns = (p: Program): string[] => p.chosen.routes.map((r) => r.pattern);

const ALERTS = { TF_ALERT_SECRET: "s".repeat(32), TF_ALERT_WEBHOOK_URL: "https://ntfy.example/ohmail" };
const STAFF = { TF_ADMIN_SECRET: "a".repeat(32), DATABASE_URL_ADMIN: dbUrl("ohmail_admin") };

describe("the list", () => {
  it("has a line for everything the marker decides, and each reads differently on the two", () => {
    // Frozen: a new difference is a new line here, with its own case below.
    expect(DIFFERENCES.map((line) => line.id)).toEqual([
      "routes", "flavor", "origin", "database", "firstAccount", "migrations", "requireVerified", "signup", "metering",
      "owedCopy", "staffDoor", "ai", "privateDials", "deviceCodeDoor", "events", "sendClock", "pager", "funnel",
      "mailLinks", "keyRetirement", "buildIdentity", "paymentVariables",
    ]);
    for (const line of DIFFERENCES) {
      expect(line.managed, `${line.id} reads the same on both: it is no difference`).not.toEqual(line.plain);
      expect(line.says.length, `${line.id} says nothing`).toBeGreaterThan(20);
    }
  });

  it("the marker picks one side of every line, whole", () => {
    for (const line of DIFFERENCES) {
      expect(chosenFor(false)[line.id]).toEqual(line.plain);
      expect(chosenFor(true)[line.id]).toEqual(line.managed);
    }
    expect(plain().chosen).toEqual(chosenFor(false));
    expect(managed().chosen).toEqual(chosenFor(true));
  });
});

describe("each line, through the loaded settings or the built program", () => {
  it("routes: pairing setup on a self-hosted server; the staff door, the funnel and the scheduled passes on the managed service", () => {
    expect(plain().chosen.routes).toBe(selfHostRoutes);
    expect(managed().chosen.routes).toBe(apiRoutes);
    expect(patterns(managed())).toContain("/waitlist");
    expect(patterns(plain())).not.toContain("/waitlist");
  });

  it("flavor, and the first account's ceremony", () => {
    const p = plainDeps(plain()).hello!;
    const m = managedDeps(managed()).hello!;
    expect([p.flavor, m.flavor]).toEqual(["selfhost", "managed"]);
    // A database fact on a self-hosted server (it flips when the first account registers); never on the managed service.
    expect(typeof p.needsSetup).toBe("function");
    expect(m.needsSetup).toBe(false);
  });

  it("origin: the operator's one origin and its host; or listed origins, with cookie hosts from a compiled list", () => {
    const p = plainDeps(plain());
    expect(p.authConfig).toMatchObject({ rpID: "mail.example.com", origin: ["https://mail.example.com"] });
    expect(p.appOrigin).toBe("https://mail.example.com");
    expect(p.allowCookieAuth).toBe(true);
    // The product's own host is nothing to a self-hosted server: a cookie is no credential there.
    expect(plain().buildDeps(at("/hello", "https://api.ohmail.app")).allowCookieAuth).toBe(false);

    const m = managedDeps(managed({ TF_AUTH_ORIGINS: "https://ohmail.app,https://admin.ohmail.app", TF_COOKIE_HOSTS: "api.ohmail.app" }));
    expect(m.authConfig).toMatchObject({ rpID: "ohmail.app", origin: ["https://ohmail.app", "https://admin.ohmail.app"] });
    expect(m.appOrigin).toBe("https://ohmail.app");
    expect(m.allowCookieAuth).toBe(true);
    // The list is compiled: a host the settings did not pick from it is bearer-only, and none can be added.
    expect(managed({ TF_COOKIE_HOSTS: "api.ohmail.app" }).buildDeps(at("/hello", "https://admin.ohmail.app")).allowCookieAuth).toBe(false);
    expect(managed().buildDeps(at("/hello", "https://mail.example.com")).allowCookieAuth).toBe(false);
    expect(() => managed({ TF_COOKIE_HOSTS: "mail.example.com" })).toThrow(/TF_COOKIE_HOSTS/);
  });

  it("database: one owned pool that also holds the LISTEN; or the pooler, with a session connection apart", () => {
    const p = plain();
    expect(p.settings.database).toEqual({ kind: "owned", url: PLAIN_ENV.DATABASE_URL, listenUrl: PLAIN_ENV.DATABASE_URL });
    // A new connection is not probed apart on a pool the server owns.
    expect(plainDeps(p).health!.freshConnect).toBeUndefined();
    // The operator's database must hold a session: a transaction pooler cannot keep the migrator's lock.
    expect(() => plain({ DATABASE_URL: dbUrl("ohmail", "db:6543", "ohmail") })).toThrow(/DATABASE_URL is unusable/);

    const m = managed();
    expect(m.settings.database).toEqual({ kind: "pooled", url: MANAGED_ENV.DATABASE_URL_POOLED, listenUrl: null });
    expect(managedDeps(m).health!.freshConnect).toBeTypeOf("function");
    const session = dbUrl("ohmail_runtime", "localhost:5432", "session");
    expect(managed({ DATABASE_URL_SESSION: session }).settings.database.listenUrl).toBe(session);
  });

  it("migrations: the server's own before it listens, or the deploy's", () => {
    expect([plain().chosen.migrations, managed().chosen.migrations]).toEqual(["at-start", "by-the-deploy"]);
  });

  it("requireVerified: stated on both, false only where a pairing invite verifies nobody by mail", () => {
    expect(plainDeps(plain()).requireVerifiedForProduct).toBe(false);
    expect(managedDeps(managed()).requireVerifiedForProduct).toBe(true);
  });

  it("signup: the pairing-invite bridge on a self-hosted server; open sign-up only where configured, with a mailer", () => {
    expect(plain().services.inviteRedeem).toBeTypeOf("function");
    expect(managed().services.inviteRedeem).toBeUndefined();
    expect(plainDeps(plain()).hello!.auth.publicSignup).toBe(false);
    // (SMTP at a loopback sink: under a test runner no mailer is built that could reach a network.)
    const mail = { SMTP_URL: "smtp://127.0.0.1:2525", MAIL_FROM: "ohmail <no-reply@ohmail.example>" };
    expect(managedDeps(managed({ TF_PUBLIC_SIGNUP: "1", ...mail })).hello!.auth.publicSignup).toBe(true);
    // The flag alone announces a ceremony the program cannot complete: no mailer, no open sign-up.
    expect(managedDeps(managed({ TF_PUBLIC_SIGNUP: "1" })).hello!.auth.publicSignup).toBe(false);
  });

  it("metering: UNMETERED, stated, on a self-hosted server; the entitlements client where the pair is set", () => {
    const p = plain();
    expect(p.services.entitlementsPort).toBe(UNMETERED);
    expect(p.services.liveBodyAdmit).toBeUndefined();
    expect(plainDeps(p).health!.entitlements).toBeUndefined();
    expect(plainDeps(p).refundObligations).toBeUndefined();

    const m = managed();
    expect(m.services.entitlementsPort).not.toBe(UNMETERED);
    expect(m.services.liveBodyAdmit).toBeTypeOf("function");
    expect(managedDeps(m).health!.entitlements).toBe("configured");
    expect(managedDeps(m).refundObligations).toBeDefined();

    // The managed service with no pair is unmetered and says so; it owes no refunds.
    const bare = managed({ ENTITLEMENTS_URL: undefined, BILLING_PLANE_SECRET: undefined });
    expect(bare.services.entitlementsPort).toBe(UNMETERED);
    expect(managedDeps(bare).health!.entitlements).toBe("unmetered");
    expect(managedDeps(bare).refundObligations).toBeUndefined();
  });

  it("owedCopy: kept with its files on a self-hosted server; without them on the managed service", () => {
    expect(plain().services.sendKeepOwedCopy).toEqual(OWED_COPY_SELF_HOST);
    expect(managed().services.sendKeepOwedCopy).toEqual(OWED_COPY_CLOUD);
  });

  it("staffDoor: the alert pass on the server's own handle, or everything cross-account on the blind role", () => {
    const p = plainDeps(plain(ALERTS));
    expect(p.alerts?.db, "a self-hosted pass has no handle: every /internal/alerts route answers 503").toBeTypeOf("function");
    expect(p.adminDb).toBeUndefined();
    expect(p.admin).toBeUndefined();
    expect(p.health!.alertsError).toBeNull();

    const m = managedDeps(managed({ ...ALERTS, ...STAFF }));
    expect(m.adminDb).toBeTypeOf("function");
    expect(m.admin?.secret).toBe("a".repeat(32));
    expect(m.alerts?.db, "the managed pass must run on the blind role, never on the handle that reads mail").toBeUndefined();
    expect(m.health!.alertsError).toBeNull();
  });

  it("staffDoor: with no blind connection the managed pager is dark and says so; nothing falls back to the runtime handle", () => {
    const m = managedDeps(managed({ ...ALERTS, TF_ADMIN_SECRET: "a".repeat(32) }));
    expect(m.admin).toBeUndefined();
    expect(m.adminDb).toBeUndefined();
    expect(m.alerts?.db).toBeUndefined();
    expect(m.health!.alertsError).toContain("DATABASE_URL_ADMIN");
    expect(m.health!.adminError).toContain("DATABASE_URL_ADMIN");
  });

  it("ai: the operator's provider on a self-hosted server; the shipped models, or none, on the managed service", () => {
    const local = { TF_AI_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://ollama:11434", TF_AI_CLASSIFY_MODEL: "m", TF_AI_DRAFT_MODEL: "m", TF_AI_ALLOW_PRIVATE: "1" };
    const p = plain(local);
    expect(p.settings.ai).toMatchObject({ kind: "operator" });
    expect(plainDeps(p).hello!.features.ai).toBe(true);
    expect(() => managed({ TF_AI_PROVIDER: "ollama" })).toThrow(/TF_AI_PROVIDER/);
    expect(managedDeps(managed()).hello!.features.ai).toBe(false);
  });

  it("privateDials: the operator's switch opens the probe on a self-hosted server and nothing on the managed service", () => {
    const on = { TF_PROBE_ALLOW_PRIVATE: "1", TF_PUSH_ALLOW_PRIVATE: "1" };
    expect(plain(on).services.probeHostGuard).toBe(ALLOW_ANY_PROBE_HOST);
    expect(plain().services.probeHostGuard).not.toBe(ALLOW_ANY_PROBE_HOST);
    const m = managed(on);
    expect(m.services.probeHostGuard, "the managed probe dials a private address").not.toBe(ALLOW_ANY_PROBE_HOST);
    expect(m.services.probeHostGuard).toBeDefined();
    expect(m.services.probeScopeResolver).toBeUndefined();
    expect(plain(on).services.probeScopeResolver).toBeDefined();
  });

  it("deviceCodeDoor: the public client arms the door on a self-hosted server only", () => {
    const device = { MS_DEVICE_CLIENT_ID: "11111111-2222-4333-8444-555555555555" };
    expect(plainDeps(plain(device)).msDevice?.clientId).toBe(device.MS_DEVICE_CLIENT_ID);
    expect(plainDeps(plain()).msDevice).toBeUndefined();
    expect(managedDeps(managed(device)).msDevice).toBeUndefined();
  });

  it("events: always served on a self-hosted server; behind the flag, and slower, on the managed service", () => {
    // No variable is read on a self-hosted server: there is none to forget.
    const p = plainDeps(plain({ TF_SSE: "0", TF_SSE_POLL_MS: "60000" }));
    expect(p.sse).toMatchObject({ enabled: true, pollMs: 5_000, lifetimeMs: 270_000 });
    expect(p.hello!.features.sse).toBe(true);

    const off = managedDeps(managed());
    expect(off.sse).toMatchObject({ enabled: false, pollMs: 8_000, lifetimeMs: 270_000 });
    expect(off.hello!.features.sse).toBe(false);
    expect(managedDeps(managed({ TF_SSE: "1", TF_SSE_POLL_MS: "12000" })).sse).toMatchObject({ enabled: true, pollMs: 12_000 });
    expect(() => managed({ TF_SSE_POLL_MS: "200" })).toThrow(/TF_SSE_POLL_MS/);

    // The flag turns it on, never the door: a managed process, which would hold every stream it
    // is asked for, serves none until the flag says so.
    const process = managedDeps(managedProcess());
    expect(process.sse).toMatchObject({ enabled: false, pollMs: 8_000, holds: true });
    expect(process.hello!.features.sse).toBe(false);
    expect(managedDeps(managedProcess({ TF_SSE: "1" })).hello!.features.sse).toBe(true);
    // Behind a function the flag is on and nothing is held: 204, and the client polls.
    expect(managedDeps(managed({ TF_SSE: "1" })).hello!.features.sse).toBe(false);
  });

  it("sendClock: a self-hosted server keeps its own; the managed service's passes are poked", async () => {
    const own = plain().startClocks();
    expect(own?.leading()).toBe(true);
    await own!.stop();
    expect(managed().startClocks()).toBeNull();
    expect(managedProcess().startClocks(), "a managed process drives nothing unless TF_API_CLOCKS says so").toBeNull();
  });

  it("pager: a missing pager is listed, empty, where one is expected; unlisted where nobody armed one", () => {
    expect(plainDeps(plain()).health!.alertSinks).toBeNull();
    expect(managedDeps(managed()).health!.alertSinks?.().arms).toEqual([]);
    expect(plainDeps(plain(ALERTS)).health!.alertSinks?.().arms.map((a) => a.name)).toEqual(["webhook"]);
  });

  it("funnel: the waitlist, mailbox discovery and the lifecycle switches are the managed service's", () => {
    const m = managed({ TF_CONNECT_REMINDER: "send", TF_CONNECT_ATTEMPTS: "record", CRON_SECRET: "c".repeat(32) });
    expect(m.services.waitlist).toBeDefined();
    expect(managedDeps(m)).toMatchObject({ connectReminder: "send", cronSecret: "c".repeat(32) });
    expect(managedDeps(m).mailDns).toBeDefined();
    expect(managedDeps(m).connectAttempts).toBeDefined();
    const p = plain({ TF_CONNECT_REMINDER: "send", TF_CONNECT_ATTEMPTS: "record" });
    expect(p.services.waitlist).toBeUndefined();
    expect(plainDeps(p).mailDns).toBeUndefined();
    expect(plainDeps(p).connectReminder).toBeUndefined();
    expect(plainDeps(p).connectAttempts).toBeUndefined();
  });

  it("mailLinks: every link names the one origin; or the configured app, site and console", () => {
    // (SMTP at a loopback sink, as above.)
    const mail = { SMTP_URL: "smtp://127.0.0.1:2525", MAIL_FROM: "ohmail <no-reply@ohmail.example>" };
    const bases = {
      MAIL_APP_URL: "https://app.example.net", MAIL_SITE_URL: "https://site.example.net",
      TF_ADMIN_URL: "https://console.example.net", MAIL_SUPPORT_EMAIL: "help@example.net",
    };
    // The bases are not read on a self-hosted server: a link in its mail can name its origin only.
    expect(plain({ ...mail, ...bases }).settings.customerMail!.links).toEqual({
      appUrl: "https://mail.example.com", siteUrl: "https://mail.example.com", adminUrl: null,
      supportEmail: "no-reply@ohmail.example", allowedOrigins: ["https://mail.example.com"],
    });
    expect(managed({ ...mail, ...bases }).settings.customerMail!.links).toEqual({
      appUrl: bases.MAIL_APP_URL, siteUrl: bases.MAIL_SITE_URL, adminUrl: bases.TF_ADMIN_URL,
      supportEmail: bases.MAIL_SUPPORT_EMAIL, allowedOrigins: null,
    });
    expect(managed(mail).settings.customerMail!.links).toMatchObject({ appUrl: "https://ohmail.app", adminUrl: "https://admin.ohmail.app" });
  });

  it("keyRetirement: a retired mark refuses a self-hosted start; the managed service reads it and checks on /health", () => {
    const retired = { [KEY_RING_V1]: undefined, [keyRingVar(2)]: "cd".repeat(32), [KEY_RING_RETIRED]: "1" };
    expect(() => loadSettings(env(PLAIN_ENV, retired), PROCESS_DOOR)).toThrow(KEY_RING_RETIRED);
    expect(plainDeps(plain()).health!.kekRetirement).toBeNull();

    const m = managed(retired);
    expect(m.settings.keyRing).toMatchObject({ retiredThrough: 1, error: null });
    expect(managedDeps(m).health!.kekRetirement).toBeTypeOf("function");
    expect(managedDeps(managed()).health!.kekRetirement).toBeNull();
  });

  it("buildIdentity: a label from a variable is named on a self-hosted /health; a managed production build with none of its own fails it", () => {
    // A source run answers `dev` honestly, and that is no fault there.
    const source = plainDeps(plain()).health!;
    expect([source.version, source.buildSource, source.buildError]).toEqual(["dev", "none", null]);
    expect(plainDeps(plain({ TF_BUILD_VERSION: "v-test" })).health!.buildError).toContain("TF_BUILD_VERSION");

    expect(managedDeps(managed({}, "production")).health!.buildError).toContain("no build identity");
    expect(managedDeps(managed({ TF_BUILD_VERSION: "v-test" }, "production")).health!.buildError).toContain("not from the deployment");
    expect(managedDeps(managedProcess()).health!.buildError).toContain("no build identity");
    // Outside production the managed service asks nothing of a build.
    expect(managedDeps(managed({ TF_BUILD_VERSION: "v-test" }, "preview")).health!.buildError).toBeNull();
    expect(managedDeps(managedProcess({ TF_ENV: "staging" })).health!.buildError).toBeNull();
  });

  it("paymentVariables: a payment provider's variable refuses the managed start; a self-hosted server does not look", () => {
    const leftover = { STRIPE_SECRET_KEY: stripeTestKey("leftover") };
    expect(() => managed(leftover)).toThrow(/STRIPE_SECRET_KEY/);
    expect(plain(leftover).chosen.paymentVariables).toBe("not-read");
  });
});

describe("what the door decides is not on the list: a function and a process differ by their inputs", () => {
  it("the same managed settings behind either door make the same choices", () => {
    expect(managedProcess().chosen).toEqual(managed().chosen);
  });

  it("a process nothing ends retries a Sent copy in memory; a function a platform ends does not", () => {
    expect(plain().services.sendCopyOutlivesAnswer).toBe(true);
    expect(managed().services.sendCopyOutlivesAnswer).toBeUndefined();
    expect(plain().services.sendSurfaceMaxTotalBytes).toBe(32 * 1024 * 1024);
    expect(managed().services.sendSurfaceMaxTotalBytes).toBe(3 * 1024 * 1024);
  });

  it("a function builds its costly services on first use; a process before it listens", () => {
    const lazy = Object.getOwnPropertyDescriptor(managed().services, "auth");
    const eager = Object.getOwnPropertyDescriptor(plain().services, "auth");
    expect(typeof lazy?.get).toBe("function");
    expect(eager?.value).toBeDefined();
  });

  it("the work a function hands its platform after an answer is the door's own hook", () => {
    const handed: Promise<unknown>[] = [];
    const p = buildProgram(loadSettings(env(MANAGED_ENV), functionDoor()), functionInput(recordingLogger().logger, (w) => handed.push(w)));
    open.push(p);
    expect(p.runtime.door.afterAnswer).toBeTypeOf("function");
    expect(plain().runtime.door.afterAnswer).toBeNull();
  });

  it("`/hello` states the release the door's build wrote in, on either service; a door with none states none", async () => {
    const self = buildProgram(loadSettings(env(PLAIN_ENV), { ...PROCESS_DOOR, release: "9.8.7" }), processInput(recordingLogger().logger));
    const cloud = buildProgram(loadSettings(env(MANAGED_ENV), { ...functionDoor(), release: " 9.8.7 " }), functionInput(recordingLogger().logger));
    const blank = buildProgram(loadSettings(env(MANAGED_ENV), { ...functionDoor(), release: "  " }), functionInput(recordingLogger().logger));
    open.push(self, cloud, blank);
    expect([plainDeps(self).hello!.apiVersion, managedDeps(cloud).hello!.apiVersion]).toEqual(["9.8.7", "9.8.7"]);
    // None, or a blank one: no key, so the route's own `0.0.0` answers and nothing guesses.
    for (const none of [plainDeps(plain()).hello!, managedDeps(managed()).hello!, managedDeps(blank).hello!]) {
      expect(none).not.toHaveProperty("apiVersion");
    }
    const wire = async (p: Program): Promise<unknown> => (await p.dispatch(at("/hello", "https://api.ohmail.app"))).json();
    expect(await wire(cloud)).toMatchObject({ flavor: "managed", apiVersion: "9.8.7" });
    expect(await wire(managed())).toMatchObject({ flavor: "managed", apiVersion: "0.0.0" });
  });
});

describe("two alerting faults that are open, and wait for a setting only the operator of the managed service can place", () => {
  /* Expected to fail today. When either becomes true the case turns red, and is rewritten as an
     ordinary one. */
  it.fails("a managed pager armed with a single vendor is refused at start: one channel is not a pager", () => {
    const mail = { RESEND_API_KEY: fixture("re", "fixture"), MAIL_FROM: "ohmail <no-reply@ohmail.example>", TF_ALERT_EMAIL: "ops@ohmail.example" };
    expect(() => loadSettings(env(MANAGED_ENV, { TF_ALERT_SECRET: "s".repeat(32), ...mail }), functionDoor("production")))
      .toThrow(/second/);
  });

  it.fails("a managed pager with no outside heartbeat says so on /health: silence must page someone", () => {
    const deps = managedDeps(managed({ ...ALERTS, ...STAFF }));
    expect(deps.health!.alertsError).toContain("TF_ALERT_HEARTBEAT_URL");
  });
});
