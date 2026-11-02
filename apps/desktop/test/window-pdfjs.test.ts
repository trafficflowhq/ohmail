/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE WINDOW'S pdf.js (`src/window-pdfjs.ts`), against a fake Worker and a fake loaded library.
 *
 * The window aliases `pdfjs-dist` to this module, which imports the real library from the dist's
 * own `pdf.min.mjs` and builds pdf.js's worker itself, handing it over as a PORT (the web's
 * `openOverPort`, shared). Left to start a worker of its own, pdf.js answers a refused one by
 * parsing the document on the page's thread; with the port, a refused or dead worker fails the
 * load instead. These cases hold that shape:
 * the one module worker, the port on every load, a refusal and a dead worker that reject rather
 * than hang, a teardown of all three parts, and nothing built for a preview closed early.
 *
 * Watched red: `worker:` dropped from the call into pdf.js → the port case; the race on the
 * worker's `error` dropped → the dead-worker case; `terminate()` dropped → the teardown case.
 *
 * The library is `fixtures/fake-pdfjs/pdf.min.mjs`, at the name the module asks for: the page's
 * base points at that directory, and each case loads a fresh copy (`vi.resetModules`).
 */

type Src = Record<string, unknown> & { worker?: FakePdfWorker };
interface FakePdfWorker {
  port: unknown;
  destroyed: boolean;
  destroy(): void;
}
interface Hooks {
  loads: number;
  events: string[];
  workers: FakePdfWorker[];
  calls: Src[];
  getDocument: (src: Src) => { promise: Promise<unknown>; destroy: () => Promise<void> };
}
const host = globalThis as unknown as { __windowPdfjsFake?: Hooks; Worker?: unknown; pdfjsWorker?: unknown };
const LIBRARY_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pdfjs");

class FakeWorker extends EventTarget {
  static built: FakeWorker[] = [];
  static refuse: Error | null = null;
  terminated = false;
  constructor(public url: URL | string, public options?: WorkerOptions) {
    super();
    if (FakeWorker.refuse) throw FakeWorker.refuse;
    FakeWorker.built.push(this);
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated = true;
    hooks.events.push("worker.terminate");
  }
}

let hooks: Hooks;
let base: HTMLBaseElement | null = null;

