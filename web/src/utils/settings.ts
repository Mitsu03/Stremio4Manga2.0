/**
 * Every preference the app keeps, held on the server.
 *
 * The reason is the deployment: one gateway, several accounts, one Suwayomi instance each. A setting
 * in `localStorage` belongs to a *browser profile*, which is the wrong owner twice over — two people
 * sharing a machine inherit each other's reading setup, and one person on a second device inherits
 * nothing. Clearing cookies and site data takes the lot with it. So the store of record is the
 * account's own global meta, the same place the saved searches and the AniList sync stamp already
 * live, and it travels in the backup with them.
 *
 * `localStorage` does not disappear, it changes job: it is a **mirror**, written on every change and
 * read once at import so the very first paint has the right theme, the right language and the right
 * reader layout. Without it the app would paint its defaults and then snap — a flash on every load,
 * on a preference that is almost never wrong. The mirror is a cache and is treated as one: the
 * server's answer replaces it as soon as it arrives, and losing it costs one frame, not a setting.
 *
 * Everything lives under one meta key rather than one row per setting: it is a single query, a single
 * mutation, and it cannot half-apply. The cost is that two tabs changing different settings within
 * the same second let the later write win the pair — an acceptable trade for state a person changes
 * a handful of times a year.
 */
import { useSyncExternalStore } from 'react'
import { client } from '../api/client'

export const SETTINGS_META_KEY = 'stremio4manga.settings'

/** The mirror, and the shape of what it holds: names to their serialised values, exactly as the meta. */
const MIRROR_KEY = 'stremio4manga.settings'

/** Long enough that dragging a slider is one write, short enough to survive closing the tab after it. */
const WRITE_DELAY = 800

const SETTINGS_QUERY = `
  query AppSettings {
    metas(condition: { key: "${SETTINGS_META_KEY}" }) {
      nodes { key value }
    }
  }
`

const SET_SETTINGS_MUTATION = `
  mutation SetAppSettings($value: String!) {
    setGlobalMeta(input: { meta: { key: "${SETTINGS_META_KEY}", value: $value } }) {
      meta { key value }
    }
  }
`

type Values = Record<string, string>

function parseValues(raw: string | null | undefined): Values {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Only the string entries: a hand-edited meta value must not be able to hand a decoder an object.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === 'string'),
    ) as Values
  } catch {
    return {}
  }
}

function readMirror(): Values {
  try {
    return parseValues(localStorage.getItem(MIRROR_KEY))
  } catch {
    // Storage can be denied outright (private mode, a locked-down profile). The app still works; it
    // just paints its defaults for the moment before the server answers.
    return {}
  }
}

let values: Values = readMirror()

/**
 * Names changed on this page since it loaded. The server's copy is authoritative *except* over these:
 * a reader who flipped to double-page while the query was still in the air meant it, and having the
 * answer to a request made before that flip undo it is the one way this store can feel broken.
 */
const changedHere = new Set<string>()

const listeners = new Map<string, Set<() => void>>()

function notify(name: string): void {
  listeners.get(name)?.forEach((listener) => listener())
}

function subscribe(name: string, listener: () => void): () => void {
  const forName = listeners.get(name) ?? new Set<() => void>()
  listeners.set(name, forName)
  forName.add(listener)
  return () => { forName.delete(listener) }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(values))
  } catch {
    // A full or forbidden quota costs the fast first paint and nothing else.
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => { void flushSettings() }, WRITE_DELAY)
}

/**
 * Push the pending change now rather than at the end of the debounce. Called when the page is being
 * hidden, because "change a setting and immediately close the tab" is an ordinary thing to do and the
 * mirror alone would leave the server behind.
 */
export async function flushSettings(): Promise<void> {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  try {
    await client.mutation(SET_SETTINGS_MUTATION, { value: JSON.stringify(values) }).toPromise()
  } catch {
    // Offline, or the session ended. The mirror still has it, and the next change tries again.
  }
}

function readRaw(name: string): string | undefined {
  return values[name]
}

function writeRaw(name: string, raw: string): void {
  if (values[name] === raw) return
  values = { ...values, [name]: raw }
  changedHere.add(name)
  writeMirror()
  scheduleWrite()
  notify(name)
}

/**
 * Take the server's copy as the truth, except for what this page has already changed.
 *
 * Called once, when the query lands. Anything the server does not know about yet — a setting changed
 * here a moment ago, or one migrated out of the old per-setting keys — is kept and pushed back, so
 * adopting never silently drops a preference.
 */
