/** @vitest-environment jsdom */
/**
 * TODAY'S SHEETS CHANGE NOTHING A DOOR DRAWS, IN A REAL BROWSER. A door's page stands in the product's document, which
 * loads today's sheets unlayered beside the new design's (`@ohmail/ui`'s index brings today's tokens and base sheet to
 * every product page, under `body.mo-canvas`): a class or an element rule of theirs that reaches a door wins over the
 * kit's layer, whatever its specificity. Each door's page is drawn here (jsdom has no cascade, so only its markup and
 * the root's attributes are taken), then laid out in Chromium twice, under the new design's sheets alone and under
 * every sheet the product page loads, at the phone's, the fold's and the desktop's width.
 *
 * Held: every element the doors draw themselves computes the same both times, the stage covers the window, and
 * nothing scrolls sideways; and so do the kit's parts inside a door (today's base sheet resets `button`, `h1`-`h3`,
 * `p`, `ul`, `input` under `.mo-canvas` and styles `kbd`, and today's icon sheet strokes every `svg`: the kit's root
 * keeps them out).
 */
import { act, cleanup, render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFeed } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { DoorStage } from "../../src/doors/stage/index.js";
import { ApprovePage } from "../../src/doors/approve/index.js";
import { AuthorizeDesktopPage } from "../../src/doors/authorize-desktop/index.js";
import { DeleteAccountPage } from "../../src/doors/delete-account/index.js";
import { InvitePage } from "../../src/doors/invite/index.js";
import { JoinPage, type JoinDoor } from "../../src/doors/join/index.js";
import { LinkDesktopPage } from "../../src/doors/link-desktop/index.js";
import { NoPagePage } from "../../src/doors/no-page/index.js";
import { SetupPage } from "../../src/doors/setup/index.js";
import { SignedOutPage } from "../../src/doors/signed-out/index.js";
import { SignInPage } from "../../src/doors/sign-in/index.js";
import { StepUpDialog, type StepUpDoor } from "../../src/doors/step-up/index.js";
import { SubscribedPage } from "../../src/doors/subscribed/index.js";
import { VerifyPage } from "../../src/doors/verify/index.js";
import { WallPage } from "../../src/doors/wall/index.js";
import doors from "../../messages/doors.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import mailboxes from "../../messages/mailboxes.en.json" with { type: "json" };
import mailboxesDe from "../../messages/mailboxes.de.json" with { type: "json" };

const REPO = resolve(__dirname, "../../../..");
const { chromium } = createRequire(join(REPO, "package.json"))(
  "@playwright/test",
) as typeof import("@playwright/test");
const css = (path: string): string => readFileSync(join(REPO, path), "utf8").replace(/@import[^;]+;/g, "");
const sheetsUnder = (dir: string, skip: (name: string) => boolean = () => false): string[] =>
  readdirSync(join(REPO, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) =>
      e.isDirectory()
        ? skip(e.name)
          ? []
          : sheetsUnder(`${dir}/${e.name}`, skip)
        : e.name.endsWith(".css")
          ? [`${dir}/${e.name}`]
          : [],
    );

/**
 * The new design's sheets as the doors bring them, collected by the bundler from what the doors' entries import
 * (`doors-sheets.mjs`, run on its own: the bundler does not run in jsdom).
 */
const doorsSheets = (): string =>
  execFileSync(process.execPath, [join(REPO, "packages/app/test/doors/doors-sheets.mjs")], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
/** Today's sheets, unlayered, as the product page loads them beside the new design's. */
const TODAY = [
  "packages/tokens/src/tokens.css",
  "packages/tokens/src/faces.css",
  "packages/tokens/src/ohmarchy.css",
  ...sheetsUnder("packages/ui/src", (name) => name === "base"),
  "apps/webapp/app/app.css",
  "apps/webapp/app/zero-layout.css",
  "apps/webapp/app/shell/today.css",
  "apps/webapp/app/shell/today-tokens.generated.css",
];

type Room = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pointer: "coarse" | "fine";
  /** The web door's Text size: `zoom` and `--ui-zoom` on the root; the window's facts stay the window's. */
  readonly zoom?: number;
};
const ROOMS: readonly [Room, Room, Room] = [
  { name: "phone", width: 390, height: 844, pointer: "coarse" },
  { name: "fold", width: 719, height: 781, pointer: "coarse" },
  { name: "desktop", width: 1440, height: 900, pointer: "fine" },
];
/** Where a page must stand whole: the desktop's window, and the unfolded phone held on its side. */
const WHOLE: readonly Room[] = [ROOMS[2], { name: "foldl", width: 841, height: 673, pointer: "coarse" }];

