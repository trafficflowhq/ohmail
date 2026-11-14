/** The door of `keys`: which keys mean what, the registry that dispatches them, the zones and focus, with no markup. */
export { SCROLL_KEYS } from "./scroll-keys.js";
export type { BindingGroup, DisabledReason, KeyBinding } from "./binding.js";
export {
  ariaShortcut,
  BINDING_GROUPS,
  chordKeys,
  chordMatches,
  chordPrefix,
  enterActivatesTarget,
  groupedBindings,
  isTypingTarget,
  KEY_WRITING,
  KeymapContext,
  modGlyph,
  useBinding,
  useCursorPlacer,
  useEnabledBinding,
  useKeyBindings,
  useKeymap,
  useKeymapStore,
  useKeyPress,
  useModGlyph,
  useOptionalKeyBindings,
  useWritingSurface,
} from "./keymap.js";
export type { BindingScope, BoundKey, CursorPlacer, KeymapStore, PlacerScope } from "./keymap.js";
export {
  currentZone,
  leaveRailAfterGoTo,
  READER_SCROLL_STEP,
  setRailSummon,
  useZone,
  useZoneIs,
  useZoneNav,
  ZoneCursor,
} from "./zone-nav.js";
export type { Zone, ZoneListStep, ZoneNavConfig } from "./zone-nav.js";
export { FocusFollows, useFocusFollows } from "./focus-follows.js";
export type { FocusFollowsOptions } from "./focus-follows.js";
