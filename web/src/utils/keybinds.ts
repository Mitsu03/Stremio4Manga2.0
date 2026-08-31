/**
 * The reader's keyboard, as data rather than as a pile of `event.key ===` checks.
 *
 * Every key the reader answers to is an *action* with a list of chords bound to it, and the list is
 * the reader's to change: the defaults below are only what an untouched browser starts with. Two
 * things fall out of that. The reader dispatches by looking an action up rather than by comparing
 * keys, so a rebound key needs no change at the call site; and the panel's shortcut strip and the
 * options dialog both read the same map, so what the reader says its keys are cannot drift from what
 * they actually are.
 *
 * A list per action rather than a single chord, because the defaults already need it — a strip
 * scrolls forward on Space *and* on PageDown, and zooming in has always answered to both `+` and `=`.
 */
import { structured } from './settings'

export type ReaderAction =
  | 'pageLeft'
  | 'pageRight'
  | 'chapterPrevious'
  | 'chapterNext'
  | 'scrollBackward'
  | 'scrollForward'
  | 'screenBackward'
  | 'screenForward'
  | 'toStart'
  | 'toEnd'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'toggleControls'
  | 'toggleOptions'
  | 'offsetSpread'
  | 'toggleFullscreen'

/** The order the options dialog lists them in, grouped the way a reader thinks about them. */
export const KEYBIND_GROUPS: Array<{ name: string; actions: ReaderAction[] }> = [
  { name: 'Turning', actions: ['pageLeft', 'pageRight', 'chapterPrevious', 'chapterNext'] },
  { name: 'Scrolling', actions: ['scrollBackward', 'scrollForward', 'screenBackward', 'screenForward', 'toStart', 'toEnd'] },
  { name: 'Zoom', actions: ['zoomIn', 'zoomOut', 'zoomReset'] },
  { name: 'Controls', actions: ['toggleControls', 'toggleOptions', 'offsetSpread', 'toggleFullscreen'] },
]

export const KEYBIND_LABELS: Record<ReaderAction, string> = {
  pageLeft: 'Page on the left',
  pageRight: 'Page on the right',
  chapterPrevious: 'Previous chapter',
  chapterNext: 'Next chapter',
  scrollBackward: 'Scroll up',
  scrollForward: 'Scroll down',
  screenBackward: 'Screen up',
  screenForward: 'Screen down',
  toStart: 'To the top',
  toEnd: 'To the bottom',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomReset: 'Back to fit',
  toggleControls: 'Show or hide the controls',
  toggleFullscreen: 'Fill the screen',
  toggleOptions: 'Show or hide the options',
  offsetSpread: 'Shift the page pairing',
}

/**
 * What the reader starts with — the keys it answered to before any of this was configurable, plus
 * the three it never had: the two chapter hops (reachable only by running off the end of a chapter)
 * and the options dialog (reachable only by the cog).
 */
export const DEFAULT_KEYBINDS: Record<ReaderAction, string[]> = {
  pageLeft: ['ArrowLeft'],
  pageRight: ['ArrowRight'],
  chapterPrevious: [','],
  chapterNext: ['.'],
  scrollBackward: ['ArrowUp'],
  scrollForward: ['ArrowDown'],
  screenBackward: ['PageUp', 'Shift+Space'],
  screenForward: ['PageDown', 'Space'],
  toStart: ['Home'],
  toEnd: ['End'],
  zoomIn: ['+', '='],
  zoomOut: ['-', '_'],
  zoomReset: ['0'],
  toggleControls: ['h'],
  toggleFullscreen: ['f'],
  toggleOptions: ['s'],
  offsetSpread: ['o'],
}

export type Keybinds = Record<ReaderAction, string[]>

// On the account, with the rest of the settings ([[settings.ts]]): a rebound key is worth as much on
// the second machine as on the first, and it was the one preference here that a cleared browser could
// take away with no way to get it back.
const KEYBINDS = structured<Keybinds>('reader.keybinds', DEFAULT_KEYBINDS, (parsed) => {
  if (typeof parsed !== 'object' || !parsed) return null
  // Merged over the defaults rather than replacing them, so an action added to the reader later still
  // arrives bound: a map saved before it existed simply has nothing to say about it. An empty list is
  // a real answer — "this action has no key" — and is kept as one.
  const bindings = { ...DEFAULT_KEYBINDS }
  for (const action of KEYBIND_ACTIONS) {
    const saved = (parsed as Record<string, unknown>)[action]
    if (isChordList(saved)) bindings[action] = saved
  }
  return bindings
})