const nothing = (): void => {};
const pending = { said: null, act: "Sign out", signingOut: false, again: nothing };
const answers = { onVerified: nothing, onCancel: nothing, onDiscarded: nothing };
const stepUp: StepUpDoor = {
  factors: () => Promise.resolve({ ok: true, factors: { passkey: true, code: true, recovery: true } }),
  verify: () => Promise.resolve({ ok: false, refusal: { word: "bad_code" } }),
};
const blanks = { token: "", code: "", email: "mila@lichtgrat.example", name: "Mila", password: "", otp: "" };
const press = { busy: false, retryIn: null, refusal: null, discarded: false, signIn: false, factor: false };
const joinDoor = (): JoinDoor => ({
  state: { at: "account" },
  stations: ["account", "verify", "factor", "codes", "plan", "mailbox"],
  note: "managed-open",
  invited: false,
  busy: false,
  refusal: null,
  fields: blanks,
  suggestion: null,
  pending,
  type: nothing,
  redeem: nothing,
  register: nothing,
  toInvite: nothing,
  takeSuggestion: nothing,
  changeAddress: nothing,
  signIn: { href: "/login" },
  resend: nothing,
  recheck: nothing,
  addPasskey: nothing,
  useAuthenticator: nothing,
  copyKey: nothing,
  openAuthenticator: nothing,
  activate: nothing,
  leaveAuthenticator: nothing,
  copyCodes: nothing,
  downloadCodes: nothing,
  save: nothing,
  codesDone: nothing,
  retryCodes: nothing,
  accountPage: { href: "https://plane.example/manage" },
  later: { href: "/" },
  open: { href: "/#/first-run" },
  retry: nothing,
  leave: { href: "/" },
  signInAgain: { href: "/login?next=join" },
  waitlist: { href: "/#pricing" },
  demo: { href: "/?demo=1" },
  slots: { mailbox: () => null, authenticatorQr: () => null },
});