export function adoptSettings(nodes: Array<{ key: string; value: string }> | undefined): void {
  const fromServer = parseValues(nodes?.find((node) => node.key === SETTINGS_META_KEY)?.value)
  const merged: Values = { ...fromServer }
  for (const name of changedHere) {
    const mine = values[name]
    if (mine !== undefined) merged[name] = mine
  }

  const touched = [...new Set([...Object.keys(values), ...Object.keys(merged)])]
    .filter((name) => values[name] !== merged[name])

  values = merged
  writeMirror()
  touched.forEach(notify)

  // The server is missing something we hold: settings changed before the answer arrived, or brought
  // over from the old browser-only keys by the migration below.
  const owed = Object.keys(merged).some((name) => fromServer[name] !== merged[name])
  if (owed) scheduleWrite()
}

/** One query at start-up, adopted whenever it answers. Failure is silent: the mirror carries the app. */
export async function loadSettings(): Promise<void> {
  try {
    const result = await client.query<{ metas: { nodes: Array<{ key: string; value: string }> } }>(
      SETTINGS_QUERY,
      {},
      { requestPolicy: 'network-only' },
    ).toPromise()
    adoptSettings(result.data?.metas.nodes)
  } catch {
    // No answer means no adoption. Everything already works off the mirror.
  }
}

export interface Preference<T> {
  /**
   * The name it is stored under. Exposed because a preference can also be held somewhere other than
   * the account-wide store — the reader keeps most of its settings per manga ([[mangaSettings.ts]]),
   * and an override store has to key on the same name the global value uses or the two would drift.
   */
  readonly name: string
  /**
   * The encoding, opened up for the same reason as the name: an override is the identical string in
   * a different place, so it must be read and written by the identical pair of functions. `decode`
   * returning null means "not a value I recognise", exactly as it does below.
   */
  decode(raw: string): T | null
  encode(value: T): string
  /** Outside React: module scope, callbacks, one-off reads. */
  get(): T
  set(value: T): void
  /**
   * `useState`'s shape, so a preference drops straight in where one used to be — and, unlike a
   * `useState` seeded from storage, it catches up on its own when the server's copy arrives.
   */
  use(): [T, (value: T) => void]
  /**
   * For the settings that are applied to the document rather than rendered — the theme paints the
   * root element, the language sets `lang` — which have to be re-applied when the server's copy turns
   * out to differ from the mirror this page painted with.
   */
  subscribe(listener: () => void): () => void
}

/**
 * Declare a preference: a name, what it is when nothing has been chosen, and how it survives being a
 * string. Keeping the three together is the point — a name, a default and a parser that drift apart
 * across files is how a setting ends up meaning one thing where it is written and another where it is
 * read.
 *
 * `decode` returning null means "this is not a value I recognise", which reads as the default. That
 * covers a hand-edited meta, a setting written by a newer version of the app, and a value whose
 * options have since changed.
 */
export function preference<T>(
  name: string,
  fallback: T,
  decode: (raw: string) => T | null,
  encode: (value: T) => string,
): Preference<T> {
  const get = (): T => {
    const raw = readRaw(name)
    if (raw === undefined) return fallback
    const decoded = decode(raw)
    return decoded === null ? fallback : decoded
  }

  const set = (value: T): void => writeRaw(name, encode(value))

  return {
    name,
    decode,
    encode,
    get,
    set,
    subscribe: (listener) => subscribe(name, listener),
    use(): [T, (value: T) => void] {
      // The snapshot has to be the raw string: `get()` builds a fresh object for the JSON-shaped
      // preferences, and returning a new one each time would loop the store forever.
      const raw = useSyncExternalStore(
        (listener) => subscribe(name, listener),
        () => readRaw(name),
      )
      const decoded = raw === undefined ? null : decode(raw)
      return [decoded === null ? fallback : decoded, set]
    },
  }
}

/** One of a fixed set of strings — the commonest shape by far. */
export function choice<T extends string>(name: string, fallback: T, options: readonly T[]): Preference<T> {
  return preference<T>(
    name,
    fallback,
    (raw) => (options.includes(raw as T) ? (raw as T) : null),
    (value) => value,
  )
}

/** On or off, spelled out rather than stored as "true": the meta is meant to be readable. */
export function flag(name: string, fallback: boolean): Preference<boolean> {
  return preference<boolean>(
    name,
    fallback,
    (raw) => (raw === 'on' ? true : raw === 'off' ? false : null),
    (value) => (value ? 'on' : 'off'),
  )
}

