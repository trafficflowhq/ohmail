import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { LOOPBACK, type Registered } from "./seam.js";
import { Authenticator } from "./totp.js";

/**
 * THE STACK'S FAR END: what a journey on the self-hosted stack starts from, made through the install's own
 * doors and nothing else. An invite the install's first account made (boot-smoke's handover), redeemed, an account registered on
 * it, its authenticator enrolled; a session signed in at the API. Never the stack's database.
 *
 * Every account is a registration, and the server allows a bounded number from one address in a window, so the
 * invites are a pool: one per account, taken in order across every journeys file of the run (files run one after
 * the other; what was taken is counted in a file beside the handover), and the pool's end is a red, never a 429.
 */
export interface Handover {
  origin: string;
  invites: string[];
  mail: { smtp: string; domain: string; imapHost: string; imapPort: number };
  compose: string[];
  envFile: string;
  commit: string;
}

/** The handover as selfhost-smoke.sh leaves it, or refused: a stack anywhere but this machine's loopback is never a bench's. */
export function readHandover(file: string | undefined): Handover {
  if (!file) throw new Error("TF_JOURNEYS=stack needs TF_JOURNEYS_STACK: the handover selfhost-smoke.sh --journeys writes");
  const h = JSON.parse(readFileSync(file, "utf8")) as Partial<Handover>;
  const host = (() => { try { return new URL(h.origin ?? "").hostname; } catch { return ""; } })();
  if (!LOOPBACK.has(host)) throw new Error(`the stack's origin must be this machine's loopback, not ${JSON.stringify(h.origin)}`);
  if (!Array.isArray(h.invites) || h.invites.length === 0) throw new Error("the handover holds no invites");
  if (!Array.isArray(h.compose) || h.compose.length === 0) throw new Error("the handover names no compose argv");
  if (!/^[0-9a-f]{40}$/.test(h.commit ?? "")) throw new Error("the handover names no commit");
  return h as Handover;
}

/** A cookie as the server set it. */
export interface Baked { name: string; value: string; path: string; httpOnly: boolean; sameSite: "Strict" | "Lax" | "None"; secure: boolean }

export function baked(setCookie: string[]): Baked[] {
  return setCookie.map((line) => {
    const [pair = "", ...attrs] = line.split(";").map((p) => p.trim());
    const at = pair.indexOf("=");
    const attr = (name: string): string | undefined => attrs.find((a) => a.toLowerCase().startsWith(name))?.split("=")[1];
    const same = (attr("samesite") ?? "Lax").toLowerCase();
    return {
      name: pair.slice(0, at), value: pair.slice(at + 1), path: attr("path") ?? "/",
      httpOnly: attrs.some((a) => a.toLowerCase() === "httponly"), secure: attrs.some((a) => a.toLowerCase() === "secure"),
      sameSite: same === "strict" ? "Strict" : same === "none" ? "None" : "Lax",
    };
  });
}

/** A signed-in session at the far end: its cookies, by name. */
export interface Session { cookies: Baked[]; userId: string; accountId: string; email: string }

export class FarEnd {
  constructor(readonly h: Handover, private readonly taken: string) {}

  /** How many invites this run has taken, every file of it. */
  used(): number {
    return existsSync(this.taken) ? readFileSync(this.taken, "utf8").split("\n").filter(Boolean).length : 0;
  }

  /** The next invite of the pool; the pool's end refuses, before the server would. */
  takeInvite(): string {
    const n = this.used();
    if (n >= this.h.invites.length) throw new Error(`the stack's ${this.h.invites.length} invites are spent: its standing list makes more accounts than the registration window allows`);
    appendFileSync(this.taken, `${n}\n`, { mode: 0o600 });
    return this.h.invites[n]!;
  }