/** One named state of every door's page: a field, a key hint, a list, a refusal and the small mark among them. */
const PAGES: Record<string, () => ReactNode> = {
  "signed-out": () => (
    <SignedOutPage door={{ state: { at: "busy" }, tryAgain: nothing, signIn: nothing, demo: nothing }} />
  ),
  "no-page": () => (
    <NoPagePage
      door={{
        at: "missing",
        words: { title: "No page here.", note: "Nothing.", home: "Home" },
        home: nothing,
      }}
    />
  ),
  "sign-in": () => (
    <SignInPage
      door={{
        state: { at: "password", busy: false, refusal: { word: "bad_credentials" } },
        note: "managed-open",
        continues: null,
        why: null,
        pending,
        fields: { email: "", password: "", code: "" },
        type: nothing,
        begin: nothing,
        passkey: nothing,
        finish: nothing,
        use: nothing,
        restart: nothing,
        join: { href: "/join" },
        demo: { href: "/?demo=1" },
      }}
    />
  ),
  verify: () => (
    <VerifyPage
      door={{
        state: {
          at: "form",
          asksCode: true,
          codeHeld: false,
          busy: false,
          refusal: doors.verify.refusedLink,
          passwordRefused: false,
        },
        fields: { code: "", password: "" },
        type: nothing,
        submit: nothing,
        signIn: nothing,
        newLink: nothing,
        pending,
      }}
    />
  ),
  setup: () => (
    <SetupPage
      door={{
        state: { at: "form", busy: false, refusal: null, tokenRefused: false },
        fields: blanks,
        type: nothing,
        submit: nothing,
        retry: nothing,
        signIn: nothing,
        copy: () => Promise.resolve(true),
      }}
    />
  ),
  invite: () => (
    <InvitePage
      door={{
        state: { at: "form", busy: false, refusal: null },
        fields: blanks,
        type: nothing,
        submit: nothing,
        pending,
      }}
    />
  ),
  subscribed: () => <SubscribedPage door={{ state: { at: "back" }, open: nothing }} />,
  join: () => <JoinPage door={joinDoor()} />,
  "step-up": () => <StepUpDialog door={stepUp} {...answers} />,
  approve: () => (
    <ApprovePage
      door={{
        state: {
          at: "ask",
          asked: {
            label: "Mila's laptop",
            platform: "Linux",
            minutes: 2,
            network: "n",
            otherNetwork: false,
            account: "mila@lichtgrat.example",
            remaining: 9,
          },
          busy: false,
          retryIn: null,
          refusal: null,
          factor: false,
        },
        confirm: nothing,
        deny: nothing,
        stepUp,
        factor: answers,
      }}
    />
  ),
  "authorize-desktop": () => (
    <AuthorizeDesktopPage
      door={{
        state: {
          at: "ask",
          client: "tf-macos",
          address: "m•••@lichtgrat.example",
          remaining: 9,
          busy: false,
          refusal: null,
          factor: false,
        },
        confirm: nothing,
        signIn: nothing,
        stepUp,
        factor: answers,
      }}
    />
  ),
  "link-desktop": () => (
    <LinkDesktopPage
      door={{
        state: { at: "code", code: ["K7", "QM-42XD"].join(""), remaining: 540, bound: true, ...press },
        press: nothing,
        openApp: nothing,
        signIn: nothing,
        stepUp,
        factor: answers,
      }}
    />
  ),
  "delete-account": () => (
    <DeleteAccountPage
      door={{
        state: {
          at: "form",
          email: "mila@lichtgrat.example",
          subscription: true,
          typed: "",
          busy: false,
          refusal: null,
          cancelled: false,
          factor: false,
        },
        service: "managed",
        type: nothing,
        begin: nothing,
        back: nothing,
        home: nothing,
        signIn: nothing,
        privacy: nothing,
        stepUp,
        factor: answers,
      }}
    />
  ),
  wall: () => (
    <WallPage
      door={{
        state: {
          at: "refused",
          headline: { key: "trialEnded", date: "1 October 2026" },
          standing: { kind: "stopped", erasure: { kind: "dated", date: "31 October 2026" } },
          check: "idle",
          wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: null },
          moveOut: { exporting: false, failed: false },
          deleteHint: "deleteHint",
          signingOut: false,
          signOutSaid: null,
        },
        wayBack: nothing,
        checkAgain: nothing,
        moveOut: nothing,
        guide: nothing,
        deleteNow: nothing,
        signOut: nothing,
        changePassword: () => {},
        home: nothing,
      }}
    />
  ),
};

/** A door's markup at a room, in a language, with the attributes its stage stamped on the root. */
type Look = { face: "paper" | "ohmarchy"; scheme: "light" | "dark" };
const PAPER: Look = { face: "paper", scheme: "light" };

async function drawn(
  page: () => ReactNode,
  room: Room,
  locale: "en" | "de" = "en",
  look: Look = PAPER,
): Promise<{ body: string; root: string }> {
  const root = document.documentElement;
  const device = () => ({
    window: createFeed({
      width: room.width,
      height: room.height,
      pointer: room.pointer,
      posture: "flat",
      reducedMotion: false,
    } as never),
    appearance: createFeed(look as never),
    root: {
      read: (name: string) => root.getAttribute(name),
      write: (name: string, value: string | null) =>
        value === null ? root.removeAttribute(name) : root.setAttribute(name, value),
    },
  });
  render(
    <TextProvider
      locale={locale}
      messages={(locale === "de" ? { ...doorsDe, ...mailboxesDe } : { ...doors, ...mailboxes }) as never}
      timeZone="UTC"
    >
      <DoorStage device={device}>{page()}</DoorStage>
    </TextProvider>,
  );
  /* What a door reads as it opens has answered: the step-up dialog's other ways are drawn. */
  await act(async () => {});
  const stamped = [...root.attributes].map((a) => `${a.name}="${a.value}"`).join(" ");
  const body = document.body.innerHTML;
  cleanup();
  for (const a of [...root.attributes]) root.removeAttribute(a.name);
  return { body, root: stamped };
}

let NEW_CSS = "";
const TODAY_CSS = TODAY.map(css).join("\n");
/** The document: the new design's sheets alone, or with today's after them and the product's body classes. */
const documentOf = (d: { body: string; root: string }, today: boolean): string => `<!doctype html>
<html lang="en" ${d.root}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${NEW_CSS}</style>${today ? `<style>${TODAY_CSS}</style>` : ""}</head>
<body${today ? ' class="mo-canvas app-body today"' : ""}>${d.body}</body></html>`;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
type Tab = import("@playwright/test").Page;
beforeAll(async () => {
  NEW_CSS = doorsSheets();
  browser = await chromium.launch();
}, 120_000);
afterAll(async () => {
  await browser?.close();
});
beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});

