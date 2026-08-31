/**
 * The reader's settings, kept per manga.
 *
 * A reading setup is a property of the *series*, not of the person. A webtoon wants the long strip,
 * fit to width, and nothing paired; a scanlated seinen wants two pages side by side, right to left,
 * with the margins trimmed. Holding one set of answers for the whole library means the settings are
 * wrong for most of it, and re-tuning them at every title is the same work done by hand — which is
 * what the account-wide store in [[settings.ts]] amounted to for everything on the Layout and Image
 * tabs. The keys are the exception and stay global: a chord is muscle memory, and muscle memory that
 * changed per title would be the one setting here that could actually get someone lost.
 *
 * **A manga holds overrides, not settings.** Anything a title has never been asked about falls
 * through to the account-wide value, so a library that reads mostly one way still opens that way on
 * a title nobody has touched, and nobody loses their setup by upgrading into this file. Changing a
 * setting inside the reader writes it *only* to the manga on screen; the global value is a baseline
 * and is never written back from here.
 *
 * The store of record is the manga's own meta — the same place the zoom level, the source binding
 * and the continue-shelf dismissal already live, so it travels with the account and the backup
 * rather than with a browser profile. One key holds every override as a single JSON object for the
 * same reason the global store does: one mutation, and it cannot half-apply. A title with no
 * overrides left holds no meta row at all, so reading a library once does not leave a row per title
 * saying "this one was never changed".
 *
 * `localStorage` mirrors exactly one manga — the one last open. Reopening the reader on the title
 * you were just reading is the common case (a reload, a chapter typed into the URL), and without a
 * mirror that reopen paints the global layout and then snaps to the manga's own the moment the query
 * lands. Any title further back than that costs one frame, which is what the mirror is worth.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { client } from '../api/client'
import type { Preference } from './settings'

/** On the manga, alongside `stremio4manga.reader-zoom`. */
export const READER_SETTINGS_META_KEY = 'stremio4manga.reader-settings'

/** The one manga the mirror holds, as `{ mangaId, values }`. */
const MIRROR_KEY = 'stremio4manga.reader-settings'

/** The same delay the global store uses: a dragged slider is one write, and closing the tab survives it. */
const WRITE_DELAY = 800

const SET_META_MUTATION = `
  mutation SetReaderSettings($mangaId: Int!, $value: String!) {
    setMangaMeta(input: { meta: { mangaId: $mangaId, key: "${READER_SETTINGS_META_KEY}", value: $value } }) {
      meta { key value mangaId }
    }
  }
`

const DELETE_META_MUTATION = `
  mutation ClearReaderSettings($mangaId: Int!) {
    deleteMangaMeta(input: { mangaId: $mangaId, key: "${READER_SETTINGS_META_KEY}" }) {
      meta { key }
    }
  }
`

type Values = Record<string, string>

const NO_VALUES: Values = {}

function parseValues(parsed: unknown): Values {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_VALUES
  // Only the string entries, for the same reason as in the global store: a hand-edited meta value
  // must not be able to hand a decoder an object.
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === 'string'),
  ) as Values
}

function parseMeta(raw: string | null | undefined): Values {
  if (!raw) return NO_VALUES
  try {
    return parseValues(JSON.parse(raw))
  } catch {
    return NO_VALUES
  }
}

interface Held {
  mangaId: number
  values: Values
}

function readMirror(): Held | null {
  try {
    const raw = localStorage.getItem(MIRROR_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { mangaId?: unknown; values?: unknown } | null
    const mangaId = parsed?.mangaId
    if (typeof mangaId !== 'number' || !Number.isInteger(mangaId)) return null
    return { mangaId, values: parseValues(parsed?.values) }
  } catch {
    // Storage denied, or a value from a shape this version does not know. One frame of the global
    // layout, then the query settles it.
    return null
  }
}

/**
 * What the reader is currently working from: the mirror at import, then whichever manga is opened.
 *
 * One entry rather than a map, because the reader shows one manga at a time and a growing cache of
 * every title ever opened would be a quota problem in exchange for a frame on a re-visit.
 */
let held: Held | null = readMirror()

/**
 * Which manga's meta has actually been read, as opposed to only mirrored.
 *
 * It decides whether a write is safe to push: a change made before the meta has landed would
 * otherwise be written on top of a copy of the overrides that may be missing whatever another device
 * set, and the push replaces the row wholesale. Until adoption, changes are kept and merged into the
 * server's answer instead.
 *
 * An id rather than a flag, because the reader can be showing one title while a stale answer for the
 * previous one arrives — "adopted" is only ever true *of a manga*, never of the store.
 */
let adoptedFor: number | null = null

/**
 * Names changed here since this manga was opened, for the same reason the global store keeps one: a
 * reader who flipped to the strip while the query was in the air meant it, and letting an answer to
 * an older request undo it is the one way this can feel broken.
 */
let changedHere = new Set<string>()

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
    if (held) localStorage.setItem(MIRROR_KEY, JSON.stringify(held))
    else localStorage.removeItem(MIRROR_KEY)
  } catch {
    // A full or forbidden quota costs the fast first paint and nothing else.
  }
}

