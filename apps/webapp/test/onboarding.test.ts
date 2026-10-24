import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROTON, PROVIDERS, isProtonAddress, portMeansImplicitTls, presetForAddress, providerById,
} from "../app/shell/providers.js";

/**
 * Stage-2 the onboarding surface's checkable claims.
 *
 * Three of them, and each exists because the alternative failure is silent:
 *
 *  1. **Provider parity with the landing.** The landing page publicly names the providers
 *     ohmail works with. A provider offered in onboarding but absent from the landing is a
 *     claim nobody reviewed; a provider on the landing but missing from onboarding is a
 *     promise the product does not keep. Neither shows up in any other test.
 *  2. **No provider preset can be a downgrade.** Every IMAP host here is contacted with a
 *     password, so an entry with `secure: false` on 143, or an empty host on a non-manual
 *     provider, is a credential leak or a broken connection that a screenshot would not
 *     reveal.
 *  3. **The client never re-derives a refusal.** `api-client.ts` carries the server's own
 *     message through, and the UI displays it. A hard-coded copy of "mailbox limit
 *     reached" in the webapp is how a user ends up being told the wrong true-sounding
 *     thing, so it is forbidden mechanically.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

/** Every `.ts`/`.tsx` under a directory, skipping build output. */
function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walkSources(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The marketing page's provider block — the public claim these presets must match.
 *
 * Since that change that copy lives in THIS app's message file: one origin, one bundle, one
 * `messages/en.json` holding both the marketing namespaces and the product's.
 */
function landingProviders(): string[] {
  const messages = JSON.parse(read("../messages/en.json")) as {
    providers: Record<string, string>;
  };
  // `title`, `any` and `note` are prose, not providers.
  const { title: _t, any: _a, note: _n, ...named } = messages.providers;
  return Object.values(named);
}

describe("provider parity — onboarding offers exactly what the landing promises", () => {
  it("every provider named on ohmail.app is connectable, and nothing else is offered", () => {
    const landing = landingProviders().sort();
    // The generic entry is the landing's `any` line ("…and any IMAP mailbox, including
    // your own server"), so it is expected here and excluded from the named comparison.
    const offered = PROVIDERS.filter((p) => !p.manual).map((p) => p.label).sort();
    expect(offered).toEqual(landing);
  });

  it("Proton is information, never a connectable preset, and so never on the list", () => {
    // It reaches other mail apps only through Proton Bridge on the person's own computer; the
    // picker shows it as a note, and the parity above would otherwise promise it connects.
    expect(PROVIDERS.filter((p) => /proton/i.test(`${p.id} ${p.label}`))).toEqual([]);
    for (const m of ["../messages/en.json", "../messages/de.json"]) {
      const list = JSON.parse(read(m)) as { providers: Record<string, string> };
      expect(Object.values(list.providers).filter((v) => v.includes(PROTON.label)), m).toEqual([]);
    }
    expect(isProtonAddress("info@proton.me")).toBe(true);
    expect(presetForAddress("info@proton.me")).toBeNull();
  });

  it("and the landing's 'any IMAP mailbox' promise has a manual entry behind it", () => {
    const manual = PROVIDERS.filter((p) => p.manual);
    expect(manual).toHaveLength(1);
    expect(manual[0]!.id).toBe("imap");
    // It must ASK for the hosts rather than guess: an empty preset host on a non-manual
    // provider would silently connect nowhere.
    expect(manual[0]!.imap.host).toBe("");
  });

  it("the Microsoft entry repeats the landing's caveat instead of softening it", () => {
    // The landing says, in public: native Exchange sync over Graph is on the roadmap and
    // not shipped; Microsoft connects over IMAP like everything else. Onboarding is where
    // someone is about to type a credential, so it is the worst possible place to imply
    // more than that.
    const ms = providerById("microsoft");
    expect(ms.note).toMatch(/IMAP/);
    expect(ms.note).toMatch(/not shipped/);

    // ── WHY THE `/OAuth|Sign in with Microsoft/` BAN WAS RETIRED, AND WHAT REPLACED IT ──────
    //
    // This assertion used to forbid the note from mentioning a Microsoft sign-in at all. That
    // was the right guard for a build where no such thing existed — the words could only have
    // been a promise of something unbuilt. The Microsoft consent ceremony now ships
    // (`packages/api/src/routes/mailbox-oauth.ts`), so the ban had inverted: it forced the note
    // to hide a real, working door and to tell every reader an app password is the only way in,
    // which is false on a configured deployment and is itself the over-claim's mirror image.
    //
    // The ban was a PROXY for the invariant stated above — do not imply more than IMAP — so the
    // invariant is asserted directly instead of through a word it happened to correlate with.
    // Mentioning the sign-in is allowed; claiming Graph or native Exchange sync is not, and
    // neither is promising the sign-in unconditionally, because the button is conditional on
    // the deployment having a registration (`microsoftOAuthAvailable`).
    expect(ms.note).not.toMatch(/\bGraph\b(?!\s+is on the roadmap)/i);
    expect(ms.note).not.toMatch(/native Exchange sync(?! over Microsoft Graph is on the roadmap)/i);
    if (/sign in with Microsoft/i.test(ms.note)) {
      // Conditional, not a promise: the sentence has to carry its own "when/where configured".
      expect(ms.note).toMatch(/when this deployment has|where it is actually configured/i);
    }
    // And the app-password path stays described, because it is the only one without a registration.
    expect(ms.note).toMatch(/app password/i);
  });
});

describe("the presets cannot be a downgrade or a dead end", () => {
  it("every non-manual provider has real hosts and TLS-appropriate ports", () => {
    for (const p of PROVIDERS.filter((x) => !x.manual)) {
      expect(p.imap.host, p.id).not.toBe("");
      expect(p.smtp.host, p.id).not.toBe("");
      // IMAP is implicit TLS on 993 everywhere. 143 (cleartext + STARTTLS) is not offered.
      expect(p.imap.port, p.id).toBe(993);
      expect(p.imap.secure, p.id).toBe(true);
      // SMTP is either implicit TLS (465) or the submission port (587, STARTTLS).
      expect([465, 587], p.id).toContain(p.smtp.port);
      expect(p.smtp.secure, p.id).toBe(portMeansImplicitTls(p.smtp.port));
    }
  });

  it("`secure` means IMPLICIT TLS, not 'encrypted' — 587 is false and is still fine", () => {
    // Stated as a test because "secure: false" on a submission port reads like a downgrade
    // and is not one, and somebody will eventually try to "fix" it.
    expect(portMeansImplicitTls(993)).toBe(true);
    expect(portMeansImplicitTls(465)).toBe(true);
    expect(portMeansImplicitTls(587)).toBe(false);
    expect(portMeansImplicitTls(143)).toBe(false);
  });

  it("every provider that needs an app password says so, with somewhere to get one", () => {
    const apps = PROVIDERS.filter((x) => x.appPassword);
    expect(apps.map((p) => p.id).sort()).toEqual(["fastmail", "gmail", "icloud", "microsoft", "yahoo"]);
    for (const p of apps) {
      expect(p.note, p.id).toMatch(/app(?:-specific)? password/i);
      expect(p.helpUrl, p.id).toMatch(/^https:\/\//);
    }
    for (const p of PROVIDERS.filter((x) => !x.manual)) {
      expect(p.note.length, p.id).toBeGreaterThan(40);
      if (p.helpUrl) expect(p.helpLabel, p.id).toBeTruthy();
    }
  });

  it("an unknown provider id falls back to the manual entry, never to a wrong preset", () => {
    // The fallback must not be "the first one": silently connecting a stranger's mailbox
    // to imap.gmail.com is the single worst way this function could be wrong.
    expect(providerById("does-not-exist").id).toBe("imap");
    expect(providerById("").manual).toBe(true);
  });
});

describe("refusals are the server's sentence, never a client copy of it", () => {
  const client = read("../app/api-client.ts");
  // The wizard, with its mailbox step (moved to its own file).
  const join = read("../app/(product)/join/JoinScreen.tsx") + read("../app/(product)/join/MailboxStep.tsx");

  /**
   * EVERY webapp source file, not two of them.
   *
   * This check used to read exactly `api-client.ts` and `JoinScreen.tsx` — 2 files of 29 —
   * while the slice document claimed it "greps webapp source and fails if any appears". The
   * gap was not theoretical: `messages/en.json` carried "it only works for the address it
   * was sent to", which is `invites.ts`'s `invite_invalid` wording verbatim, sitting in the
   * one place the grep could not see. Copy files are exactly where a duplicated server
   * sentence ends up, because that is where copy is written.
   */
  const WEBAPP_SOURCE = walkSources(`${HERE}../app`).concat([`${HERE}../messages/en.json`]);

  it("the client passes `error.message` through verbatim", () => {
    // The server's own sentence first; the fallback is this client's, in the reader's language.
    expect(client).toMatch(/env\?\.message \?\? said\("somethingWrong", "Something went wrong/);
    expect(client).toMatch(/if \(err instanceof ApiError\) return err\.message;/);
  });

  it("no webapp source re-states a server refusal — every file, including the copy", () => {
    // These sentences belong to `mailbox-allowance.ts` and `invites.ts`, which wrote them
    // with the entitlement state in hand. A second copy here drifts on the first change to
    // the plan table and is then confidently wrong.
    const forbidden = [
      /mailbox limit reached/i,
      /already been used/i,
      /no active subscription/i,
      // The `invite_invalid` sentence. It lived in `en.json` until this grep could see it.
      /only works for the address it was sent to/i,
      /invite has expired/i,
    ];
    expect(WEBAPP_SOURCE.length, "the walk found nothing — the grep would pass vacuously")
      .toBeGreaterThan(10);
    for (const file of WEBAPP_SOURCE) {
      const src = readFileSync(file, "utf8");
      for (const re of forbidden) {
        expect(src, `${file} restates a server refusal (${re})`).not.toMatch(re);
      }
    }
  });

  /**
   * TWO CASES REPLACED BY ONE, because the surface they guarded has left this app.
   *
   * They held the plan card's copy to the SERVER's numbers — `{mailboxes}`, `{credits}`,
   * `{price}` as ICU arguments, no literal tier anywhere — and the trial note to what the
   * subscription actually granted. Both existed because copy that restates a pricing table is
   * copy that goes wrong the next time the table moves, on the page where being wrong costs a
   * sale. The tiers did move while that screen was being written.
   *
   * There is no card to render now: the step links out to the page that owns the plan, so the
   * property becomes total rather than argument-shaped — this catalogue states no number at
   * all, and a literal cannot drift if there is none.
   */
  it("the join copy states no price, no tier and no trial term", () => {
    const messages = JSON.parse(read("../messages/en.json")) as {
      join: Record<string, string>; accessLock: Record<string, string>;
    };
    /*
     * ONE trial sentence is ruled in (2026-10-17): the plan step says what the site's tier buttons
     * promise, `planTrial`, in the same words as the wall's never-started state. No price and no
     * tier in it; the terms are the plane's (a 14-day trial, no card while trial-eligible), so a
     * change there changes this sentence and the wall's together, which the second check holds.
     */
    const { planTrial, ...rest } = messages.join;
    expect(planTrial).toBe("14 days free, no card.");
    expect(messages.accessLock.neverStartedLead.startsWith(planTrial!)).toBe(true);
    const copy = Object.values(rest).join(" ");
    expect(copy.length, "the join namespace is empty — then this guards nothing")
      .toBeGreaterThan(400);
    expect(copy, "a price is back in the signup funnel").not.toMatch(/\$\d/);
    expect(copy, "a mailbox tier is back in the signup funnel").not.toMatch(/\d+\s+mailboxes/);
    expect(copy, "a trial term is back in the signup funnel")
      .not.toMatch(/14 days|no card|full access|everything included|unlimited/i);
    // …and the component reads no plan table off any response.
    expect(join).not.toMatch(/sub\.plans|card\.mailboxes|card\.priceUsd|monthlyCredits/);
  });
});
