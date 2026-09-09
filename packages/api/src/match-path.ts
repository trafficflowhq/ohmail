/**
 * Which spelling of a path is which route, over the minimum a caller must supply. Two callers:
 * `router.ts` against the real table, and `relay-allowlist.ts` against method+pattern pairs in
 * another process. Two implementations would be two answers to the question a refusal turns on.
 *
 * NO IMPORTS, and that is load-bearing: `router.ts` type-imports `ApiDeps`, whose module reaches
 * the IMAP adapter, and `cloud-engine-census` walks type edges too.
 */

export type RouteParams = Record<string, string>;

const segsOf = (p: string): string[] => p.split("/").filter((s) => s.length > 0);

/**
 * Percent-decode a path segment WITHOUT throwing.
 *
 * `decodeURIComponent` raises `URIError` on a malformed escape (`/messages/%ZZ/move`), and this
 * runs inside route matching — above `withErrorEnvelope` in `createApp` — so that throw used to
 * escape the pipeline entirely and surface as the host's generic 500 with a logged stack, for
 * what is plainly a 400. Hosts that can reject malformed encoding earlier do
 * (the hosted API host's `normalizePathname` answers 400); this is the floor for every other
 * host: an undecodable segment is matched VERBATIM, which simply finds no route for a
 * nonsense id and answers the 404 it deserves.
 */
function safeDecodeSegment(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Try one pattern against the path segments. Returns extracted params + a
 * per-segment specificity vector (1 = static literal, 0 = `:param`) or null if
 * the pattern does not match. The specificity vector is compared lexicographically
 * so STATIC segments win over params at the earliest differing position:
 * `/threads/merge` [1,1] beats `/threads/:id` [1,0].
 */
function tryMatch(patternSegs: string[], pathSegs: string[]): { params: RouteParams; spec: number[] } | null {
  if (patternSegs.length !== pathSegs.length) return null;
  const params: RouteParams = {};
  const spec: number[] = [];
  for (let i = 0; i < patternSegs.length; i++) {
    const ps = patternSegs[i]!;
    const val = pathSegs[i]!;
    if (ps.startsWith(":")) {
      params[ps.slice(1)] = safeDecodeSegment(val);
      spec.push(0);
    } else if (ps === val) {
      spec.push(1);
    } else {
      return null;
    }
  }
  return { params, spec };
}

/** Lexicographic compare: > 0 iff `a` is strictly more specific than `b`. */
function cmpSpec(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

export function matchSpec<T extends { method: string; pattern: string }>(
  specs: readonly T[],
  method: string,
  pathname: string,
): { matched: true; spec: T; params: RouteParams } | { matched: false; methodNotAllowed: boolean } {
  const pathSegs = segsOf(pathname);
  const wanted = method.toUpperCase();
  let pathMatched = false;
  let best: { spec: T; params: RouteParams; spec2: number[] } | null = null;

  for (const s of specs) {
    const m = tryMatch(segsOf(s.pattern), pathSegs);
    if (!m) continue;
    pathMatched = true;
    if (s.method.toUpperCase() !== wanted) continue;
    if (!best || cmpSpec(m.spec, best.spec2) > 0) best = { spec: s, params: m.params, spec2: m.spec };
  }

  if (best) return { matched: true, spec: best.spec, params: best.params };
  return { matched: false, methodNotAllowed: pathMatched };
}
