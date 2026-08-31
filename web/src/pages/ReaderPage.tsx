import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'urql'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../api/session'
import { friendlyError } from '../utils/errors'
import { t } from '../utils/i18n'
import { ENQUEUE_DOWNLOADS_MUTATION, START_DOWNLOADER_MUTATION } from '../utils/downloads'
import { ANILIST_TRACKER_ID } from '../utils/tracking'
import {
  DEFAULT_KEYBINDS,
  KEYBIND_GROUPS,
  KEYBIND_LABELS,
  actionFor,
  bindChord,
  chordLabel,
  isDefaultKeybinds,
  isModifierKey,
  keyChord,
  readKeybinds,
  unbindChord,
  useKeybinds,
  type ReaderAction,
} from '../utils/keybinds'
import { choice, flag, preference, quantity } from '../utils/settings'
import { adoptMangaSettings, flushMangaSettings, openManga, useMangaPreference } from '../utils/mangaSettings'

const READER_QUERY = `
  query ReaderContext($mangaId: Int!) {
    manga(id: $mangaId) {
      id title
      meta { key value }
      trackRecords { nodes { trackerId remoteUrl } }
    }
    chapters(condition: { mangaId: $mangaId }, order: { by: SOURCE_ORDER }) {
      nodes { id name sourceOrder chapterNumber realUrl isDownloaded }
    }
  }
`

// Zoom lives in the manga's own meta rather than in this browser, so it follows the reader between
// machines and belongs to the account rather than to the profile — the same store the source binding
// and the continue-shelf dismissal already use. One key holding both layouts: a strip's zoom is a
// column width and a page's is a magnification, and writing them together keeps a change to one from
// costing a second round trip.
const ZOOM_META_KEY = 'stremio4manga.reader-zoom'

const SET_ZOOM_META_MUTATION = `
  mutation SetReaderZoom($mangaId: Int!, $value: String!) {
    setMangaMeta(input: { meta: { mangaId: $mangaId, key: "${ZOOM_META_KEY}", value: $value } }) {
      meta { key value mangaId }
    }
  }
`

// Fit is stored as *nothing*: a library read once should not end up with a meta row per title saying
// "this one was never zoomed".
const DELETE_ZOOM_META_MUTATION = `
  mutation ClearReaderZoom($mangaId: Int!) {
    deleteMangaMeta(input: { mangaId: $mangaId, key: "${ZOOM_META_KEY}" }) {
      meta { key }
    }
  }
`

const FETCH_PAGES_MUTATION = `
  mutation FetchChapterPages($chapterId: Int!) {
    fetchChapterPages(input: { chapterId: $chapterId }) {
      pages
      chapter { id name pageCount lastPageRead }
    }
  }
`

interface ReaderChapter {
  id: number
  name: string
  sourceOrder: number
  chapterNumber: number
  /** This chapter's own page on the source site. Null on sources that publish no per-chapter URL. */
  realUrl: string | null
  isDownloaded: boolean
}

interface ReaderQueryResult {
  /** The manga being read is the source-bound copy, so it is the one carrying the track record. */
  manga: {
    id: number
    title: string
    meta: Array<{ key: string; value: string }>
    trackRecords: { nodes: Array<{ trackerId: number; remoteUrl: string | null }> }
  }
  chapters: { nodes: ReaderChapter[] }
}

interface FetchPagesResult {
  fetchChapterPages: {
    pages: string[]
    chapter: { id: number; name: string; pageCount: number; lastPageRead: number }
  } | null
}

type ReaderMode = 'paged' | 'strip'
type PageFit = 'height' | 'width'
// Which side of the page turns forward. Strip mode has no handedness — vertical scrolling reads the
// same either way — so this only ever applies to paged mode.
type ReadingDirection = 'ltr' | 'rtl'
// The three layouts as the options menu names them. Single and Double are both paged mode with the
// spread off and on — one control rather than a mode plus a checkbox, because "how is the chapter
// laid out" is one question with three answers.
type ReaderLayout = 'single' | 'double' | 'strip'
// Whether the scrolling keys jump or animate. The distance is the same either way.
type KeyboardScroll = 'fast' | 'smooth'
// Which edge the reading progress runs along, or nothing at all.
type ProgressBarPosition = 'left' | 'top' | 'right' | 'bottom' | 'off'
type OptionsTab = 'layout' | 'image' | 'keys'
// 'pending' while the saved position is still unknown, 'free' once the reader follows the user's scroll.
type StripAnchor = 'pending' | 'free' | number

// The scrolling half of the keyboard, named by what it does rather than by which key does it: every
// one of these is rebindable (section 36), so anything that used to test `event.key` now tests the
// action the press resolved to.
//
// Scrolling the strip means the reader should stop holding the resume anchor.
const SCROLL_ACTIONS = new Set<ReaderAction>(['scrollBackward', 'scrollForward', 'screenBackward', 'screenForward', 'toStart', 'toEnd'])
// Actions that mean "more, please" — at the bottom of the strip they open the next chapter. Not
// `toEnd`: jumping to the bottom is arriving somewhere, not asking for what comes after it.
const ADVANCE_ACTIONS = new Set<ReaderAction>(['scrollForward', 'screenForward'])
// Actions that move by a screen rather than by a nudge.
const SCREEN_SCROLL_ACTIONS = new Set<ReaderAction>(['screenBackward', 'screenForward'])
// Actions that move backwards.
const BACKWARD_SCROLL_ACTIONS = new Set<ReaderAction>(['scrollBackward', 'screenBackward'])

// The four the panel's footer strip names, and what to call each. One chord per action: the strip is
// a reminder, not the settings screen.
const SHORTCUT_STRIP: Array<{ actions: ReaderAction[]; name: string }> = [
  { actions: ['pageLeft', 'pageRight'], name: 'pages' },
  { actions: ['chapterPrevious', 'chapterNext'], name: 'chapters' },
  { actions: ['toggleControls'], name: 'controls' },
  { actions: ['zoomIn', 'zoomOut'], name: 'zoom' },
]
// How far a scrolling key travels, as a fraction of what is on screen.
const KEY_SCROLL_NUDGE = 0.28
const KEY_SCROLL_SCREEN = 0.9
// Wheel distance to keep scrolling past the end of the strip before the next chapter opens.
const STRIP_OVERSCROLL = 220
// A pause this long ends the current wheel gesture, so momentum alone never carries into a chapter.
const WHEEL_GESTURE_GAP = 600

function wheelDistance(event: WheelEvent, viewportHeight: number): number {
  if (event.deltaMode === 1) return event.deltaY * 16
  if (event.deltaMode === 2) return event.deltaY * viewportHeight
  return event.deltaY
}

function isFormControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['SELECT', 'INPUT', 'TEXTAREA'].includes(target.tagName)
}

// How many pages to pull in behind the current one, matching Mihon's HttpPageLoader preloadSize.
const PREFETCH_AHEAD = 4

// The surround the reader has always had, and what "Fixed" means.
const READER_BACKDROP: [number, number, number] = [36, 38, 41]
const READER_BACKDROP_CSS = `rgb(${READER_BACKDROP.join(' ')})`
// Long edge of the sampling canvas. An average colour does not need resolution, and a full-size
// buffer per page is real memory over a long chapter.
const BACKDROP_SAMPLE_EDGE = 64
// How far in from each edge to read, in sampled pixels — enough to miss a stray border line.
const BACKDROP_STRIP = 3
// How far the surround travels from the fixed colour toward the page's own edge. Dark pages are
// followed closely because that is the case worth having; bright ones are held back, since a white
// page at full strength turns the whole window into a lamp.
const BACKDROP_PULL_DARK = 0.62
const BACKDROP_PULL_LIGHT = 0.28

// Border trimming reads geometry rather than an average, so it samples finer than the backdrop does —
// but still nowhere near full size: a border is measured in percents of a page, not in pixels.
const CROP_SAMPLE_EDGE = 96
// How far a pixel may drift from the border's own colour and still count as border. Wide enough for
// JPEG noise in a flat white margin, narrow enough that artwork does not read as filler.
const CROP_TOLERANCE = 14
// What fraction of a line must match for the line to be border. Not 1: a stray dark pixel, a scanner
// mark or a page number in the margin should not stop the trim.
const CROP_SOLID = 0.92
// Never trim more than this from one side, however far the flat colour runs. A page that is mostly
// flat colour by design is not a page with a border, and a runaway scan would eat the artwork.
const CROP_MAX_SIDE = 0.35
// How long a stretch of non-matching lines may sit *inside* a margin and still be margin, as a
// fraction of the page. Scanlator watermarks live in the margin, and stopping at the first line they
// touch leaves the whole band behind them uncropped — which is what the first version of this did.
const CROP_GAP = 0.04
// Below this there is nothing to gain, and a one-pixel trim would only make the layout twitch.
const CROP_MIN_SIDE = 0.02

/** How much of each edge is solid filler, in fractions, plus the aspect of what is left. */
interface PageCrop {
  top: number
  right: number
  bottom: number
  left: number
  /** Width over height of the kept region — what the layout has to be shaped like. */
  aspect: number
}

/**
 * Find the solid border around a page, the way Mihon's crop-borders does: walk in from each edge for
 * as long as the lines keep matching the colour the edge started with.
 *
 * Returns null when there is nothing worth trimming — including for a page that is *all* flat colour,
 * where every scan would run to its limit and "cropping" would mean inventing a frame.
 */
function measureCrop(image: HTMLImageElement): PageCrop | null {
  try {
    const { naturalWidth, naturalHeight } = image
    if (!naturalWidth || !naturalHeight) return null
    const scale = CROP_SAMPLE_EDGE / Math.max(naturalWidth, naturalHeight)
    const width = Math.max(8, Math.round(naturalWidth * scale))
    const height = Math.max(8, Math.round(naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, width, height)
    const { data } = context.getImageData(0, 0, width, height)

    const pixelAt = (x: number, y: number): [number, number, number] => {
      const offset = (y * width + x) * 4
      return [data[offset], data[offset + 1], data[offset + 2]]
    }
    const alike = (a: [number, number, number], b: [number, number, number]): boolean =>
      Math.abs(a[0] - b[0]) <= CROP_TOLERANCE && Math.abs(a[1] - b[1]) <= CROP_TOLERANCE && Math.abs(a[2] - b[2]) <= CROP_TOLERANCE

    // `horizontal` scans rows (trimming top or bottom); otherwise columns (left or right).
    const solidLine = (index: number, horizontal: boolean, reference: [number, number, number]): boolean => {
      const length = horizontal ? width : height
      let matched = 0
      for (let step = 0; step < length; step += 1) {
        if (alike(horizontal ? pixelAt(step, index) : pixelAt(index, step), reference)) matched += 1
      }
      return matched / length >= CROP_SOLID
    }
    // Each side takes its reference from its own outermost line, so a page with a white margin at the
    // top and a black one at the bottom is trimmed on both rather than on neither.
    const scanSide = (horizontal: boolean, fromStart: boolean): { inset: number; capped: boolean } => {
      const span = horizontal ? height : width
      const limit = Math.floor(span * CROP_MAX_SIDE)
      const edge = fromStart ? 0 : span - 1
      const step = fromStart ? 1 : -1
      const reference = horizontal ? pixelAt(Math.floor(width / 2), edge) : pixelAt(edge, Math.floor(height / 2))
      const gapLimit = Math.max(2, Math.floor(span * CROP_GAP))
      // The trim is the *furthest* border line found, not the first mismatch: a watermark sitting in
      // the margin is a short stretch of non-matching lines with more margin behind it, while artwork
      // is a stretch that never ends. Anything longer than the gap allowance is taken for artwork.
      let cursor = 0
      let lastBorder = -1
      let gap = 0
      while (cursor < limit) {
        if (solidLine(edge + step * cursor, horizontal, reference)) {
          lastBorder = cursor
          gap = 0
        } else {
          gap += 1
          if (gap > gapLimit) break
        }
        cursor += 1
      }
      const inset = lastBorder + 1
      return { inset: inset / span, capped: inset >= limit }
    }

    const top = scanSide(true, true)
    const bottom = scanSide(true, false)
    const left = scanSide(false, true)
    const right = scanSide(false, false)
    // Every side running to its cap is the signature of a blank or single-colour page, not of a border.
    if (top.capped && bottom.capped && left.capped && right.capped) return null

    const keep = (side: { inset: number }): number => (side.inset >= CROP_MIN_SIDE ? side.inset : 0)
    const insets = { top: keep(top), right: keep(right), bottom: keep(bottom), left: keep(left) }
    if (insets.top + insets.right + insets.bottom + insets.left === 0) return null

    const keptWidth = 1 - insets.left - insets.right
    const keptHeight = 1 - insets.top - insets.bottom
    return { ...insets, aspect: (naturalWidth * keptWidth) / (naturalHeight * keptHeight) }
  } catch {
    // Tainted canvas or an image that decoded into nothing: show the page as it is.
    return null
  }
}

const CROP_BORDERS = flag('reader.crop', false)

// Zoom is a preference of the *series* rather than a moment on one panel: a dense seinen page wants a
// closer look than a webtoon does, and the level a reader settled on for one title says nothing about
// the next. So it is kept in that manga's meta (see ZOOM_META_KEY), and a title that was never zoomed
// opens at fit — deliberately with no shared fallback for a new manga to inherit a stranger's level.
const ZOOM_MIN = 1
const ZOOM_MAX = 4
/** What "not zoomed" is in either layout: a page at its fit size, a strip at its natural width. */
const ZOOM_FIT = 1
// What a double tap, a double click and the keyboard all jump to — enough to read small dialogue without
// losing the rest of the panel.
const ZOOM_STEP_TO = 2
const ZOOM_KEY_STEP = 0.5
// What the slider moves in. Quarters in both layouts, so the two read the same way even though they
// cover different ranges.
const ZOOM_SLIDER_STEP = 0.25

// A long strip zooms by *width*, not by transform: the strip is already the scroller, and scaling it
// would fight the scrolling it is built on. What a reader wants from a strip is a wider or narrower
// column, so that is what the same control does there, and the browser's own scrollbars carry the
// panning for free.
const STRIP_ZOOM_MIN = 0.5
const STRIP_ZOOM_MAX = 3
const STRIP_ZOOM_STEP = 0.25

/** The span the slider covers, which is the layout's own: a strip can go narrower than fit, a page cannot. */
function zoomRange(mode: ReaderMode): { min: number; max: number } {
  return mode === 'strip' ? { min: STRIP_ZOOM_MIN, max: STRIP_ZOOM_MAX } : { min: ZOOM_MIN, max: ZOOM_MAX }
}

/** A dragging slider would otherwise send a mutation per quarter-step. */
const ZOOM_WRITE_DELAY = 600

interface ZoomLevels {
  paged: number
  strip: number
}

const NO_ZOOM_LEVELS: ZoomLevels = { paged: ZOOM_FIT, strip: ZOOM_FIT }

function clampLevel(level: unknown, mode: ReaderMode): number {
  const { min, max } = zoomRange(mode)
  const value = Number(level)
  return Number.isFinite(value) && value >= min && value <= max ? value : ZOOM_FIT
}

/**
 * The levels a manga's meta is carrying, if any. Anything unreadable — a key that was never written,
 * a value from a future shape of this object — reads as fit rather than throwing a reader that would
 * otherwise have opened fine.
 */
function zoomFromMeta(meta: Array<{ key: string; value: string }>): ZoomLevels {
  const raw = meta.find((entry) => entry.key === ZOOM_META_KEY)?.value
  if (!raw) return NO_ZOOM_LEVELS
  try {
    const parsed = JSON.parse(raw)
    return { paged: clampLevel(parsed?.paged, 'paged'), strip: clampLevel(parsed?.strip, 'strip') }
  } catch {
    return NO_ZOOM_LEVELS
  }
}

// Past this a pointer is panning rather than tapping, so the tap it ends on must not turn the page.
const DRAG_SLOP = 8
/**
 * How far across the stage a finger has to travel before it is a page turn.
 *
 * A fraction rather than a pixel count, so the gesture asks the same *effort* of a phone and a
 * desktop - the same reasoning the auto-scroll speeds use. Deliberately far above `DRAG_SLOP`:
 * 8px means "this was not a tap", which is nowhere near enough commitment to throw a page away.
 */
const SWIPE_FRACTION = 0.15
/** A floor for the fraction above, so a very narrow window cannot make the gesture trivial. */
const SWIPE_MIN = 48
// Two taps closer together than this, and nearer than DOUBLE_TAP_SLOP apart, are one gesture.
const DOUBLE_TAP_MS = 320
const DOUBLE_TAP_SLOP = 40

interface ZoomState {
  scale: number
  /** Where the page's centre sits relative to the middle of the stage, in screen pixels. */
  x: number
  y: number
}

const NO_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 }