/** A loading task as pdf.js gives one: its promise settled by the case, its teardown recorded. */
function deferredTask(opts: { teardownHangs?: boolean } = {}) {
  let resolve!: (doc: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<unknown>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  const task = {
    promise,
    destroy: vi.fn(() => {
      hooks.events.push("task.destroy");
      return opts.teardownHangs ? new Promise<void>(() => {}) : Promise.resolve();
    }),
  };
  return { task, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  FakeWorker.built = [];
  FakeWorker.refuse = null;
  hooks = { loads: 0, events: [], workers: [], calls: [], getDocument: () => deferredTask().task };
  host.__windowPdfjsFake = hooks;
  host.Worker = FakeWorker;
  base = document.createElement("base");
  base.href = pathToFileURL(`${LIBRARY_DIR}/`).href;
  document.head.appendChild(base);
});

afterEach(() => {
  base?.remove();
  delete host.__windowPdfjsFake;
  delete host.Worker;
});

const load = () => import("../src/window-pdfjs.js");
const PARAMS = { data: new Uint8Array([37, 80, 68, 70]), disableAutoFetch: true, disableStream: true };

/** Where a promise stands after `ms`: a load that should fail must not still be pending. */
async function within(p: Promise<unknown>, ms = 1_000): Promise<"resolved" | "rejected" | "pending"> {
  return Promise.race([
    p.then(() => "resolved" as const, () => "rejected" as const),
    new Promise<"pending">((done) => setTimeout(() => done("pending"), ms)),
  ]);
}

/** Until the fake library has been called, or the bound: the first import is a module load. */
async function untilCalled(): Promise<void> {
  for (let i = 0; i < 400 && hooks.calls.length === 0 && FakeWorker.built.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// A loaded runner can take longer than the default 5 s over the module loads these cases wait on.
vi.setConfig({ testTimeout: 15_000 });

describe("the window's pdf.js builds its own worker and hands it over as a port", () => {
  it("one module worker per document, from pdf.worker.min.mjs; the library is imported once, from pdf.min.mjs", async () => {
    const pdfjs = await load();
    expect(pdfjs.PDFJS_FILES).toEqual(["pdf.min.mjs", "pdf.worker.min.mjs"]);
    const first = deferredTask();
    const second = deferredTask();
    const tasks = [first, second];
    hooks.getDocument = () => tasks.shift()!.task;
    const a = pdfjs.getDocument(PARAMS);
    const b = pdfjs.getDocument(PARAMS);
    first.resolve({ numPages: 1 });
    second.resolve({ numPages: 2 });
    await expect(a.promise).resolves.toEqual({ numPages: 1 });
    await expect(b.promise).resolves.toEqual({ numPages: 2 });
    expect(hooks.loads, "the library was imported more than once").toBe(1);
    expect(FakeWorker.built).toHaveLength(2);
    for (const w of FakeWorker.built) {
      expect(String(w.url)).toBe(pathToFileURL(join(LIBRARY_DIR, "pdf.worker.min.mjs")).href);
      expect(w.options).toEqual({ type: "module" });
    }
  });

  it("the real getDocument always receives a PDFWorker on that worker, with the caller's parameters", async () => {
    const pdfjs = await load();
    const t = deferredTask();
    hooks.getDocument = () => t.task;
    const task = pdfjs.getDocument(PARAMS);
    t.resolve({ numPages: 1 });
    await task.promise;
    expect(hooks.calls).toHaveLength(1);
    const call = hooks.calls[0]!;
    expect(call.worker, "pdf.js was left to start a worker of its own").toBe(hooks.workers[0]);
    expect(call.worker?.port).toBe(FakeWorker.built[0]);
    expect(call).toMatchObject(PARAMS);
  });

  it("a worker the policy refuses at construction fails the load, and pdf.js is never asked", async () => {
    const pdfjs = await load();
    FakeWorker.refuse = new Error("refused by worker-src");
    const task = pdfjs.getDocument(PARAMS);
    await expect(task.promise).rejects.toThrow("refused by worker-src");
    expect(hooks.calls, "the document reached pdf.js without a worker").toEqual([]);
    expect(hooks.workers).toEqual([]);
  });

  for (const event of ["error", "messageerror"]) {
    it(`a worker that fires ${event} fails the load instead of leaving it pending`, async () => {
      const pdfjs = await load();
      const t = deferredTask();
      hooks.getDocument = () => t.task;
      const task = pdfjs.getDocument(PARAMS);
      await untilCalled();
      expect(FakeWorker.built).toHaveLength(1);
      FakeWorker.built[0]!.dispatchEvent(new Event(event));
      expect(await within(task.promise), "a dead worker left the load hanging").toBe("rejected");
    });
  }
});

describe("the teardown", () => {
  it("tears down the task, then the PDFWorker, then the worker, once however often it is asked", async () => {
    const pdfjs = await load();
    const t = deferredTask();
    hooks.getDocument = () => t.task;
    const task = pdfjs.getDocument(PARAMS);
    t.resolve({ numPages: 1 });
    await task.promise;
    const first = task.destroy();
    expect(task.destroy(), "a second destroy started a second teardown").toBe(first);
    await first;
    expect(hooks.events).toEqual(["task.destroy", "pdfWorker.destroy", "worker.terminate"]);
    expect(FakeWorker.built[0]!.terminated, "the worker outlived its document").toBe(true);
    expect(hooks.workers[0]!.destroyed).toBe(true);
  });

  it("a preview closed before pdf.js loaded builds no worker and asks pdf.js nothing", async () => {
    const pdfjs = await load();
    const task = pdfjs.getDocument(PARAMS);
    await task.destroy();
    await expect(task.promise).rejects.toThrow();
    expect(FakeWorker.built, "a worker was built for a preview already closed").toEqual([]);
    expect(hooks.calls).toEqual([]);
  });

  it("a dead worker does not hold the teardown: it is terminated though pdf.js never answers", async () => {
    const pdfjs = await load();
    const t = deferredTask({ teardownHangs: true });
    hooks.getDocument = () => t.task;
    const task = pdfjs.getDocument(PARAMS);
    await untilCalled();
    FakeWorker.built[0]!.dispatchEvent(new Event("error"));
    await expect(task.promise).rejects.toThrow();
    expect(await within(task.destroy()), "the teardown waited on a worker that will never answer").toBe("resolved");
    expect(FakeWorker.built[0]!.terminated).toBe(true);
  });

  it("never sets the main-thread worker global pdf.js's fake worker would read", async () => {
    const pdfjs = await load();
    const t = deferredTask();
    hooks.getDocument = () => t.task;
    const task = pdfjs.getDocument(PARAMS);
    t.resolve({ numPages: 1 });
    await task.promise;
    await task.destroy();
    expect("pdfjsWorker" in globalThis).toBe(false);
    // A seam: the overlay hands it the load, and there is no worker option to set.
    expect(pdfjs.seam).toBe(true);
    expect("GlobalWorkerOptions" in pdfjs).toBe(false);
  });
});

function source(rel: string): string {
  try {
    return readFileSync(resolve(process.cwd(), rel), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "../..", rel), "utf8");
  }
}

describe("what the shared overlay asks of pdf.js, and the one version both apps carry", () => {
  /* The alias answers only what `AttachmentPreview` reads; a new read would meet `undefined` in
     the window, so it fails here first. The document it gets back is the real one. */
  it("AttachmentPreview asks for seam and reads getDocument, task.promise and task.destroy, and no layer", async () => {
    const code = source("apps/webapp/app/components/AttachmentPreview.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const of = (re: RegExp) => [...new Set([...code.matchAll(re)].map((m) => m[1]))].sort();
    expect(of(/\b(?:pdfjs|mod)\.(\w+)/g)).toEqual(["getDocument"]);
    expect(code, "the overlay no longer tells a seam from the library").toMatch(/"seam" in mod\b/);
    expect(code, "the overlay sets a worker option pdf.js would start a worker from").not.toMatch(/GlobalWorkerOptions|workerSrc/);
    expect(of(/\btask\??\.(\w+)/g)).toEqual(["destroy", "promise"]);
    expect(code).not.toMatch(/AnnotationLayer|TextLayer|XfaLayer|pdf_viewer|sandbox|pdfjs-dist\//);
    expect(code.match(/await import\(\s*"pdfjs-dist"\s*\)/g) ?? [], "pdf.js is loaded in a second place").toHaveLength(1);
    // Both builds' modules answer both reads.
    for (const alias of [await load(), await import("../src/no-pdfjs.js")]) {
      expect(alias.seam).toBe(true);
      expect(alias.getDocument).toBeTypeOf("function");
    }
  });

  it("apps/desktop and apps/webapp pin the same pdfjs-dist, exactly", () => {
    const pin = (rel: string) => (JSON.parse(source(rel)) as { dependencies: Record<string, string> }).dependencies["pdfjs-dist"];
    expect(pin("apps/desktop/package.json")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin("apps/desktop/package.json")).toBe(pin("apps/webapp/package.json"));
  });
});
