/** @vitest-environment jsdom */
/**
 * Render smoke for every exported component, populated from
 * @ohmail/testing wherever the component has a natural fixture.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { marksUnder, renderedText } from "../../../test/support/wordmark.js";
import { enDecisionCopy } from "./decision-copy.js";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  CommandPalette,
  DecisionBar,
  Doorbell,
  Facets,
  FocusReplyOverlay,
  Icon,
  Kbd,
  ListGroupLabel,
  ListPane,
  ListRows,
  MessageRow,
  PilesStack,
  ProtectedBlock,
  RailNav,
  ReadColumn,
  Reader,
  ReadingPane,
  SearchBox,
  SegmentedControl,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsSubhead,
  SplitButton,
  StreamArt,
  StreamCard,
  Switch,
  TagDot,
  ThemeProvider,
  ToastHost,
  VipChip,
  Waterline,
} from "@ohmail/ui";
import {
  counts,
  getFixtures,
  notificationSettings,
  ohbox,
  reads,
  readsWaterline,
  receipts,
  search,
  triage,
  waiting,
} from "@ohmail/testing";

afterEach(cleanup);

const fx = getFixtures();
const noop = () => {};

const cases: [string, ReactElement][] = [
  [
    "ThemeProvider",
    <ThemeProvider storageKey={null}>
      <span>themed</span>
    </ThemeProvider>,
  ],
  ["Icon", <Icon name="spark" />],
  ["Button", <Button icon="spark" kbdHint="f">Reply Run</Button>],
  ["Kbd", <Kbd>esc</Kbd>],
  [
    "SplitButton",
    <SplitButton label="Ohbox" onPress={noop} check={{ onPress: noop, label: "Ohbox, mark read" }} ai kbdHint="y" />,
  ],
  ["Chip (rationale)", <Chip variant="rationale">{ohbox[0].rationale}</Chip>],
  ["Chip (tracker)", <Chip variant="tracker">{ohbox[0].trackerNote}</Chip>],
  [
    "Chip (ai + actions)",
    <Chip variant="ai" actions={[{ label: "Approve", onPress: noop }, { label: "Correct", onPress: noop }]}>
      Reads — AI 0.87
    </Chip>,
  ],
  ["Chip (tag)", <Chip variant="tag" hue="moss">Pottery Project</Chip>],
  ["Chip (add)", <Chip variant="add" kbdHint="t" onPress={noop}>Tag</Chip>],
  ["Badge", <Badge variant="ai">→ Reads 0.88</Badge>],
  ["TagDot", <TagDot hue="ochre" />],
  ["Avatar", <Avatar initials="L" />],
  [
    "SegmentedControl",
    <SegmentedControl
      ariaLabel="Screener sections"
      value="waiting"
      onChange={noop}
      options={[
        { id: "waiting", label: "Waiting", count: 3 },
        { id: "screened", label: "Screened out", count: 2 },
        { id: "spam", label: "Spam", count: 2 },
      ]}
    />,
  ],
  ["Switch", <Switch checked ariaLabel="Reads" onChange={noop} />],
  ["ToastHost", <ToastHost><span>app</span></ToastHost>],
  ["Card", <Card lift={2} floating>raised</Card>],
  ["Waterline", <Waterline label="Seen up to here" meta={readsWaterline.meta} />],
  [
    "RailNav",
    <RailNav composeLabel="Compose" mailboxesLabel="Mailboxes" ariaLabel="Main"
      onCompose={noop}
      activeId="ohbox"
      onNavigate={noop}
      groups={[
        {
          items: [
            { id: "ohbox", label: "Ohbox", count: counts.ohboxUnread, hot: true },
            { id: "reads", label: "Reads", count: counts.reads },
            { id: "receipts", label: "Receipts", count: counts.receipts },
          ],
        },
        {
          label: "Triage",
          items: [{ id: "triage", label: "Answer Later", count: counts.replyLater }],
          tags: {
            label: "Tags",
            items: fx.tags.map((t) => ({ id: t.id, label: t.name, hue: t.hue, count: t.assignedTo.length })),
          },
        },
      ]}
      mailboxes={fx.mailboxes.map((m) => ({ name: m.name, hint: m.railHint }))}
      /* The host's own controls at the foot of the rail, in the rail's vocabulary — the
         `.ritem` row with a keycap in `.cnt`, exactly as the Search row carries "/". One line:
         `.dock-cmd` takes it, `.dock-theme` is a lone glyph on its right end and therefore
         carries its name in `aria-label` + `title`. */
      dock={
        <>
          <button type="button" className="ritem dock-cmd" onClick={noop}>
            Command
            <span className="cnt">
              <Kbd>⌘K</Kbd>
            </span>
          </button>
          <button
            type="button"
            className="ritem dock-theme"
            onClick={noop}
            aria-label="Theme: Auto (dark). Press for Light"
            title="Theme: Auto (dark). Press for Light"
          >
            <Icon name="auto" />
          </button>
        </>
      }
      footer={fx.account.email}
    />,
  ],
  [
    "MessageRow",
    <MessageRow
      id={ohbox[0].id}
      from={ohbox[0].from.name}
      address={ohbox[0].from.address}
      time={ohbox[0].time}
      subject={ohbox[0].subject}
      preview={ohbox[0].snippet}
      unread
      threadCount={ohbox[0].threadCount}
    />,
  ],
  [
    "ListPane",
    <ListPane title="Ohbox" meta="4 unread of 9" hints={<span>j / k move</span>}>
      <ListGroupLabel>New</ListGroupLabel>
      <ListRows ariaLabel="New">
        <MessageRow id="petra" from="Petra Wyss" subject="Your talk is in! 🎈" unread />
      </ListRows>
    </ListPane>,
  ],
  [
    "StreamCard",
    <StreamCard expandLabel="Expand" collapseLabel="Collapse"
      id={reads[0].id}
      from={reads[0].from.name}
      address={reads[0].from.address}
      time={reads[0].time}
      subject={reads[0].subject}
      body={reads[0].body!}
      unread
    />,
  ],
  [
    "StreamArt",
    <StreamArt ariaLabel="Produktbild" caption="KLAPPRI">
      <svg viewBox="0 0 10 10" />
    </StreamArt>,
  ],
  [
    "ReadingPane",
    <ReadingPane
      from={ohbox[1].from.name}
      address={ohbox[1].from.address}
      time={ohbox[1].time}
      subject={ohbox[1].subject}
      body={ohbox[1].body}
      attachment={{ filename: "Speaker_Info.pdf", size: "1.2 MB" }}
    />,
  ],
  ["ReadColumn", <ReadColumn><span>column</span></ReadColumn>],
  [
    "Reader",
    <Reader returnHint="to return" open onClose={noop}>
      <ReadingPane from="Giulia Ferrari" subject="Re: Glaze order #2214 🎉" body="Buongiorno" />
    </Reader>,
  ],
  [
    "DecisionBar",
    <DecisionBar
      aiDest={waiting[0].ai.dest as "ohbox"}
      scope="sender"
      onScopeChange={noop}
      copy={enDecisionCopy(waiting[0].from.address)}
      onDecide={noop}
    />,
  ],
  [
    "Doorbell",
    <Doorbell actionLabel="Screener ›"
      initials={waiting.map((w) => w.initial)}
      message={<><b>3 new senders</b> waiting</>}
      onPress={noop}
    />,
  ],
  [
    "CommandPalette",
    <CommandPalette placeholder="Type a command…" emptyHint="No command — try “screener”, “tag”, “theme”…" ariaLabel="Command palette" footNavigate="navigate" footRun="run" footClose="close"
      open
      onClose={noop}
      commands={[{ id: "ohbox", label: "Go to Ohbox", keys: ["g", "o"], run: noop }]}
    />,
  ],
  [
    "ProtectedBlock",
    <ProtectedBlock label="Verification code" redactedNote="(redacted)" policy={<><b>Protected</b> — never sent to AI.</>} />,
  ],
  [
    "SearchBox",
    <SearchBox
      value={search.query}
      onChange={noop}
      placeholder="Search everything — typos welcome"
      ariaLabel="Search"
    />,
  ],
  ["Facets", <Facets groups={search.facets} />],
  [
    "SettingsSection + rows",
    <SettingsSection>
      <SettingsRow
        label={notificationSettings.channels[0].label}
        description={notificationSettings.channels[0].description}
        control={<Switch checked ariaLabel={notificationSettings.channels[0].label} onChange={noop} />}
      />
      <SettingsSubhead>{notificationSettings.vipLabel}</SettingsSubhead>
      <SettingsNote>{notificationSettings.privacyNote}</SettingsNote>
    </SettingsSection>,
  ],
  ["VipChip", <VipChip>Petra Wyss</VipChip>],
  [
    "PilesStack",
    <PilesStack
      piles={[
        {
          id: "reply",
          icon: "clock",
          title: "Answer Later",
          count: triage.replyLater.length,
          items: triage.replyLater.map((t) => ({ title: t.title, subtitle: t.subtitle })),
          hint: "Answered one at a time in Reply Run.",
        },
        {
          id: "resurface",
          icon: "up",
          title: "Resurface",
          count: 1,
          items: [{ title: triage.resurface[0].title, when: triage.resurface[0].resurfaceAt }],
        },
      ]}
    />,
  ],
  [
    "FocusReplyOverlay",
    <FocusReplyOverlay
      open
      step={0}
      total={triage.replyLater.length}
      message={{
        subject: triage.replyLater[0].subtitle!,
        from: triage.replyLater[0].title,
        preview: triage.replyLater[0].preview!,
      }}
      onDone={noop}
      onSkip={noop}
      onClose={noop}
      doneLabel="Done → next"
      skipLabel="Skip"
      copy={{
        ariaLabel: "Reply run",
        empty: "Answer Later is empty.",
        emptyBack: "Back to Triage",
        progress: (step: number, total: number) => `${step} of ${total}`,
        placeholder: "Your reply",
        replyAria: "Reply",
        exit: "exit",
      }}
    />,
  ],
];