/** Every action, in the order the groups list them — the dialog's rows and the reset's reach. */
export const KEYBIND_ACTIONS: ReaderAction[] = KEYBIND_GROUPS.flatMap((group) => group.actions)

/**
 * A key press as a string, and the one place that decides what counts as "the same key".
 *
 * Shift is part of the chord only for keys that have no character of their own. On a printable key
 * the shift is *already* in the character the browser reports — `+` is Shift and `=` on most
 * layouts — so recording it as `Shift++` would make a chord no reader could ever press by name, and
 * `Shift+Space` (which the strip has always read as "a screen backwards") would have no way to exist
 * without it.
 */
export function keyChord(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string {
  const key = event.key === ' ' ? 'Space' : event.key
  const printable = key.length === 1
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.metaKey) parts.push('Meta')
  if (event.shiftKey && !printable) parts.push('Shift')
  // Letters are matched case-insensitively for the same reason: `H` and `h` are one key held two ways.
  parts.push(printable ? key.toLowerCase() : key)
  return parts.join('+')
}

/** The modifiers themselves are not chords — held alone they are half of one still being pressed. */
export function isModifierKey(key: string): boolean {
  return ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead'].includes(key)
}

/** How a chord is written on screen: the arrows and the long names as symbols, the rest as-is. */
const CHORD_SYMBOLS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Space: 'Space',
  Escape: 'Esc',
  Enter: '⏎',
  Backspace: '⌫',
  Tab: '⇥',
}

export function chordLabel(chord: string): string {
  return chord
    .split('+')
    // A trailing `+` bound as a key splits to an empty last part; put it back rather than drop it.
    .map((part, index, parts) => (part === '' && index === parts.length - 1 ? '+' : CHORD_SYMBOLS[part] ?? part))
    .filter((part, index, parts) => !(part === '' && index < parts.length - 1))
    .join(' + ')
}

function isChordList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((chord) => typeof chord === 'string')
}

/** The saved bindings over the defaults, as `useState` would have handed them over. */
export function useKeybinds(): [Keybinds, (bindings: Keybinds) => void] {
  return KEYBINDS.use()
}

/**
 * The bindings as they stand *now*, outside a render.
 *
 * What a functional `setState` updater was for: two chips can be taken off one row faster than a
 * render lands between them, and the second change computed against the render's copy would quietly
 * put the first chord back. The store has no such lag — it is read at the moment it is asked.
 */
export function readKeybinds(): Keybinds {
  return KEYBINDS.get()
}

/** Which action a press means, or null. */
export function actionFor(bindings: Keybinds, chord: string): ReaderAction | null {
  return KEYBIND_ACTIONS.find((action) => bindings[action].includes(chord)) ?? null
}

/**
 * Bind a chord to an action, taking it off whatever else held it.
 *
 * One key, one action: a chord left on two rows would fire whichever the dispatch happened to reach
 * first, which is a coin toss dressed up as a setting. Returns the action it was taken from, so the
 * dialog can say where it went.
 */
export function bindChord(
  bindings: Keybinds,
  action: ReaderAction,
  chord: string,
): { bindings: Keybinds; takenFrom: ReaderAction | null } {
  const previous = actionFor(bindings, chord)
  if (previous === action) return { bindings, takenFrom: null }
  const next = { ...bindings }
  if (previous) next[previous] = next[previous].filter((bound) => bound !== chord)
  next[action] = [...next[action], chord]
  return { bindings: next, takenFrom: previous }
}

export function unbindChord(bindings: Keybinds, action: ReaderAction, chord: string): Keybinds {
  return { ...bindings, [action]: bindings[action].filter((bound) => bound !== chord) }
}

/** True when nothing has been changed — what the dialog's "reset" button is enabled by. */
export function isDefaultKeybinds(bindings: Keybinds): boolean {
  return KEYBIND_ACTIONS.every((action) => {
    const bound = bindings[action]
    const defaults = DEFAULT_KEYBINDS[action]
    return bound.length === defaults.length && bound.every((chord, index) => chord === defaults[index])
  })
}
