/* The mechanism page of `inline-pictures-frame-mechanism.test.ts`: the real sanitizer and frame
 * document, a picture minted in THIS window (an object URL, or a `data:` URI), and the sandboxed
 * frame the reader mounts — or one control: the frame without `allow-same-origin`, or the frame's
 * policy without `blob:`. And the web's ask: a marked link and an honest one in the reader's
 * frame, armed (`link-ask.ts`) or not. Bundled by the test; nothing here is product code. */
import { buildMailDocument, COPY, FRAME_SANDBOX, sanitizeMailHtml } from "../../app/components/MessageBody";
import { armAsks, askPage } from "../../app/components/link-ask";

const LETTER = `<p>A picture.</p><p><img src="cid:pic@rig" width="32" height="32" alt="pic"></p>`;

interface Arm {
  carrier: "blob" | "data";
  /** The frame's sandbox tokens; the reader's own when absent. */
  sandbox?: string;
  /** The control: the frame's policy as it was, `img-src data:` alone. */
  policyWithoutBlob?: boolean;
}

async function mount(png: number[], arm: Arm): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(png);
  const url = arm.carrier === "blob"
    ? URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
    : `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
  const { html } = sanitizeMailHtml(LETTER, { cidImages: new Map([["pic@rig", url]]) });
  let doc = buildMailDocument(html);
  if (arm.policyWithoutBlob) doc = doc.replace("img-src data: blob:;", "img-src data:;");
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", arm.sandbox ?? FRAME_SANDBOX);
  frame.style.cssText = "width:240px;height:240px;border:0;display:block;background:#fff";
  const loaded = new Promise((done) => frame.addEventListener("load", done, { once: true }));
  frame.srcdoc = doc;
  document.body.replaceChildren(frame);
  await loaded;
  // Until the picture settles where the page can see it; an opaque frame is given a second instead.
  const readable = frame.contentDocument !== null;
  for (let waited = 0; readable && waited < 3000; waited += 50) {
    if (frame.contentDocument?.querySelector("img")?.complete !== false) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  await new Promise((done) => setTimeout(done, readable ? 300 : 1000));
  let naturalWidth: number | null = null;
  try {
    naturalWidth = frame.contentDocument?.querySelector("img")?.naturalWidth ?? null;
  } catch {
    naturalWidth = null;
  }
  return {
    written: html.includes(`src="${url}"`),
    policy: /img-src [^;]*/.exec(doc)?.[0] ?? null,
    sandbox: frame.getAttribute("sandbox"),
    naturalWidth,
  };
}

/** How many pure-red pixels a PNG screenshot holds — read here, where the page can decode one. */
async function redPixels(b64: string): Promise<number> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const g = canvas.getContext("2d")!;
  g.drawImage(bitmap, 0, 0);
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i]! > 200 && d[i + 1]! < 60 && d[i + 2]! < 60) n += 1;
  return n;
}

const ASK_LETTER = `<table width="600"><tr><td>` +
  `<p><a id="ask" href="https://evil.ohmail.test/x?n=1">bank.ohmail.test</a></p>` +
  `<p><a id="honest" href="https://elsewhere.ohmail.test/page">elsewhere.ohmail.test</a></p></td></tr></table>`;

/** The letter in the reader's frame as the web builds it, armed once loaded as the reader arms it, or not. */
async function mountAsk(arm: boolean): Promise<Record<string, unknown>> {
  const { html, asks } = sanitizeMailHtml(ASK_LETTER, { askInPage: true });
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", FRAME_SANDBOX);
  frame.style.cssText = "width:480px;height:200px;border:0;display:block;background:#fff";
  const loaded = new Promise((done) => frame.addEventListener("load", done, { once: true }));
  frame.srcdoc = buildMailDocument(html);
  document.body.replaceChildren(frame);
  await loaded;
  const copy = {
    lang: "en", title: COPY.linkAskTitle, elsewhere: COPY.linkAskElsewhere, goes: COPY.linkAskGoes, open: COPY.linkAskOpen,
    stay: COPY.linkAskStay,
  };
  if (arm) armAsks(frame.contentDocument, (url) => askPage(url, copy));
  const ask = frame.contentDocument?.getElementById("ask");
  // Where each link stands on the page, read from here: the test presses there with the mouse and
  // runs nothing inside the frame, which has no scripts.
  const at = (id: string): { x: number; y: number } => {
    const box = frame.getBoundingClientRect();
    const r = frame.contentDocument!.getElementById(id)!.getBoundingClientRect();
    return { x: box.left + r.left + r.width / 2, y: box.top + r.top + r.height / 2 };
  };
  return {
    asks, href: ask?.getAttribute("href") ?? null, marked: ask?.hasAttribute("data-ohmail-elsewhere") ?? false,
    at: { ask: at("ask"), honest: at("honest") },
  };
}

(window as unknown as { rig: unknown }).rig = { mount, mountAsk, redPixels, FRAME_SANDBOX };