/**
 * Zoom about a point, leaving whatever is under that point where it is.
 *
 * `point` is measured from the centre of the stage, so the same arithmetic serves a pinch midpoint, a
 * double-tap position and the keyboard's implicit centre (0, 0).
 */
function zoomAbout(zoom: ZoomState, scale: number, point: { x: number; y: number }): ZoomState {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
  if (next === ZOOM_MIN) return NO_ZOOM
  const factor = next / zoom.scale
  return {
    scale: next,
    x: point.x - factor * (point.x - zoom.x),
    y: point.y - factor * (point.y - zoom.y),
  }
}

/**
 * Keep the zoomed page over the stage: it can be dragged until its edge meets the stage's and no
 * further. An axis where the page is smaller than the stage is pinned to the middle, so zooming back
 * out always lands centred rather than off in a corner.
 */
function clampPan(zoom: ZoomState, page: DOMRect | null, stage: DOMRect | null): ZoomState {
  if (!page || !stage || zoom.scale === ZOOM_MIN) return zoom
  const limitX = Math.max(0, (page.width * zoom.scale - stage.width) / 2)
  const limitY = Math.max(0, (page.height * zoom.scale - stage.height) / 2)
  return {
    scale: zoom.scale,
    x: Math.min(limitX, Math.max(-limitX, zoom.x)),
    y: Math.min(limitY, Math.max(-limitY, zoom.y)),
  }
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * The average colour of a page's four border strips, raw. What the surround finally becomes is
 * `backdropCss`'s business — the two are split so that the sample can be cached per page while the
 * colour modes (section 18) still re-tint it without resampling anything.
 *
 * Returns null rather than throwing: pages are same-origin today, but a source serving them from
 * another origin would taint the canvas and make getImageData throw, and a background setting must
 * never be able to break the reader.
 */
function sampleBackdrop(image: HTMLImageElement): [number, number, number] | null {
  try {
    const { naturalWidth, naturalHeight } = image
    if (!naturalWidth || !naturalHeight) return null
    const scale = BACKDROP_SAMPLE_EDGE / Math.max(naturalWidth, naturalHeight)
    const width = Math.max(1, Math.round(naturalWidth * scale))
    const height = Math.max(1, Math.round(naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, width, height)
    const { data } = context.getImageData(0, 0, width, height)

    let red = 0
    let green = 0
    let blue = 0
    let counted = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const onBorder = x < BACKDROP_STRIP || x >= width - BACKDROP_STRIP || y < BACKDROP_STRIP || y >= height - BACKDROP_STRIP
        if (!onBorder) continue
        const offset = (y * width + x) * 4
        red += data[offset]
        green += data[offset + 1]
        blue += data[offset + 2]
        counted += 1
      }
    }
    if (counted === 0) return null
    return [red / counted, green / counted, blue / counted]
  } catch {
    // Tainted canvas, or an image that decoded into nothing. Fall back to the fixed colour.
    return null
  }
}

/**
 * A sampled edge colour as the surround should actually be painted: put through the same colour
 * modes as the page, then pulled back toward the reader's fixed surround.
 *
 * The colour modes are applied here rather than left off, because the surround's whole job is to
 * match the page *on screen* — sampling an unfiltered white edge for a page that inverts to near
 * black puts the artwork back in the frame the setting exists to remove. Same operations as the CSS
 * `filter`, in the same order, so the two cannot disagree.
 */
function backdropCss(average: [number, number, number], grayscale: boolean, invert: boolean): string {
  let colour = average
  if (grayscale) {
    const grey = luminance(colour)
    colour = [grey, grey, grey]
  }
  if (invert) colour = [255 - colour[0], 255 - colour[1], 255 - colour[2]]
  // Dark edges are followed closely, bright ones held back — decided on the colour as it will be
  // seen, so an inverted page is judged on what it inverts to.
  const pull = luminance(colour) < luminance(READER_BACKDROP) ? BACKDROP_PULL_DARK : BACKDROP_PULL_LIGHT
  const mixed = READER_BACKDROP.map((base, channel) => Math.round(base + (colour[channel] - base) * pull))
  return `rgb(${mixed.join(' ')})`
}

const BACKGROUND = choice<'fixed' | 'auto'>('reader.background', 'fixed', ['fixed', 'auto'])

// How many chapters to keep on disk ahead of the one being read. Off by default: it writes to the
// disk without being asked otherwise.
const DOWNLOAD_AHEAD_VALUES = [0, 2, 3, 5, 10]
// How far into a chapter counts as reading it. Early enough that the next chapter is on disk well
// before this one runs out, late enough that opening a chapter and leaving costs nothing.
const DOWNLOAD_AHEAD_TRIGGER = 0.25

const DOWNLOAD_AHEAD = preference<number>(
  'reader.download-ahead',
  0,
  (raw) => (DOWNLOAD_AHEAD_VALUES.includes(Number(raw)) ? Number(raw) : null),
  (value) => String(value),
)

const GRAYSCALE = flag('reader.grayscale', false)
const INVERT = flag('reader.invert', false)

/**
 * How far the page can be dimmed below the screen's own brightness, in percent.
 *
 * Capped well short of 100: a fully black stage would hide the artwork *and* the reason it went black,
 * leaving nothing to aim at but the slider that caused it.
 */
const DIM_MAX = 80
const DIM_STEP = 5

const DIM = quantity('reader.dim', 0, { min: 0, max: DIM_MAX, step: DIM_STEP })