/** The overrides in force for a manga, or none at all if the one being held is a different title. */
function valuesFor(mangaId: number): Values {
  return held && held.mangaId === mangaId ? held.values : NO_VALUES
}

let writeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The change the server has not been told about yet, carrying its own manga id *and its own values*.
 *
 * Both halves matter. The id, because a pending write belongs to the title it was made on even if
 * the reader has walked to another one since. The values, because reading them back at flush time
 * would read whatever the store holds *then* — and since a title with no overrides is stored by
 * deleting the row, a flush that found the store on a different manga would send a delete and wipe
 * the settings it was supposed to be saving.
 */
let pending: Held | null = null

function scheduleWrite(next: Held): void {
  // Two titles cannot be owed at once: the one going out is paid off before the new one is queued.
  if (pending && pending.mangaId !== next.mangaId) void flushMangaSettings()
  pending = next
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => { void flushMangaSettings() }, WRITE_DELAY)
}

/**
 * Push the pending change now rather than at the end of the debounce — on the way out of a manga, on
 * the way out of the reader, and when the tab is hidden. "Change a setting and immediately close the
 * chapter" is an ordinary thing to do, and the mirror alone would leave the server behind.
 */
export async function flushMangaSettings(): Promise<void> {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  const owed = pending
  pending = null
  if (!owed) return
  const { mangaId, values } = owed
  try {
    // Nothing overridden is stored as *nothing*, so a title tuned and then put back to the account's
    // own settings leaves no row behind.
    await (Object.keys(values).length === 0
      ? client.mutation(DELETE_META_MUTATION, { mangaId }).toPromise()
      : client.mutation(SET_META_MUTATION, { mangaId, value: JSON.stringify(values) }).toPromise())
  } catch {
    // Offline, or the session ended. The mirror still has it, and the next change tries again.
  }
}

/**
 * Take the manga's meta as the truth, except for what has already been changed here.
 *
 * Called when the reader's query lands. It carries `manga.meta` already, so this costs no request of
 * its own.
 */
export function adoptMangaSettings(mangaId: number, meta: Array<{ key: string; value: string }>): void {
  const fromServer = parseMeta(meta.find((entry) => entry.key === READER_SETTINGS_META_KEY)?.value)
  const mine = valuesFor(mangaId)
  const merged: Values = { ...fromServer }
  for (const name of changedHere) {
    if (mine[name] !== undefined) merged[name] = mine[name]
  }

  const touched = [...new Set([...Object.keys(mine), ...Object.keys(merged)])]
    .filter((name) => mine[name] !== merged[name])

  held = { mangaId, values: merged }
  adoptedFor = mangaId
  writeMirror()
  touched.forEach(notify)

  // The server is missing something we hold: a setting changed before its answer arrived. Owed back
  // now that there is a full copy to write it into.
  if (Object.keys(merged).some((name) => fromServer[name] !== merged[name])) scheduleWrite(held)
}

/**
 * The reader has walked to another manga. Whatever the last one still owed goes out now, and the
 * store drops to that title's own overrides — which is nothing until its meta lands, unless it is
 * the mirrored one.
 *
 * Chapters of the same manga do not come through here: the reader stays mounted and the id does not
 * change, so the overrides simply stay in force.
 */
export function openManga(mangaId: number): void {
  if (held?.mangaId === mangaId && adoptedFor === mangaId) return
  void flushMangaSettings()
  changedHere = new Set<string>()
  adoptedFor = null
  const leaving = held
  held = held && held.mangaId === mangaId ? held : null
  // Every name either side of the switch has to repaint: the one going out of force just as much as
  // the one coming in.
  const touched = new Set([...Object.keys(leaving?.values ?? NO_VALUES), ...Object.keys(held?.values ?? NO_VALUES)])
  touched.forEach(notify)
}

function writeOverride(mangaId: number, name: string, raw: string): void {
  const current = valuesFor(mangaId)
  if (current[name] === raw) return
  held = { mangaId, values: { ...current, [name]: raw } }
  changedHere.add(name)
  writeMirror()
  // Before this manga's meta has landed there is no full copy to write into: pushing now would send
  // an override set missing whatever another device had set, and the mutation replaces the row
  // wholesale. Adoption merges this change in and schedules the write itself.
  if (adoptedFor === mangaId) scheduleWrite(held)
  notify(name)
}

/**
 * A preference read for one manga: its own override where it has one, the account-wide value where
 * it does not, and `useState`'s shape either way so it drops in where `Preference.use()` was.
 *
 * Both stores are subscribed to, because either can move underneath a reader sitting on a chapter —
 * the manga's when its meta lands, the account's when the global query does.
 */
export function useMangaPreference<T>(preference: Preference<T>, mangaId: number): [T, (value: T) => void] {
  const [fallback] = preference.use()
  const raw = useSyncExternalStore(
    (listener) => subscribe(preference.name, listener),
    () => valuesFor(mangaId)[preference.name],
  )
  const decoded = raw === undefined ? null : preference.decode(raw)
  const set = useCallback(
    (value: T) => writeOverride(mangaId, preference.name, preference.encode(value)),
    [mangaId, preference],
  )
  return [decoded === null ? fallback : decoded, set]
}
