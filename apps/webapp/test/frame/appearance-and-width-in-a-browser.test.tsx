import { createServer } from "node:http";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import RootLayout from "../../app/(product)/layout";
import en from "../../messages/en.json";

const request = vi.hoisted(() => ({ firstPage: null as "now" | "wait" | null }));

vi.mock("next/headers", () => ({
  headers: () => new Headers({
    "x-nonce": "browser-test",
    ...(request.firstPage ? { "x-ohmail-first-page": request.firstPage, cookie: "tf_owner=reader" } : {}),
    ...(request.firstPage === "now" ? { "x-ohmail-first-page-owner": "reader" } : {}),
  }),
}));

let browser: Browser;
let js: string;
let css: string;
let documentHtml: string;

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [join(__dirname, "demo-page/entry.tsx")],
    bundle: true, format: "iife", jsx: "automatic", write: false, outdir: "out",
    alias: { "next-intl": join(__dirname, "../editor-feel/intl-shim.mjs") },
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl" },
    banner: { js: "window.process = window.process || { env: {} };" },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE": "undefined" },
    logLevel: "silent",
  });
  js = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
  documentHtml = "<!doctype html>" + renderToString(await RootLayout({
    children: <div id="app" style={{ display: "contents" }} />,
  }));
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => browser?.close());

function withHead(content: string, html = documentHtml) {
  return html.includes("</head>")
    ? html.replace("</head>", () => content + "</head>")
    : html.replace("<body", () => "<head>" + content + "</head><body");
}

const ORIGIN = "https://mail.browser.test";
const WIDTHS_KEY = "ohmail.ui.columns";

async function openList(page: Page) {
  await page.route("**/*", (route) => {
    const { origin, pathname } = new URL(route.request().url());
    if (origin !== ORIGIN) return route.abort();
    if (pathname === "/page.js") return route.fulfill({ contentType: "application/javascript", body: js });
    if (pathname === "/page.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: withHead('<link rel="stylesheet" href="/page.css">')
        .replace("</body>", '<script src="/page.js"></script></body>'),
    });
  });

  const separator = page.getByRole("separator", { name: en.frame.columns.listWidth });
  const list = page.getByRole("region", { name: en.frame.landmark.list, exact: true });
  const width = async () => (await list.boundingBox())!.width;
  const dragAtListEdge = async (delta: number) => {
    const { x, width } = (await list.boundingBox())!;
    const { y, height } = (await separator.boundingBox())!;
    const gap = await list.evaluate((el) => parseFloat(getComputedStyle(el.parentElement!).columnGap));
    const edge = x + width + gap / 2;
    await page.mouse.move(edge, y + height / 2);
    await page.mouse.down();
    await page.mouse.move(edge + delta, y + height / 2, { steps: 5 });
    await page.mouse.up();
  };

  await page.goto(`${ORIGIN}/demo#/ohbox`);
  await separator.waitFor();
  return { separator, width, dragAtListEdge };
}

