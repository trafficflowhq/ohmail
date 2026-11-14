/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { readFileSync } from "node:fs";
import type { StayVerdict } from "@ohmail/client-engine";
import type { EngineMutation, Folder } from "@ohmail/wire";
import { verdictSentence } from "@ohmail/app-logic/press/press-verdict";
import { confirmSyncOwner, createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { forgetOwner, rememberOwner } from "@ohmail/app-logic/storage/owner-cookie";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { sliceOfDeclaration } from "./source-anchor";
import { act, message, mountShell, stubDom, unmountAll, waitFor } from "./_draft-shell";

type T = Parameters<typeof verdictSentence>[0];
const tEn = createTranslator({ locale: "en", messages: en, namespace: "screening" }) as unknown as T;
const tDe = createTranslator({ locale: "de", messages: de, namespace: "screening" }) as unknown as T;
const still = (stillPlace: string | null): Exclude<StayVerdict, { key: "none" }> =>
  ({ key: "still", count: 5, still: 1, stillPlace, ids: ["h-1"], movable: true }) as Exclude<StayVerdict, { key: "none" }>;

const from = { name: "Fixture sender", address: "sender@example.invalid" };
const folder = "Fixture";
const reportSentence = () => verdictSentence(tEn, still(folder), from.address, "Ohbox");
const report = (el: HTMLElement) => el.querySelector('.fr-report [role="status"]')?.textContent;
const lettersAtTheGate = () => {
  const date = new Date().toISOString();
  return [
    ...Array.from({ length: 5 }, (_, i) => message(`incoming-${i}`, { from, date, folder: "ohmail/Screener" })),
    message("retained", { from, date, folder: folder as Folder }),
  ];
};
async function fileTheSender(): Promise<void> {
  const row = await screen.findByRole("option", { name: /Fixture sender/ });
  fireEvent.contextMenu(row);
  const menu = screen.getByRole("menu");
  fireEvent.click(within(menu).getByText("Ohbox"));
  fireEvent.click(screen.getByRole("button", { name: /^Screened out/ }));
}

afterEach(async () => {
  await unmountAll();
  forgetOwner();
});

describe("the shell's verdict sentence names the one staying place", () => {
  it("a row kept in History is said to be in History, in en and de", () => {
    expect(verdictSentence(tEn, still(null), "info@shop.example", "Ohbox")).toBe("5 are in Ohbox · 1 is still in History.");
    const de1 = verdictSentence(tDe, still(null), "info@shop.example", "Ohbox");
    expect(de1).toContain(de.screening.placeHistory);
    expect(de1).not.toContain("History");
  });

  it("the positive control: a row in a folder is said to be in that folder", () => {
    expect(verdictSentence(tEn, still("Fixture"), "info@shop.example", "Ohbox")).toBe("5 are in Ohbox · 1 is still in Fixture.");
  });

  it("sayVerdict toasts this function's sentence, never its own copy", async () => {
    const source = withoutComments(readFileSync(`${process.cwd()}/packages/app-logic/src/screener/screener-state.ts`, "utf8"));
    const explanation = sliceOfDeclaration(source, "explainDecision");
    expect(explanation).toMatch(/verdictSentence\(ts, verdict,/);
    expect(explanation).not.toMatch(/placeHistory/);
    stubDom();
    const shell = await mountShell("#/screener", lettersAtTheGate(), []);
    await fileTheSender();
    await waitFor(() => shell.sent.some((write) => write.kind === "screener_decide"), "the sender decision on the wire");
    expect(shell.sent.filter((write) => write.kind === "screener_decide")).toHaveLength(1);
    // The report keeps its final word in its own span, so compare the status's full text.
    await waitFor(() => report(shell.el) === reportSentence(), "the report saying where the remaining letter stayed");
  });

  it("an account change after confirmation withholds the previous account's folder from the report", async () => {
    stubDom();
    const owner = "acc-screening-a";
    rememberOwner(owner);
    let changedAccount = false;
    const shell = await mountShell("#/screener", lettersAtTheGate(), [], {
      prepareEngine(engine) {
        registerSyncGate(engine, createSyncGate(owner));
        confirmSyncOwner(engine, owner);
        const mutate = engine.mutate.bind(engine);
        engine.mutate = async (press) => {
          const answer = await mutate(press);
          if (press.kind === "screener_decide" && answer.status === "confirmed") {
            rememberOwner("acc-screening-b");
            changedAccount = true;
          }
          return answer;
        };
      },
    });
    await fileTheSender();
    await waitFor(() => changedAccount, "the browser changes account after confirmation");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(shell.sent.filter((write) => write.kind === "screener_decide")).toHaveLength(1);
    expect(report(shell.el) ?? "").not.toContain(folder);
  });

  it("a bulk decision reports its own summary without a separate per-sender success", async () => {
    stubDom();
    const date = new Date().toISOString();
    const shell = await mountShell("#/screener", [
      message("inbox-a", { from, date }),
      message("inbox-b", { from: { name: "Second sender", address: "another@second.example" }, date }),
    ], []);
    await screen.findByRole("option", { name: /Fixture sender/ });
    await screen.findByRole("option", { name: /Second sender/ });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all spam" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark 2 as spam" }));
    await waitFor(() => report(shell.el)?.includes("2 moved to Spam") === true, "the bulk summary");
    fireEvent.click(screen.getByRole("button", { name: /^Screened out/ }));
    await waitFor(() => shell.sent.filter((write) => write.kind === "rule_create").length === 2, "both presented sender decisions on the wire");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(report(shell.el) ?? "").not.toMatch(/future mail from/i);
  });

  it("a promoted domain decision names the organizer still holding part of the result", async () => {
    stubDom();
    const now = Date.now();
    const held = message("held-for-organizer", {
      from: { name: "Another sender", address: "another@example.invalid" },
      date: new Date(now - 1_000).toISOString(), folder: "ohmail/Screener",
    });
    const decisions: Array<Extract<EngineMutation, { kind: "screener_decide" }>> = [];
    const holder = "Other organizer";
    const shell = await mountShell("#/screener", [message("presented-inbox", { from, date: new Date(now).toISOString() }), held], [], {
      prepareEngine(engine) {
        const mutate = engine.mutate.bind(engine);
        engine.mutate = async (press) => {
          if (press.kind !== "screener_decide") return mutate(press);
          decisions.push(press);
          return { id: "decision", key: "decision", status: "confirmed", seq: null, pendingWith: { name: holder } };
        };
      },
    });
    fireEvent.click(await screen.findByRole("option", { name: /Fixture sender/ }));
    fireEvent.keyDown(document.body, { key: "s" });
    const card = await screen.findByRole("dialog", { name: "Change this sender's screening" });
    fireEvent.click(within(card).getByRole("radio", { name: /the whole domain/ }));
    fireEvent.click(within(card).getByRole("radio", { name: "Ohbox" }));
    fireEvent.click(screen.getByRole("button", { name: /^Screened out/ }));
    await waitFor(() => decisions.length > 0, "the promoted domain decision was sent");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ scope: "domain", senderId: held.id, dest: "ohbox" });
    await waitFor(() => report(shell.el)?.includes(holder) === true, "the report names the organizer that will file the held mail");
  });
});