describe("the reply run's verb is refused while its own send is out", () => {
  /**
   * The host keeps ONE send lane per message and the run shares it with that message's inline
   * editor — the same reply either way. The lock that keeps one press to one delivery therefore
   * made a second press do nothing at all, under a label already reading "Sending…". A control
   * that looks live and is not is worse than a disabled one.
   *
   * Mutation: drop `disabled={donePending}` from the overlay's Done button.
   */
  const overlay = (donePending: boolean): React.ReactElement => (
    <FocusReplyOverlay
      open
      step={0}
      total={1}
      message={{ subject: "s", from: "f", preview: "p" }}
      onDone={noop}
      onSkip={noop}
      onClose={noop}
      doneLabel="Done"
      donePending={donePending}
      skipLabel="Skip"
      copy={{
        ariaLabel: "Reply run",
        empty: "Answer Later is empty.",
        emptyBack: "Back to Triage",
        progress: (step: number, total: number) => `${step} of ${total}`,
        placeholder: "Your reply",
        replyAria: "Reply",
        exit: "exit",
      }}
    />
  );
  const doneOf = (c: HTMLElement): HTMLButtonElement =>
    c.querySelectorAll<HTMLButtonElement>(".fr-foot button")[0]!;

  it("pending refuses the press; idle admits it", () => {
    const pending = render(overlay(true));
    expect(
      doneOf(pending.container).disabled,
      "the verb is live while its own send is already out — a press does nothing at all",
    ).toBe(true);
    const idle = render(overlay(false));
    expect(
      doneOf(idle.container).disabled,
      "the verb is refused when nothing is out there, so the run cannot be finished at all",
    ).toBe(false);
  });
});

