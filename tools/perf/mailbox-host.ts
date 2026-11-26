import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  createApp,
  csrfTokenFor,
  DEFAULT_SSE,
  normalizePathname,
  sessionCookies,
  type ApiDeps,
  type ApiServices,
} from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { makeHttpServer } from "@trafficflow/core/adapters/http-host";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import { bindDb, UNMETERED } from "@trafficflow/db";
import {
  ensureHotPathIndexes,
  ensureSearchExtensions,
  ensureWordIndex,
  runMigrations,
} from "@trafficflow/db/admin";
import { makeChangeWakeHub, makeOwnedDb } from "@trafficflow/db/cloud";
import {
  attachmentsService,
  awayResponderService,
  contactsService,
  draftsService,
  makeApprovalService,
  makeAuthService,
  makeMailboxService,
  makeScreenerService,
  makeTestAuthDeps,
  messageService,
  notifyRulesService,
  proposalsService,
  rulesService,
  scheduleService,
  searchService,
  sendService,
  snippetsService,
  tagsService,
  threadService,
  triageService,
  workflowsService,
} from "@trafficflow/services";
import { calendarFeed } from "@trafficflow/services/calendar";
import { createWindowOutbox, WINDOW_OUTBOX_ROUTE } from "../../apps/sidecar/src/window-outbox.js";
import {
  ageMailbox,
  arrive,
  createFixtureSession,
  ensureAttachmentMetadata,
  expectedAttachmentCounts,
  MAILBOX_SIZES,
  mailboxStatus,
  seedMailbox,
  type MailboxCounts,
} from "./mailbox-fixture.js";
import { drizzle, LOOPBACK, startPostgres, type Sql } from "./mailbox-postgres.js";

const readableGroups = new Set([
  "account",
  "approvals",
  "auth",
  "away-responder",
  "consent",
  "contacts",
  "drafts",
  "events",
  "health",
  "hello",
  "mailboxes",
  "messages",
  "notify",
  "organizer-requests",
  "proposals",
  "rules",
  "screener",
  "search",
  "snippets",
  "sync",
  "tags",
  "threads",
  "trash",
  "triage",
  "workflows",
]);
const writableGroups = new Set(["drafts", "messages", "sends", "tags", "threads", "trash", "triage"]);
const mailRoutes = selfHostRoutes.filter(({ method, pattern, cost }) => {
  if (method === "POST" && pattern === "/auth/refresh") return true;
  const group = pattern.split("/")[1]!;
  if (method === "GET") {
    if (pattern === "/attachments/:id/meta" || pattern === "/files" || pattern === "/events") return true;
    return (
      cost !== "connection" &&
      cost !== "paid" &&
      readableGroups.has(group) &&
      (group !== "auth" || pattern === "/auth/session") &&
      pattern !== "/screener/junk/body"
    );
  }
  return writableGroups.has(group) && pattern !== "/messages/:id/draft";
});
const app = createApp([
  ...mailRoutes,
  ...calendarRoutes.filter(
    ({ method, cost, pattern }) =>
      (method === "GET" && cost === "read") || (method === "PATCH" && pattern === "/calendar/settings"),
  ),
]);

const exactCategories = new Map([
  ["/auth/session", "session"],
  ["/auth/refresh", "sessionRefresh"],
  ["/calendar/settings", "calendarSettings"],
  ["/calendar/sync", "calendarSync"],
  ["/calendar/sync/snapshot", "calendarSnapshot"],
  ["/sync", "mailSync"],
  ["/sync/snapshot", "mailSnapshot"],
  ["/consent", "consent"],
  ["/mailboxes", "mailboxes"],
  ["/events", "events"],
  ["/account/access", "accountAccess"],
  ["/account/ai", "accountAi"],
  ["/account/screening", "screening"],
  ["/screener/waiting/count", "screenerWaitingCount"],
  ["/screener/unscreened/count", "screenerUnscreenedCount"],
  ["/screener/held-releases", "screenerHeldReleases"],
  ["/away-responder", "awayResponder"],
  ["/notify-rules", "notifyRules"],
  ["/organizer-requests", "organizerRequests"],
  ["/local/window/outbox", "windowOutbox"],
]);
const familyCategories = new Set([
  "account",
  "calendar",
  "drafts",
  "files",
  "health",
  "hello",
  "messages",
  "rules",
  "screener",
  "search",
  "threads",
  "triage",
  "workflows",
]);

