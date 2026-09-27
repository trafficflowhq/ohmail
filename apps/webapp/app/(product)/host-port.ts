/**
 * A SERVER NAME WITH A PORT AFTER IT — `mail.home.arpa:1143`, `[fd00::25]:587` — split for a connect
 * form that has one field per server. A bare name, an unbracketed IPv6 literal and a port outside
 * 1–65535 stay one host, so nothing that is not plainly `name:port` changes what is sent.
 */
export function splitHostPort(raw: string): { host: string; port?: number } {
  const value = raw.trim();
  const m = /^\[([^\]\s]+)\]:(\d{1,5})$/.exec(value) ?? /^([^:\s[\]]+):(\d{1,5})$/.exec(value);
  if (!m) return { host: value };
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 ? { host: m[1]!, port } : { host: value };
}
