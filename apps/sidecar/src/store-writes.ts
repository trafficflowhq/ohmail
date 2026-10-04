/**
 * HOW MANY WRITES THE DEVICE STORE HAS COMMITTED — the gauge that lowers the store's sentence
 * (`DeadLetterLedger.storeFaultSince`). A statement counts when it changes data and has committed:
 * on its own outside a transaction, or by its transaction's COMMIT. Classified by the statement's
 * first keyword, never by its values; a read counts nothing, so a full disk that still reads keeps
 * the sentence up.
 */
export type StatementKind = "write" | "begin" | "commit" | "rollback" | "other";

const WRITE = /^(insert|update|delete|replace|upsert|create|drop|alter|truncate)\b/;

/** The kind of ONE statement, by its first keyword (leading whitespace and comments skipped). */
export function statementKind(sql: string): StatementKind {
  const head = sql.replace(/^(\s+|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "").slice(0, 200).toLowerCase();
  if (WRITE.test(head)) return "write";
  if (/^with\b/.test(head)) return /\b(insert|update|delete)\b/.test(sql.toLowerCase()) ? "write" : "other";
  if (/^(begin|start\s+transaction)\b/.test(head)) return "begin";
  if (/^(commit|end)\b/.test(head)) return "commit";
  if (/^rollback\b/.test(head) && !/^rollback\s+(transaction\s+)?to\b/.test(head)) return "rollback";
  return "other";
}

/** A text that may hold several statements (`exec`): does any of them write? */
export const anyWrite = (text: string): boolean => text.split(";").some((s) => statementKind(s) === "write");

/** The counter one store keeps, fed by its statement door's SUCCESS path only. */
export function storeWriteGauge(): {
  /** Writes committed so far. */
  count(): number;
  /** One statement on the connection answered without a throw. */
  statementOk(sql: string): void;
  /** One transaction committed, and whether it wrote. */
  committed(wrote: boolean): void;
} {
  let writes = 0;
  let inTx = false;
  let txWrote = false;
  return {
    count: () => writes,
    statementOk(sql) {
      const kind = statementKind(sql);
      if (kind === "begin") { inTx = true; txWrote = false; }
      else if (kind === "commit") { if (inTx && txWrote) writes++; inTx = false; txWrote = false; }
      else if (kind === "rollback") { inTx = false; txWrote = false; }
      else if (kind === "write") { if (inTx) txWrote = true; else writes++; }
    },
    committed(wrote) { if (wrote) writes++; },
  };
}
