import net from "node:net";
import { applyLaneGreenmail, greenmailEndpoint, readLaneGreenmail } from "../../scripts/lib/lane-greenmail-env.mjs";
import {
  TEST_SERVICES, serviceAddressOf, type ServiceName, type ServiceProbe, type ServiceVerdict,
} from "../../packages/db/src/test-services.js";

export { TEST_SERVICES, probedService, serviceAddressOf, serviceUp } from "../../packages/db/src/test-services.js";

/**
 * WHERE EACH TEST SERVICE IS, AND THE ONE PROBE OF IT. One resolver per service, the same one the
 * tests dial through, so the probe asks about the address a test would reach:
 * Postgres `PG_TEST_URL` (handed in), GreenMail `greenmailEndpoint` after this checkout's
 * `.lane-greenmail.env`, Dovecot {@link condstoreEndpoint}, RustFS {@link rustfsUrl}.
 */

/** The CONDSTORE server (Dovecot) the IMAP adapter's CONDSTORE cases dial. */
export function condstoreEndpoint(env: NodeJS.ProcessEnv): { host: string; port: number } {
  return { host: env.IMAP_CONDSTORE_HOST ?? env.IMAP_HOST ?? "127.0.0.1", port: Number(env.IMAP_CONDSTORE_PORT ?? 3144) };
}
export const CONDSTORE_HOST = condstoreEndpoint(process.env).host;
export const CONDSTORE_PORT = condstoreEndpoint(process.env).port;

/** The RustFS endpoint the live staging round trip signs against. */
export function rustfsUrl(env: NodeJS.ProcessEnv): string {
  return env.TF_RUSTFS_URL || "http://127.0.0.1:3902";
}
export const RUSTFS_URL = rustfsUrl(process.env);

export interface ServiceAddress { host: string; port: number }
export type ServiceAddresses = Record<ServiceName, ServiceAddress[]>;

const fromAddress = (a: string): ServiceAddress => {
  const i = a.lastIndexOf(":");
  return { host: a.slice(0, i).replace(/^\[(.*)\]$/, "$1"), port: Number(a.slice(i + 1)) };
};
/** `host:port`, an IPv6 host in brackets, as `serviceAddressOf` writes it. */
export const addressText = (a: ServiceAddress): string => (a.host.includes(":") ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`);

/** Every service's addresses, from `env` with this checkout's own GreenMail applied to a copy of it. */
export function serviceAddresses(env: NodeJS.ProcessEnv, root: string, pgUrl: string): ServiceAddresses {
  const lane = readLaneGreenmail(root);
  const gmEnv = { ...env };
  applyLaneGreenmail(gmEnv, lane);
  const gm = greenmailEndpoint(gmEnv, lane);
  const rustfs = rustfsUrl(env);
  return {
    pg: [fromAddress(serviceAddressOf(pgUrl, 5432))],
    greenmail: [{ host: gm.imapHost, port: gm.imapPort }, { host: gm.smtpHost, port: gm.smtpPort }],
    dovecot: [condstoreEndpoint(gmEnv)],
    rustfs: [fromAddress(serviceAddressOf(rustfs, new URL(rustfs).protocol === "https:" ? 443 : 80))],
  };
}

/** Only this machine is ever dialed: localhost, 127.0.0.0/8 and ::1. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

type Dial = (o: { host: string; port: number }) => net.Socket;

/** One TCP connect that writes nothing and closes: `""` when it was accepted, else why not. */
function knock(a: ServiceAddress, timeoutMs: number, dial: Dial): Promise<string> {
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) {
    throw new Error(`the test-service probe cannot run: ${a.port} is not a port (${a.host})`);
  }
  return new Promise((resolve) => {
    const s = dial({ host: a.host, port: a.port });
    let done = false;
    const end = (why: string) => { if (!done) { done = true; s.destroy(); resolve(why); } };
    s.setTimeout(timeoutMs, () => end(`no answer within ${timeoutMs} ms`));
    s.once("connect", () => end(""));
    s.once("error", (e: NodeJS.ErrnoException) => end(e.code ?? e.message));
  });
}

/**
 * THE PROBE: every address of every service at once, `timeoutMs` each. A service is up when any of
 * its addresses accepts. A host off this machine is never dialed and is recorded up ("not probed"),
 * and `IMAP_CONDSTORE` forces Dovecot up, as it forces `probeCondstore`. A probe that cannot run
 * throws; it is never reported as an absence.
 */
export async function probeServices(
  env: NodeJS.ProcessEnv, addresses: ServiceAddresses, timeoutMs = 5000, dial: Dial = (o) => net.connect(o),
): Promise<ServiceVerdict> {
  const out: ServiceVerdict = {};
  await Promise.all((Object.keys(TEST_SERVICES) as ServiceName[]).map(async (name) => {
    const list = addresses[name];
    const at = list.map(addressText);
    const off = list.find((a) => !isLoopback(a.host));
    if (off !== undefined) { out[name] = { at, up: true, why: `not probed: ${off.host} is not this machine` }; return; }
    if (name === "dovecot" && env.IMAP_CONDSTORE) { out[name] = { at, up: true, why: "IMAP_CONDSTORE forces it on" }; return; }
    const whys = await Promise.all(list.map((a) => knock(a, timeoutMs, dial)));
    const up = whys.some((w) => w === "");
    out[name] = { at, up, why: up ? "" : [...new Set(whys)].join(", ") } satisfies ServiceProbe;
  }));
  return out;
}

/** The stderr line for a service the probe found absent. */
export function absentLine(name: ServiceName, p: ServiceProbe): string {
  const s = TEST_SERVICES[name];
  return `[services] ${s.label} is not running at ${p.at.join(", ")} (${p.why}): the files that need it are skipped `
    + `(${s.start} starts it; ${s.require}=1 makes its absence fail)\n`;
}