/** Every element of the door, whose it is, and what it computes, by its place in the tree. */
interface Read {
  styles: { at: string; own: boolean; style: Record<string, string> }[];
  covers: boolean;
  sideways: number;
}

async function readAt(html: string, room: Room): Promise<Read> {
  const tab = await browser!.newPage({ viewport: { width: room.width, height: room.height } });
  try {
    await tab.setContent(html, { waitUntil: "load" });
    return await tab.evaluate(() => {
      const stage = document.querySelector<HTMLElement>(".way-stage");
      const all = stage ? [stage, ...stage.querySelectorAll<Element>("*")] : [];
      const classes = (el: Element): string => el.getAttribute("class")?.trim() ?? "";
      const styles = all.map((el, i) => {
        const cs = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of Array.from(cs)) style[prop] = cs.getPropertyValue(prop);
        const at = `${i} ${el.tagName.toLowerCase()}${classes(el) ? `.${classes(el).replace(/\s+/g, ".")}` : ""}`;
        return { at, own: /(^|\s)way-/.test(classes(el)), style };
      });
      const box = stage?.getBoundingClientRect();
      const covers =
        !!box && box.left <= 0 && box.top <= 0 && box.right >= innerWidth && box.bottom >= innerHeight;
      return { styles, covers, sideways: document.documentElement.scrollWidth - innerWidth };
    });
  } finally {
    await tab.close();
  }
}

/**
 * Said of the whole document by today's tokens, not drawn by anyone: the scheme native controls take. The new design's
 * tokens say none yet (handed to the tokens' owner), so a door takes today's.
 */
const DOCUMENT_WIDE = new Set(["color-scheme"]);
/**
 * What the browser resolves from what stands inside an element, not from its rules: an element of the doors' own is
 * as tall as the kit's parts in it make it, and those are the OPEN case's.
 */
const RESOLVED = new Set([
  "width",
  "height",
  "inline-size",
  "block-size",
  "perspective-origin",
  "transform-origin",
  "grid-template-rows",
  "grid-template-columns",
]);

/** Each property an element of the door computes otherwise under today's sheets: the doors' own, or the kit's parts. */
function differences(alone: Read, beside: Read, whose: "own" | "kit"): string[] {
  const out: string[] = [];
  alone.styles.forEach((a, i) => {
    const b = beside.styles[i];
    if (!b || b.at !== a.at) {
      out.push(`${a.at}: the tree differs`);
      return;
    }
    if (a.own !== (whose === "own")) return;
    for (const [prop, value] of Object.entries(a.style)) {
      if (DOCUMENT_WIDE.has(prop) || (whose === "own" && RESOLVED.has(prop))) continue;
      if (b.style[prop] !== value) out.push(`${a.at} { ${prop}: ${value} -> ${b.style[prop]} }`);
    }
  });
  return out;
}

/** Every door at a room: what differs, of the doors' own or of the kit's parts, and where the stage fails. */
async function readRoom(room: Room, whose: "own" | "kit"): Promise<string[]> {
  const found: string[] = [];
  for (const [door, page] of Object.entries(PAGES)) {
    const d = await drawn(page, room);
    const alone = await readAt(documentOf(d, false), room);
    const beside = await readAt(documentOf(d, true), room);
    if (alone.styles.length < 4) found.push(`${door}: drew nothing`);
    found.push(...differences(alone, beside, whose).map((s) => `${door}: ${s}`));
    if (!beside.covers) found.push(`${door}: the stage leaves the window's ground to today's canvas`);
    if (beside.sideways > 0) found.push(`${door}: the page scrolls sideways by ${beside.sideways} px`);
  }
  return found;
}