/** A number inside a range, snapped to a step where one is given. Anything outside reads as the default. */
export function quantity(
  name: string,
  fallback: number,
  { min, max, step }: { min: number; max: number; step?: number },
): Preference<number> {
  return preference<number>(
    name,
    fallback,
    (raw) => {
      const value = Number(raw)
      if (!Number.isFinite(value)) return null
      const snapped = step ? Math.round(value / step) * step : value
      return snapped >= min && snapped <= max ? snapped : null
    },
    (value) => String(value),
  )
}

/**
 * Anything with a shape of its own. `revive` is handed the parsed JSON and must return a value or
 * null; it is the only thing standing between a corrupt entry and the code that consumes it, so it
 * validates rather than casts.
 */
export function structured<T>(name: string, fallback: T, revive: (parsed: unknown) => T | null): Preference<T> {
  return preference<T>(
    name,
    fallback,
    (raw) => {
      try {
        return revive(JSON.parse(raw))
      } catch {
        return null
      }
    },
    (value) => JSON.stringify(value),
  )
}

/**
 * The old per-setting `localStorage` keys, brought over once.
 *
 * Without this, moving the store to the server would read to everyone as "the app forgot my
 * settings". It runs before the first query lands, so the migrated values are in `changedHere` and
 * survive adoption; the old keys are then removed, which is what makes it run exactly once.
 */
export function migrateLegacySettings(): void {
  for (const [from, to] of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(from)
      if (raw === null) continue
      if (values[to] === undefined) writeRaw(to, raw)
      localStorage.removeItem(from)
    } catch {
      return
    }
  }
  try {
    for (const key of REMOVED_KEYS) localStorage.removeItem(key)
  } catch {
    // Nothing to clean up if storage is unreadable in the first place.
  }
}

/**
 * Old key to new name, for everything that used to have a `localStorage` entry of its own.
 *
 * The stored *values* carry over untouched — the encodings here are the ones those keys already used,
 * which is why this is a rename and not a conversion. Kept as one table rather than spread across the
 * modules that own each setting: what a reader wants when they find a stray key in a browser is a
 * single place that says where it went.
 */
const LEGACY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['stremio4manga.reader.mode', 'reader.mode'],
  ['stremio4manga.reader.fit', 'reader.fit'],
  ['stremio4manga.reader.direction', 'reader.direction'],
  ['stremio4manga.reader.spread', 'reader.spread'],
  ['stremio4manga.reader.spread-offset', 'reader.spread-offset'],
  ['stremio4manga.reader.sliding', 'reader.sliding'],
  ['stremio4manga.reader.keyboard-scroll', 'reader.keyboard-scroll'],
  ['stremio4manga.reader.progress-bar', 'reader.progress-bar'],
  ['stremio4manga.reader.background', 'reader.background'],
  ['stremio4manga.reader.grayscale', 'reader.grayscale'],
  ['stremio4manga.reader.invert', 'reader.invert'],
  ['stremio4manga.reader.download-ahead', 'reader.download-ahead'],
  ['stremio4manga.reader.crop', 'reader.crop'],
  ['stremio4manga.reader.dim', 'reader.dim'],
  ['stremio4manga.reader.autoscroll', 'reader.autoscroll'],
  ['stremio4manga.reader.wakelock', 'reader.wakelock'],
  ['stremio4manga.reader.tap-layout', 'reader.tap-layout'],
  ['stremio4manga.reader.options-open', 'reader.options-open'],
  ['stremio4manga.reader.keybinds', 'reader.keybinds'],
  ['stremio4manga:theme', 'theme'],
  ['stremio4manga:language', 'language'],
  ['stremio4manga.library.shelf', 'library.shelf'],
  ['stremio4manga.library.grouping', 'library.grouping'],
  ['stremio4manga.library.category-hidden', 'library.category-hidden'],
  ['stremio4manga.library.sort', 'library.sort'],
  ['stremio4manga.discover.feed-open', 'discover.feed-open'],
]

/**
 * Keys that are simply gone, swept up on the same pass.
 *
 * The strip's width was one setting for the whole library; it is now kept per manga, in that manga's
 * own meta, so there is nothing here for it to become.
 */
const REMOVED_KEYS: readonly string[] = ['stremio4manga.reader.strip-zoom']