describe("render smoke — every exported component", () => {
  it.each(cases)("%s renders", (_name, element) => {
    const { container } = render(element);
    expect(document.body.contains(container)).toBe(true);
  });

  /**
   * The wordmark is painted in two runs — `mail` in ink, `oh` in accent-ink —
   * so the rail echoes the "oh." app mark. That split is exactly why the
   * casing sweep missed it: the source reads `mail<em>oh</em>`, so a grep for
   * the brand name as one string finds nothing, in this file or any other.
   * Four surfaces shipped "OhMail" that way — the rail, the app.ohmail.app gate
   * and sign-in screens, and the demo embedded on the landing page.
   *
   * So this asserts the CONCATENATED text, which is what a person actually
   * reads, and not the markup that produces it.
   *
   * That was written after the CASING sweep. It then held while the
   * `mailoh → ohmail` rename walked past ten other split wordmarks that had no
   * test — the rail was the only one fixed. Those ten now have their own tests
   * (apps/{webapp,admin,landing}/test/wordmark.test.ts) and
   * `test/wordmark-completeness.test.ts` fails if an untested twelfth appears.
   */
  it("the rail wordmark reads 'ohmail' — lower-case, however it is split", () => {
    // No `wordmark` prop, so this renders the DEFAULT — the one every client
    // that does not override it ships.
    const { container } = render(<RailNav composeLabel="Compose" mailboxesLabel="Mailboxes" ariaLabel="Main" groups={[{ items: [{ id: "ohbox", label: "Ohbox" }] }]} />);
    const mark = container.querySelector(".wordmark");
    expect(mark).toBeTruthy();
    expect(mark!.textContent).toBe("ohmail");
    expect(mark!.querySelector("em")!.textContent).toBe("oh");
  });

  /**
   * The other ten surfaces cannot be mounted (async server components,
   * non-exported subcomponents, a static HTML file), so they are asserted by
   * parsing the markup they ship into a DOM. This is the one surface that can
   * be BOTH mounted and parsed, so it proves the parsing method agrees with a
   * real React render — otherwise the ten tests would be trusting an unverified
   * approximation.
   */
  it("the markup audit agrees with a real render of the same component", () => {
    const { container } = render(<RailNav composeLabel="Compose" mailboxesLabel="Mailboxes" ariaLabel="Main" groups={[{ items: [{ id: "ohbox", label: "Ohbox" }] }]} />);
    const real = container.querySelector(".wordmark")!.textContent!.replace(/\s+/g, "");
    const audited = marksUnder("packages/ui/src/composites/RailNav.tsx");
    expect(audited).toHaveLength(1);
    expect(renderedText(audited[0].markup)).toBe(real);
  });

  it("MessageRow renders the receipts amount variant", () => {
    const r = receipts[0];
    const { getByText } = render(
      <MessageRow id={r.id} from={r.from.name} subject={r.subject} amount={r.amount} unread />,
    );
    expect(getByText("CHF 96.00")).toBeTruthy();
  });

  it("MessageRow renders the screener AI-suggestion variant", () => {
    const w = waiting[1];
    const { getByText } = render(
      <MessageRow
        id={w.id}
        from={w.from.name}
        address={w.from.address}
        subject={w.held[0].subject}
        avatarInitial={w.initial}
        aiSuggestion={{ destLabel: "Reads", confidence: w.ai.confidence }}
      />,
    );
    expect(getByText("0.88")).toBeTruthy();
  });
});