function requestCategory({ pathname, searchParams }: URL): string {
  if (pathname === "/messages/bodies")
    return searchParams.has("ids") ? "messageBodiesById" : "messageBodiesWindow";
  if (/^\/messages\/[^/]+\/body$/.test(pathname)) return "messageBody";
  const exact = exactCategories.get(pathname);
  if (exact) return exact;
  const family = pathname.split("/", 3)[1] ?? "";
  return familyCategories.has(family) ? family : "other";
}

interface RequestCounts {
  requests: number;
  failures: number;
  queries: number;
}

function loopbackOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" &&
      raw === url.origin &&
      (url.hostname === LOOPBACK || url.hostname === "localhost")
      ? raw
      : null;
  } catch {
    return null;
  }
}

async function stateDirectory(root: string, path: string) {
  const parent = await realpath(dirname(path));
  const inside = relative(root, parent);
  if (inside === ".." || inside.startsWith("../") || inside.startsWith("/")) {
    throw new Error("state must be under the output directory");
  }
  const directory = join(parent, basename(path));
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      state: { type: "string" },
      rows: { type: "string" },
      "pg-bin": { type: "string" },
      template: { type: "string" },
      "prepare-only": { type: "boolean" },
      "events-mode": { type: "string" },
      "roster-witness": { type: "boolean" },
    },
  });
  const rows = Number(values.rows);
  if (!values.output || !values.state || !MAILBOX_SIZES.some((size) => size === rows)) {
    throw new Error("specify --output <root> --state <new directory> and --rows <supported size>");
  }
  const root = await realpath(values.output);
  const state = await stateDirectory(root, values.state);
  const template = values.template ? await realpath(values.template) : undefined;
  if (template && !template.startsWith(root + "/"))
    throw new Error("template must be under the output directory");
  if (template) {
    const prepared = JSON.parse(await readFile(join(template, "template-ready.json"), "utf8")) as {
      rowCount: number;
    };
    if (prepared.rowCount !== rows) throw new Error("template tier does not match --rows");
  }
  // An explicitly selected local-only witness uses the standalone managed cadence.
  const eventsMode = values["events-mode"] ?? "polling";
  if (!["polling", "held", "held-poll-only"].includes(eventsMode))
    throw new Error("Unknown fixture event mode");
  const shutdown = new AbortController();
  let stop = async () => {
    shutdown.abort();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  const pg = await startPostgres(
    root,
    state,
    values["pg-bin"] ?? "/usr/lib/postgresql/16/bin",
    template,
    shutdown.signal,
  );
  const fixtureSse = {
    ...DEFAULT_SSE,
    enabled: eventsMode !== "polling",
    pollMs: 8_000,
    lifetimeMs: 270_000,
  };
  const changeWake = eventsMode === "held" ? makeChangeWakeHub(pg.url.toString()) : null;
  const work = pg.connect();
  const sample = new AsyncLocalStorage<{ queries: number; counts: RequestCounts }>();
  const categories = new Map<string, RequestCounts>();
  let totalQueries = 0;
  let attributedQueries = 0;
  let totalRequests = 0;
  let submitted = 0;
  const owned = makeOwnedDb(pg.url.toString(), { role: "api" });
  const client = (owned.db as typeof owned.db & { $client: Sql }).$client;
  client.options.debug = () => {
    totalQueries++;
    const current = sample.getStore();
    if (current) {
      current.queries++;
      current.counts.queries++;
      attributedQueries++;
    }
  };
  let server: ReturnType<typeof makeHttpServer> | undefined;
  let stopping: Promise<void> | undefined;
  stop = () =>
    (stopping ??= (async () => {
      shutdown.abort();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((done) => server!.close(() => done()));
      }
      await Promise.allSettled([owned.close(), changeWake?.end(), work.end({ timeout: 2 })]);
      pg.stop();
    })());

  let stage = "migration";
  try {
    if (!template) {
      await runMigrations(pg.url.toString());
      const fixtureDb = drizzle(work);
      await ensureSearchExtensions(fixtureDb, { concurrently: false });
      await ensureWordIndex(fixtureDb, { concurrently: false });
      await ensureHotPathIndexes(fixtureDb, { concurrently: false });
    }
    stage = "seed";
    if (!template) await seedMailbox(work, rows);
    let initial = await mailboxStatus(work);
    if (initial.rowCount !== rows) throw new Error("unexpected baseline row count");
    const expected = expectedAttachmentCounts(rows);
    const metadataMatches = () =>
      initial.attachmentCount === expected.attachmentCount &&
      initial.attachmentFlags === expected.attachmentCount &&
      initial.messagesWithAttachments === expected.messagesWithAttachments;
    if (template && !metadataMatches()) {
      stage = "attachment metadata";
      await ensureAttachmentMetadata(work);
      initial = await mailboxStatus(work);
    }
    if (!metadataMatches()) throw new Error("unexpected attachment metadata count");
    if (values["prepare-only"]) {
      await stop();
      await writeFile(join(state, "template-ready.json"), JSON.stringify({ rowCount: rows, ...expected }), {
        flag: "wx",
        mode: 0o600,
      });
      return;
    }
    stage = "listen";
    const auth = makeTestAuthDeps({ accessTtlMs: 24 * 60 * 60 * 1_000 });
    const identity = await createFixtureSession(work, auth.config);
    const outbox = createWindowOutbox({
      dataDir: state,
      owner: { address: identity.email, base: `http://${LOOPBACK}` },
      scope: () => identity.mailboxId,
      authorized: async (req) => req.headers.get("authorization") === `Bearer ${identity.sessionToken}`,
      calendar: true,
      log: () => {},
    });
    const { db } = owned;
    const mailbox = makeMailboxService({
      keyProvider: auth.keyProvider,
      allowance: async () => {},
      signatureChecks: false,
    });
    const rosterWitness = Object.create(mailbox) as typeof mailbox;
    rosterWitness.list = (ctx, opts) =>
      ctx.db.transaction((tx) => mailbox.list({ ...ctx, db: tx as unknown as typeof ctx.db }, opts), {
        accessMode: "read only",
      });
    const services: ApiServices = {
      auth: makeAuthService(auth),
      mailbox,
      message: messageService,
      thread: threadService,
      search: searchService,
      triage: triageService,
      tags: tagsService,
      drafts: draftsService,
      schedules: scheduleService,
      sends: sendService,
      attachments: attachmentsService,
      contacts: contactsService,
      snippets: snippetsService,
      notify: notifyRulesService,
      away: awayResponderService,
      workflows: workflowsService,
      proposals: proposalsService,
      rules: rulesService,
      screener: makeScreenerService({}),
      approval: makeApprovalService({}),
      calendar: calendarFeed,
      entitlementsPort: UNMETERED,
      storageCapOf: async () => UNMETERED_STORAGE_CAP,
      // The real send service persists the draft and receipt. The SMTP hop is a local sink.
      sendAdapter: async () => ({
        async send(message) {
          submitted++;
          return { providerMessageId: message.messageId! };
        },
        async messageInSent() {
          return false;
        },
        async close() {},
      }),
    };
    let cachedCounts: MailboxCounts | undefined = initial;
    const currentStatus = async () => {
      const status = await mailboxStatus(work, cachedCounts);
      cachedCounts = status;
      return status;
    };
    const handle = async (incoming: Request): Promise<Response> => {
      const url = new URL(incoming.url);
      url.pathname = normalizePathname(url.pathname);
      const req = url.href === incoming.url ? incoming : new Request(url, incoming);
      if (url.pathname.startsWith("/__perf/")) {
        if (req.headers.get("authorization") !== `Bearer ${identity.sessionToken}`) {
          return new Response(null, { status: 401 });
        }
        if (req.method === "GET" && url.pathname === "/__perf/stats") {
          return Response.json({
            totalQueries,
            attributedQueries,
            totalRequests,
            submitted,
            queryCategories: Object.fromEntries(categories),
            cpuMicroseconds: process.cpuUsage(),
            rssBytes: process.memoryUsage.rss(),
          });
        }
        if (req.method === "GET" && url.pathname === "/__perf/status")
          return Response.json(await currentStatus());
        if (req.method === "POST" && url.pathname === "/__perf/age") {
          const body = await req.json().catch(() => null);
          const lastSyncAt = new Date(String(body?.lastSyncAt ?? ""));
          if (!Number.isFinite(lastSyncAt.getTime()) || lastSyncAt.getTime() > Date.now()) {
            return new Response(null, { status: 400 });
          }
          await ageMailbox(work, lastSyncAt);
          return Response.json(await currentStatus());
        }
        if (req.method === "POST" && url.pathname === "/__perf/arrive") {
          const body = await req.json().catch(() => null);
          if (![1, 500, 5000].includes(body?.count)) return new Response(null, { status: 400 });
          const before = cachedCounts ?? (await currentStatus());
          const added = await arrive(work, body.count);
          cachedCounts = {
            rowCount: before.rowCount + added.rowCount,
            attachmentCount: before.attachmentCount + added.attachmentCount,
            attachmentFlags: before.attachmentFlags + added.attachmentFlags,
            messagesWithAttachments: before.messagesWithAttachments + added.messagesWithAttachments,
          };
          return Response.json(await currentStatus());
        }
        return new Response(null, { status: 404 });
      }

      const category = requestCategory(url);
      let counts = categories.get(category);
      if (!counts) {
        counts = { requests: 0, failures: 0, queries: 0 };
        categories.set(category, counts);
      }
      totalRequests++;
      counts.requests++;
      if (url.pathname === WINDOW_OUTBOX_ROUTE) {
        const response = await outbox.handle(req);
        response.headers.set("x-perf-sql-queries", "0");
        if (!response.ok) counts.failures++;
        return response;
      }

      const origin = loopbackOrigin(req.headers.get("origin"));
      // This opt-in witness changes only the transaction used by the existing list service.
      const grouped =
        values["roster-witness"] &&
        req.method === "GET" &&
        url.pathname === "/mailboxes" &&
        !url.search &&
        req.headers.get("x-perf-roster-transaction") === "grouped";
      const deps: ApiDeps = {
        db: bindDb(db, { account: null }),
        now: () => new Date(),
        requestId: "",
        session: null,
        authConfig: origin ? { ...auth.config, origin, rpID: new URL(origin).hostname } : auth.config,
        keyProvider: auth.keyProvider,
        services: grouped ? { ...services, mailbox: rosterWitness } : services,
        sse: fixtureSse,
        ...(changeWake ? { changeWake } : {}),
        hello: {
          flavor: "self-host",
          needsSetup: false,
          auth: { password: true, totp: true, webauthn: false, publicSignup: false },
          features: {
            sse: fixtureSse.enabled,
            staging: false,
            ai: false,
            pairing: false,
            remoteImages: false,
            scheduleFiles: false,
            calendar: true,
          },
        },
      };
      const request = { queries: 0, counts };
      return sample.run(request, async () => {
        const response = await app.handle(req, deps);
        if (!response.ok) request.counts.failures++;
        // Marking read, filing and trashing keep the physical rows. Sending can project a new sent copy.
        if (response.ok && req.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(url.pathname)) {
          cachedCounts = undefined;
        }
        const headers = new Headers(response.headers);
        headers.set("x-perf-sql-queries", String(request.queries));
        return new Response(response.body, { status: response.status, headers });
      });
    };
    server = makeHttpServer(
      async (incoming) => {
        try {
          return await handle(incoming);
        } catch (error) {
          const details = error as { name?: string; code?: string; stack?: string };
          const frame = details.stack?.split("\n")[1]?.trim().split("/").at(-1);
          console.error("Mailbox fixture request failed", details.name, details.code ?? "", frame ?? "");
          return Response.json({ error: "fixture_request_failed" }, { status: 500 });
        }
      },
      {
        bodyMaxBytes: 1024 * 1024,
        headersTimeoutMs: 10_000,
        requestTimeoutMs: 30_000,
        eventStreamShutdown: shutdown.signal,
      },
    );
    server.listen(0, LOOPBACK);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture API did not bind");
    const { databaseSocket, databasePort, databaseUser, databaseName, databaseVersion, postgresPid } = pg;
    const database = {
      databaseSocket,
      databasePort,
      databaseUser,
      databaseName,
      databaseVersion,
      postgresPid,
    };
    const csrfToken = csrfTokenFor(identity.sessionToken);
    const cookies = sessionCookies(
      {
        accessToken: identity.sessionToken,
        refreshToken: identity.refreshToken,
        tokenType: "Bearer",
        expiresIn: auth.config.accessTtlMs / 1_000,
      },
      csrfToken,
      auth.config,
      identity.accountId,
      identity.familyId,
    );
    const resumeMarker = cookies
      .find((cookie) => cookie.startsWith("tf_resume="))
      ?.split(";")[0]
      ?.slice("tf_resume=".length);
    if (!resumeMarker) throw new Error("browser resume marker is missing");
    await writeFile(
      join(state, "mailbox-sql-ready.json"),
      JSON.stringify({
        ...database,
        ...initial,
        accountId: identity.accountId,
        mailboxId: identity.mailboxId,
      }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(state, "mailbox-ready.json"),
      JSON.stringify({
        ...identity,
        ...initial,
        initialCursor: initial.cursor,
        csrfToken,
        resumeMarker,
        eventsMode,
        baseUrl: `http://${LOOPBACK}:${address.port}`,
        apiPid: process.pid,
        ...database,
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    console.error("Mailbox fixture stage", stage);
    await stop();
    throw error;
  }
}

void main().catch((error: unknown) => {
  const details = error as { name?: string; code?: string; cause?: { code?: string } };
  console.error("Mailbox fixture startup failed", details.name, details.code ?? details.cause?.code ?? "");
  process.exitCode = 1;
});
