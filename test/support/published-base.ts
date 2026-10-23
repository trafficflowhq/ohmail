/**
 * THE BASE THE PUBLISHED IMAGES ARE BUILT FROM, BY DIGEST, AND THE NODE RELEASE IT CARRIES.
 *
 * Read anonymously from Docker Hub on 2026-10-23: node:22-bookworm-slim's multi-arch index (amd64
 * and arm64/v8 among its platforms), and NODE_VERSION as its amd64 and arm64 configs both state it.
 * A bump moves this constant, every published Dockerfile and every workflow's setup-node in one
 * reviewed commit; the tests that import it refuse any of the three moving alone.
 */
export const NODE_BASE = {
  image: "node:22-bookworm-slim",
  digest: "sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d",
  node: "22.23.4",
} as const;
export const NODE_BASE_REF = `${NODE_BASE.image}@${NODE_BASE.digest}`;
/** The Dockerfile frontend line 1 names: docker/dockerfile 1.27.1, the index tag `1` named on 2026-10-14. */
export const FRONTEND_REF = "docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e";

/** Each published Dockerfile and the outside sources it names, as written: its frontend, then its base. */
export const PUBLISHED_DOCKERFILES: Record<string, string[]> = {
  "apps/server/Dockerfile": [FRONTEND_REF, NODE_BASE_REF],
  "apps/webapp/Dockerfile": [FRONTEND_REF, NODE_BASE_REF],
  "apps/worker/Dockerfile": [FRONTEND_REF, NODE_BASE_REF],
  "apps/worker/Dockerfile.selfhost": [FRONTEND_REF, NODE_BASE_REF],
};

/** A file the publisher could ship as a Dockerfile: `Dockerfile`, `Dockerfile.<x>`, `<x>.Dockerfile`. */
export const isDockerfileName = (name: string): boolean =>
  !/\.dockerignore$/i.test(name) && /(?:^Dockerfile(?:\.[\w.-]+)?|\.Dockerfile)$/i.test(name);

/** A source of outside bytes: the `# syntax=` frontend, a FROM (`stage` its AS name), an image a COPY or RUN reads, an ADD of a URL. */
export type From = { image: string; stage: string | null; raw: string; kind: "syntax" | "from" | "copy" | "add" };

/**
 * A Dockerfile's sources of outside bytes as BuildKit reads them. Parser directives first: only the lines
 * at the very top, before any other comment, blank line or instruction, and `syntax=` is the frontend that
 * reads the rest. Then comment lines dropped, `\` continuations joined, keywords in any case, `--flag=value`
 * options skipped, `$VAR` resolved from the ARGs before the first FROM: a FROM; a `COPY --from=` or a
 * `RUN --mount=…from=` naming an image; an `ADD` of a URL, whose `image` is the URL.
 */
export function fromImages(text: string): From[] {
  const out: From[] = [];
  for (const raw of text.split("\n")) {
    const d = /^#\s*(syntax|escape|check)\s*=\s*(\S+)\s*$/i.exec(raw.replace(/\r$/, ""));
    if (!d) break;
    if (d[1].toLowerCase() === "syntax") out.push({ image: d[2], stage: null, raw: raw.trim(), kind: "syntax" });
  }
  const joined = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").replace(/\\\r?\n/g, " ");
  const args = new Map<string, string>();
  const sub = (w: string) => w.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => args.get(a ?? b) ?? all);
  let fromSeen = false;
  for (const line of joined.split("\n")) {
    const arg = /^\s*ARG\s+([A-Za-z_]\w*)(?:=(\S*))?\s*$/i.exec(line);
    if (arg && !fromSeen) { args.set(arg[1], (arg[2] ?? "").replace(/^["']|["']$/g, "")); continue; }
    const m = /^\s*FROM\s+(.*)$/i.exec(line);
    if (m) {
      const words = m[1].trim().split(/\s+/).filter((w) => !/^--[\w-]+=/.test(w));
      const as = words.findIndex((w) => /^as$/i.test(w));
      out.push({ image: sub(words[0] ?? ""), stage: as > 0 ? (words[as + 1] ?? null) : null, raw: line.trim(), kind: "from" });
      fromSeen = true;
      continue;
    }
    const ref = /^\s*COPY\b.*?\s--from=(\S+)/i.exec(line) ?? /^\s*RUN\b.*?\s--mount=\S*?\bfrom=([^,\s]+)/i.exec(line);
    if (ref) { out.push({ image: sub(ref[1]), stage: null, raw: line.trim(), kind: "copy" }); continue; }
    const url = /^\s*ADD\s/i.test(line) ? line.split(/\s+/).find((w) => /^(?:https?|git):\/\/|^git@/.test(sub(w))) : undefined;
    if (url) out.push({ image: sub(url), stage: null, raw: line.trim(), kind: "add" });
  }
  return out;
}

/** The sources that are outside this file, in order: `scratch`, and a stage (by name or index) declared ABOVE, left out. */
export function externalFroms(text: string): From[] {
  const seen = new Set<string>();
  const out: From[] = [];
  let stages = 0;
  for (const f of fromImages(text)) {
    const local = f.kind !== "add" && (f.image === "scratch" || seen.has(f.image.toLowerCase()) || (f.kind === "copy" && /^\d+$/.test(f.image) && Number(f.image) < stages));
    if (!local) out.push(f);
    if (f.kind === "from") { stages += 1; if (f.stage) seen.add(f.stage.toLowerCase()); }
  }
  return out;
}

/** The outside sources not pinned: an image by anything but a sha256 digest, a URL added with no `--checksum=sha256:`. */
export const unpinnedFroms = (text: string): string[] => externalFroms(text)
  .filter((f) => (f.kind === "add" ? !/\s--checksum=sha256:[0-9a-f]{64}(?:\s|$)/.test(` ${f.raw} `) : !/^[^\s$@]+@sha256:[0-9a-f]{64}$/.test(f.image)))
  .map((f) => f.raw);

/** The outside sources a Dockerfile names, as written. */
export const externalBases = (text: string): string[] => externalFroms(text).map((f) => f.image);