function updateReaderProgress(mangaId: number, chapterIndex: number, pageIndex: number, pageCount: number): void {
  const body = new URLSearchParams({ lastPageRead: String(pageIndex) })
  if (pageIndex === pageCount - 1) body.set('read', 'true')
  void apiFetch(`/api/v1/manga/${mangaId}/chapter/${chapterIndex}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  })
}

const MODE = choice<ReaderMode>('reader.mode', 'paged', ['paged', 'strip'])
const FIT = choice<PageFit>('reader.fit', 'height', ['height', 'width'])
const DIRECTION = choice<ReadingDirection>('reader.direction', 'ltr', ['ltr', 'rtl'])

// How the screen is divided into tap targets. Regions are fractions of the stage, authored
// left-to-right, and every one of them overlays the page — which is the whole point of the setting:
// the old fixed targets were the grid margins beside the artwork, and nothing shaped like a bottom
// band or an L can be expressed that way.
type TapLayout = 'sides' | 'edges' | 'l-shaped' | 'kindle' | 'off'
interface TapRegion { role: 'back' | 'forward' | 'panel'; left: number; top: number; width: number; height: number }

// Thirds, except for Kindle-ish, whose top strip is a strip rather than a third. Each map covers the
// whole stage: an unassigned gap would be a place where tapping does nothing, which reads as the
// reader having missed the tap.
const TAP_LAYOUTS: Record<TapLayout, { name: string; hint: string; regions: TapRegion[] }> = {
  sides: {
    name: 'Sides',
    hint: 'Two halves — either side of the page turns it.',
    regions: [
      { role: 'back', left: 0, top: 0, width: 0.5, height: 1 },
      { role: 'forward', left: 0.5, top: 0, width: 0.5, height: 1 },
    ],
  },
  edges: {
    name: 'Edges',
    hint: 'Narrow edges turn the page; the middle shows and hides these controls.',
    regions: [
      { role: 'back', left: 0, top: 0, width: 0.25, height: 1 },
      { role: 'panel', left: 0.25, top: 0, width: 0.5, height: 1 },
      { role: 'forward', left: 0.75, top: 0, width: 0.25, height: 1 },
    ],
  },
  'l-shaped': {
    name: 'L-shaped',
    hint: 'Forward along one side and the bottom, back across the top.',
    regions: [
      { role: 'back', left: 0, top: 0, width: 0.67, height: 0.33 },
      { role: 'forward', left: 0.67, top: 0, width: 0.33, height: 0.67 },
      { role: 'back', left: 0, top: 0.33, width: 0.33, height: 0.34 },
      { role: 'panel', left: 0.33, top: 0.33, width: 0.34, height: 0.34 },
      { role: 'forward', left: 0, top: 0.67, width: 1, height: 0.33 },
    ],
  },
  kindle: {
    name: 'Kindle-ish',
    hint: 'Almost everything goes forward; the top strip shows these controls.',
    regions: [
      { role: 'panel', left: 0, top: 0, width: 1, height: 0.12 },
      { role: 'back', left: 0, top: 0.12, width: 0.33, height: 0.88 },
      { role: 'forward', left: 0.33, top: 0.12, width: 0.67, height: 0.88 },
    ],
  },
  off: {
    name: 'Off',
    hint: 'No tap zones — swipe, the keyboard or this panel turn the page.',
    regions: [],
  },
}

const TAP_LAYOUT_ORDER = Object.keys(TAP_LAYOUTS) as TapLayout[]

const TAP_LAYOUT = choice<TapLayout>('reader.tap-layout', 'sides', TAP_LAYOUT_ORDER)

/**
 * The map as it sits on screen. Right-to-left **mirrors the geometry** rather than swapping the two
 * roles: for two symmetrical halves the results are identical, but for an L or an edge strip only
 * mirroring says anything — swapping the roles would leave the forward zone wrapped around the same
 * corner it was in, now meaning the opposite thing.
 */
function tapRegions(layout: TapLayout, direction: ReadingDirection): TapRegion[] {
  const regions = TAP_LAYOUTS[layout].regions
  if (direction === 'ltr') return regions
  // Rounded, or a mirrored third comes out as -5.55e-15 and reaches the DOM as a percentage in
  // exponential notation.
  return regions.map((region) => ({ ...region, left: Math.round((1 - region.left - region.width) * 1e4) / 1e4 }))
}

// Hands-free scrolling for a long strip. Seconds to travel one screen rather than pixels a second,
// so a speed reads the same on a phone as on a desktop — a fixed pixel rate is a crawl on one and a
// blur on the other.
type AutoScrollSpeed = 'off' | 'slow' | 'medium' | 'fast'
const AUTO_SCROLL_SECONDS_PER_SCREEN: Record<Exclude<AutoScrollSpeed, 'off'>, number> = { slow: 14, medium: 8, fast: 4.5 }
const AUTO_SCROLL_ORDER: AutoScrollSpeed[] = ['off', 'slow', 'medium', 'fast']
const AUTO_SCROLL_LABELS: Record<AutoScrollSpeed, string> = { off: 'Off', slow: 'Slow', medium: 'Medium', fast: 'Fast' }

const AUTO_SCROLL = choice<AutoScrollSpeed>('reader.autoscroll', 'off', AUTO_SCROLL_ORDER)

// Off by default: it changes how the device behaves, which is something to be asked for rather than
// discovered.
const WAKE_LOCK = flag('reader.wakelock', false)

// Absent rather than disabled where the browser has no wake lock — insecure contexts and most
// desktop Firefox. A toggle that can never take effect is worse than no toggle.
const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator

// Off, paired by position, or paired by what each page turns out to look like. The same key the
// boolean used, and the same two values it wrote, so a stored setting carries over untouched.
type SpreadMode = 'off' | 'on' | 'auto'

const SPREAD = choice<SpreadMode>('reader.spread', 'off', ['off', 'on', 'auto'])

// The options start folded away: the panel is opened mid-chapter to move around, not to re-tune the
// reader, and the page and chapter steppers are what has to be reachable without scrolling past
// nine settings. Remembered, so someone who does live in the settings is not folding them open
// every time.
const OPTIONS_OPEN = flag('reader.options-open', false)

// 0 pairs from the first page, 1 leaves the first page standing alone so a cover does not drag every
// later pair one page out of step with the artwork.
const SPREAD_OFFSET = quantity('reader.spread-offset', 0, { min: 0, max: 1, step: 1 })

// On unless turned off: the page arriving from the side it was turned from is what a page turn looks
// like, and it is the one setting here whose default anyone would notice missing.
const SLIDING = flag('reader.sliding', true)

const KEYBOARD_SCROLL = choice<KeyboardScroll>('reader.keyboard-scroll', 'fast', ['fast', 'smooth'])

// Left, top, right, bottom, off — in the order the picker draws them.
const PROGRESS_BAR_POSITIONS: ProgressBarPosition[] = ['left', 'top', 'right', 'bottom', 'off']

// Along the bottom is where the reader has always put it, so that stays the default: a stored
// setting nobody has touched should not move the furniture.
const PROGRESS_BAR = choice<ProgressBarPosition>('reader.progress-bar', 'bottom', PROGRESS_BAR_POSITIONS)

// Past this many pages the gaps between segments are wider than the segments themselves, so the
// separators come off and the bar reads as one striped run again.
const DENSE_TRACK_PAGES = 150

const PROGRESS_BAR_LABELS: Record<ProgressBarPosition, string> = {
  left: 'Down the left edge',
  top: 'Along the top',
  right: 'Down the right edge',
  bottom: 'Along the bottom',
  off: 'Hidden',
}

// Frame plus the bar inside it, so each icon is a picture of where the bar ends up. The frame is
// stroked like every other icon here; the bar is the one filled part.
const PROGRESS_BAR_ICONS: Record<ProgressBarPosition, React.ReactNode> = {
  left: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><rect className="solid" x="5.5" y="7" width="3" height="10" rx="1" /></>,
  top: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><rect className="solid" x="5.5" y="7" width="13" height="3" rx="1" /></>,
  right: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><rect className="solid" x="15.5" y="7" width="3" height="10" rx="1" /></>,
  bottom: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><rect className="solid" x="5.5" y="14" width="13" height="3" rx="1" /></>,
  off: <path d="M6 6l12 12M18 6 6 18" />,
}

// Two pages side by side need the room for two pages. Below this the reader shows one, without
// touching the stored setting — a narrow window is a passing condition, not a change of mind.
const SPREAD_VIEWPORT = '(min-width: 820px) and (orientation: landscape)'

/**
 * The first page of the pair holding `target`. With the offset on, page one stands alone and pairing
 * picks up after it, which is the whole point of the control: it shifts every later pair by one.
 */
function pairStart(target: number, offset: number): number {
  if (target < offset) return 0
  return target - ((target - offset) % 2)
}

/**
 * The same question when the reader is deciding for itself: walk the chapter from the front, pairing
 * two portrait pages at a time and letting a wide one stand alone, until the walk reaches `target`.
 *
 * It has to be a walk rather than arithmetic — one wide page shifts every pair after it, so there is
 * no parity to compute from. A page nothing is known about counts as portrait, which is what keeps a
 * turn from ever waiting on a decode: it pairs as it would have anyway and re-pairs if the image
 * arrives wide.
 */
function autoPairStart(target: number, isWide: (index: number) => boolean): number {
  let start = 0
  while (start < target) {
    const width = isWide(start) || isWide(start + 1) ? 1 : 2
    if (start + width > target) break
    start += width
  }
  return start
}

export default function ReaderPage() {
  const { mangaId, chapterIndex } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const id = Number(mangaId)
  const sourceOrder = Number(chapterIndex)
  const returnMangaId = Number(searchParams.get('from'))
  const returnQuery = Number.isInteger(returnMangaId) && returnMangaId > 0 ? `?from=${returnMangaId}` : ''
  const chaptersHref = Number.isInteger(returnMangaId) && returnMangaId > 0 ? `/manga/${returnMangaId}` : `/manga/${id}`
  const [page, setPage] = useState(0)
  const [mode, setModeState] = useMangaPreference(MODE, id)
  const [fit, setFit] = useMangaPreference(FIT, id)
  const [direction, setDirection] = useMangaPreference(DIRECTION, id)
  const [spread, setSpread] = useMangaPreference(SPREAD, id)
  // Which pages turned out to be wider than they are tall, by url. Filled in as images decode —
  // mostly by the prefetch, so the shape of a page is usually known before the turn that shows it.
  const [widePages, setWidePages] = useState<Record<string, boolean>>({})
  const [spreadOffset, setSpreadOffset] = useMangaPreference(SPREAD_OFFSET, id)
  const [sliding, setSliding] = useMangaPreference(SLIDING, id)
  const [keyboardScroll, setKeyboardScroll] = useMangaPreference(KEYBOARD_SCROLL, id)
  const [progressBar, setProgressBar] = useMangaPreference(PROGRESS_BAR, id)
  const [roomForSpread, setRoomForSpread] = useState(() => window.matchMedia(SPREAD_VIEWPORT).matches)
  const [tapLayout, setTapLayout] = useMangaPreference(TAP_LAYOUT, id)
  const [background, setBackgroundState] = useMangaPreference(BACKGROUND, id)
  const [grayscale, setGrayscale] = useMangaPreference(GRAYSCALE, id)
  const [invert, setInvert] = useMangaPreference(INVERT, id)
  const [downloadAhead, setDownloadAhead] = useMangaPreference(DOWNLOAD_AHEAD, id)
  const [dim, setDimState] = useMangaPreference(DIM, id)
  const [cropBorders, setCropBorders] = useMangaPreference(CROP_BORDERS, id)
  // Both start at fit and are filled in once the manga's meta arrives with the query: the level is the
  // server's to tell us, not this browser's to remember.
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM)
  const [stripZoom, setStripZoomState] = useState<number>(ZOOM_FIT)
  const [keybinds, setKeybinds] = useKeybinds()
  // Which row of the keys tab is listening for a press, if any.
  const [capturing, setCapturing] = useState<ReaderAction | null>(null)
  // What the last binding did to some other row, so the dialog can say where the key went.
  const [keybindNote, setKeybindNote] = useState<string | null>(null)
  // Live pointers on the stage, by pointerId: one is a drag, two are a pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchStart = useRef<{ distance: number; scale: number } | null>(null)
  // Set once a pointer has travelled far enough to be a pan, so the click it ends with is not a tap.
  const panned = useRef(false)
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  // Where a one-finger gesture began, kept separately from `pointers` because that map is overwritten
  // on every move - it tracks where each finger *is*, and a swipe is a question about where it
  // started. Cleared the moment a second finger lands: a pinch is not a swipe.
  const swipeStart = useRef<{ id: number; x: number; y: number } | null>(null)
  // Measured per page url, and kept in state rather than only in a ref because the layout is built
  // from it. The ref alongside is what stops a page being measured twice.
  const [crops, setCrops] = useState<Record<string, PageCrop | null>>({})
  const cropCache = useRef(new Map<string, PageCrop | null>())
  // The chapter and depth the reader has already downloaded ahead for, so this runs once per chapter
  // rather than on every page turn — and re-arms if the depth is turned up mid-chapter.
  const downloadedAhead = useRef<string | null>(null)
  // The edge colour currently in force, and the per-page cache behind it — both raw samples, so the
  // colour modes re-tint the surround without a resample. Cached by page url so turning back to a
  // page does not sample it again; dropped when the chapter changes.
  const [backdrop, setBackdrop] = useState<[number, number, number] | null>(null)
  const backdrops = useRef(new Map<string, [number, number, number]>())
  // Pages whose last request came back an error, and how many times the reader has since asked for
  // each of them again. Dropped when the chapter changes, alongside the backdrop cache.
  const [pageErrors, setPageErrors] = useState<Record<string, { failed: boolean; retries: number }>>({})
  const [autoScroll, setAutoScroll] = useMangaPreference(AUTO_SCROLL, id)
  const [wakeLock, setWakeLock] = useMangaPreference(WAKE_LOCK, id)
  const wakeLockSentinel = useRef<WakeLockSentinel | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [optionsOpen, setOptionsOpen] = OPTIONS_OPEN.use()
  // Not remembered: the dialog opens on Layout every time, which is where all but three of the
  // settings live.
  const [optionsTab, setOptionsTab] = useState<OptionsTab>('layout')
  const optionsDialogRef = useRef<HTMLDivElement | null>(null)
  const optionsToggleRef = useRef<HTMLButtonElement | null>(null)
  const [stripAnchor, setStripAnchor] = useState<StripAnchor>('pending')
  const requestedChapter = useRef<number | null>(null)
  const reportedStripPage = useRef<number>(-1)
  // Set while a chapter hop is in flight, so one gesture never skips two chapters.
  const changingChapter = useRef(false)
  // Set when the reader backs out of page one, so the previous chapter opens on its last page.
  const enterAtEnd = useRef(false)
  // Prefetched pages, kept alive by this ref so a request still in flight is not collected when the
  // page turns. Keyed by url and only ever added to, so a page already being fetched is never
  // restarted; the whole map is dropped when the chapter changes.
  const prefetched = useRef(new Map<string, HTMLImageElement>())
  // The page image the surround takes its colour from — the first of a pair, or the only one.
  const pagedImageRef = useRef<HTMLImageElement | null>(null)
  const readerStageRef = useRef<HTMLElement | null>(null)
  const stripReaderRef = useRef<HTMLDivElement | null>(null)
  const [{ data, fetching, error }] = useQuery<ReaderQueryResult>({ query: READER_QUERY, variables: { mangaId: id } })
  const [pagesResult, fetchPages] = useMutation<FetchPagesResult>(FETCH_PAGES_MUTATION)
  const [, setZoomMeta] = useMutation(SET_ZOOM_META_MUTATION)
  const [, clearZoomMeta] = useMutation(DELETE_ZOOM_META_MUTATION)
  const [, enqueueDownloads] = useMutation(ENQUEUE_DOWNLOADS_MUTATION)
  const [, startDownloader] = useMutation(START_DOWNLOADER_MUTATION)

  // --- Remembering the zoom -----------------------------------------------------------------------
  // Which manga's meta has already been adopted — the zoom below, and the layout and image settings
  // held per manga in [[mangaSettings.ts]]. Guards against a refetch putting the server's copy back
  // over something the reader has since moved.
  const metaAdoptedFor = useRef<number | null>(null)
  // The change the server has not been told about yet, carrying its own manga id: a pending write
  // belongs to the title it was made on, even if the reader has walked to another one since.
  const pendingZoom = useRef<({ mangaId: number } & ZoomLevels) | null>(null)
  const zoomWriteTimer = useRef<number | null>(null)
  // Read by the writer rather than passed to it, so changing one layout's level does not mean threading
  // the other's through every caller.
  const zoomLevels = useRef<ZoomLevels>(NO_ZOOM_LEVELS)
  zoomLevels.current = { paged: zoom.scale, strip: stripZoom }

  // Kept in a ref rather than in a dependency array: the two effects that flush — leaving a manga, and
  // closing the reader — must not re-run because a mutation function happened to be rebuilt.
  const flushZoom = useRef<() => void>(() => {})
  flushZoom.current = () => {
    const pending = pendingZoom.current
    if (zoomWriteTimer.current) window.clearTimeout(zoomWriteTimer.current)
    zoomWriteTimer.current = null
    pendingZoom.current = null
    if (!pending) return
    const { mangaId, paged, strip } = pending
    void (paged === ZOOM_FIT && strip === ZOOM_FIT
      ? clearZoomMeta({ mangaId })
      : setZoomMeta({ mangaId, value: JSON.stringify({ paged, strip }) }))
  }

  const rememberZoom = useCallback((patch: Partial<ZoomLevels>) => {
    // Before this manga's own level has been adopted there is nothing to remember: anything written
    // here would be the previous title's level, or a fit the reader never chose.
    if (metaAdoptedFor.current !== id) return
    pendingZoom.current = { mangaId: id, ...zoomLevels.current, ...patch }
    if (zoomWriteTimer.current) window.clearTimeout(zoomWriteTimer.current)
    zoomWriteTimer.current = window.setTimeout(() => flushZoom.current(), ZOOM_WRITE_DELAY)
  }, [id])

  const chapters = useMemo(
    () => [...(data?.chapters.nodes ?? [])].sort((a, b) => a.chapterNumber - b.chapterNumber || a.sourceOrder - b.sourceOrder),
    [data],
  )
  const chapter = chapters.find((item) => item.sourceOrder === sourceOrder)
  const chapterPosition = chapter ? chapters.findIndex((item) => item.id === chapter.id) : -1
  const previousChapter = chapterPosition > 0 ? chapters[chapterPosition - 1] : undefined
  const nextChapter = chapterPosition >= 0 && chapterPosition < chapters.length - 1 ? chapters[chapterPosition + 1] : undefined
  const fetchedChapter = pagesResult.data?.fetchChapterPages
  const prepared = fetchedChapter?.chapter.id === chapter?.id ? fetchedChapter : undefined

  // The series on AniList, alongside the chapter on its source. A bound track record names the exact
  // entry; without one there is nothing to point at but a search, which is still better than leaving
  // the reader to type the title in themselves. The two cases say which they are in the label.
  const anilistUrl = data?.manga.trackRecords.nodes
    .find((record) => record.trackerId === ANILIST_TRACKER_ID)?.remoteUrl || null
  const anilistSearchUrl = data?.manga.title
    ? `https://anilist.co/search/manga?search=${encodeURIComponent(data.manga.title)}`
    : null
  const anilistHref = anilistUrl ?? anilistSearchUrl

  const setMode = (nextMode: ReaderMode) => {
    if (nextMode === 'strip') setStripAnchor(page > 0 ? page : 'free')
    setModeState(nextMode)
  }

  // The three layout tiles, written back as the two settings they have always been: paged mode with
  // the spread off, paged mode with it on, and the strip. Switching to the strip and back therefore
  // returns to the single-or-double the reader was last on — and Double only ever *starts* pairing by
  // position, so coming back to it does not quietly undo the automatic pairing underneath.
  const setLayout = (nextLayout: ReaderLayout) => {
    if (nextLayout === 'strip') {
      setMode('strip')
      return
    }
    setMode('paged')
    if (nextLayout === 'single') setSpread('off')
    else if (spread === 'off') setSpread('on')
  }

  // A sampled edge colour is a property of the page under the "auto" setting; turning it off has to
  // drop the one in force rather than leave the last sample painted behind the next page.
  const setBackground = (nextBackground: 'fixed' | 'auto') => {
    setBackgroundState(nextBackground)
    if (nextBackground === 'fixed') setBackdrop(null)
  }

  const setStripZoom = useCallback((nextZoom: number) => {
    const clamped = Math.min(STRIP_ZOOM_MAX, Math.max(STRIP_ZOOM_MIN, Math.round(nextZoom * 100) / 100))
    setStripZoomState(clamped)
    rememberZoom({ strip: clamped })
  }, [rememberZoom])

  // Clamped on the way in as well as on the way out: the slider cannot ask for more than the maximum,
  // but the keyboard's step can.
  const setDim = (nextDim: number) => setDimState(Math.min(DIM_MAX, Math.max(0, nextDim)))

  // Dismissing hands the keyboard back to the cog rather than to the top of the document, so the
  // next Tab carries on from where the dialog was opened.
  const closeOptions = useCallback(() => {
    setOptionsOpen(false)
    optionsToggleRef.current?.focus()
  }, [setOptionsOpen])

  // A retry has to ask for a *different* url. Section 4 made every page url bare so that the prefetch
  // and the display are one cache entry — and a failed response is cached the same way, so
  // re-requesting the identical url would replay the failure instead of asking the source again.
  const srcFor = useCallback(
    (url: string) => {
      const retries = pageErrors[url]?.retries ?? 0
      return retries === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}retry=${retries}`
    },
    [pageErrors],
  )

  // What automatic pairing runs on. Recorded from whichever image decoded it first — the prefetch or
  // the page on screen — and only when it changes, so this cannot loop through a render.
  const notePageSize = useCallback((url: string, image: HTMLImageElement) => {
    if (!image.naturalWidth || !image.naturalHeight) return
    const wide = image.naturalWidth > image.naturalHeight
    setWidePages((current) => current[url] === wide ? current : { ...current, [url]: wide })
    // Measured here because this is the one place every decoded page passes through — the page on
    // screen, its neighbour in a spread, a strip page, and the prefetch's own Image objects. Only when
    // the setting is on: reading pixels off every page that decodes is work nobody asked for.
    if (!cropBorders || cropCache.current.has(url)) return
    const measured = measureCrop(image)
    cropCache.current.set(url, measured)
    setCrops((current) => ({ ...current, [url]: measured }))
  }, [cropBorders])

  const failPage = (url: string) =>
    setPageErrors((current) => ({ ...current, [url]: { failed: true, retries: current[url]?.retries ?? 0 } }))

  const retryPage = (url: string) =>
    setPageErrors((current) => ({ ...current, [url]: { failed: false, retries: (current[url]?.retries ?? 0) + 1 } }))

  const openChapter = useCallback(
    (target: ReaderChapter | undefined, atEnd = false) => {
      if (!target || changingChapter.current) return
      changingChapter.current = true
      enterAtEnd.current = atEnd
      setPage(0)
      navigate(`/manga/${id}/chapter/${target.sourceOrder}${returnQuery}`)
    },
    [id, navigate, returnQuery],
  )

  const goToPage = useCallback(
    (nextPage: number) => {
      if (!prepared) return
      // Running off either end of the chapter continues into the neighbouring one.
      if (nextPage > prepared.pages.length - 1) return openChapter(nextChapter)
      if (nextPage < 0) return openChapter(previousChapter, true)
      const target = Math.min(Math.max(0, nextPage), prepared.pages.length - 1)
      setPage(target)
      if (mode !== 'strip') return
      setStripAnchor(target)
      reportedStripPage.current = target
      updateReaderProgress(id, sourceOrder, target, prepared.pages.length)
    },
    [id, mode, nextChapter, openChapter, prepared, previousChapter, sourceOrder],
  )

  useEffect(() => {
    if (!chapter || requestedChapter.current === chapter.id) return
    requestedChapter.current = chapter.id
    reportedStripPage.current = -1
    changingChapter.current = false
    prefetched.current.clear()
    backdrops.current.clear()
    cropCache.current.clear()
    setBackdrop(null)
    setCrops({})
    setPageErrors({})
    setWidePages({})
    setPage(0)
    setStripAnchor('pending')
    fetchPages({ chapterId: chapter.id }).then((result) => {
      const lastRead = result.data?.fetchChapterPages?.chapter.lastPageRead ?? 0
      const pageCount = result.data?.fetchChapterPages?.pages.length ?? 1
      const enteredBackwards = enterAtEnd.current
      enterAtEnd.current = false
      const resumeAt = enteredBackwards ? pageCount - 1 : Math.min(Math.max(0, lastRead), pageCount - 1)
      setPage(resumeAt)
      reportedStripPage.current = resumeAt
      setStripAnchor(resumeAt > 0 ? resumeAt : 'free')
    })
  }, [chapter, fetchPages])

  // Paged mode renders one <img> per screen and only asks for it once the turn has happened, so every
  // turn waits on the source with a blank frame. Pulling the next few pages while the current one is
  // on screen means those turns come out of the browser cache instead.
  //
  // This is also why the visible <img> no longer carries `?updateProgress=true`: that flag makes the
  // server record the page it serves as read (MangaController page handler → Chapter.updateChapterProgress),
  // so prefetching four pages ahead would have marked four unseen pages read and finished every
  // chapter four pages early. Progress is reported from the visible page's onLoad instead, through
  // the same updateReaderProgress the strip has always used — which writes the same lastPageRead and
  // the same read flag on the final page. The URLs then stay identical between prefetch and display,
  // which is the whole point: a differing query string is a different cache entry and the prefetch
  // would be downloaded twice.
  //
  // Nothing is prefetched across a chapter boundary. The next chapter's page urls are only known
  // after fetchChapterPages, and firing that mutation speculatively on every chapter's last page is a
  // heavier thing to spend than the one blank frame it would save.
  // Holds the screen awake while a chapter is open. Released the moment the reader is left or the
  // setting is switched off, because the cleanup runs on both.
  //
  // The re-acquire on visibilitychange is not optional: the browser drops the sentinel whenever the
  // tab is backgrounded and never restores it, so without this the setting quietly stops working
  // after the first phone call or app switch — the one moment it is most obviously meant to help.
  useEffect(() => {
    if (!wakeLockSupported || !wakeLock || !prepared) return
    let released = false

    const acquire = async () => {
      if (released || wakeLockSentinel.current) return
      try {
        wakeLockSentinel.current = await navigator.wakeLock.request('screen')
      } catch {
        // Refused — some browsers reject on low battery. A lock we cannot have is not a reader error.
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        wakeLockSentinel.current = null
        return
      }
      void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      void wakeLockSentinel.current?.release()
      wakeLockSentinel.current = null
    }
  }, [prepared, wakeLock])

  // A window that cannot hold two pages side by side shows one, and starts showing two again the
  // moment it can. The stored setting is never touched by this — the reader is told what fits, not
  // what the user wants.
  useEffect(() => {
    const query = window.matchMedia(SPREAD_VIEWPORT)
    const onChange = () => setRoomForSpread(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // Once the reader is a quarter of the way in, put the next few chapters on disk. Quietly: this is
  // a convenience running behind a chapter someone is reading, and a source that will not serve a
  // chapter ahead of time is not worth interrupting them over — the chapter list and the Downloads
  // screen are where a failed download is meant to be seen.
  useEffect(() => {
    if (!downloadAhead || !prepared || chapterPosition < 0) return
    if (page / prepared.pages.length <= DOWNLOAD_AHEAD_TRIGGER) return
    const armed = `${chapters[chapterPosition].id}:${downloadAhead}`
    if (downloadedAhead.current === armed) return
    downloadedAhead.current = armed
    const ids = chapters
      .slice(chapterPosition + 1)
      .filter((item) => !item.isDownloaded)
      .slice(0, downloadAhead)
      .map((item) => item.id)
    if (!ids.length) return
    // Enqueuing alone leaves the downloader STOPPED with the chapters sitting at QUEUED, so the
    // start is not optional — the same pairing the chapter list and the Downloads screen use.
    void enqueueDownloads({ ids }).then((result) => {
      if (result.error) return
      void startDownloader({})
    })
  }, [chapterPosition, chapters, downloadAhead, enqueueDownloads, page, prepared, startDownloader])

  useEffect(() => {
    if (mode !== 'paged' || !prepared) return
    for (const url of prepared.pages.slice(page + 1, page + 1 + PREFETCH_AHEAD)) {
      if (prefetched.current.has(url)) continue
      const image = new Image()
      // The prefetch is also where automatic pairing learns the shape of what is coming, which is
      // what lets a wide page be given a screen of its own before the turn rather than after it.
      image.onload = () => notePageSize(url, image)
      image.src = url
      prefetched.current.set(url, image)
    }
  }, [mode, notePageSize, page, prepared])

  // Right-to-left keeps every control where it is and swaps what it means: the left of the screen
  // advances, the right goes back, and the arrow keys follow. This delta drives the two things that
  // are inherently left-and-right — the arrow keys and the panel's ‹ › stepper — while the tap map
  // is mirrored instead (see tapRegions). Both end up saying the same thing, which is the point: a
  // reader whose tap zone and arrow key disagree is worse than having no setting at all.
  const advance = direction === 'rtl' ? -1 : 1
  const pageCount = prepared?.pages.length ?? 0
  // Spreads are a paged-mode display choice that a narrow window can veto, so the stored setting and
  // what is actually on screen are two different things. Only the stored one is ever written back.
  const spreadActive = spread !== 'off' && mode === 'paged' && roomForSpread
  const autoPairing = spread === 'auto'
  const isWide = (index: number) => Boolean(prepared && widePages[prepared.pages[index]])
  const spreadFirst = !spreadActive ? page : autoPairing ? autoPairStart(page, isWide) : pairStart(page, spreadOffset)
  // One page whenever there is no second one to show: the lone leading page under an offset, the
  // final page of a chapter with an odd number left over, and — under automatic pairing — either
  // half of a would-be pair turning out to be wider than it is tall.
  const pairable = spreadActive && spreadFirst + 1 <= pageCount - 1 && (
    autoPairing ? !isWide(spreadFirst) && !isWide(spreadFirst + 1) : spreadFirst >= spreadOffset
  )
  const spreadPages = pairable ? [spreadFirst, spreadFirst + 1] : [spreadFirst]
  // Turning moves by whatever is on screen, so a spread advances two pages and a lone page one.
  // Everything still goes through goToPage, which is what keeps running off either end a chapter hop.
  const forwardPage = spreadFirst + spreadPages.length
  const backwardPage = spreadFirst === 0
    ? -1
    : autoPairing ? autoPairStart(spreadFirst - 1, isWide) : pairStart(spreadFirst - 1, spreadOffset)
  const leftPage = advance === 1 ? backwardPage : forwardPage
  const rightPage = advance === 1 ? forwardPage : backwardPage
  // Which edge the arriving page slides in from. It follows the direction of travel and is mirrored
  // right-to-left, so the page always enters from the side that was tapped — a turn that slid the
  // wrong way would read as going back.
  const previousSpreadFirst = useRef(spreadFirst)
  useEffect(() => {
    previousSpreadFirst.current = spreadFirst
  }, [spreadFirst])
  const forwardEdge = direction === 'rtl' ? 'left' : 'right'
  const backwardEdge = direction === 'rtl' ? 'right' : 'left'
  const slideEdge = spreadFirst < previousSpreadFirst.current ? backwardEdge : forwardEdge
  // Strip mode scrolls; there is no turn to animate.
  const slideClass = sliding && mode === 'paged' ? ` sliding from-${slideEdge}` : ''
  // The progress bar is one segment per page rather than a filled line: the chapter's length is
  // legible at a glance, every page is its own target, and the page under the pointer names itself.
  //
  // Memoised on what it actually draws. The strip re-renders the reader on every scroll frame, and
  // rebuilding three hundred buttons each time would be the most expensive thing on the page; with
  // the element identity unchanged React skips the whole subtree instead.
  const activeFrom = spreadPages[0]
  const activeTo = spreadPages[spreadPages.length - 1]
  const progressTrack = useMemo(() => (
    <div className={`reader-track${pageCount > DENSE_TRACK_PAGES ? ' dense' : ''}`} role="group" aria-label={t('Pages')}>
      {Array.from({ length: pageCount }, (_, index) => {
        const current = index >= activeFrom && index <= activeTo
        return (
          <button
            key={index}
            type="button"
            /* Out of the tab order: a three-hundred-page chapter would otherwise put three hundred
               stops between the reader and the panel. The panel's page picker is the keyboard way
               to the same place, and it lands on the page by number. */
            tabIndex={-1}
            className={`reader-track-seg${current ? ' is-active' : index < activeFrom ? ' is-visited' : ''}`}
            aria-label={t('Page {page}', { page: index + 1 })}
            aria-current={current ? 'page' : undefined}
            onClick={() => goToPage(index)}
          />
        )
      })}
    </div>
  ), [activeFrom, activeTo, goToPage, pageCount])
  // Auto backgrounds are a paged-mode idea: a continuous strip has no single page on screen to take
  // a colour from.
  const autoBackdrop = background === 'auto' && mode === 'paged'
  // Handed to the page images alone, never to the stage: filtering the stage would filter everything
  // standing on it, the surround included, and the auto background has to stay a colour the reader
  // controls rather than one CSS has already inverted. It follows the page all the same — see
  // backdropCss, which puts the sampled edge through the same two operations.
  const pageFilter = [grayscale && 'grayscale(1)', invert && 'invert(1)'].filter(Boolean).join(' ') || 'none'
  // Also what the panel's picker draws, so a preview cannot drift from the map it previews.
  const regions = tapRegions(tapLayout, direction)

  // Where the colour comes from when no load event is coming. Two cases need it, and prefetching
  // made the second one the common one:
  //
  //  - the setting was switched on while a page was already on screen;
  //  - the image was already decoded when React attached to it, because it had been prefetched, so
  //    its load event fired before there was an onLoad to hear it.
  //
  // Both end here, reading the element that is already in the document.
  useEffect(() => {
    if (!autoBackdrop || !prepared) {
      setBackdrop(null)
      return
    }
    const url = prepared.pages[spreadFirst]
    const cached = backdrops.current.get(url)
    if (cached) {
      setBackdrop(cached)
      return
    }
    const image = pagedImageRef.current
    if (image?.complete && image.naturalWidth && image.currentSrc.endsWith(srcFor(url))) {
      const sample = sampleBackdrop(image)
      if (sample) {
        backdrops.current.set(url, sample)
        setBackdrop(sample)
        return
      }
    }
    // Still loading: its onLoad will set the colour when it arrives.
    setBackdrop(null)
  }, [autoBackdrop, prepared, spreadFirst, srcFor])

  // Switching the trim on mid-chapter has to measure what is already on screen: those images decoded
  // long ago and their load events are gone — the same gap section 10 found for the backdrop, in the
  // same shape. Everything decoded from here on is measured by `notePageSize` as it loads.
  useEffect(() => {
    if (!cropBorders || !prepared) return
    const stage = readerStageRef.current
    if (!stage) return
    for (const image of Array.from(stage.querySelectorAll('img'))) {
      if (!image.complete || !image.naturalWidth) continue
      const url = prepared.pages.find((candidate) => image.currentSrc.endsWith(srcFor(candidate)))
      if (url) notePageSize(url, image)
    }
  }, [cropBorders, notePageSize, page, prepared, srcFor])

  // --- Zoom and pan -------------------------------------------------------------------------------
  // The *gestures* are paged only. A long strip is already a scroller, and a transform on it would
  // fight the scrolling it is built on, so a pinch or a drag there stays the browser's. The zoom
  // level itself is not paged only any more: in a strip it drives the column's width instead of a
  // transform (section 36), which is the shape of zoom a vertical reader actually wants.
  const zoomable = mode === 'paged'

  // One number for both, so the badge, the panel's slider and the keys have a single thing to read
  // and a single thing to change. 1 means "at fit" in either layout.
  const zoomLevel = mode === 'strip' ? stripZoom : zoom.scale
  const zoomedIn = zoomLevel !== ZOOM_FIT
  // `Number(...)` rather than a fixed number of decimals: the strip steps in quarters, so 1.25 has to
  // survive, while a paged 2 should not be written "2.0×".
  const zoomReadout = `${Number(zoomLevel.toFixed(2))}×`
  const zoomSpan = zoomRange(mode)

  const stageCentre = (): { left: number; top: number } | null => {
    const stage = readerStageRef.current?.getBoundingClientRect()
    return stage ? { left: stage.left + stage.width / 2, top: stage.top + stage.height / 2 } : null
  }

  // Whatever the layout put on the stage: a page, a trimmed page, or a pair. The same selector the CSS
  // transforms, so the thing being measured and the thing being moved cannot drift apart.
  const pageElement = (): HTMLElement | null =>
    readerStageRef.current?.querySelector<HTMLElement>('.paged-reader > img, .paged-reader > .page-crop, .paged-reader > .page-spread') ?? null

  // Guarded here rather than at each entry point: the pointer handlers checked `zoomable` but the
  // keyboard did not, so `+` in a long strip moved nothing (only `.paged-reader` children transform)
  // while still raising the badge and setting `touch-action: none` on the scroller — which would have
  // stopped a strip scrolling by touch.
  const applyZoom = (next: ZoomState) => {
    if (!zoomable) return
    const stage = readerStageRef.current?.getBoundingClientRect() ?? null
    const rect = pageElement()?.getBoundingClientRect() ?? null
    // A rect is measured *after* the transform, so the scale in force has to come back out of it —
    // clamping against an already-zoomed box would let the page drift further on every gesture.
    const base = rect ? new DOMRect(0, 0, rect.width / zoom.scale, rect.height / zoom.scale) : null
    const framed = clampPan(next, base, stage)
    setZoom(framed)
    // Written from here rather than from an effect on the scale: an effect would also fire when the
    // meta lands, and would write the level straight back out again. Panning alone is not worth a
    // write — only the level is remembered, never where the page was dragged to.
    if (framed.scale !== zoom.scale) rememberZoom({ paged: framed.scale })
  }

  // A point on screen, as an offset from the middle of the stage — the frame `zoomAbout` works in.
  const fromCentre = (clientX: number, clientY: number): { x: number; y: number } => {
    const centre = stageCentre()
    return centre ? { x: clientX - centre.left, y: clientY - centre.top } : { x: 0, y: 0 }
  }

  const zoomTo = (scale: number, at?: { clientX: number; clientY: number }) => {
    const point = at ? fromCentre(at.clientX, at.clientY) : { x: 0, y: 0 }
    applyZoom(zoomAbout(zoom, scale, point))
  }

  const toggleZoom = (at?: { clientX: number; clientY: number }) =>
    zoomTo(zoom.scale > ZOOM_MIN ? ZOOM_MIN : ZOOM_STEP_TO, at)

  /**
   * Did this gesture land on a region that turns the page?
   *
   * Turning by tapping and zooming by double tapping are the same two clicks, and the tap map covers
   * the whole stage — so reading at a zoom, turning two pages with two ordinary clicks in the same
   * place, put a `dblclick` on the stage and the reader read it as "back to fit". It turned both
   * pages *and* threw the zoom away, and then wrote that fit to the server, which is what made the
   * level look like it never survived. A turn is the more specific reading of two clicks on a region
   * whose whole job is turning, so it wins; every other way in — the panel's slider, a pinch, ctrl
   * and the wheel, the keyboard, and a double click anywhere that is not a turn region — is
   * untouched.
   */
  const onTurnRegion = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest('.turn-hit'))

  // The three the keyboard and the panel's stepper share. In paged mode they zoom about the middle of
  // the stage, because neither a key press nor a button has a position on the page; in a strip they
  // widen or narrow the column, where a centre would mean nothing.
  const zoomIn = () => {
    if (mode === 'strip') return setStripZoom(stripZoom + STRIP_ZOOM_STEP)
    zoomTo(zoom.scale <= ZOOM_MIN ? ZOOM_STEP_TO : zoom.scale + ZOOM_KEY_STEP)
  }
  const zoomOut = () => {
    if (mode === 'strip') return setStripZoom(stripZoom - STRIP_ZOOM_STEP)
    zoomTo(zoom.scale - ZOOM_KEY_STEP)
  }
  const resetZoom = () => {
    if (mode === 'strip') return setStripZoom(ZOOM_FIT)
    setZoom(NO_ZOOM)
    rememberZoom({ paged: ZOOM_FIT })
  }

  // What the panel's slider drives. A strip's zoom is a width and a paged one is a transform, so the
  // one control routes to whichever the layout is using — and in paged mode it scales about the middle
  // of the stage, a slider having no position on the page to scale about.
  const setZoomLevel = (level: number) => {
    if (mode === 'strip') return setStripZoom(level)
    zoomTo(level)
  }

  // Adopted once, when the manga's meta arrives. Guarded by the id it was adopted for rather than by a
  // "have we run" flag: the query refetches, and a later refetch must not snap a level the reader has
  // since moved back to whatever the server last heard.
  //
  // The reader's query already asks for `manga.meta`, so the per-manga settings come out of the same
  // answer as the zoom and cost no request of their own.
  useEffect(() => {
    const loaded = data?.manga
    if (!loaded || metaAdoptedFor.current === loaded.id) return
    metaAdoptedFor.current = loaded.id
    adoptMangaSettings(loaded.id, loaded.meta)
    const levels = zoomFromMeta(loaded.meta)
    setStripZoomState(levels.strip)
    setZoom({ ...NO_ZOOM, scale: levels.paged })
  }, [data])

  // Walking to another manga: whatever the last one still owed the server goes out now, and the reader
  // drops back to fit — and to the account-wide layout and image settings — until the new title's own
  // meta lands. Chapters of the same manga keep both: the id does not change, so neither does either.
  useEffect(() => {
    flushZoom.current()
    openManga(id)
    metaAdoptedFor.current = null
    setStripZoomState(ZOOM_FIT)
    setZoom(NO_ZOOM)
  }, [id])

  // Closing the reader inside the debounce window would otherwise lose the last change — the commonest
  // one there is, since changing something and leaving is a single gesture.
  useEffect(() => () => {
    flushZoom.current()
    void flushMangaSettings()
  }, [])

  // A layout or a fit change re-frames the page, and so does a page turn: the *pan* belonged to the
  // panel that has just gone, and carrying it over would leave the next page framed on nothing in
  // particular. The level survives all of them — it belongs to the manga now rather than to whatever
  // page happened to be on screen, which is what remembering it has to mean to be worth anything.
  const recentre = useCallback(() => setZoom((current) => ({ ...NO_ZOOM, scale: current.scale })), [])
  useEffect(() => { recentre() }, [fit, mode, prepared, spread, recentre])
  // Paged only: in a strip `page` is the marker walking down the chapter as it scrolls, and there is
  // no transform to re-centre in the first place.
  useEffect(() => { if (mode === 'paged') recentre() }, [mode, page, recentre])

  const onPointerDown = (event: React.PointerEvent) => {
    if (!zoomable) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    panned.current = false
    swipeStart.current = pointers.current.size === 1
      ? { id: event.pointerId, x: event.clientX, y: event.clientY }
      : null
    if (pointers.current.size === 2) {
      const [first, second] = [...pointers.current.values()]
      pinchStart.current = { distance: Math.hypot(first.x - second.x, first.y - second.y), scale: zoom.scale }
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!zoomable || !pointers.current.has(event.pointerId)) return
    const previous = pointers.current.get(event.pointerId)!
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.current.size >= 2 && pinchStart.current) {
      const [first, second] = [...pointers.current.values()]
      const distance = Math.hypot(first.x - second.x, first.y - second.y)
      if (pinchStart.current.distance > 0) {
        panned.current = true
        const midpoint = { clientX: (first.x + second.x) / 2, clientY: (first.y + second.y) / 2 }
        applyZoom(zoomAbout(zoom, pinchStart.current.scale * (distance / pinchStart.current.distance), fromCentre(midpoint.clientX, midpoint.clientY)))
      }
      return
    }

    // One pointer, and only once there is something to move: at fit size a drag is a swipe over the tap
    // zones, which is the reader's business rather than this one's.
    if (zoom.scale === ZOOM_MIN) return
    const deltaX = event.clientX - previous.x
    const deltaY = event.clientY - previous.y
    if (Math.abs(deltaX) > DRAG_SLOP || Math.abs(deltaY) > DRAG_SLOP) panned.current = true
    applyZoom({ scale: zoom.scale, x: zoom.x + deltaX, y: zoom.y + deltaY })
  }

  const onPointerUp = (event: React.PointerEvent) => {
    if (!zoomable) return
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinchStart.current = null

    // A swipe turns the page. This is the gesture `onPointerMove` hands off at fit size, where its
    // own comment says a drag "is a swipe over the tap zones, which is the reader's business rather
    // than this one's" - nothing had ever picked it up, so until now a horizontal drag did nothing
    // at all, in every one of the five tap layouts including `off`, which has no touch navigation
    // otherwise.
    const started = swipeStart.current
    if (started && started.id === event.pointerId) {
      swipeStart.current = null
      const deltaX = event.clientX - started.x
      const deltaY = event.clientY - started.y
      const width = readerStageRef.current?.getBoundingClientRect().width ?? 0
      const far = Math.max(SWIPE_MIN, width * SWIPE_FRACTION)
      // Zoomed in, a drag pans and has already moved the page; only at fit size is it a turn. Mouse
      // is left out on purpose - dragging with a pointer that has no momentum is not a page-turn
      // idiom, and it would fight text selection.
      const swipeable = zoom.scale === ZOOM_MIN && pointers.current.size === 0
        && (event.pointerType === 'touch' || event.pointerType === 'pen')
      // Mostly sideways, or a diagonal scroll attempt in a fit-width page would turn the page out
      // from under the reader.
      if (swipeable && Math.abs(deltaX) >= far && Math.abs(deltaX) > Math.abs(deltaY)) {
        // The page follows the finger: swiping left carries the current page off to the left and
        // brings in the one to its right. `leftPage`/`rightPage` already carry the reading direction
        // and the spread pairing, so this needs no mirror of its own and turns by two on a spread.
        const target = deltaX < 0 ? rightPage : leftPage
        // Before the click that follows: both the turn zones and the panel toggle test `panned`, so
        // this is what stops a swipe ending over a tap zone from turning the page a second time.
        panned.current = true
        if (!blocked(target)) goToPage(target)
        return
      }
    }

    // Touch has no dblclick worth relying on, so the double tap is counted here. Mouse double clicks
    // arrive as `dblclick` instead, which the stage handles.
    if (event.pointerType === 'touch' && !panned.current && !onTurnRegion(event.target)) {
      const previous = lastTap.current
      const now = event.timeStamp
      if (previous && now - previous.at < DOUBLE_TAP_MS
        && Math.abs(event.clientX - previous.x) < DOUBLE_TAP_SLOP
        && Math.abs(event.clientY - previous.y) < DOUBLE_TAP_SLOP) {
        lastTap.current = null
        toggleZoom(event)
        return
      }
      lastTap.current = { at: now, x: event.clientX, y: event.clientY }
    }
  }

  // Ctrl (or ⌘) and the wheel, the way every other viewer does it — and as a native listener rather
  // than React's `onWheel`, which is why it did the wrong thing until now: React attaches wheel
  // handlers to the root as *passive*, so the `preventDefault` here was ignored and the browser zoomed
  // its own page on top of the reader zooming the manga. A bare wheel is still left alone: it scrolls a
  // fit-width page and turns pages in a strip, both of which are already spoken for.
  useEffect(() => {
    const stage = readerStageRef.current
    if (!prepared || !stage) return
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      // A strip has no point to zoom about — the column simply gets wider or narrower — so it steps
      // rather than scaling continuously about the pointer.
      if (mode === 'strip') return setStripZoom(stripZoom + (event.deltaY < 0 ? STRIP_ZOOM_STEP : -STRIP_ZOOM_STEP))
      applyZoom(zoomAbout(zoom, zoom.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), fromCentre(event.clientX, event.clientY)))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
    // `applyZoom` and `fromCentre` are rebuilt every render and close over the zoom in force, so the
    // listener has to be replaced with them — otherwise the wheel would keep zooming from whatever the
    // level was when the chapter opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, prepared, setStripZoom, stripZoom, zoom])

  useEffect(() => {
    if (!prepared) return
    const onKeyDown = (event: KeyboardEvent) => {
      // The options dialog holds the keyboard while it is up: Escape dismisses it, and the reader's
      // own keys would otherwise act on the chapter behind it. Escape is deliberately not one of the
      // rebindable actions — a dialog that could be left without a way out is not a setting.
      if (optionsOpen) {
        // While a keys row is listening, Escape belongs to it — it is how a recording is abandoned
        // without binding anything, and closing the whole dialog instead would be a surprise.
        if (event.key === 'Escape' && !capturing) closeOptions()
        return
      }
      const action = actionFor(keybinds, keyChord(event))
      if (!action) return
      // The controls and the options are reachable from a focused picker, since neither of them is
      // something a <select> could want the key for; everything else waits until focus leaves it.
      if (action === 'toggleControls') setPanelOpen((current) => !current)
      if (action === 'toggleOptions') setOptionsOpen(!optionsOpen)
      if (isFormControl(event.target)) return
      if (action === 'pageLeft') goToPage(leftPage)
      if (action === 'pageRight') goToPage(rightPage)
      // The two hops the reader had no key for at all: reaching the next chapter meant running off
      // the end of this one, and the previous one meant the panel.
      if (action === 'chapterPrevious') openChapter(previousChapter)
      if (action === 'chapterNext') openChapter(nextChapter)
      // Zoom from the keyboard as well as from a pinch: a gesture nobody can see is a feature only a
      // touchscreen has.
      if (action === 'zoomIn') zoomIn()
      if (action === 'zoomOut') zoomOut()
      if (action === 'zoomReset') resetZoom()
      if (action === 'offsetSpread' && spreadActive) setSpreadOffset(spreadOffset === 0 ? 1 : 0)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // The zoom helpers close over the current zoom, so the listener has to be replaced when it
    // changes — otherwise `+` would keep zooming from whatever the scale was when the reader opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, closeOptions, goToPage, keybinds, leftPage, mode, nextChapter, openChapter, optionsOpen, prepared, previousChapter, rightPage, setOptionsOpen, spreadActive, spreadOffset, stripZoom, zoom])

  // --- Recording a key ----------------------------------------------------------------------------
  // A row of the keys tab listens for exactly one press and then stops. `keydown` in the capture
  // phase, so the press is taken before anything else in the app can act on it: the row being bound
  // is a button with focus, and Space or Enter would otherwise activate it rather than be recorded.
  useEffect(() => {
    if (!capturing) return
    const onKeyDown = (event: KeyboardEvent) => {
      // A modifier held on its own is half of a chord still being pressed, not a chord.
      if (isModifierKey(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      setCapturing(null)
      if (event.key === 'Escape') return
      const chord = keyChord(event)
      const { bindings, takenFrom } = bindChord(keybinds, capturing, chord)
      setKeybinds(bindings)
      setKeybindNote(takenFrom ? t('{chord} was taken off {action}', { chord: chordLabel(chord), action: t(KEYBIND_LABELS[takenFrom]) }) : null)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [capturing, keybinds, setKeybinds])

  // Read back from the store rather than off this render, because two chips can be taken off one row
  // faster than a render lands between them — and the second click computed against the render's list
  // would still have the first chord in it, quietly putting it back.
  const removeChord = (action: ReaderAction, chord: string) => {
    setKeybindNote(null)
    setKeybinds(unbindChord(readKeybinds(), action, chord))
  }

  const resetKeybinds = () => {
    setCapturing(null)
    setKeybindNote(null)
    setKeybinds({ ...DEFAULT_KEYBINDS })
  }

  // Vertical scrolling from the keyboard. The stage is the scroller rather than the document, and it
  // is not focusable, so none of these keys move anything by themselves — the browser scrolls the
  // focused scroll container, and that is the page behind. Driving it here is also what gives the
  // fast/smooth setting something to choose between: the distance is identical, only the arrival
  // differs. Applies to both layouts, since a fit-width page is taller than the screen just as a
  // strip is.
  useEffect(() => {
    if (!prepared) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (optionsOpen || isFormControl(event.target)) return
      const action = actionFor(keybinds, keyChord(event))
      if (!action || !SCROLL_ACTIONS.has(action)) return
      const stage = readerStageRef.current
      if (!stage) return
      const behavior: ScrollBehavior = keyboardScroll === 'smooth' ? 'smooth' : 'auto'
      event.preventDefault()
      if (action === 'toStart' || action === 'toEnd') {
        stage.scrollTo({ top: action === 'toStart' ? 0 : stage.scrollHeight, behavior })
        return
      }
      const step = SCREEN_SCROLL_ACTIONS.has(action) ? KEY_SCROLL_SCREEN : KEY_SCROLL_NUDGE
      stage.scrollBy({ top: stage.clientHeight * step * (BACKWARD_SCROLL_ACTIONS.has(action) ? -1 : 1), behavior })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keybinds, keyboardScroll, optionsOpen, prepared])

  useEffect(() => {
    if (!optionsOpen) return
    // Focus moves into the dialog when it opens, so the first Tab lands on its own controls.
    optionsDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [optionsOpen])

  useEffect(() => {
    if (mode !== 'strip' || !prepared || stripAnchor === 'pending' || !readerStageRef.current) return
    const stage = readerStageRef.current
    // Held in a local rather than in state so that releasing it takes effect before the next scroll frame.
    let anchor = typeof stripAnchor === 'number' ? Math.min(stripAnchor, prepared.pages.length - 1) : null
    let animationFrame = 0

    const updateStripProgress = () => {
      const stripPages = [...(stripReaderRef.current?.querySelectorAll<HTMLElement>('.strip-page') ?? [])]
      if (!stripPages.length) return
      const stageRect = stage.getBoundingClientRect()
      if (anchor !== null) {
        // Hold the resumed page at the top while lazy images above settle their heights.
        const drift = stripPages[anchor].getBoundingClientRect().top - stageRect.top
        if (Math.abs(drift) > 1) stage.scrollTop += drift
      }
      const marker = stageRect.top + Math.min(stage.clientHeight * 0.33, 240)
      let visiblePage = 0
      for (const [index, stripPage] of stripPages.entries()) {
        if (stripPage.getBoundingClientRect().top <= marker) visiblePage = index
        else break
      }
      // The page itself is the whole measure now that the bar is one segment per page — there is no
      // sub-page fraction left for anything to draw.
      setPage((current) => current === visiblePage ? current : visiblePage)
      if (reportedStripPage.current !== visiblePage) {
        reportedStripPage.current = visiblePage
        if (anchor === null) updateReaderProgress(id, sourceOrder, visiblePage, prepared.pages.length)
      }
    }

    const scheduleUpdate = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(updateStripProgress)
    }
    const releaseAnchor = () => {
      if (anchor === null) return
      anchor = null
      setStripAnchor('free')
    }
    const releaseOnScrollKey = (event: KeyboardEvent) => {
      const action = actionFor(keybinds, keyChord(event))
      if (action && SCROLL_ACTIONS.has(action)) releaseAnchor()
    }
    const strip = stripReaderRef.current
    const resizeObserver = new ResizeObserver(scheduleUpdate)
    if (strip) resizeObserver.observe(strip)
    // Images finishing their load shift the strip, so re-anchor on every one of them.
    strip?.addEventListener('load', scheduleUpdate, { capture: true })
    stage.addEventListener('scroll', scheduleUpdate, { passive: true })
    if (anchor !== null) {
      stage.addEventListener('wheel', releaseAnchor, { passive: true })
      stage.addEventListener('touchstart', releaseAnchor, { passive: true })
      stage.addEventListener('pointerdown', releaseAnchor)
      window.addEventListener('keydown', releaseOnScrollKey)
    }
    scheduleUpdate()
    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      strip?.removeEventListener('load', scheduleUpdate, { capture: true })
      stage.removeEventListener('scroll', scheduleUpdate)
      stage.removeEventListener('wheel', releaseAnchor)
      stage.removeEventListener('touchstart', releaseAnchor)
      stage.removeEventListener('pointerdown', releaseAnchor)
      window.removeEventListener('keydown', releaseOnScrollKey)
    }
  }, [id, keybinds, mode, prepared, sourceOrder, stripAnchor])

  // Hands-free strip reading. A frame loop rather than an interval and a fixed step: a strip is
  // continuous, and stepping it would put back the page turn that strip mode exists to remove.
  useEffect(() => {
    if (mode !== 'strip' || autoScroll === 'off' || !prepared) return
    const stage = readerStageRef.current
    if (!stage) return
    // Auto-scroll *is* scrolling, so the resume anchor has to let go. It holds the page it resumed on
    // at the top of the stage on every scroll event, and would drag the strip back a frame at a time.
    setStripAnchor('free')
    const secondsPerScreen = AUTO_SCROLL_SECONDS_PER_SCREEN[autoScroll]
    let frame = 0
    let last = 0
    // Sub-pixel remainder. At the slow setting a frame is well under a pixel, and dropping the
    // fraction every time would leave the strip standing still.
    let carry = 0

    const step = (time: number) => {
      frame = requestAnimationFrame(step)
      if (!last) {
        last = time
        return
      }
      const travelled = ((time - last) / 1000) * (stage.clientHeight / secondsPerScreen) + carry
      last = time
      const whole = Math.floor(travelled)
      carry = travelled - whole
      if (whole <= 0) return
      // At the end it idles instead of stopping: the strip still grows as lazy images below settle,
      // and continuing into the next chapter is the end panel's job, not this loop's.
      if (stage.scrollHeight - stage.scrollTop - stage.clientHeight <= 1) return
      stage.scrollBy(0, whole)
    }

    const stop = (event: Event) => {
      // A tap on a control is not a scroll gesture. The reveal button sits on the stage, and opening
      // the panel to change a setting must not cancel the thing being changed. `Element` rather than
      // `HTMLElement`: these buttons are an svg with a path in it, and an SVGElement is neither.
      if (event.target instanceof Element && event.target.closest('button')) return
      setAutoScroll('off')
    }
    const stopOnScrollKey = (event: KeyboardEvent) => {
      const action = actionFor(keybinds, keyChord(event))
      if (action && SCROLL_ACTIONS.has(action)) setAutoScroll('off')
    }

    frame = requestAnimationFrame(step)
    stage.addEventListener('wheel', stop, { passive: true })
    stage.addEventListener('touchstart', stop, { passive: true })
    stage.addEventListener('pointerdown', stop)
    window.addEventListener('keydown', stopOnScrollKey)
    return () => {
      cancelAnimationFrame(frame)
      stage.removeEventListener('wheel', stop)
      stage.removeEventListener('touchstart', stop)
      stage.removeEventListener('pointerdown', stop)
      window.removeEventListener('keydown', stopOnScrollKey)
    }
  }, [autoScroll, keybinds, mode, prepared, setAutoScroll])

  // Long strip: once the end card is on screen, more scrolling means "open the next chapter".
  useEffect(() => {
    if (mode !== 'strip' || !prepared || !nextChapter || !readerStageRef.current) return
    const stage = readerStageRef.current
    let overscroll = 0
    let lastWheelAt = 0

    const atBottom = () => stage.scrollHeight - stage.scrollTop - stage.clientHeight <= 2

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY <= 0 || !atBottom()) {
        overscroll = 0
        return
      }
      // Lifting off the wheel/trackpad starts a fresh gesture rather than adding to the last one.
      if (event.timeStamp - lastWheelAt > WHEEL_GESTURE_GAP) overscroll = 0
      lastWheelAt = event.timeStamp
      overscroll += wheelDistance(event, stage.clientHeight)
      if (overscroll < STRIP_OVERSCROLL) return
      overscroll = 0
      openChapter(nextChapter)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isFormControl(event.target)) return
      const action = actionFor(keybinds, keyChord(event))
      if (!action || !ADVANCE_ACTIONS.has(action)) return
      if (atBottom()) openChapter(nextChapter)
    }

    stage.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [keybinds, mode, nextChapter, openChapter, prepared])

  if (!Number.isInteger(id) || !Number.isInteger(sourceOrder)) return <div className="state-panel error"><p>{t('Invalid chapter address.')}</p></div>
  if (fetching) return <div className="state-panel reader-state"><p>{t('Opening chapter…')}</p></div>
  if (error) return <div className="state-panel error reader-state"><h2>{t('Chapter unavailable')}</h2><p>{friendlyError(error)}</p></div>
  if (!chapter) return <div className="state-panel error reader-state"><p>{t('Chapter not found.')}</p></div>
  if (pagesResult.error) return <div className="state-panel error reader-state"><h2>{t('Pages unavailable')}</h2><p>{friendlyError(pagesResult.error)}</p></div>
  if (pagesResult.fetching || !prepared) return <div className="state-panel reader-state"><span className="eyebrow">{t('Preparing chapter')}</span><h1>{chapter.name}</h1><p>{t('Fetching the pages from the source…')}</p></div>
  if (!prepared.pages.length) return <div className="state-panel error reader-state"><p>{t('This chapter contains no readable images.')}</p></div>

  // A hit target is dead only when what lies past it does not exist — running off either end is a
  // chapter hop, not the end of the road.
  const blocked = (target: number) => (target < 0 && !previousChapter) || (target > pageCount - 1 && !nextChapter)
  // The label always describes where the button takes you, which is the half of right-to-left that
  // the chevrons cannot express (see below).
  const hitLabel = (target: number) => {
    if (target < 0) return t('Previous chapter')
    if (target > pageCount - 1) return t('Next chapter')
    return target < page ? t('Previous page') : t('Next page')
  }

  // Sampled from the image the reader has just put on screen — already decoded, so reading it costs
  // no request. Only the first page of a pair decides the surround; two colours either side of a
  // spread would fight each other.
  const onPageLoad = (index: number) => (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!autoBackdrop) return
    const url = prepared.pages[index]
    const sample = backdrops.current.get(url) ?? sampleBackdrop(event.currentTarget)
    if (!sample) return
    backdrops.current.set(url, sample)
    if (index === spreadFirst) setBackdrop(sample)
  }

  // What a page the source would not serve looks like, in place of the browser's broken-image icon.
  // Sized close to a page so that recovering one does not shove the rest of the reader around.
  const pageErrorPanel = (url: string) => (
    <div className="page-error" key={url} role="alert">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4.5m0 3h.01M10.3 4.3 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" /></svg>
      <p>{t('This page did not load.')}</p>
      <button type="button" onClick={() => retryPage(url)}>{t('Try again')}</button>
    </div>
  )

  // One page of the paged reader. `lead` is the page the surround samples from and the one whose
  // load reports progress — the first of a pair, or the only page on screen.
  /**
   * A page with its border trimmed away.
   *
   * The wrapper is what carries the page's sizing — shaped to the kept region's aspect, so the layout
   * reserves the space the trimmed page actually needs rather than the space the untrimmed one did —
   * and the image inside is blown up by the inverse of the trim so the kept region exactly fills it.
   * A transform on the image alone could not do this: it would leave the old box, and its whitespace,
   * behind in the layout.
   */
  const cropWrapper = (url: string, crop: PageCrop, image: React.ReactNode, className?: string) => {
    const keptWidth = 1 - crop.left - crop.right
    const keptHeight = 1 - crop.top - crop.bottom
    return (
      <div
        key={url}
        className={`page-crop${className ? ` ${className}` : ''}`}
        style={{
          '--crop-aspect': String(crop.aspect),
          '--crop-width': `${100 / keptWidth}%`,
          '--crop-height': `${100 / keptHeight}%`,
          '--crop-left': `${(-100 * crop.left) / keptWidth}%`,
          '--crop-top': `${(-100 * crop.top) / keptHeight}%`,
        } as React.CSSProperties}
      >
        {image}
      </div>
    )
  }

  // What the setting has actually found, so its own row can say whether it is doing anything on this
  // chapter — a toggle with no visible effect otherwise reads as broken rather than as "no margins".
  const croppedNow = Object.values(crops).filter(Boolean).length


  const pagedPage = (index: number, lead: boolean, className?: string) => {
    const url = prepared.pages[index]
    if (pageErrors[url]?.failed) return pageErrorPanel(url)
    const crop = cropBorders ? crops[url] : null
    const image = (
      <img
        key={url}
        ref={lead ? pagedImageRef : undefined}
        className={crop ? undefined : className}
        src={srcFor(url)}
        alt={t('Page {page}', { page: index + 1 })}
        onError={() => failPage(url)}
        onLoad={(event) => {
          notePageSize(url, event.currentTarget)
          if (lead) {
            // The furthest page on screen that actually rendered. A page that failed has not been
            // seen, and reporting it would mark a chapter read on artwork nobody looked at.
            const seen = spreadPages.filter((target) => !pageErrors[prepared.pages[target]]?.failed)
            updateReaderProgress(id, sourceOrder, seen[seen.length - 1] ?? index, pageCount)
          }
          onPageLoad(index)(event)
        }}
      />
    )
    // The sliding animation moves whichever element the layout sizes, so it changes hands with the
    // wrapper — animating the image inside a fixed-size box would slide it against its own frame.
    return crop ? cropWrapper(url, crop, image, className) : image
  }

  return (
    <div className={`reader-shell ${mode}${panelOpen ? ' panel-open' : ' panel-closed'} bar-${progressBar}`}>
      <main
        className={`reader-stage fit-${fit}${zoomedIn ? ' zoomed' : ''}`}
        ref={readerStageRef}
        /* Always written, never dropped: React does not reliably remove a custom property when the
           style prop goes away, which left a sampled colour stuck on the element after the setting
           was switched back to Fixed. */
        style={{
          '--reader-bg': backdrop ? backdropCss(backdrop, grayscale, invert) : READER_BACKDROP_CSS,
          '--page-filter': pageFilter,
          // Handed to CSS rather than to an element: the page is an image, a trimmed page or a pair
          // depending on the layout, and one rule over the three beats threading a style through them.
          '--page-zoom': String(zoom.scale),
          '--pan-x': `${Math.round(zoom.x)}px`,
          '--pan-y': `${Math.round(zoom.y)}px`,
          // The strip's zoom is a width rather than a transform, so it travels as its own property.
          '--strip-zoom': String(stripZoom),
        } as React.CSSProperties}
        /* The gestures live on the stage rather than on the page, so a pinch that starts on the surround
           still zooms, and a drag can carry on past the page's own edge. */
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => { if (zoomable && !onTurnRegion(event.target)) toggleZoom(event) }}
      >
        {!panelOpen && (
          <button className="reader-panel-reveal" type="button" onClick={() => setPanelOpen(true)} aria-label={t('Show reader controls')} title={t('Show controls')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14" /></svg>
          </button>
        )}

        {/* Zoomed, and how far — with the way out on the same control. Without it a reader who pinched
            by accident has nothing on screen telling them what happened or how to undo it. */}
        {zoomedIn && (
          <button className="reader-zoom-badge" type="button" onClick={resetZoom} aria-label={t('{zoom}. Back to fit', { zoom: zoomReadout })} title={t('Back to fit')}>
            {zoomReadout}
          </button>
        )}

        {/* The dimmer, over the artwork and the surround but not over the panel: the controls have to
            stay legible enough to turn it back down. Sticky rather than absolute for the same reason
            the tap map is — a long strip is far taller than the screen, and the dimming has to stay
            with the viewport rather than scroll off it. Never a click target. */}
        {dim > 0 && <div className="reader-dim" style={{ opacity: dim / 100 }} aria-hidden="true" />}

        {mode === 'paged' ? (
          <div className="paged-reader">
            {/* Progress reports the *last* page on screen, not the first. Both have been seen, and
                reporting the first would leave a chapter whose final pair is a spread never reaching
                its last page — so it would never be marked read. Resuming still lands on the same
                pair, since pairStart maps either page of a pair back to it. */}
            {spreadPages.length === 2 ? (
              /* Keyed on the pair so the turn animation replays: an element React reuses in place
                 keeps the animation it already ran. */
              <div key={spreadFirst} className={`page-spread${direction === 'rtl' ? ' rtl' : ''}${slideClass}`}>
                {spreadPages.map((index, position) => pagedPage(index, position === 0))}
              </div>
            ) : (
              pagedPage(spreadFirst, true, slideClass.trim() || undefined)
            )}
            {/* The tap map, laid over the page. The chevrons keep pointing outward, at the side of
                the screen the region sits on rather than at the direction of travel — after
                mirroring, a back region on the right of the screen points right. What the region
                does is carried by its aria-label. */}
            {regions.length > 0 && (
              <div className="page-hits">
                {regions.map((region) => {
                  const style = {
                    left: `${region.left * 100}%`,
                    top: `${region.top * 100}%`,
                    width: `${region.width * 100}%`,
                    height: `${region.height * 100}%`,
                  }
                  const key = `${region.role}-${region.left}-${region.top}`
                  if (region.role === 'panel') {
                    return (
                      <button
                        key={key}
                        type="button"
                        className="page-hit panel-hit"
                        style={style}
                        aria-label={panelOpen ? t('Hide reader controls') : t('Show reader controls')}
                        onClick={() => { if (!panned.current) setPanelOpen((open) => !open) }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14" /></svg>
                      </button>
                    )
                  }
                  const target = region.role === 'forward' ? forwardPage : backwardPage
                  const pointsLeft = (region.role === 'back') === (direction === 'ltr')
                  return (
                    <button
                      key={key}
                      type="button"
                      /* `turn-hit` rather than a look-up by role at the point of use: the double
                         click below has to know whether it landed on a region that turns the page,
                         and the DOM is where that question gets asked. */
                      className="page-hit turn-hit"
                      style={style}
                      aria-label={hitLabel(target)}
                      /* A pan that happens to end over a tap zone is not a tap: dragging a zoomed page
                         to the left would otherwise turn the page as soon as the finger came up. */
                      onClick={() => { if (!panned.current) goToPage(target) }}
                      disabled={blocked(target)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d={pointsLeft ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7'} />
                      </svg>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="strip-reader" ref={stripReaderRef}>
            {prepared.pages.map((url, index) => {
              const crop = cropBorders ? crops[url] : null
              // A strip page has to report its size for the same reason a paged one does — it is the
              // only moment the border can be measured — so this img carries an onLoad now too.
              const image = (
                <img
                  src={srcFor(url)}
                  loading={index < 2 ? 'eager' : 'lazy'}
                  alt={t('Page {page}', { page: index + 1 })}
                  onError={() => failPage(url)}
                  onLoad={(event) => notePageSize(url, event.currentTarget)}
                />
              )
              return (
                <div className="strip-page" data-page={index + 1} key={url}>
                  {pageErrors[url]?.failed
                    ? pageErrorPanel(url)
                    : crop ? cropWrapper(url, crop, image) : image}
                </div>
              )
            })}
            <div className="strip-end">
              <span className="eyebrow">{t('End of {chapter}', { chapter: prepared.chapter.name })}</span>
              {nextChapter ? (
                <button className="strip-end-next" type="button" onClick={() => openChapter(nextChapter)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6" /></svg>
                  <span><strong>{nextChapter.name}</strong><small>{t('Keep scrolling to continue')}</small></span>
                </button>
              ) : (
                <p>{t('No later chapter available yet.')}</p>
              )}
            </div>
          </div>
        )}

        {/* The counter follows what is on screen, so a spread reads "4–5" rather than picking one of
            the two pages the reader is looking at. Along an edge it is the same three parts turned
            on their side; the vertical rail shows the last page of a pair alone, because "4–5" in a
            column that narrow would wrap. */}
        {(progressBar === 'top' || progressBar === 'bottom') && (
          <footer className={`reader-footer at-${progressBar}${direction === 'rtl' && mode === 'paged' ? ' rtl' : ''}`}>
            <span>{spreadPages.length === 2 ? `${spreadPages[0] + 1}–${spreadPages[1] + 1}` : spreadFirst + 1}</span>
            {progressTrack}
            <span>{pageCount}</span>
          </footer>
        )}
        {(progressBar === 'left' || progressBar === 'right') && (
          <div className={`reader-rail at-${progressBar}`}>
            <span>{spreadPages[spreadPages.length - 1] + 1}</span>
            {progressTrack}
            <span>{pageCount}</span>
          </div>
        )}
      </main>

      <aside className="reader-panel" aria-label={t('Reader controls')} aria-hidden={!panelOpen} inert={!panelOpen}>
        <header className="reader-panel-header">
          <Link to={chaptersHref} className="reader-panel-icon" aria-label={t('Close reader')} title={t('Back to chapters')}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </Link>
          <div className="reader-panel-header-actions">
            {/* The chapter as the source publishes it — for reporting a broken page, reading the
                scanlator's notes, or just seeing it where it lives. Absent, not disabled, on
                sources that hand us no per-chapter URL. */}
            {chapter?.realUrl && (
              <a
                className="reader-panel-icon"
                href={chapter.realUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={t('Open this chapter on the source site')}
                title={t('Open on the source site')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14 4h6v6" /><path d="M20 4 11 13" />
                  <path d="M18 14v5a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 19V7.8A1.8 1.8 0 0 1 5.8 6H11" />
                </svg>
              </a>
            )}
            {/* The same trip outwards, one shelf over: the series as AniList knows it, for the
                synopsis, the rating or the chapter count the source never reports. */}
            {anilistHref && (
              <a
                className="reader-panel-icon anilist-link"
                href={anilistHref}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={anilistUrl ? t('Open this title on AniList') : t('Search for this title on AniList')}
                title={anilistUrl ? t('Open on AniList') : t('Find on AniList')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6.361 2.943 0 21.056h4.942l1.077-3.133H11.4l1.052 3.133H22.9c.71 0 1.1-.392 1.1-1.101V17.53c0-.71-.39-1.101-1.1-1.101h-6.483V4.045c0-.71-.392-1.102-1.101-1.102h-2.422c-.71 0-1.101.392-1.101 1.102v1.064l-.85-2.166zm.598 10.993 1.478-4.834 1.53 4.834z" />
                </svg>
              </a>
            )}
            <button className="reader-panel-icon" type="button" onClick={() => setPanelOpen(false)} aria-label={t('Hide reader controls')} title={t('Hide controls')}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
            </button>
          </div>
        </header>

        <div className="reader-panel-body">
          <div className="reader-title-block with-action">
            <span className="reader-detail-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4.5h5A3 3 0 0 1 13 7.5V20a3 3 0 0 0-3-3H5V4.5Zm14 0h-3a3 3 0 0 0-3 3V20a3 3 0 0 1 3-3h3V4.5Z" /></svg></span>
            <div><span className="eyebrow">{t('Now reading')}</span><strong>{data?.manga.title}</strong></div>
            <button
              className="reader-options-toggle"
              type="button"
              ref={optionsToggleRef}
              aria-expanded={optionsOpen}
              aria-controls="reader-options"
              aria-label={optionsOpen ? t('Hide reader options') : t('Show reader options')}
              title={optionsOpen ? t('Hide options') : t('Show options')}
              onClick={() => setOptionsOpen(!optionsOpen)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.3 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.6 1.1v.3a1.8 1.8 0 0 1-3.6 0v-.2a1.5 1.5 0 0 0-2.7-1.1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1.1-2.6h-.3a1.8 1.8 0 0 1 0-3.6h.2a1.5 1.5 0 0 0 1.1-2.7l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.3a1.8 1.8 0 0 1 3.6 0v.2a1.5 1.5 0 0 0 2.6 1.1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.3a1.8 1.8 0 0 1 0 3.6h-.2a1.5 1.5 0 0 0-1.4.9Z" />
              </svg>
            </button>
          </div>
          <div className="reader-title-block chapter-title-block">
            <span className="reader-detail-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.75h8.5L19.25 7.5v12.75H7V3.75ZM15.25 4v3.75H19" /></svg></span>
            <div><small>{t('Chapter')}</small><strong>{prepared.chapter.name}</strong></div>
          </div>

          <div className="reader-control-group">
            <span className="reader-control-label">{t('Page')}</span>
            {/* Mirrored with the tap zones, or the panel would send you backwards from the side of
                the screen that sends you forwards. It stops at the ends rather than hopping chapters,
                which is what it has always done. */}
            <div className="reader-stepper">
              <button type="button" disabled={leftPage < 0 || leftPage > pageCount - 1} onClick={() => goToPage(leftPage)} aria-label={hitLabel(leftPage)}>‹</button>
              <select value={page} onChange={(event) => goToPage(Number(event.target.value))} aria-label={t('Current page')}>
                {prepared.pages.map((_, index) => <option value={index} key={index}>{t('Page {page} of {total}', { page: index + 1, total: pageCount })}</option>)}
              </select>
              <button type="button" disabled={rightPage < 0 || rightPage > pageCount - 1} onClick={() => goToPage(rightPage)} aria-label={hitLabel(rightPage)}>›</button>
            </div>
          </div>

          <div className="reader-control-group">
            <span className="reader-control-label">{t('Chapter')}</span>
            <div className="reader-stepper">
              <button type="button" disabled={!previousChapter} onClick={() => openChapter(previousChapter)} aria-label={t('Previous chapter')}>‹</button>
              <select value={chapter.id} onChange={(event) => openChapter(chapters.find((item) => item.id === Number(event.target.value)))} aria-label={t('Current chapter')}>
                {chapters.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select>
              <button type="button" disabled={!nextChapter} onClick={() => openChapter(nextChapter)} aria-label={t('Next chapter')}>›</button>
            </div>
          </div>

          {/* Zoom as a slider rather than a stepper, and on the panel rather than only under a gesture:
              pinch is a touchscreen's, ctrl and the wheel is a mouse's, and `+ −` is a keyboard's, so a
              reader who wanted a closer look had nothing on screen to reach for — and stepping in
              quarters meant a dozen presses to cross the range. The level reads out beside the label and
              the button on the right is the way back to fit, the same as the badge on the stage. */}
          <div className="reader-control-group">
            <span className="reader-control-label">
              {t('Zoom')}
              <span className="reader-control-value">{zoomedIn ? zoomReadout : t('Fit')}</span>
            </span>
            <div className="reader-range">
              <input
                type="range"
                min={zoomSpan.min}
                max={zoomSpan.max}
                step={ZOOM_SLIDER_STEP}
                value={zoomLevel}
                onChange={(event) => setZoomLevel(Number(event.target.value))}
                aria-label={t('Zoom')}
                aria-valuetext={zoomedIn ? zoomReadout : t('At fit size')}
              />
              <button
                className="reader-range-reset"
                type="button"
                disabled={!zoomedIn}
                onClick={resetZoom}
                aria-label={t('Back to fit')}
                title={t('Back to fit')}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9.5 4.5v5h-5M3.5 3.5l6 6M14.5 19.5v-5h5M20.5 20.5l-6-6" />
                </svg>
              </button>
            </div>
            <small className="reader-options-hint">
              {mode === 'strip'
                ? t('Widens or narrows the strip. Kept for this manga alone')
                : t('Kept for this manga alone. Pinch, double click or ctrl and the wheel do the same')}
            </small>
          </div>

          <div className="reader-panel-rule" />

          {/* Read off the bindings rather than written out, so a rebound key cannot be described here
              by the key it used to be. */}
          <div className="reader-shortcuts">
            {SHORTCUT_STRIP.map(({ actions, name }) => {
              // The *first* chord of each action rather than the first two of the list: a zoom bound
              // to `+` `=` `−` would otherwise read "+ =" and never mention zooming out at all.
              const chords = actions.map((action) => keybinds[action][0]).filter(Boolean)
              if (!chords.length) return null
              return <span key={name}>{chords.map(chordLabel).join(' ')} {t(name)}</span>
            })}
          </div>
        </div>
      </aside>

      {/* Kept in the DOM while closed so the cog's aria-controls always resolves; `hidden` takes the
          whole dialog out of the tab order with it. It sits outside the panel because the panel is
          transformed off-screen when it hides, and a fixed child would be carried off with it. */}
      <div className="reader-options-backdrop" id="reader-options" hidden={!optionsOpen} onClick={closeOptions}>
        <div
          className="reader-options-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('Reader options')}
          ref={optionsDialogRef}
          onClick={(event) => event.stopPropagation()}
        >
          {/* Two tabs rather than one long scroll: how the chapter is laid out, and how each page is
              drawn. The head carries them instead of a title — the tabs already say what this is. */}
          <header className="reader-options-head">
            <div className="reader-options-tabs" role="tablist" aria-label={t('Reader options')}>
              {(['layout', 'image', 'keys'] as OptionsTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`reader-options-tab-${tab}`}
                  className="reader-options-tab"
                  aria-selected={optionsTab === tab}
                  aria-controls={`reader-options-panel-${tab}`}
                  onClick={() => setOptionsTab(tab)}
                >
                  {tab === 'layout' ? t('Layout') : tab === 'image' ? t('Image') : t('Keys')}
                </button>
              ))}
            </div>
            <button className="reader-panel-icon" type="button" onClick={closeOptions} aria-label={t('Close options')} title={t('Close options')}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </header>

          {/* Said once, under the tabs, rather than repeated beside every control: everything on
              Layout and Image is remembered against *this* series, so a webtoon set to the long
              strip does not drag every paged title with it. A setting that quietly means something
              narrower than it looks is worth a sentence — and the keys, which do not, say so in the
              same breath rather than leaving the reader to work out the exception. */}
          {optionsTab !== 'keys' && (
            <p className="reader-options-scope">{t('Remembered for this manga alone — only the keys are shared with the rest of the library.')}</p>
          )}

          <div
            className="reader-options-body"
            role="tabpanel"
            id="reader-options-panel-layout"
            aria-labelledby="reader-options-tab-layout"
            hidden={optionsTab !== 'layout'}
          >
            {/* Single and Double are the same paged reader with the spread off and on, so the three
                sit in one row of tiles rather than as a mode plus a checkbox hidden below it. */}
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Layout')}</span>
              <div className="reader-choices tiles" role="group" aria-label={t('Layout')}>
                <button className="reader-choice" type="button" aria-pressed={mode === 'paged' && spread === 'off'} onClick={() => setLayout('single')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3.5" width="8" height="17" rx="1.6" /></svg>
                  <span>{t('Single')}</span>
                </button>
                <button className="reader-choice" type="button" aria-pressed={mode === 'paged' && spread !== 'off'} onClick={() => setLayout('double')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="7.5" height="15" rx="1.4" /><rect x="13" y="4.5" width="7.5" height="15" rx="1.4" /></svg>
                  <span>{t('Double')}</span>
                </button>
                <button className="reader-choice" type="button" aria-pressed={mode === 'strip'} onClick={() => setLayout('strip')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.5" width="6" height="19" rx="1.4" /><path d="M9 8.8h6M9 15.2h6" /></svg>
                  <span>{t('Long strip')}</span>
                </button>
              </div>
              {/* Says which of the two paged states you are actually in, since the window can veto a
                  spread without changing the setting. */}
              <small className="reader-options-hint">
                {mode === 'strip'
                  ? t('Continuous vertical reading')
                  : spread !== 'off' && !roomForSpread
                    ? t('One page — the window is too narrow')
                    : spread === 'auto'
                      ? t('Two pages side by side, except where one is wider than it is tall')
                      : spread === 'on' ? t('Two pages side by side') : t('One page at a time')}
              </small>
              {/* Both pairing controls answer "where does a pair start", so only one of them can be
                  on show: shifting by hand is the answer for a cover, and deciding from the artwork
                  is the answer for a chapter with a splash page in the middle of it. */}
              {mode === 'paged' && spread !== 'off' && (
                <button className="reader-check" type="button" aria-pressed={autoPairing} onClick={() => setSpread(autoPairing ? 'on' : 'auto')}>
                  <span className="reader-check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                  <span>
                    <strong>{t('Pair by page shape')}</strong>
                    <small>{autoPairing ? t('A page wider than it is tall gets a screen to itself') : t('Every pair is two pages, whatever their shape')}</small>
                  </span>
                </button>
              )}
              {mode === 'paged' && spread === 'on' && (
                <button className="reader-check" type="button" aria-pressed={spreadOffset === 1} onClick={() => setSpreadOffset(spreadOffset === 1 ? 0 : 1)}>
                  <span className="reader-check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                  <span>
                    <strong>{t('Shift the pairing')}</strong>
                    <small>{spreadOffset === 1 ? t('First page stands alone') : t('Pairs start at page one')}</small>
                  </span>
                </button>
              )}
            </section>

            {/* Direction and the turn animation stay on show in strip mode rather than vanishing —
                the menu keeps the same shape whichever layout is on — but they are disabled there,
                because a strip scrolls the same either way and has no turn to animate. */}
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Reading direction')}</span>
              <div className="reader-choices" role="group" aria-label={t('Reading direction')}>
                {/* These arrows mirror each other — unlike the tap-zone chevrons they name the
                    setting rather than marking a side of the screen. */}
                <button className="reader-choice" type="button" disabled={mode === 'strip'} aria-pressed={direction === 'ltr'} onClick={() => setDirection('ltr')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16m0 0-5-5m5 5-5 5" /></svg>
                  <span>{t('Left to Right')}</span>
                </button>
                <button className="reader-choice" type="button" disabled={mode === 'strip'} aria-pressed={direction === 'rtl'} onClick={() => setDirection('rtl')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H4m0 0 5-5m-5 5 5 5" /></svg>
                  <span>{t('Right to Left')}</span>
                </button>
              </div>
              <small className="reader-options-hint">
                {mode === 'strip'
                  ? t('A long strip reads the same either way')
                  : direction === 'rtl' ? t('Tap the left side to go forward') : t('Tap the right side to go forward')}
              </small>
            </section>

            <section className="reader-options-group">
              <button className="reader-check plain" type="button" disabled={mode === 'strip'} aria-pressed={sliding} onClick={() => setSliding(!sliding)}>
                <span className="reader-check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                <span><strong>{t('Sliding animation')}</strong></span>
              </button>
            </section>

            <section className="reader-options-group">
              <span className="reader-control-label">{t('Keyboard scrolling')}</span>
              <div className="reader-choices" role="group" aria-label={t('Keyboard scrolling')}>
                <button className="reader-choice" type="button" aria-pressed={keyboardScroll === 'fast'} onClick={() => setKeyboardScroll('fast')}>
                  <span>{t('Scroll fast')}</span>
                </button>
                <button className="reader-choice" type="button" aria-pressed={keyboardScroll === 'smooth'} onClick={() => setKeyboardScroll('smooth')}>
                  <span>{t('Scroll smooth')}</span>
                </button>
              </div>
              <small className="reader-options-hint">{keyboardScroll === 'smooth' ? t('The arrow and page keys glide') : t('The arrow and page keys jump')}</small>
            </section>

            {/* Kept on show outside the strip and disabled there, like the direction and animation
                rows: a paged reader has nothing to scroll on its own. */}
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Auto-scroll')}</span>
              <div className="reader-choices" role="group" aria-label={t('Auto-scroll')}>
                {AUTO_SCROLL_ORDER.map((speed) => (
                  <button
                    key={speed}
                    className="reader-choice"
                    type="button"
                    disabled={mode !== 'strip'}
                    aria-pressed={autoScroll === speed}
                    onClick={() => setAutoScroll(speed)}
                  >
                    <span>{t(AUTO_SCROLL_LABELS[speed])}</span>
                  </button>
                ))}
              </div>
              <small className="reader-options-hint">
                {mode !== 'strip'
                  ? t('Long strip only')
                  : autoScroll === 'off'
                    ? t('The strip moves only when you do')
                    : t('Any wheel, tap or key hands it back — pair it with Keep the screen awake')}
              </small>
            </section>

            <section className="reader-options-group">
              <span className="reader-control-label">{t('Progress bar')}</span>
              <div className="reader-choices icons" role="group" aria-label={t('Progress bar')}>
                {PROGRESS_BAR_POSITIONS.map((position) => (
                  <button
                    key={position}
                    className="reader-choice"
                    type="button"
                    aria-pressed={progressBar === position}
                    aria-label={t(PROGRESS_BAR_LABELS[position])}
                    title={t(PROGRESS_BAR_LABELS[position])}
                    onClick={() => setProgressBar(position)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">{PROGRESS_BAR_ICONS[position]}</svg>
                  </button>
                ))}
              </div>
              <small className="reader-options-hint">{t(PROGRESS_BAR_LABELS[progressBar])}</small>
            </section>

            {/* Dropped rather than disabled in strip mode, unlike the two above: this one is a row of
                five diagrams of a screen that has no tap targets on it at all.

                Five options do not fit a row of labelled buttons, and a map is far easier to
                recognise drawn than described. Each diagram is drawn from tapRegions with the
                direction applied, so it shows the map as it will actually sit on the screen. */}
            {mode === 'paged' && (
              <section className="reader-options-group">
                <span className="reader-control-label">{t('Tap zones')}</span>
                <div className="tap-layout-options" role="group" aria-label={t('Tap zone layout')}>
                  {TAP_LAYOUT_ORDER.map((layout) => (
                    <button
                      key={layout}
                      type="button"
                      className={`tap-layout-option${tapLayout === layout ? ' active' : ''}`}
                      aria-pressed={tapLayout === layout}
                      aria-label={t('{layout} tap zones', { layout: t(TAP_LAYOUTS[layout].name) })}
                      title={t(TAP_LAYOUTS[layout].name)}
                      onClick={() => setTapLayout(layout)}
                    >
                      <svg viewBox="0 0 30 42" aria-hidden="true" preserveAspectRatio="none">
                        <rect className="zone-empty" x="0" y="0" width="30" height="42" />
                        {tapRegions(layout, direction).map((region) => (
                          <rect
                            key={`${region.role}-${region.left}-${region.top}`}
                            className={`zone-${region.role}`}
                            x={region.left * 30}
                            y={region.top * 42}
                            width={region.width * 30}
                            height={region.height * 42}
                          />
                        ))}
                      </svg>
                    </button>
                  ))}
                </div>
                <small className="reader-options-hint">{t(TAP_LAYOUTS[tapLayout].hint)}</small>
              </section>
            )}
          </div>

          {/* How each page is drawn, rather than how the chapter is laid out. */}
          <div
            className="reader-options-body"
            role="tabpanel"
            id="reader-options-panel-image"
            aria-labelledby="reader-options-tab-image"
            hidden={optionsTab !== 'image'}
          >
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Page fit')}</span>
              <div className="reader-choices" role="group" aria-label={t('Page fit')}>
                <button className="reader-choice" type="button" disabled={mode === 'strip'} aria-pressed={fit === 'height'} onClick={() => setFit('height')}>
                  <span>{t('Fit height')}</span>
                </button>
                <button className="reader-choice" type="button" disabled={mode === 'strip'} aria-pressed={fit === 'width'} onClick={() => setFit('width')}>
                  <span>{t('Fit width')}</span>
                </button>
              </div>
              <small className="reader-options-hint">
                {mode === 'strip'
                  ? t('A long strip always fills the width')
                  : fit === 'height' ? t('The whole page on screen') : t('Scaled to the window width')}
              </small>
            </section>

            {/* Beside Page fit because that is what it changes: how much of the screen the artwork
                gets. Every layout — a strip page is framed by its own margin just as a single page is. */}
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Borders')}</span>
              <button className="reader-check" type="button" aria-pressed={cropBorders} onClick={() => setCropBorders(!cropBorders)}>
                <span className="reader-check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                <span>
                  <strong>{t('Trim solid margins')}</strong>
                  <small>
                    {cropBorders
                      ? croppedNow > 0
                        ? t('Trimmed on {count} of the {total} pages seen so far', { count: croppedNow, total: pageCount })
                        : t('No margin found on these pages')
                      : t('Pages as the source scanned them')}
                  </small>
                </span>
              </button>
            </section>

            {/* Both apply to every layout — a long strip inverts for exactly the same reason a page
                does — and they compose, so the two together read a page as light-on-dark grey. */}
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Colour')}</span>
              <button className="reader-check" type="button" aria-pressed={grayscale} onClick={() => setGrayscale(!grayscale)}>
                <span className="reader-check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                <span>
                  <strong>{t('Grayscale')}</strong>
                  <small>{grayscale ? t('Colour drained from every page') : t('Pages keep their own colour')}</small>
                </span>
              </button>
              <button className="reader-check" type="button" aria-pressed={invert} onClick={() => setInvert(!invert)}>
                <span className="reader-check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                <span>
                  <strong>{t('Invert colours')}</strong>
                  <small>{invert ? t('White pages read as dark') : t('Pages as the source drew them')}</small>
                </span>
              </button>
            </section>

            {/* Independent of the device's own backlight, and of the colour modes above: this darkens
                what is on the stage rather than changing how the page is drawn. */}
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Brightness')}</span>
              <div className="reader-range">
                <input
                  type="range"
                  min={0}
                  max={DIM_MAX}
                  step={DIM_STEP}
                  value={dim}
                  onChange={(event) => setDim(Number(event.target.value))}
                  aria-label={t('Dim the page')}
                  aria-valuetext={dim === 0 ? t('Not dimmed') : t('Dimmed {percent} percent', { percent: dim })}
                />
                <button
                  className="reader-range-reset"
                  type="button"
                  disabled={dim === 0}
                  onClick={() => setDim(0)}
                  aria-label={t('Stop dimming the page')}
                  title={t('Full brightness')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="4.2" />
                    <path d="M12 3.2v2.4M12 18.4v2.4M3.2 12h2.4M18.4 12h2.4M5.9 5.9l1.7 1.7M16.4 16.4l1.7 1.7M18.1 5.9l-1.7 1.7M7.6 16.4l-1.7 1.7" />
                  </svg>
                </button>
              </div>
              <small className="reader-options-hint">
                {dim === 0 ? t('As bright as the screen itself') : t('Dimmed {percent}% — darker than the backlight goes', { percent: dim })}
              </small>
            </section>

            {/* Paged-only for the same reason as before: a continuous strip has no single page on
                screen to take a colour from. */}
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Background')}</span>
              <button className="reader-check" type="button" disabled={mode === 'strip'} aria-pressed={background === 'auto'} onClick={() => setBackground(background === 'auto' ? 'fixed' : 'auto')}>
                <span className="reader-check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                <span>
                  <strong>{t('Background follows the page')}</strong>
                  <small>
                    {mode === 'strip'
                      ? t('Single and double pages only')
                      : background === 'auto' ? t('Takes each page’s own edge colour') : t('The usual dark surround')}
                  </small>
                </span>
              </button>
            </section>

            {/* Not about how a page is drawn, but it belongs beside the screen setting rather than
                in Layout: both are about the reading session rather than the shape of the chapter. */}
            <section className="reader-options-group">
              <span className="reader-control-label">{t('Download ahead')}</span>
              <div className="reader-choices" role="group" aria-label={t('Download ahead')}>
                {DOWNLOAD_AHEAD_VALUES.map((count) => (
                  <button
                    key={count}
                    className="reader-choice"
                    type="button"
                    aria-pressed={downloadAhead === count}
                    aria-label={count === 0 ? t('Download nothing ahead') : t('Keep {count} chapters ahead on disk', { count })}
                    onClick={() => setDownloadAhead(count)}
                  >
                    <span>{count === 0 ? t('Off') : count}</span>
                  </button>
                ))}
              </div>
              <small className="reader-options-hint">
                {downloadAhead === 0
                  ? t('Nothing is downloaded while you read')
                  : t('The next {count} chapters download once you are a quarter of the way in', { count: downloadAhead })}
              </small>
            </section>

            {/* Not gated on the layout — a long strip keeps the screen on for the same reason. */}
            {wakeLockSupported && (
              <section className="reader-options-group">
                <span className="reader-control-label">{t('Screen')}</span>
                <button className="reader-check" type="button" aria-pressed={wakeLock} onClick={() => setWakeLock(!wakeLock)}>
                  <span className="reader-check-box" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" /></svg></span>
                  <span>
                    <strong>{t('Keep the screen awake')}</strong>
                    <small>{wakeLock ? t('On while a chapter is open') : t('Off — the screen dims as usual')}</small>
                  </span>
                </button>
              </section>
            )}
          </div>

          {/* Which key does what. Every row is a list of chords rather than a single one, because the
              reader's own defaults need it — a strip scrolls on Space *and* on PageDown — and because
              taking a key away should not have to mean putting another one in its place. */}
          <div
            className="reader-options-body"
            role="tabpanel"
            id="reader-options-panel-keys"
            aria-labelledby="reader-options-tab-keys"
            hidden={optionsTab !== 'keys'}
          >
            {KEYBIND_GROUPS.map((group) => (
              <section className="reader-options-group" key={group.name}>
                <span className="reader-control-label">{t(group.name)}</span>
                <div className="keybind-rows">
                  {group.actions.map((action) => (
                    <div className="keybind-row" key={action}>
                      <span className="keybind-name">{t(KEYBIND_LABELS[action])}</span>
                      <div className="keybind-chords">
                        {keybinds[action].map((chord) => (
                          <button
                            key={chord}
                            className="keybind-chord"
                            type="button"
                            onClick={() => removeChord(action, chord)}
                            aria-label={t('Unbind {chord} from {action}', { chord: chordLabel(chord), action: t(KEYBIND_LABELS[action]) })}
                            title={t('Remove')}
                          >
                            <kbd>{chordLabel(chord)}</kbd>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
                          </button>
                        ))}
                        {keybinds[action].length === 0 && <span className="keybind-empty">{t('No key')}</span>}
                        <button
                          className={`keybind-add${capturing === action ? ' listening' : ''}`}
                          type="button"
                          onClick={() => { setKeybindNote(null); setCapturing(capturing === action ? null : action) }}
                          aria-label={capturing === action
                            ? t('Cancel — listening for a key for {action}', { action: t(KEYBIND_LABELS[action]) })
                            : t('Add a key for {action}', { action: t(KEYBIND_LABELS[action]) })}
                          title={capturing === action ? t('Press a key, or Escape') : t('Add a key')}
                        >
                          {capturing === action ? t('Press a key…') : '+'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {/* Said once, on the group it applies to: the two page keys are the only ones in the
                    list whose meaning is a side of the screen rather than a direction of travel. */}
                {group.name === 'Turning' && (
                  <small className="reader-options-hint">{t('The page keys follow the side of the screen, so they swap over with a right-to-left reading direction — as the panel\u2019s arrows and the tap zones already do.')}</small>
                )}
              </section>
            ))}

            <section className="reader-options-group">
              {keybindNote && <small className="reader-options-hint">{keybindNote}</small>}
              <button className="reader-choice wide" type="button" disabled={isDefaultKeybinds(keybinds)} onClick={resetKeybinds}>
                <span>{t('Back to the default keys')}</span>
              </button>
              <small className="reader-options-hint">{t('One key belongs to one action: binding a key that is already taken moves it. Escape is the reader\u2019s own — it closes this dialog and abandons a recording, and cannot be bound.')}</small>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
