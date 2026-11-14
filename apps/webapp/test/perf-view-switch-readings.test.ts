import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");

function writeBundle(dist: string, legacy: boolean) {
  writeFileSync(join(dist, "index.html"), '<nav></nav><main></main><script src="entry.js"></script>');
  writeFileSync(join(dist, "entry.js"), `
    const legacy = ${legacy};
    const nav = document.querySelector("nav");
    const main = document.querySelector("main");
    main.className = "fr-main";
    const ids = ["ohbox", "reads", "receipts", "screener"];
    const names = ["Ohbox", "News", "Receipts", "Screener"];
    const iframe = "<iframe></iframe>";
    const row = '<div class="row" role="button" data-id="letter" data-index="0">Letter</div>';
    nav.innerHTML = ids.map((id, i) => {
      if (legacy) return '<button data-rail-id="' + id + '">' + names[i] + '</button>';
      const railId = id === "reads" ? "news" : id;
      return '<span data-rail-id="' + railId + '"><button>' + names[i] + '</button></span>';
    }).join("") + iframe;

    function draw(place, section = "waiting") {
      let list = row + iframe;
      let reading = "";
      if (place === "reads" || place === "receipts") {
        const name = names[ids.indexOf(place)];
        const card = legacy ? '<div class="scast">' : '<div data-stream-item="letter">';
        reading = '<div role="region" aria-label="' + name + ' stream">' + card + iframe + '</div></div>';
        list = '<div role="region" aria-label="' + name + '">' + list + '</div>';
      }
      if (place === "screener") {
        const sections = ["waiting", "screened", "spam"];
        const labels = ["Waiting", "Screened out", "Spam"];
        const group = legacy ? '<div class="scn-seg">' : '<div role="group" aria-label="Screener sections">';
        const buttons = sections.map((id, i) => {
          const state = legacy ? 'role="tab" aria-selected' : 'aria-pressed';
          return '<button ' + state + '="' + (section === id) + '">' + labels[i] + '</button>';
        }).join("");
        const mark = '<div role="option" data-index="0" data-id="' + section + ':sender">Sender</div>';
        list = group + buttons + '</div><div role="listbox" aria-label="Screener">' + mark + '</div>' + iframe;
      }
      if (legacy && place !== "ohbox") main.innerHTML = '<div class="view-' + place + '">' + list + reading + '</div>';
      else main.innerHTML = '<section class="fr-list"><div class="' + (place === "ohbox" ? 'ob-list' : '') + '">' + list +
        '</div></section><section class="fr-reading">' + reading + '</section>';
      if (place === "screener") main.querySelectorAll("button").forEach((button, i) => {
        button.onclick = () => draw(place, ["waiting", "screened", "spam"][i]);
      });
    }
    nav.querySelectorAll("button").forEach((button, i) => { button.onclick = () => draw(ids[i]); });
    document.addEventListener("keydown", (event) => {
      if (["1", "2", "3"].includes(event.key)) draw(ids[Number(event.key) - 1]);
    });
    window.__harness = { vitals: () => ({}) };
    draw("ohbox");
  `);
}

async function measure(legacy: boolean, scenario: "piles" | "screener") {
  const { runArm } = await import(join(ROOT, "scripts/perf/view-switch.mjs"));
  const dist = mkdtempSync(join(tmpdir(), "ohmail-paint-readings-"));
  try {
    writeBundle(dist, legacy);
    const run = await runArm({ dist, scenario, reps: 1, warm: 0 });
    expect(run.errors).toEqual([]);
    return run.presses as Array<{ view: string; phase: string; iframes: number; cards: number; rows: number }>;
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

it.each([false, true])("reads both pile layouts and counts frames across the active place (legacy=%s)", async (legacy) => {
  const presses = await measure(legacy, "piles");
  expect(presses).toHaveLength(9);
  expect(presses.filter((press) => press.view === "2").map(({ phase }) => phase)).toEqual(["first", "revisit", "first", "rapid"]);
  for (const press of presses) {
    expect(press.rows).toBe(1);
    expect(press.iframes).toBe(press.view === "1" ? 1 : 2);
    expect(press.cards).toBe(press.view === "1" ? 0 : 1);
  }
}, 30_000);

it.each([false, true])("counts active Screener documents on both layouts (legacy=%s)", async (legacy) => {
  const presses = await measure(legacy, "screener");
  expect(presses).toHaveLength(13);
  expect(presses.every(({ iframes }) => iframes === 1)).toBe(true);
}, 30_000);
