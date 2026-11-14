/**
 * THE JOIN'S MAILBOX STEP, PROBED BY ROLE AND NAME. The step is the one connect form. The cases that drive it find a
 * field by the label it wears, a provider's tile and a press by their names, the refusal by its role and the consent
 * by its switch. The cases keep the names they had for the fields; this says which label each one is.
 */
import { PROTON, PROVIDERS } from "../app/shell/providers.js";

type Words = Record<string, string>;
type Act = (cb: () => Promise<void> | void) => Promise<void>;

export interface JoinMessages {
  readonly join: Words;
  readonly providerPicker: Words;
}

/** The step's fields, by the names the cases call them. */
export type JoinField = "join-mb-address" | "join-mb-user" | "join-mb-pass" | "join-imap" | "join-smtp";

export function mailboxProbes(host: HTMLElement, messages: JoinMessages, act: Act) {
  const join = messages.join as unknown as Words;
  const picker = messages.providerPicker as unknown as Words;
  const LABEL: Record<JoinField, string> = {
    "join-mb-address": join.mailboxAddress!,
    "join-mb-user": join.mailboxUser!,
    "join-mb-pass": join.appPasswordLabel!,
    "join-imap": join.imapHost!,
    "join-smtp": join.smtpHost!,
  };
  /** A field by its label's words. */
  const labelled = (label: string): HTMLInputElement | null => {
    const found = [...host.querySelectorAll("label")].find((l) => l.textContent === label);
    return found ? (host.ownerDocument.getElementById(found.htmlFor) as HTMLInputElement | null) : null;
  };
  const field = (name: JoinField): HTMLInputElement | null => labelled(LABEL[name]);
  /** A field by the name a case calls it: the mailbox step's by its label, another step's by its own id. */
  const input = (name: string): HTMLInputElement | null =>
    Object.hasOwn(LABEL, name) ? field(name as JoinField) : host.querySelector<HTMLInputElement>(`#${name}`);
  const typeInto = async (input: HTMLInputElement | null, value: string, what: string): Promise<void> => {
    if (input === null) throw new Error(`${what} is not on screen`);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const type = (name: string, value: string): Promise<void> => typeInto(input(name), value, name);
  /** The providers' tiles: the presses of the picker's group that name a provider of the table. */
  const names = new Set(PROVIDERS.map((p) => (p.manual ? picker.otherLabel! : p.label)));
  const group = (): HTMLElement | null =>
    [...host.querySelectorAll<HTMLElement>('[role="group"]')].find(
      (g) => g.getAttribute("aria-label") === picker.label,
    ) ?? null;
  const tiles = (): HTMLElement[] =>
    [...(group()?.querySelectorAll<HTMLElement>("button[aria-pressed]") ?? [])].filter((b) =>
      names.has(b.textContent ?? ""),
    );
  /** The names of the tiles that stand chosen. */
  const checked = (): string[] =>
    tiles()
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent ?? "");
  /** Press the one tile whose name begins with these words. */
  const choose = async (label: string): Promise<void> => {
    const found = tiles().filter((b) => (b.textContent ?? "").startsWith(label));
    if (found.length !== 1) throw new Error(`"${label}" matched ${found.length} tiles`);
    await act(async () => {
      found[0]!.click();
    });
  };
  /** The provider whose mail reaches other apps only through its own bridge: its press beside the tiles. */
  const bridge = (): HTMLElement | null =>
    [...(group()?.querySelectorAll<HTMLElement>("button[aria-pressed]") ?? [])].find(
      (b) => b.textContent === PROTON.label,
    ) ?? null;
  const button = (name: string): HTMLButtonElement | null =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === name) ?? null;
  const link = (name: string): HTMLAnchorElement | null =>
    [...host.querySelectorAll("a")].find((a) => a.textContent === name) ?? null;
  /** Every refusal on screen: what is said as an alert. */
  const alerts = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="alert"]')];
  /**
   * The refusal's own sentence, or `null` where none stands: the words of the alert's line, without the one way on
   * a line may carry beside them (the form's refusal is the kit's line, said as an alert).
   */
  const refusal = (): string | null => {
    const said = alerts()[0] ?? null;
    if (said === null) return null;
    return (said.querySelector('[role="status"] span') ?? said.querySelector(":scope > span") ?? said).textContent;
  };
  /** What is said calmly: a status that stands in no alert. */
  const statuses = (): HTMLElement[] =>
    [...host.querySelectorAll<HTMLElement>('[role="status"]')].filter((s) => s.closest('[role="alert"]') === null);
  /** A consent's switch, by the words it is named with. */
  const consent = (label: string): HTMLElement | null =>
    [...host.querySelectorAll<HTMLElement>('[role="switch"]')].find((s) => s.getAttribute("aria-label") === label) ??
    null;
  return {
    labelled, field, input, type, typeInto, tiles, checked, choose, bridge, button, link, alerts, refusal, statuses, consent,
  };
}

export type MailboxProbes = ReturnType<typeof mailboxProbes>;
