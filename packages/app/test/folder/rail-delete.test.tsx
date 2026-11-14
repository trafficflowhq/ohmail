/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { NONE } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { FOLDERS_ON, LIST_WORDS, listFrame } from "../places/list-seat.js";

const project = {
  id: "projects",
  name: "Projects",
  mailboxId: "work",
  mailbox: "work" + "@" + "example.test",
};

function mount(
  summary: (id: string) => Promise<{ folders: number; messages: number } | null>,
  writable = true,
  extraFolders: readonly (typeof project)[] = [],
) {
  const { host, mail } = listFrame({
    first: "#/ohbox",
    letters: [],
    consent: FOLDERS_ON,
    more: Object.fromEntries([project, ...extraFolders].map((folder) => [`folder:${folder.id}`, folder])),
    mailboxes: async () => [
      {
        id: "work",
        address: project.mailbox,
        status: "connected",
        errorCode: null,
        disabledReason: null,
        syncBlockedReason: null,
        syncBlockedSince: null,
        lastSyncAt: null,
      },
    ],
  });
  render(
    <TextProvider locale="en" messages={LIST_WORDS} timeZone="Europe/Zurich">
      <Frame
        host={{
          ...host,
          capabilities: { ...host.capabilities, foldersStorable: writable },
          wires: { ...host.wires, folderSummary: writable ? summary : NONE },
        }}
      />
    </TextProvider>,
  );
  return mail;
}

async function askDelete() {
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Projects" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
  return await screen.findByRole("alertdialog");
}

afterEach(cleanup);

it("counts before offering Delete folder and sends one request only after confirmation", async () => {
  let answer!: (count: { folders: number; messages: number }) => void;
  const summary = vi.fn(
    () =>
      new Promise<{ folders: number; messages: number }>((resolve) => {
        answer = resolve;
      }),
  );
  const mail = mount(summary);
  const dialog = await askDelete();
  const confirm = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Delete folder" });
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
  expect(confirm.disabled).toBe(true);
  expect(screen.queryByRole("alertdialog", { description: "Counting what moves…" })).toBe(dialog);
  const warning = within(dialog).getByRole("status");
  expect(mail.mutations).toHaveLength(0);
  expect(summary.mock.calls).toEqual([["projects"]]);
  await act(async () => answer({ folders: 2, messages: 3 }));
  expect(
    screen.queryByRole("alertdialog", {
      description: /these 2 folders.*Trash.*the 3 messages.*then removed/,
    }),
  ).toBe(dialog);
  expect(within(dialog).getByRole("status")).toBe(warning);
  expect(warning.textContent?.includes("the 3 messages")).toBe(true);
  expect(document.activeElement).toBe(cancel);
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => expect(mail.mutations).toEqual([{ kind: "folder_delete", folderId: "projects" }]));
});

it("asks without numbers on a count refusal and cancel sends nothing", async () => {
  const mail = mount(async () => {
    throw new Error("count unavailable");
  });
  const dialog = await askDelete();
  expect(
    await screen.findByRole("alertdialog", {
      description: "Everything in it moves to the Trash on your mail server; the folder is then removed.",
    }),
  ).toBe(dialog);
  expect(within(dialog).getByRole("status").textContent?.includes("the folder is then removed")).toBe(true);
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Enter" });
  fireEvent.click(cancel);
  expect(mail.mutations).toHaveLength(0);
});

it("keeps a read-only folder rail free of mutation controls", async () => {
  const summary = vi.fn(async () => null);
  const mail = mount(summary, false);
  fireEvent.contextMenu(await screen.findByRole("button", { name: "Projects" }));
  expect(screen.queryByRole("menuitem", { name: "Delete…" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
  expect(mail.mutations).toHaveLength(0);
  expect(summary).not.toHaveBeenCalled();
});

it("trims pasted names for creates and renames in their existing parents", async () => {
  const mail = mount(async () => null);
  fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
  fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
  const name = screen.getByRole<HTMLInputElement>("textbox", { name: "Folder name" });
  fireEvent.change(name, { target: { value: "Bad*" } });
  fireEvent.submit(name.form!);
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(mail.mutations).toHaveLength(0);
  fireEvent.change(name, { target: { value: "  Archive  " } });
  fireEvent.submit(name.form!);
  await waitFor(() =>
    expect(mail.mutations[0]).toMatchObject({
      kind: "folder_create",
      mailboxId: "work",
      name: "Archive",
    }),
  );

  const openMenu = async () => {
    const projects = screen.getAllByRole("button", { name: "Projects" });
    fireEvent.contextMenu(projects[0]!);
  };
  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "New subfolder" }));
  const subfolder = screen.getByRole<HTMLInputElement>("textbox", { name: "Folder name" });
  fireEvent.change(subfolder, { target: { value: "  Bids  " } });
  fireEvent.submit(subfolder.form!);
  await waitFor(() =>
    expect(mail.mutations[1]).toMatchObject({
      kind: "folder_create",
      mailboxId: "work",
      name: "Projects/Bids",
    }),
  );

  const openRename = async () => {
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    return screen.getByRole<HTMLInputElement>("textbox", { name: "New name" });
  };
  for (const value of ["   ", "  Projects  "]) {
    const rename = await openRename();
    fireEvent.change(rename, { target: { value } });
    fireEvent.submit(rename.form!);
    expect(screen.queryByRole("textbox", { name: "New name" })).toBeNull();
    expect(mail.mutations).toHaveLength(2);
  }

  const rename = await openRename();
  fireEvent.change(rename, { target: { value: "  Work  " } });
  fireEvent.submit(rename.form!);
  await waitFor(() =>
    expect(mail.mutations[2]).toEqual({
      kind: "folder_rename",
      folderId: "projects",
      name: "Work",
    }),
  );
});

it("opens the shelf's Rename and New subfolder editors even when Find has no matches", async () => {
  const extras = Array.from({ length: 12 }, (_, i) => ({
    ...project,
    id: `reserve-${i}`,
    name: `Reserve ${i}`,
  }));
  const mail = mount(async () => null, true, extras);
  fireEvent.click(await screen.findByRole("button", { name: "All folders" }));
  const tree = screen.getByRole("tree", { name: "All folders" });

  for (const [command, label] of [
    ["Rename", "New name"],
    ["New subfolder", "Folder name"],
  ]) {
    const find = within(tree).getByRole<HTMLInputElement>("textbox", { name: "Find a folder" });
    fireEvent.change(find, { target: { value: "unmatched search" } });
    expect(within(tree).getByText("No folder matches.")).toBeTruthy();
    expect(within(tree).queryByRole("button", { name: "Projects" })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(screen.getByRole("menuitem", { name: command }));

    const editor = within(tree).queryByRole("textbox", { name: label });
    expect(editor).not.toBeNull();
    expect(find.value).toBe("");
    expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(editor!, { key: "Escape" });
    expect(within(tree).queryByRole("textbox", { name: label })).toBeNull();
  }
  expect(mail.mutations).toHaveLength(0);
});
