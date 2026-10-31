/**
 * A file name's fragments as a reader types them, shared by `search-device-parity.test.ts` (PGlite and
 * SQLite) and its real-Postgres twin `search-document.pg.test.ts`, so every store answers one table.
 * The targets, then 61 invoices `INV-100.pdf` to `INV-160.pdf`, older, whose names share the pattern.
 * `hl` is Ines Varga's letter ("Papers for SR2"); every other letter is `Papers <key>` from Clerk <key>.
 */
export const FRAGMENT_FILES: ReadonlyArray<readonly [key: string, file: string]> = [
  ["inv", "INV-123.pdf"], ["q3", "q3-tax.pdf"], ["po", "PO-456.pdf"], ["abc", "abc-123.xlsx"], ["tq", "tax-q3.pdf"],
  ["eu", "eu-vat-2024.xlsx"], ["hl", "harbour-ledger-7731.pdf"], ["sc", "scan0042.PDF"], ["ct", "Contract_v1.docx"],
];

/**
 * The fragment, the letter answered first and how many letters 0.30.16 answered, the same on every store:
 * `INV-123` also finds the older `INV-123.pdf` invoice, `31.pd` also `INV-131.pdf`.
 */
export const FRAGMENTS: ReadonlyArray<readonly [q: string, first: string, letters: number]> = [
  ["INV-123", "inv", 2], ["inv-123", "inv", 2], ["q3-tax", "q3", 1], ["po-456", "po", 1], ["abc-123", "abc", 1],
  ["tax-q3", "tq", 1], ["eu-vat", "eu", 1], ["bour-ledg", "hl", 1], ["arbou", "hl", 1], ["led", "hl", 1],
  ["ger-77", "hl", 1], ["31.pd", "hl", 2], ["ledger-7731", "hl", 1], ["harbour-ledger", "hl", 1],
  ["harbour-ledger-7731.pdf", "hl", 1], ["can004", "sc", 1], ["inv-145", "n145", 1],
];
