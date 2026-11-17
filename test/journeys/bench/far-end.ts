import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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

  private async post(path: string, body: unknown, jar?: Baked[]): Promise<Response> {
    const csrf = jar?.find((c) => c.name === "tf_csrf")?.value;
    return fetch(`${this.h.origin}${path}`, {
      method: "POST",
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
    const redeemed = await this.must(await this.post("/pair/redeem", { grant: "invite", token: this.takeInvite(), email }), 200, "the invite's redeem");
    const { invite } = await redeemed.json() as { invite: { code: string } };
    const reg = await this.must(await this.post("/auth/register", { email, password, displayName, inviteCode: invite.code }), 201, "the registration");
    const enrolling = baked(reg.headers.getSetCookie());
    const enroll = await this.must(await this.post("/auth/2fa/totp/enroll", {}, enrolling), 200, "the authenticator's enrollment");
    const { secret } = await enroll.json() as { secret: string };
    const auth = new Authenticator(secret);
    await this.must(await this.post("/auth/2fa/totp/activate", { code: await auth.code() }, enrolling), 200, "the authenticator's activation");
    return { email, password, displayName, auth, code: () => auth.code() };
  }

  /** The person signs in at the API: the password, then the authenticator's code. */
  async signIn(r: Registered): Promise<Session> {
    const login = await this.must(await this.post("/auth/login", { email: r.email, password: r.password }), 200, "the sign-in");
    const { loginToken } = await login.json() as { loginToken: string };
    const verify = await this.must(await this.post("/auth/2fa/totp/verify", { loginToken, code: await r.code() }), 200, "the second factor");
    const cookies = baked(verify.headers.getSetCookie());
    const who = await this.session(cookies);
    if (!who) throw new Error("the stack signed the person in, and its session names nobody");
    return { cookies, ...who };
  }

  /**
   * A mailbox on the compose's GreenMail, connected through the API's door as the setup's mailbox step does. GreenMail
   * runs without authentication, so the address stands in for the password a real server would ask.
   */
  async connectMailbox(session: Session): Promise<string> {
    const address = `journeys-${randomUUID().slice(0, 8)}@${this.h.mail.domain}`;
    const imap = { host: this.h.mail.imapHost, port: this.h.mail.imapPort, secure: false, allowInsecure: true, user: address, pass: address };
    const made = await this.must(await this.post("/api/mailboxes", { provider: "imap", address, imap }, session.cookies), 201, "the mailbox's connection");
    const { id } = await made.json() as { id: string };
    return id;
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

/** A word made for this run alone, never written down anywhere. */
const minted = (prefix: string): string => `${prefix}-${randomUUID()}`;

export const cookieHeader = (jar: Baked[]): string => jar.map((c) => `${c.name}=${c.value}`).join("; ");
