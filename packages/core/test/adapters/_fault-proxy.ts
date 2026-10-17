import net from "node:net";
import type { ImapFlow } from "imapflow";

/**
 * A TCP relay in front of a real IMAP server that fails the EXPUNGE and passes everything else.
 *
 * `fault` is read at each EXPUNGE, so a test changes it between cycles: `no` answers a tagged NO
 * without forwarding, `drop` closes both sockets without forwarding, `drop-after` forwards and
 * closes before the server's answer reaches the client (the server expunged, the client cannot
 * know). `hide` strips capabilities from every list, so a server with MOVE can be made to take
 * the COPY + EXPUNGE path. Both directions are parsed literal-aware; bytes are otherwise verbatim.
 */
export type ExpungeFault = "pass" | "no" | "drop" | "drop-after";

export interface FaultProxy {
  readonly port: number;
  fault: ExpungeFault;
  /** Only an EXPUNGE issued while this mailbox is selected is faulted; null faults every one. */
  onlyMailbox: string | null;
  /** Commands seen, by name, with the mailbox selected when each was sent. */
  readonly log: ReadonlyArray<{ command: string; mailbox: string | null; faulted: boolean }>;
  count(command: string, mailbox?: string): number;
  close(): Promise<void>;
}

export interface Copy { folder: string; uid: number; deleted: boolean }

/** Every copy of a Message-ID in every folder, read on a connection that does not go through the proxy. */
export async function copiesOf(c: ImapFlow, messageId: string): Promise<Copy[]> {
  const out: Copy[] = [];
  for (const box of await c.list()) {
    if (box.flags.has("\\Noselect")) continue;
    const lock = await c.getMailboxLock(box.path);
    try {
      const uids = await c.search({ header: { "message-id": messageId } }, { uid: true });
      if (!Array.isArray(uids) || uids.length === 0) continue;
      for await (const m of c.fetch(uids.join(","), { uid: true, flags: true }, { uid: true })) {
        out.push({ folder: box.path, uid: m.uid, deleted: m.flags?.has("\\Deleted") ?? false });
      }
    } finally { lock.release(); }
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder) || a.uid - b.uid);
}

interface Framer { buf: Buffer; literal: number; continuing: boolean }

/** Split a stream into lines, passing literal payloads through untouched. */
function frame(
  st: Framer, chunk: Buffer, emit: (b: Buffer) => void,
  onLine: (text: string, atStart: boolean, raw: Buffer) => Buffer | null | "halt",
): void {
  st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk;
  while (st.buf.length) {
    if (st.literal > 0) {
      const n = Math.min(st.literal, st.buf.length);
      emit(st.buf.subarray(0, n));
      st.buf = st.buf.subarray(n);
      st.literal -= n;
      continue;
    }
    const nl = st.buf.indexOf("\r\n");
    if (nl < 0) return;
    const raw = st.buf.subarray(0, nl + 2);
    st.buf = st.buf.subarray(nl + 2);
    const text = raw.toString("latin1").slice(0, -2);
    const lit = /\{(\d+)\+?\}$/.exec(text);
    const atStart = !st.continuing;
    st.continuing = lit !== null;
    if (lit) st.literal = Number(lit[1]);
    const out = onLine(text, atStart, raw);
    if (out === "halt") { st.buf = Buffer.alloc(0); return; }
    if (out) emit(out);
  }
}

function unquote(word: string): string {
  return word.startsWith("\"") && word.endsWith("\"") ? word.slice(1, -1).replace(/\\(.)/g, "$1") : word;
}

export async function startFaultProxy(
  target: { host: string; port: number },
  opts: { hide?: readonly string[]; fault?: ExpungeFault; onlyMailbox?: string | null } = {},
): Promise<FaultProxy> {
  const hide = (opts.hide ?? []).map((c) => c.toUpperCase());
  const log: Array<{ command: string; mailbox: string | null; faulted: boolean }> = [];
  const sockets = new Set<net.Socket>();
  const state = { fault: opts.fault ?? "pass" as ExpungeFault, onlyMailbox: opts.onlyMailbox ?? null };

  const stripCaps = (text: string): string => {
    if (!/CAPABILITY/i.test(text)) return text;
    let out = text;
    for (const cap of hide) out = out.replace(new RegExp(` ${cap}(?=[ \\]]|$)`, "gi"), "");
    return out;
  };

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client); sockets.add(upstream);
    let selected: string | null = null;
    let pendingSelect: { tag: string; mailbox: string } | null = null;
    let swallowTag: string | null = null; // drop-after: the tag whose answer must never arrive
    const kill = (): void => { client.destroy(); upstream.destroy(); };
    const cs: Framer = { buf: Buffer.alloc(0), literal: 0, continuing: false };
    const ss: Framer = { buf: Buffer.alloc(0), literal: 0, continuing: false };

    client.on("data", (chunk: Buffer) => frame(cs, chunk, (b) => upstream.write(b), (text, atStart, raw) => {
      if (!atStart) return raw;
      const m = /^(\S+) (UID )?([A-Za-z]+)(?: (.*))?$/.exec(text);
      if (!m) return raw;
      const tag = m[1]!;
      const command = `${m[2] ? "UID " : ""}${m[3]!.toUpperCase()}`;
      if (command === "SELECT" || command === "EXAMINE") {
        pendingSelect = { tag, mailbox: unquote((m[4] ?? "").split(" (")[0]!) };
      }
      const isExpunge = command === "EXPUNGE" || command === "UID EXPUNGE";
      const faulted = isExpunge && state.fault !== "pass"
        && (state.onlyMailbox === null || state.onlyMailbox === selected);
      log.push({ command, mailbox: selected, faulted });
      if (!faulted) return raw;
      if (state.fault === "no") {
        client.write(`${tag} NO [SERVERBUG] expunge refused by the fault proxy\r\n`);
        return null;
      }
      if (state.fault === "drop") { kill(); return "halt"; }
      swallowTag = tag;
      return raw;
    }));

    upstream.on("data", (chunk: Buffer) => frame(ss, chunk, (b) => client.write(b), (text, atStart, raw) => {
      if (!atStart) return raw;
      if (swallowTag !== null && text.startsWith(`${swallowTag} `)) { kill(); return "halt"; }
      if (pendingSelect && text.startsWith(`${pendingSelect.tag} `)) {
        selected = /^\S+ OK/i.test(text) ? pendingSelect.mailbox : null;
        pendingSelect = null;
      }
      const out = stripCaps(text);
      return out === text ? raw : Buffer.from(`${out}\r\n`, "latin1");
    }));

    for (const s of [client, upstream]) {
      s.on("close", kill);
      s.on("error", kill);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    get fault() { return state.fault; },
    set fault(f: ExpungeFault) { state.fault = f; },
    get onlyMailbox() { return state.onlyMailbox; },
    set onlyMailbox(m: string | null) { state.onlyMailbox = m; },
    log,
    count(command, mailbox) {
      return log.filter((e) => e.command === command && (mailbox === undefined || e.mailbox === mailbox)).length;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
