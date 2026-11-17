import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { language } from "../vocabulary/catalogue.js";
import { fenced, shown, type PlaywrightPerson } from "./dom-playwright.js";
import { cookieHeader, FarEnd, readHandover, type Session } from "./far-end.js";
import type { Account, Bench, Size } from "./seam.js";

/**
 * THE SELF-HOSTED STACK (W-i). The web, the API and the organizer from the images built from this tree, behind
 * the install's own door, on Postgres and the compose's GreenMail: what an operator runs, on a plain machine.
 * `selfhost-smoke.sh --journeys` boots it, runs the first-run ceremony and hands over (`TF_JOURNEYS_STACK`).
 *
 * The bench hears nothing the API answers and faults no door: the stack is the real thing, and a journey that
 * needs either is not one of its journeys. Its world comes through the doors a person uses (`far-end.ts`).
 */
export const ELSEWHERE = "ohmail-elsewhere.test";

/** Inside the api's container: one request to its own port under a Host the journey names, every value by environment. */
const ASK_INSIDE = [
  'const http = require("node:http");',
  "const req = http.request({ host: \"127.0.0.1\", port: 8080, path: process.env.ASK_PATH, headers: { host: process.env.ASK_HOST, cookie: process.env.ASK_COOKIE } }, (res) => {",
  '  let body = ""; res.setEncoding("utf8"); res.on("data", (c) => { body += c; });',
  "  res.on(\"end\", () => { let user = false; try { user = Boolean(JSON.parse(body).user); } catch {} process.stdout.write(JSON.stringify({ status: res.statusCode, user })); });",
  "});",
  'req.on("error", (e) => { process.stderr.write(String(e)); process.exit(1); });',
  "req.end();",
].join("\n");

function run(argv: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0]!, argv.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    // The compose's own lines are not read back: a container's output is the stack's, never this log's.
    p.stderr.resume();
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, out }));
  });
}

export async function startStack(recordAs: string, size: Size): Promise<Bench> {
  const file = process.env.TF_JOURNEYS_STACK;
  const h = readHandover(file);
  const far = new FarEnd(h, `${file}.taken`);
  const origin = h.origin;
  const port = new URL(origin).port;
  const elsewhere = `http://${ELSEWHERE}${port ? `:${port}` : ""}`;
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${ELSEWHERE} 127.0.0.1`] });
  const people: PlaywrightPerson[] = [];
  const sessions = new WeakMap<Account, Session>();
  const lang = language();
  console.log(`journeys bench: W-i ${size} at ${origin} · the stack from images of ${h.commit} · ${far.used()} of ${h.invites.length} invites taken · ${lang} · ${recordAs}`);

  const jar = (a: Account): Session => {
    const s = sessions.get(a);
    if (!s) throw new Error("this account was not made by the stack's bench");
    return s;
  };

  const bench: Bench = {
    id: "stack", setting: "W-i", size, flavour: "selfhost", origin,
    heard: [],
    // A door of the real stack cannot be made to fail from here: a journey that tries is refused, never green.
    faults: Object.freeze([]) as unknown as Bench["faults"],
    held: () => [],
    release() {},
    fixtures: null,
    has: (need) => need === "pg" || need === "stack",
    async ask(a, method, path) { return far.ask(jar(a).cookies, method, path); },
    async account() {
      const session = await far.signIn(await far.register());
      await far.connectMailbox(session);
      const account: Account = {
        accountId: session.accountId, userId: session.userId, email: session.email,
        access: session.cookies.find((c) => c.name === "tf_session")?.value ?? "",
        refresh: session.cookies.find((c) => c.name === "tf_refresh")?.value ?? "",
        familyId: "",
        planter: {
          plant: async () => { throw new Error("the stack's world arrives through its mail server: the mail planter is not here yet"); },
          mailboxId: async () => { throw new Error("the stack's mailboxes are connected through its doors: not here yet"); },
        } as unknown as Account["planter"],
      };
      sessions.set(account, session);
      return account;
    },
    async person(o = {}) {
      if (o.door !== undefined) throw new Error("the stack has no demo");
      const person = await fenced(browser, { origin, base: "/", lang: "en", allow: [ELSEWHERE], size });
      if (o.account) {
        const host = o.host ?? new URL(origin).hostname;
        const foreign = host !== new URL(origin).hostname;
        const expires = Math.floor(Date.now() / 1000) + 3600;
        await person.context.addCookies(jar(o.account).cookies.map((c) => ({
          name: c.name, value: c.value, domain: host, path: c.path, httpOnly: c.httpOnly, sameSite: c.sameSite, expires,
          // Under a foreign name over plain http a Secure cookie is never sent: forced in, so the door is what refuses it.
          secure: foreign ? false : c.secure,
        })));
      }
      people.push(person);
      const want = o.lang ?? lang;
      if (want !== "en" && o.account !== undefined) await person.speak(want);
      return person;
    },
    async sessionLive(a) { return (await far.session(jar(a).cookies)) !== null; },
    stack: {
      elsewhere,
      async registered() { return far.register(); },
      invite: () => `${origin}/join/invite#${far.takeInvite()}`,
      async recreate(service) {
        const up = await run([...h.compose, "up", "-d", "--no-build", "--pull", "never", "--force-recreate", "--no-deps", service]);
        if (up.code !== 0) throw new Error(`the stack could not make a new ${service} container (exit ${up.code})`);
        const deadline = Date.now() + 180_000;
        for (;;) {
          const health = await fetch(`${origin}/health`).then(async (r) => (r.status === 200 ? await r.json() as { version?: string } : null), () => null);
          if (health?.version === h.commit) return;
          if (Date.now() > deadline) throw new Error(`the new ${service} container never answered /health with ${h.commit}`);
          await new Promise((r) => setTimeout(r, 500));
        }
      },
      async inside({ host, path, account }) {
        const cookie = cookieHeader(jar(account).cookies);
        const asked = await run([...h.compose, "exec", "-T", "-e", "ASK_COOKIE", "-e", "ASK_HOST", "-e", "ASK_PATH", "api", "node", "-e", ASK_INSIDE], {
          ASK_COOKIE: cookie, ASK_HOST: host, ASK_PATH: path,
        });
        if (asked.code !== 0) throw new Error(`the ask inside the api's container failed (exit ${asked.code})`);
        return JSON.parse(asked.out) as { status: number; user: boolean };
      },
    },
    problems: (tolerated = []) => people.flatMap((p) => p.problems(tolerated)),
    async story() {
      const pages: string[] = [];
      for (const p of people) {
        const tree = await p.page.getByRole("document").or(p.page.getByRole("main")).first().ariaSnapshot().catch((e) => String(e));
        pages.push(`${shown(p.page.url())}\n${tree}\n${p.problems().join("\n")}`);
      }
      return pages.join("\n---\n");
    },
    async closePeople() {
      for (const p of people.splice(0)) await p.context.close().catch(() => {});
    },
    async stop() {
      await browser.close().catch(() => {});
    },
  };
  return bench;
}