describe("a door's page under every sheet the product page loads", () => {
  for (const room of ROOMS) {
    it(`${room.name}, ${room.width} by ${room.height}: what the doors draw themselves computes as under the new design alone`, async () => {
      expect(await readRoom(room, "own")).toEqual([]);
    }, 240_000);
  }

  /* Today's element rules (packages/ui/src/base.css, icons.css) stop at the new design's root. */
  it("the kit's parts inside a door compute as under the new design alone", async () => {
    expect(await readRoom(ROOMS[0], "kit")).toEqual([]);
  }, 240_000);

  /* German runs longest: at the phone's width, under every sheet the product loads, every box holds its words. */
  it("German, at the phone's width: no door's words run out of their box, and nothing scrolls sideways", async () => {
    const found: string[] = [];
    for (const [door, page] of Object.entries(PAGES)) {
      const d = await drawn(page, ROOMS[0], "de");
      const tab = await browser!.newPage({ viewport: { width: ROOMS[0].width, height: ROOMS[0].height } });
      try {
        await tab.setContent(documentOf(d, true).replace('lang="en"', 'lang="de"'), { waitUntil: "load" });
        const out = await tab.evaluate(() => {
          const stage = document.querySelector(".way-stage");
          const over = [...(stage?.querySelectorAll<HTMLElement>("*") ?? [])]
            .filter((el) => {
              const cs = getComputedStyle(el);
              /* A box of its own that is drawn: inline words are held by the box around them. */
              if (["inline", "contents", "none"].includes(cs.display) || el.clientWidth <= 1) return false;
              return el.scrollWidth > el.clientWidth + 1;
            })
            .map(
              (el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").slice(0, 40)}"`,
            );
          return { over, sideways: document.documentElement.scrollWidth - innerWidth };
        });
        found.push(...out.over.map((s) => `${door}: ${s}`));
        if (out.sideways > 0) found.push(`${door}: scrolls sideways by ${out.sideways} px`);
      } finally {
        await tab.close();
      }
    }
    expect(found).toEqual([]);
  }, 240_000);

  it("CONTROL: a rule of today's kind on a class the doors draw is read", async () => {
    const d = await drawn(PAGES.verify!, ROOMS[0]);
    const alone = await readAt(documentOf(d, false), ROOMS[0]);
    const planted = documentOf(d, true).replace(
      "</head>",
      "<style>.way-door-form { letter-spacing: 3px }</style></head>",
    );
    const beside = await readAt(planted, ROOMS[0]);
    expect(differences(alone, beside, "own").some((s) => s.includes("letter-spacing"))).toBe(true);
  }, 120_000);
});

/* The page's one act, by the name the catalogue gives it, in each language. */
type Words = typeof doors;
const INK: Readonly<Record<string, (w: Words) => string>> = {
  "signed-out": (w) => w.resume.tryAgain,
  "no-page": () => "Home",
  "sign-in": (w) => w.login.continue,
  verify: (w) => w.verify.confirm,
  setup: (w) => w.setup.createAccount,
  invite: (w) => w.joinInvite.createAccount,
  subscribed: (w) => w.subscribed.open,
  join: (w) => w.join.createAccount,
  "step-up": (w) => w.stepUp.passkey,
  approve: (w) => w.approve.confirm,
  "authorize-desktop": (w) => w.authorizeDesktop.confirm,
  "link-desktop": (w) => w.linkDesktop.openApp,
  "delete-account": (w) => w.deleteAccount.begin,
  wall: (w) => w.accessLock.subscribe,
};
const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/*
 * OPEN: a form of labelled fields stands taller than the unfolded phone on its side, until its blanks stand in the
 * page's sentence as the design draws them, or the page's foot stays in sight at every size (the design keeps it in
 * sight on the phone alone: a question for the studio). Once either holds, this list shrinks: the email confirmation,
 * the invite and the server setup left it when their blanks moved into the sentence.
 */
const OPEN_TALLER: Readonly<Record<string, readonly string[]>> = {
  foldl: ["join"],
};

/*
 * THE KIT'S SMALLER WINDOWS (its ask to the doors, from its check CHECK-45): three smaller desktop windows, and the web
 * door's Text size at the desktop's window and at the smallest of them, a fine pointer each.
 */
const SMALLER: readonly Room[] = [
  { name: "1280x720", width: 1280, height: 720, pointer: "fine" },
  { name: "1100x640", width: 1100, height: 640, pointer: "fine" },
  { name: "1024x600", width: 1024, height: 600, pointer: "fine" },
  { name: "text 1.25 at 1440x900", width: 1440, height: 900, pointer: "fine", zoom: 1.25 },
  { name: "text 1.5 at 1440x900", width: 1440, height: 900, pointer: "fine", zoom: 1.5 },
  { name: "text 1.25 at 1280x720", width: 1280, height: 720, pointer: "fine", zoom: 1.25 },
];

/*
 * OPEN: the acts the review of round 2 measured outside those windows (REVIEW-ROUND-2.md, ruling d), a room named
 * without a language in both. A page of two columns cannot scroll, so its act cannot be reached at all (setup, the wall,
 * authorize-desktop, the delete page): the kit is asked to fold such a page to one column, which scrolls, where its
 * sentence column is taller than its window (the wall first), and they leave this list in the round that merges that
 * fold. A page of one column scrolls (the sign-in, the email confirmation, the invite, the join): they stay until the
 * studio answers whether a page's foot stays in sight at every size.
 */
const OPEN_SMALLER: Readonly<Record<string, readonly string[]>> = {
  setup: [
    "1100x640",
    "1024x600",
    "text 1.25 at 1440x900 de",
    "text 1.5 at 1440x900",
    "text 1.25 at 1280x720",
  ],
  wall: ["1100x640 de", "1024x600", "text 1.5 at 1440x900", "text 1.25 at 1280x720"],
  "authorize-desktop": ["1100x640 de", "1024x600 de", "text 1.5 at 1440x900", "text 1.25 at 1280x720"],
  "sign-in": ["1100x640", "1024x600", "text 1.5 at 1440x900", "text 1.25 at 1280x720"],
  verify: ["1024x600", "text 1.5 at 1440x900", "text 1.25 at 1280x720"],
  join: SMALLER.map((room) => room.name),
};

/** The doors whose act stands outside `room` in `locale`, by the OPEN list's rows. */
const openAt = (
  open: Readonly<Record<string, readonly string[]>>,
  room: Room,
  locale: "en" | "de",
): string[] =>
  Object.keys(PAGES).filter((door) =>
    (open[door] ?? []).some((at) => at === room.name || at === `${room.name} ${locale}`),
  );

/** Each door's one act at `room` in `locale`, under every sheet the product page loads: where it stands outside. */
async function actsOutside(room: Room, locale: "en" | "de"): Promise<string[]> {
  const words = (locale === "de" ? doorsDe : doors) as Words;
  const textSize = room.zoom ? ` style="zoom:${room.zoom};--ui-zoom:${room.zoom}"` : "";
  const outside: string[] = [];
  for (const [door, page] of Object.entries(PAGES)) {
    const name = INK[door]!(words);
    const d = await drawn(page, room, locale);
    const tab = await browser!.newPage({ viewport: { width: room.width, height: room.height } });
    try {
      await tab.setContent(documentOf(d, true).replace('lang="en"', `lang="${locale}"${textSize}`), {
        waitUntil: "load",
      });
      const box = await tab
        .getByRole("button", { name: new RegExp(`^${escaped(name)}`) })
        .first()
        .boundingBox({ timeout: 2_000 })
        .catch(() => null);
      if (!box) outside.push(`${door}: no "${name}"`);
      else if (box.x < 0 || box.y < 0 || box.x + box.width > room.width || box.y + box.height > room.height)
        outside.push(`${door}: "${name}" at [${box.x}, ${box.y}, ${box.width}, ${box.height}]`);
    } finally {
      await tab.close();
    }
  }
  return outside;
}

const doorOf = (said: string): string => said.slice(0, said.indexOf(":"));

/*
 * A PAGE STANDS WHOLE ON ITS FIRST SCREEN. The page's body scrolls without a bar, so a button under the window's edge
 * is a button nobody sees: at the desktop's window and the unfolded phone on its side, in both languages, under every
 * sheet the product page loads, each page's one act stands inside the window.
 */
describe("a door's one act stands inside the window", () => {
  for (const room of WHOLE)
    for (const locale of ["en", "de"] as const)
      it(`${room.name}, ${room.width} by ${room.height}, ${locale}`, async () => {
        const outside = await actsOutside(room, locale);
        expect(outside.map(doorOf), outside.join("\n")).toEqual(OPEN_TALLER[room.name] ?? []);
      }, 240_000);
});

/*
 * AND IN THE KIT'S SMALLER WINDOWS: each page's one act inside the window, in both languages, under every sheet the
 * product page loads, but for the OPEN list above, which names exactly what stands outside today.
 */
describe("a door's one act stands inside the kit's smaller windows", () => {
  for (const room of SMALLER)
    for (const locale of ["en", "de"] as const)
      it(`${room.name}, ${locale}`, async () => {
        const outside = await actsOutside(room, locale);
        expect(outside.map(doorOf), outside.join("\n")).toEqual(openAt(OPEN_SMALLER, room, locale));
      }, 240_000);
});

/*
 * A SECOND BUTTON HAS A SHAPE. Its ground is the soft one of what it stands on (on the stage the stage's, on a sheet
 * the sheet's), or, in a face that rings its second buttons, its ring. Under the new design's sheets, in each face and
 * scheme, a second button and the setup's command block each have one, so neither is drawn as bare words.
 */
describe("a second button and the setup's command have a ground of their own", () => {
  const LOOKS: readonly Look[] = [
    PAPER,
    { face: "paper", scheme: "dark" },
    { face: "ohmarchy", scheme: "light" },
    { face: "ohmarchy", scheme: "dark" },
  ];
  /**
   * Every second button a page draws (the kit's kind `two`), and the setup's command block: its ground, the ground it
   * stands on, and whether a ring that shows is drawn round it.
   */
  const shapes = (tab: Tab) =>
    tab.evaluate(() => {
      const clear = (c: string) => c === "transparent" || c === "rgba(0, 0, 0, 0)";
      const ground = (from: Element | null) => {
        let at = from;
        while (at && clear(getComputedStyle(at).backgroundColor)) at = at.parentElement;
        return at;
      };
      /* A ring shows where one of its shadows has a colour. */
      const ringed = (el: Element) =>
        getComputedStyle(el)
          .boxShadow.split(/,(?![^(]*\))/)
          .some((part) => part.trim() !== "none" && !part.includes("rgba(0, 0, 0, 0)"));
      const read = (el: Element, what: string) => {
        const under = ground(el.parentElement);
        return {
          what,
          own: getComputedStyle(el).backgroundColor,
          ground: under ? getComputedStyle(under).backgroundColor : "none",
          ring: ringed(el),
        };
      };
      const seconds = [...document.querySelectorAll('button[data-kind="two"]')].map((b) =>
        read(b, (b.textContent ?? "").trim() || (b.getAttribute("aria-label") ?? "")),
      );
      /* The block the command stands in is the nearest box round it, or itself, that has a ground. */
      const command = [...document.querySelectorAll("code")]
        .filter((c) => c.textContent === "docker compose logs api")
        .map((c) => read(ground(c) ?? c, "the command"));
      return [...seconds, ...command];
    });
  for (const look of LOOKS)
    it(`${look.face}, ${look.scheme}`, async () => {
      const bare: string[] = [];
      let read = 0;
      for (const [door, page] of Object.entries(PAGES)) {
        const d = await drawn(page, ROOMS[2], "en", look);
        const tab = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
        try {
          await tab.setContent(documentOf(d, false), { waitUntil: "load" });
          for (const s of await shapes(tab)) {
            read += 1;
            if (s.own === s.ground && !s.ring) bare.push(`${door}: ${s.what}: ${s.own} on ${s.ground}`);
          }
        } finally {
          await tab.close();
        }
      }
      /* At least the approval's Not me and the setup's command: the case reads what it is about. */
      expect(read).toBeGreaterThanOrEqual(2);
      expect(bare).toEqual([]);
    }, 120_000);
});

/** The wall with its way to move out off for now (the settings file is being made). */
const wallMovingOut = (): ReactNode => (
  <WallPage
    door={{
      state: {
        at: "refused",
        headline: { key: "trialEnded", date: "1 October 2026" },
        standing: { kind: "stopped", erasure: { kind: "dated", date: "31 October 2026" } },
        check: "idle",
        wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: null },
        moveOut: { exporting: true, failed: false },
        deleteHint: "deleteHint",
        signingOut: false,
        signOutSaid: null,
      },
      wayBack: nothing,
      checkAgain: nothing,
      moveOut: nothing,
      guide: nothing,
      deleteNow: nothing,
      signOut: nothing,
      changePassword: () => {},
      home: nothing,
    }}
  />
);

/*
 * A WAY OUT IS A PRESS, AND LOOKS IT. The wall's ways are rows on a sheet: under the pointer a row takes the hover
 * wash as the design's rows do, a press gives as a button's does, and a way that is off for now stands on the off
 * ground in its ink and takes no wash, as an off button does.
 */
describe("the wall's ways out answer the pointer and a press, and one that is off says so", () => {
  it("paper, light, at the desktop's size", async () => {
    const d = await drawn(wallMovingOut, ROOMS[2]);
    const tab = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await tab.setContent(documentOf(d, true), { waitUntil: "load" });
      /* What the tokens resolve to under the same root: the hover wash, the off ground and its ink. */
      const tokens = await tab.evaluate(() => {
        const probe = document.createElement("i");
        document.querySelector(".way-stage")!.append(probe);
        const read = (prop: string, value: string): string => {
          probe.style.setProperty(prop, value);
          return getComputedStyle(probe).getPropertyValue(prop);
        };
        return {
          hover: read("background-color", "var(--hover)"),
          off: read("background-color", "var(--off)"),
          onOff: read("color", "var(--on-off)"),
        };
      });
      const look = (name: string) =>
        tab.getByRole("button", { name: new RegExp(`^${name}`) }).evaluate((el) => {
          const cs = getComputedStyle(el);
          return { ground: cs.backgroundColor, ink: cs.color, turn: cs.transform, cursor: cs.cursor };
        });
      const del = doors.accessLock.deleteNow;
      const off = doors.accessLock.moveOut;
      expect((await look(del)).ground).toBe("rgba(0, 0, 0, 0)");
      await tab.getByRole("button", { name: new RegExp(`^${del}`) }).hover();
      await tab.waitForTimeout(300);
      expect((await look(del)).ground).toBe(tokens.hover);
      await tab.mouse.down();
      await tab.waitForTimeout(300);
      expect((await look(del)).turn).not.toBe("none");
      await tab.mouse.up();
      const offAtRest = await look(off);
      expect([offAtRest.ground, offAtRest.ink, offAtRest.cursor]).toEqual([
        tokens.off,
        tokens.onOff,
        "default",
      ]);
      await tab.getByRole("button", { name: new RegExp(`^${off}`) }).hover({ force: true });
      await tab.waitForTimeout(300);
      expect((await look(off)).ground).toBe(tokens.off);
    } finally {
      await tab.close();
    }
  }, 120_000);
});

/** An address of sixty characters, as a person may well have one. */
const LONG = "mila.brunner.household@office.lichtgrat-family-trust.example";

/*
 * THE ADDRESS TO TYPE BACK IS READ WHOLE. The delete page's sentence holds the session's own address as its blank's
 * hint; cut, a person cannot read what to type. Drawn live (the page measures its line in the browser), with every
 * sheet of the doors' states page: the address typed into its blank fits it, the reference's own in a desktop window
 * of 841x673 (two columns at their narrowest) and on the unfolded phone on its side, and an address of sixty
 * characters at the desktop's size.
 */
describe("the delete page's address to type back stands whole", () => {
  let page = "";
  beforeAll(() => {
    page = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { doorsPage } from './packages/app/test/states/build-doors.mjs'; process.stdout.write(await doorsPage());",
      ],
      { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  }, 120_000);
  /* A desktop window takes the desktop's plan from 840 on, whatever its width (the states page's own room). */
  for (const [room, email] of [
    [{ name: "a desktop window", device: null, width: 841, height: 673 }, "mila@lichtgrat.example"],
    [
      { name: "the unfolded phone on its side", device: "foldl", width: 841, height: 673 },
      "mila@lichtgrat.example",
    ],
    [{ name: "the desktop", device: null, width: 1440, height: 900 }, LONG],
  ] as const)
    it(`${room.name} at ${room.width}x${room.height}, ${email.length} characters`, async () => {
      expect(LONG).toHaveLength(60);
      const tab = await browser!.newPage({ viewport: { width: room.width, height: room.height } });
      try {
        await tab.route("http://doors.test/**", (r) => r.fulfill({ contentType: "text/html", body: page }));
        const at = new URLSearchParams({ screen: "deleteaccount", email });
        if (room.device) at.set("device", room.device);
        await tab.goto(`http://doors.test/?${at}`);
        const blank = tab.getByRole("textbox");
        await blank.waitFor();
        await tab.waitForTimeout(300);
        /* What the person types back is the hint they read: as a value it shows whole, or the blank scrolls. */
        const fit = await blank.evaluate((input: HTMLInputElement) => {
          input.value = input.placeholder;
          return { room: input.clientWidth, text: input.scrollWidth, size: getComputedStyle(input).fontSize };
        });
        expect(fit.text, `the blank holds ${fit.room} of ${fit.text} px at ${fit.size}`).toBeLessThanOrEqual(
          fit.room + 1,
        );
        /* What reads the address against its line takes no room of the page's: nothing scrolls sideways. */
        const sideways = await tab.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(sideways).toBeLessThanOrEqual(0);
      } finally {
        await tab.close();
      }
    }, 120_000);
});