  private async write(path: string, body: unknown, jar?: Baked[], method: "POST" | "PATCH" = "POST"): Promise<Response> {
    const csrf = jar?.find((c) => c.name === "tf_csrf")?.value;
    return fetch(`${this.h.origin}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(jar ? { cookie: cookieHeader(jar) } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify(body),
    });
  }

  private async must(res: Response, status: number, what: string): Promise<Response> {
    if (res.status !== status) throw new Error(`${what}: the stack answered ${res.status}, not ${status}`);
    return res;
  }

  /** An invented person registered on an invite, their authenticator enrolled; signed in nowhere. */
  async register(): Promise<Registered & { auth: Authenticator; displayName: string }> {
    const email = `journeys-${randomUUID().slice(0, 8)}@selfhost.example`;
    const password = minted("journeys");
    const displayName = "Ada Journey";
    const redeemed = await this.must(await this.write("/pair/redeem", { grant: "invite", token: this.takeInvite(), email }), 200, "the invite's redeem");
    const { invite } = await redeemed.json() as { invite: { code: string } };
    const reg = await this.must(await this.write("/auth/register", { email, password, displayName, inviteCode: invite.code }), 201, "the registration");
    const enrolling = baked(reg.headers.getSetCookie());
    const enroll = await this.must(await this.write("/auth/2fa/totp/enroll", {}, enrolling), 200, "the authenticator's enrollment");
    const { secret } = await enroll.json() as { secret: string };
    const auth = new Authenticator(secret);
    await this.must(await this.write("/auth/2fa/totp/activate", { code: await auth.code() }, enrolling), 200, "the authenticator's activation");
    return { email, password, displayName, auth, code: () => auth.code() };
  }

  /** The person signs in at the API: the password, then the authenticator's code. */
  async signIn(r: Registered): Promise<Session> {
    const login = await this.must(await this.write("/auth/login", { email: r.email, password: r.password }), 200, "the sign-in");
    const { loginToken } = await login.json() as { loginToken: string };
    const verify = await this.must(await this.write("/auth/2fa/totp/verify", { loginToken, code: await r.code() }), 200, "the second factor");
    const cookies = baked(verify.headers.getSetCookie());
    const who = await this.session(cookies);
    if (!who) throw new Error("the stack signed the person in, and its session names nobody");
    return { cookies, ...who };
  }

  /**
   * An account ready to use Mail. Connect on GreenMail, agree to organizing and record that setup was left,
   * through the same doors as first run. GreenMail runs without authentication.
   */
  async setUpMailbox(session: Session): Promise<string> {
    const address = `journeys-${randomUUID().slice(0, 8)}@${this.h.mail.domain}`;
    const imap = { host: this.h.mail.imapHost, port: this.h.mail.imapPort, secure: false, allowInsecure: true, user: address, pass: address };
    const made = await this.must(await this.write("/api/mailboxes", { provider: "imap", address, imap }, session.cookies), 201, "the mailbox's connection");
    const { id } = await made.json() as { id: string };
    await this.must(await this.write(`/api/mailboxes/${id}/organize`, { intent: "join" }, session.cookies), 202, "the mailbox's organize consent");
    await this.must(await this.write("/api/consent/settings", { onboardingCompleted: true }, session.cookies, "PATCH"), 200, "leaving first-run setup");
    return address;
  }

  /** A letter from an invented sender to `to`, through the compose's mail server, as the outside world sends one. */
  async deliver(to: string, letter: Letter): Promise<void> {
    await smtpDeliver(this.h.mail.smtp, to, letter);
  }

  /** Wait until the organizer has brought a letter of that subject in and /sync names it; its message ids. */
  async arrived(cookies: Baked[], subject: string, ms = 120_000): Promise<string[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      const asked = await this.ask(cookies, "GET", "/sync?types=message&limit=500");
      if (asked.status !== 200) throw new Error(`GET /sync: the stack answered ${asked.status}`);
      const ids = arrivedIn(asked.body, subject);
      if (ids.length > 0) return ids;
      if (Date.now() > deadline) throw new Error(`the letter ${JSON.stringify(subject)} never arrived in /sync within ${ms / 1000} s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Who the session is, at the install's own door; null when it names nobody. */
  async session(cookies: Baked[]): Promise<{ userId: string; accountId: string; email: string } | null> {
    const res = await fetch(`${this.h.origin}/auth/session`, { headers: { cookie: cookieHeader(cookies) } });
    if (res.status !== 200) return null;
    const { user } = await res.json() as { user?: { userId: string; accountId: string; email: string } };
    return user ? { userId: user.userId, accountId: user.accountId, email: user.email } : null;
  }

  /** One request to the API as the person's own browser makes it. */
  async ask(cookies: Baked[], method: string, path: string): Promise<{ status: number; body: unknown }> {
    const csrf = cookies.find((c) => c.name === "tf_csrf")?.value ?? "";
    const res = await fetch(`${this.h.origin}/api${path}`, { method, headers: { cookie: cookieHeader(cookies), "x-csrf-token": csrf, origin: this.h.origin } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
}

/** A letter as the far end sends it: an invented sender, a subject, words. */
export interface Letter { from: { name: string; address: string }; subject: string; text: string }

/**
 * One letter handed to a mail server over SMTP, as another person's server hands it over: greeting, EHLO, the
 * envelope, the message, QUIT. Every reply is read whole (a multi-line reply ends at `<code> `) and any but the one
 * expected refuses, naming the step.
 */
export async function smtpDeliver(hostPort: string, to: string, letter: Letter, now: Date = new Date()): Promise<void> {
  // The port follows the last colon: an IPv6 loopback is written in brackets, `[::1]:3026`.
  const cut = hostPort.lastIndexOf(":");
  const host = cut > 0 ? hostPort.slice(0, cut) : "";
  const port = Number(hostPort.slice(cut + 1));
  if (host === "" || !Number.isInteger(port) || port <= 0) throw new Error(`the mail server's SMTP door must be host:port, not ${JSON.stringify(hostPort)}`);
  // Only the throwaway stack's own mail server, published on this machine: never a real one.
  if (!LOOPBACK.has(host)) throw new Error(`the far end sends only to a mail server on this machine's loopback, not ${JSON.stringify(host)}`);
  const socket = connect({ host: host.replace(/^\[(.*)\]$/, "$1"), port });
  socket.setEncoding("utf8");
  let buffer = "";
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  const failed = new Promise<never>((_, reject) => {
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("the mail server closed the connection")));
  });
  failed.catch(() => {});
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\r\n"); at >= 0; at = buffer.indexOf("\r\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const waiter = waiting.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const line = (): Promise<string> => (lines.length > 0 ? Promise.resolve(lines.shift()!) : Promise.race([new Promise<string>((r) => waiting.push(r)), failed]));
  const reply = async (code: number, step: string): Promise<void> => {
    for (;;) {
      const got = await line();
      if (got.length >= 4 && got[3] === "-") continue;
      if (!got.startsWith(`${code} `) && got !== String(code)) throw new Error(`${step}: the mail server answered ${JSON.stringify(got.slice(0, 3))}, not ${code}`);
      return;
    }
  };
  const say = (words: string): void => { socket.write(`${words}\r\n`); };
  try {
    await reply(220, "the greeting");
    say("EHLO journeys.invalid"); await reply(250, "EHLO");
    say(`MAIL FROM:<${letter.from.address}>`); await reply(250, "the sender");
    say(`RCPT TO:<${to}>`); await reply(250, "the recipient");
    say("DATA"); await reply(354, "DATA");
    const head = [
      `From: ${letter.from.name} <${letter.from.address}>`, `To: <${to}>`, `Subject: ${letter.subject}`,
      `Date: ${now.toUTCString().replace("GMT", "+0000")}`, `Message-ID: <${randomUUID()}@journeys.invalid>`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit",
    ];
    // A line that starts with a dot is doubled, or the server reads it as the message's end.
    const body = letter.text.split(/\r?\n/).map((l) => (l.startsWith(".") ? `.${l}` : l));
    socket.write(`${[...head, "", ...body].join("\r\n")}\r\n.\r\n`);
    await reply(250, "the message");
    say("QUIT"); await reply(221, "QUIT");
  } finally {
    socket.destroy();
  }
}

/** The ids of the messages whose subject is `subject` among a /sync answer's created records. */
export function arrivedIn(answer: unknown, subject: string): string[] {
  const creates = (answer as { changes?: { creates?: Array<{ type?: string; id?: string; entity?: { subject?: unknown } }> } } | null)?.changes?.creates ?? [];
  return creates.filter((c) => c.type === "message" && c.entity?.subject === subject && typeof c.id === "string").map((c) => c.id!);
}

/** A word made for this run alone, never written down anywhere. */
const minted = (prefix: string): string => `${prefix}-${randomUUID()}`;

export const cookieHeader = (jar: Baked[]): string => jar.map((c) => `${c.name}=${c.value}`).join("; ");
