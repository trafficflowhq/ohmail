import { SsrfRefusal, assertPublicHost, type HostResolver } from "./ssrf-guard.js";

/**
 * THE MANAGED DIAL POLICY, DECIDED ONCE for both doors that dial a stored mail server: the API's
 * and the organizer's. The port rule runs first, so a port that carries no mail resolves nothing;
 * then the host gate, whose refusals pass through as they are; then the bound on what is pinned.
 * Each door says the refusal in its own words. The person's own engines never compose it: they dial
 * their own network by name.
 */

/** The ports the managed policy dials. An explicit port outside the set is refused. */
export const MAIL_DIAL_PORTS: Readonly<Record<"imap" | "smtp", ReadonlySet<number>>> = {
  imap: new Set([143, 993]),
  smtp: new Set([25, 465, 587]),
};

/**
 * The most addresses one dial pins. A DNS answer is input somebody else controls and the gate
 * returns every address it cleared; each one kept was cleared, so the bound narrows and never widens.
 */
export const MAX_PINNED_ADDRESSES = 16;

/** A port that carries no mail. The port and the offered set ride as fields, for each door's sentence. */
export class MailDialRefusal extends SsrfRefusal {
  readonly port?: number;
  readonly ports?: readonly number[];
  constructor(why: string, fields: { port?: number; ports?: readonly number[] } = {}) {
    super(why);
    this.name = "MailDialRefusal";
    this.port = fields.port;
    this.ports = fields.ports;
  }
}

/**
 * The addresses a dial of `host` on `port` may use. `port` undefined is the add-time ladder, which
 * dials only mail ports. The resolver is required: a default would ship the permit branch unrun.
 */
export async function clearMailDial(
  resolver: HostResolver, host: string, port: number | undefined, transport: "imap" | "smtp",
): Promise<string[]> {
  if (port !== undefined && !MAIL_DIAL_PORTS[transport].has(port)) {
    const ports = [...MAIL_DIAL_PORTS[transport]].sort((a, b) => a - b);
    throw new MailDialRefusal("port does not carry mail", { port, ports });
  }
  return (await assertPublicHost(host, resolver)).slice(0, MAX_PINNED_ADDRESSES);
}
