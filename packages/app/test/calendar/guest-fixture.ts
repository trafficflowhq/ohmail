import type { CalendarInvitee } from "@ohmail/wire";

export const guestOrganizer = { name: "Robin Field", address: ["robin", "garden.example"].join("@") };
const names = [
  "Ada Field",
  "Bea Finch",
  "Cleo Ash",
  "Devi Reed",
  "Evan Marsh",
  "Faye Grove",
  "Gio Dell",
  "Hana Wick",
  "Ida Hart",
  "Jules Vale",
  "Kai Birch",
  "Lea Moss",
  "Miro Dale",
  "Nia Pine",
  "Oli Holt",
];
const answers = ["accepted", "tentative", "none", "declined"] as const;

export const gardenGuests: CalendarInvitee[] = names.map((name, index) => ({
  name,
  address: [name.toLowerCase().replace(" ", "."), "garden.example"].join("@"),
  role: "required",
  answer: answers[index % answers.length]!,
}));