describe("the mail frame's list separator", () => {
  it("can be dragged twice at the moving list edge, then dragged again after a reload", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const { separator, width, dragAtListEdge } = await openList(page);
      const initial = await width();
      await dragAtListEdge(90);
      const first = await width();
      expect(first).toBeGreaterThan(initial + 40);
      await dragAtListEdge(-50);
      const second = await width();
      expect(second).toBeCloseTo(first - 50);
      await page.waitForFunction(([key, width]) => JSON.parse(localStorage.getItem(String(key)) ?? "{}").list === width,
        [WIDTHS_KEY, second]);

      await page.reload();
      await separator.waitFor();
      expect(await width()).toBeCloseTo(second);
      await dragAtListEdge(35);
      expect(await width()).toBeCloseTo(second + 35);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("widens the default list by the full distance of a small rightward drag", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const { width, dragAtListEdge } = await openList(page);
      const initial = await width();
      await dragAtListEdge(10);
      expect(await width()).toBeCloseTo(initial + 10);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("narrows a list whose saved width is clamped to leave room for reading", async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    try {
      const saved = 720;
      await page.addInitScript(({ key, saved }) => {
        localStorage.setItem(key, JSON.stringify({ v: 1, list: saved }));
      }, { key: WIDTHS_KEY, saved });
      const { separator, width, dragAtListEdge } = await openList(page);
      const initial = await width();
      expect(initial).toBeLessThan(saved);
      expect(initial - 10).toBeGreaterThanOrEqual(Number(await separator.getAttribute("aria-valuemin")));
      await dragAtListEdge(-10);
      expect(await width()).toBeCloseTo(initial - 10);
    } finally {
      await page.close();
    }
  }, 30_000);
});

const looks = [
  { name: "saved paper and dark", key: "ohmail.face.account", face: "paper", theme: "dark", system: "light",
    platform: "Linux x86_64", ground: "rgb(14, 13, 12)", owner: "reader", deviceFace: null },
  { name: "saved ohmarchy and light", key: "ohmail.face", face: "ohmarchy", theme: "light", system: "dark",
    platform: "Linux x86_64", ground: "rgb(242, 239, 228)" },
  { name: "Linux default with system dark", key: null, face: "ohmarchy", theme: null, system: "dark",
    platform: "Linux x86_64", ground: "rgb(19, 20, 28)" },
  { name: "paper default with system light", key: null, face: "paper", theme: null, system: "light",
    platform: "MacIntel", ground: "rgb(240, 235, 227)" },
  { name: "saved account face, dark scheme and larger text on a signed-in page",
    key: null, face: "ohmarchy", theme: "dark", system: "light", platform: "Linux x86_64",
    ground: "rgb(19, 20, 28)", owner: "reader", deviceFace: "paper" },
  { name: "a signed-in page with another account's saved face",
    key: null, face: "paper", theme: "dark", system: "light", platform: "Linux x86_64",
    ground: "rgb(14, 13, 12)", owner: "previous-reader", deviceFace: null },
  { name: "a wait document with a saved face and no confirmed owner",
    key: null, face: "paper", theme: "dark", system: "light", platform: "Linux x86_64",
    ground: "rgb(14, 13, 12)", owner: "reader", deviceFace: null, firstPage: "wait" },
] as const;

describe("the web document's first paint", () => {
  for (const look of looks) {
    it(look.name, async () => {
      const signedIn = "owner" in look;
      let rendered = documentHtml;
      if (signedIn) {
        request.firstPage = "firstPage" in look ? look.firstPage : "now";
        try {
          rendered = "<!doctype html>" + renderToString(await RootLayout({ children: null }));
        } finally {
          request.firstPage = null;
        }
      }
      const html = withHead(`<style>${css}</style>`, rendered);
      const boundary = html.indexOf(">", html.indexOf("<body")) + 1;
      const page = await browser.newPage({ colorScheme: look.system });
      const server = createServer((request, response) => {
        if (request.url !== "/") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/html",
          "Content-Security-Policy": "script-src 'nonce-browser-test'; style-src 'unsafe-inline'",
        });
        response.write(html.slice(0, boundary));
        // Let Chromium paint while the rest of the streamed body and the app's JavaScript are still pending.
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        await page.addInitScript((saved) => {
          Object.defineProperty(navigator, "platform", { value: saved.platform });
          if (saved.key) localStorage.setItem(saved.key, saved.face);
          if (saved.theme) localStorage.setItem("ohmail.theme", saved.theme);
          if ("owner" in saved) {
            document.cookie = "tf_owner=reader; Path=/";
            localStorage.setItem("ohmail.face.account.owner", saved.owner);
            localStorage.setItem("ohmail.face.account", saved.key ? saved.face : "ohmarchy");
            if (saved.deviceFace) localStorage.setItem("ohmail.face", saved.deviceFace);
            if (!saved.key) localStorage.setItem("ohmail.textSize", "125");
          }
        }, look);
        await page.goto(`http://127.0.0.1:${port}/#/ohbox`, { waitUntil: "commit" });
        await page.waitForFunction(() => performance.getEntriesByName("first-paint").length > 0, null, { timeout: 5000 });
        const first = await page.evaluate(() => ({
          face: document.documentElement.dataset.face ?? "paper",
          scheme: document.documentElement.dataset.scheme,
          theme: document.documentElement.dataset.theme ?? null,
          ground: getComputedStyle(document.body).backgroundColor,
          zoom: Number(getComputedStyle(document.documentElement).zoom),
        }));
        expect(first).toEqual({
          face: look.face, scheme: look.theme ?? look.system, theme: look.theme, ground: look.ground, zoom: signedIn && !look.key ? 1.25 : 1,
        });
      } finally {
        await page.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 15_000);
  }
});
