# Plan

Cumulative, newest work last. Sections 1–3 came from surveying the Tachimanga fork; 4–8 from scout
report #11; 9–11 from report #14; 12–14 are the rest of report #11, deferred at the time. Ideas
**rejected after inspection** are recorded here on purpose —
the weekly scout reads this file and an unrecorded rejection comes back as a fresh finding.

## Sections 1–3 — three features borrowed from the Tachimanga fork

**Status: all three shipped, merged to `main`, and deployed (2026-08-11).** PR #6 (continue reading),
PR #7 (carry progress on rebind), PR #8 (batch library actions); every branch deleted after merge.
Each was verified against the running server on throwaway titles, with the test data reverted
afterwards. The continue-reading shelf was then reworked into a shelf of covers, one card per series
(`68ff220`, `ff211dd`). The build of `ff211dd` (`assets/index-CWWsQmAo.js`) is copied into the data
directory's `webUI/` and is what the tray server serves, so all of this is live in normal (non-dev)
use — no further build/copy/restart pending.


Ideas taken from `tachimanga/Tachidesk-Server` after surveying it. **No code is ported**: their base is
pre-GraphQL Tachidesk (0 files under `tachidesk/graphql/`, REST controllers only, squashed `update`
commits), so each item is a reimplementation against our stack. All three land in
`Stremio4Manga-UI` — the server already exposes everything needed, so `Stremio4Manga-Server` is not
touched and no rebuild/redeploy of the jar is required.

Rejected after inspection (recorded so this is not re-litigated): `ImageUtil`, `MemoUtil`, the
rate-limit/user-agent/Cloudflare interceptors (we already have equivalents), `UserData.kt` DB vacuum
(our `database.mv.db` is 11.4 MB — not a problem), `Stats.kt` read-duration (needs a schema change
for a vanity number), and everything iOS-only (`JavaChannel`, `PipStatus`, `CallNativeNetInterceptor`,
`McCookieJar`, the `cloud/` sync package, `ChapterForRead.supportDirect`).

## Shared context

- Read state is already written: `ReaderPage.tsx:55-63` PATCHes `lastPageRead`, plus `read=true` on
  the last page, to `/api/v1/manga/:id/chapter/:sourceOrder`. The server stamps `lastReadAt`.
- Chapters hang off the **bound source manga**, not the library entry. `LibraryPage` resolves the
  binding from manga meta `stremio4manga.source-binding` with the localStorage value as fallback
  (`boundSourceId`, `LibraryPage.tsx:137`). Reader links carry `?from=<libraryEntryId>` so Back
  returns to the library entry rather than the source entry.
- Verified available in our GraphQL schema:
  - `ChapterOrderBy.LAST_READ_AT`, used as `order: [{ by: LAST_READ_AT, byType: DESC }]`
  - `ChapterFilter.lastReadAt: LongFilter` (`greaterThan`); `Long` is the `LongString` scalar, so it
    is passed as a **string** variable typed `LongString`
  - `chapters(..., first: Int)`, `ChapterType.manga`, `ChapterType.lastPageRead/lastReadAt`
  - `updateChapters(input: { ids, patch: { isRead } })`, `updateMangas(input: { ids, patch: { inLibrary } })`

Order of attack: **1 → 2 → 3**. Each is a separate branch and PR off `main` in
`Stremio4Manga-UI`, and the merged branch gets deleted (local + remote).

---

## 1. Continue reading / history shelf

*Their `History.kt` + `HistoryController`. We need no table — we already store the data and simply
never read it back: `lastReadAt` appears nowhere in the UI.*

Branch: `feat/continue-reading`

**Behaviour.** A shelf at the top of the library listing the titles most recently read, newest first.
Each card shows the cover, the title, the chapter you stopped on, and resumes at that chapter (the
reader already restores `lastPageRead` on open). One entry per title — the most recent chapter wins.
If the last chapter was finished, point at the next unread chapter instead of re-opening a finished
one; if there is no next chapter, the card says the title is caught up and links to the detail page.

**Steps.**
1. `RECENT_READS_QUERY` in `LibraryPage.tsx`:
   `chapters(filter: { lastReadAt: { greaterThan: $since } }, order: [{ by: LAST_READ_AT, byType: DESC }], first: 60)`
   selecting `id name chapterNumber sourceOrder lastPageRead pageCount isRead mangaId manga { id title thumbnailUrl }`.
   `$since: LongString!` = `"0"`. Over-fetch (60) because several chapters of the same title collapse
   into one card.
2. Invert the existing `boundByManga` map (library entry → bound source) to bound → library entry, so
   a history row on a source manga resolves back to its library card. Rows whose manga is neither a
   library entry nor a bound source (read straight from Discover) still render, linking to themselves.
3. Collapse to one row per manga (highest `lastReadAt`), take the first 8.
4. Local `ContinueReadingShelf` component in `LibraryPage.tsx` — the file already hosts its own
   helpers, and `MangaDetailPage.tsx` sets the precedent for page-local components.
5. Reader link: `/manga/<chapterMangaId>/chapter/<sourceOrder>?from=<libraryEntryId>`, matching
   `ChapterList.readerPath`.
6. Styles in `App.css` next to the existing `.shelf` / `.card` rules; reuse `.cover-wrap`.
7. Hide the shelf entirely when nothing has been read, so a fresh install is unchanged.

**Done when:** reading a chapter, going back to the library, and seeing that title first in the shelf,
resuming on the page it was left at.

---

## 2. Carry read progress across a source change

*Their `Migrate.kt`. Our "Change source" flow (`MangaDetailPage.bindTo`, line 970) already rebinds,
and AniList-tracked titles survive it — `bindTrackRecord` + `fetchTrack` reconcile progress
(`MangaDetailPage.tsx:920-941`), and `readThrough = max(anilistProgress, localReadThrough)` renders
old chapters as read. **Untracked titles lose everything on rebind**, and that is the real gap.*

Branch: `feat/carry-progress-on-rebind`

**Behaviour.** When the source is changed, read-through from the outgoing source is applied to the
incoming one: every chapter on the new source at or below the old read-through is marked read. The
user is told what happened and can undo it — silent bulk mutation of read state is not acceptable.

**Steps.**
1. Before rebinding, compute `previousReadThrough` = highest `chapterNumber` with `isRead` on the
   currently bound manga (or on the library entry when unbound). `ChapterList` already derives
   exactly this as `localReadThrough` (line 281) — lift it to the page via a callback, in the same
   shape as the existing `onLatestChapter`.
2. In `bindTo`, after the binding is saved: `fetchChapters` on the new manga (the chapter list does
   this on mount anyway — reuse the mutation rather than racing it), then query its chapters.
3. `updateChapters(input: { ids: [...], patch: { isRead: true } })` for chapters with
   `chapterNumber <= previousReadThrough` that are not already read. Skip entirely when
   `previousReadThrough === 0`.
4. Confirmation UI on the source card: "Marked N chapters read, carried over from <old source>" plus
   an Undo that flips the same ids back to `isRead: false`. Hold the id list in state for the undo.
5. Guard the AniList path: when a track record is present the reconcile effect already covers
   display, so carrying over is still correct but must not fight `fetchTrack`. Run the carry-over
   only after the rebind's `saveSourceBinding` resolves.

**Done when:** an untracked title read to chapter 20 on source A, rebound to source B, shows
chapters 1–20 read on B, and Undo restores B to fully unread.

---

## 3. Batch library actions

*Their `MangaBatch.kt`. Our server already has the batch mutations from upstream v2.3; only the
multi-select is missing.*

Branch: `feat/library-batch-actions`

**Behaviour.** A selection mode on the library grid: toggle it on, tick covers, then apply one action
to all of them. Two actions, both of which are chores today: **remove from library** and **mark
caught up** (mark every chapter on the bound source read).

**Steps.**
1. Selection state in `LibraryPage` (`Set<number>` of library entry ids) plus a mode toggle in the
   existing `.library-toolbar`, next to the AniList refresh button — icon-only with `aria-label`,
   matching the toolbar's style.
2. While in selection mode, cards stop navigating: the `Link` becomes a `button` that toggles
   selection, with `aria-pressed` and a checked marker on the cover.
3. Action bar showing the count and the two actions, with a confirmation step for removal since it is
   destructive and hits several titles at once.
4. Remove: `updateMangas(input: { ids, patch: { inLibrary: false } })`, then refetch the library.
5. Mark caught up: for each selected entry resolve its bound source, collect that manga's unread
   chapter ids, and `updateChapters` them in one call per title. Report failures per title rather
   than failing the whole batch — the same pattern as `refreshFromAniList` (`LibraryPage.tsx:198`).
6. Leave selection mode and clear the selection once the batch settles.

**Done when:** three titles can be selected and removed in one action, and "mark caught up" clears
their unread chips.

---

## Sections 4–8 — from scout report #11

Surveyed from Mihon, Kavita and the Suwayomi server's own schema, then re-verified against `main` at
`6bfb2da` (post-PR #10). Order of attack: **7 → 8 → 4 → 5 → 6** — backup first because it is the only
one that protects data and the cheapest to build, then the library update gap, then the reader work
cheapest-first. **All five shipped**, each with its own corrections recorded under its steps.

Left in the report for later, deliberately not planned here (issue #11 stays open): configurable
tap-zone layouts (the RTL toggle in 5 covers the inversion case that actually matters), user-defined
categories (the library already groups by AniList status), and the chapter download queue (the
largest item, worth doing on its own).

---

## 4. Prefetch the next reader pages

**Status: shipped. Step 1 of the plan was wrong in a way that would have corrupted read state — see
the correction below.**

*Mihon's `HttpPageLoader` keeps `preloadSize = 4` pages ahead. We fetch nothing ahead: `ReaderPage.tsx:335`
renders one `<img>` per screen, and `preload`/`prefetch`/`new Image(` appear nowhere in `src`.*

Branch: `feat/reader-prefetch`

### Correction: prefetching through `withProgress` marks unseen pages read

Step 1 said the prefetch must reuse `withProgress` or the browser cache would miss. It would have
missed for the right reason and broken something worse: `withProgress` appends `updateProgress=true`,
and the server's page handler treats that as *the reader has reached this page* —
`MangaController.kt:491` calls `Chapter.updateChapterProgress`, which writes `lastPageRead = index`
and sets `isRead` when the index is the last page (`Chapter.kt:811-821`). Prefetching four pages
ahead would therefore have pushed progress four pages past what was on screen and marked every
chapter read four pages early.

The fix inverts it: the visible `<img>` **drops** `withProgress`, and progress is reported from its
`onLoad` through `updateReaderProgress` — the same PATCH the strip has always used, writing the same
`lastPageRead` and the same `read=true` on the final page. Every page url is then bare and identical
between prefetch and display, which is what makes the prefetch a cache hit at all. `withProgress` is
gone from the file; the whole reader now reports progress through one path.

**This also retires the caveat in section 10 step 1** — there is no longer a query parameter on page
urls that a second request could trip.

**Behaviour.** Turning a page in paged mode shows the image immediately instead of a blank frame,
because the next few pages were already fetched while the current one was on screen. Nothing visible
changes otherwise — no setting, no indicator.

**Steps as built.**
1. Effect keyed on `[mode, page, prepared]`: for `page + 1 … page + 4`, `new Image()` on the **bare**
   page url (see the correction above).
2. The `Image` objects live in a ref keyed by url so a request in flight is not collected when the
   page turns and a page already being fetched is never restarted; the map is cleared alongside the
   existing `requestedChapter` reset.
3. Paged mode only — `mode === 'strip'` already has native lazy-loading with `loading="eager"` on the
   first two, and prefetching a long strip would fight it.
4. Nothing is prefetched across a chapter boundary. The original step 4 said to prefetch the next
   chapter's first pages "only if its pages are already known" — they never are, since they arrive
   only from `fetchChapterPages`, so this reduces to nothing and was dropped rather than trading a
   speculative mutation on every chapter's last page for one blank frame.

**Verified:** on a chapter of a title outside the library, the reader requested pages 0–4 on open and
slid the window forward on each turn (5 and 6 after two turns), with exactly one request per page —
no page fetched twice. Progress wrote `lastPageRead: 2` on page 3 and `isRead: true` on the last page,
matching the old behaviour; the test progress was reverted afterwards.

---

## 5. Right-to-left reading direction

**Status: shipped. Step 3 (mirroring the chevrons) was not done — see the note under the steps.**

*Mihon defaults new titles to `ReadingMode.RIGHT_TO_LEFT`; Kavita exposes the same as a per-series
"Reading Direction". Inkstream is hardcoded LTR — `ArrowLeft` is always `page - 1` and `ArrowRight`
always `page + 1` (`ReaderPage.tsx:191-192`), and the tap zones are fixed left=previous,
right=next (lines 325-343).*

Branch: `feat/reader-rtl`

**Behaviour.** A direction setting in the reader panel. In RTL, tapping or clicking the **left** side
advances the page and the right side goes back, the arrow keys swap to match, and the chevrons mirror
so they still point the way they take you. Strip mode is unaffected — vertical scrolling has no
handedness.

**Steps.**
1. `direction` state alongside `mode` and `fit` (lines 100-101), persisted to
   `localStorage['stremio4manga.reader.direction']` through a `setDirection` wrapper matching
   `setMode`/`setFit` (lines 130, 135). Default `'ltr'` so nothing changes until it is switched.
2. Derive `const advance = direction === 'rtl' ? -1 : 1` and route every navigation through it: the
   two `.page-hit` buttons (lines 330, 339), the keyboard handler (lines 191-192), and the panel
   stepper (line 396) — miss one and the reader becomes internally inconsistent, which is worse than
   no setting at all.
3. ~~Swap the chevron `<path>` between the two hit targets in RTL~~, and swap their `aria-label`s with
   them, so the label always describes what the button does.

   **The chevrons were left alone.** They mark a side of the screen, not a direction of travel:
   mirroring them puts a right-pointing arrow on the *left* edge, aiming at the opposite side of the
   screen from the one it sits on. The `aria-label` carries the meaning instead, through a single
   `hitLabel(target)` that also covers the chapter-hop wording at the two ends.
4. Toggle in the reader panel below the fit control, as a **labelled** `.reader-setting` row with
   `aria-pressed` — the icon-only rule is a toolbar convention, and report #14's triage already
   corrected this step. Its arrow *does* mirror, because unlike the tap-zone chevrons it reports the
   setting's value. Hidden in strip mode the way the fit row is.
5. Leave the footer page counter counting 1…N in reading order — it is a position, not a direction.

Implementation note: `advance = direction === 'rtl' ? -1 : 1`, with `leftPage`/`rightPage` derived
once and used by the tap zones, the keyboard handler and the panel stepper alike. The stepper is
mirrored too — otherwise the panel would send you backwards from the side of the screen that sends
you forwards — but it still stops at the ends rather than hopping chapters, as it always has.

**Verified:** with RTL on, the left tap zone advanced 1→2, `ArrowLeft` advanced 2→3, `ArrowRight`
went back 3→2, and the stepper's left chevron advanced 2→3; labels read "Next page" on the left and
"Previous chapter"/"Previous page" on the right; the setting survived a reload and the row disappears
in strip mode.

---

## 6. Double-page spreads

**Status: shipped. Step 6 (report the first page of the pair) was inverted — see the note under the
steps; as written it would have stopped chapters ever being marked read.**

*Kavita's "Layout Mode" (Single / Double / Double-Manga) plus a "Double Page Offset" for when the
cover throws pairing off. We render exactly one `<img>` per screen (`ReaderPage.tsx:335`) with no
pairing logic anywhere.*

Branch: `feat/reader-spreads`

**Behaviour.** In paged mode on a wide enough screen, two pages sit side by side and turn together.
An offset control shifts the pairing by one so that two-page artwork lands on one screen instead of
being split across a turn. With RTL on (section 5), the pair reads right-to-left.

**Steps.**
1. `spread` state persisted like the others (`stremio4manga.reader.spread`, default off). Depends on
   section 5 landing first — pairing has to respect `direction`, and building it twice is wasted work.
2. Pair index → `[page, page + 1]`, shifted by a stored `spreadOffset` of 0 or 1. Advancing moves by
   2, not 1, and `goToPage` must stay the single entry point so chapter continuation (PR #10) still
   fires at the ends.
3. Render both images in the existing `.paged-reader` block, ordered by `direction`. The `fit`
   setting has to split its budget across the pair — a naive `fit: height` on two images overflows
   horizontally, so the pair needs its own CSS rule in `App.css` next to the current reader styles.
4. Fall back to a single page when the viewport is portrait or too narrow, and when the pair would
   run past the last page. Do not persist that fallback into the setting.
5. Offset toggle in the panel, shown only while `spread` is on.
6. ~~Report the **first** page of the visible pair~~ — **the last one is reported instead.**
   `updateReaderProgress` only sets `read=true` when the reported index is the final page, so a
   chapter whose last pair is a full spread would never reach it and would never be marked read.
   Reporting the last page on screen is also the more honest reading of "furthest page reached" —
   both pages were seen — and resuming still lands on the same pair, because `pairStart` maps either
   page of a pair back to it.

Implementation notes:

- `pairStart(target, offset)` is the one piece of arithmetic: the first page of the pair holding
  `target`. Everything else — what to render, what the counter says, where a turn goes — derives from
  it, so the offset control is a one-line change of input rather than a second code path.
- Turns move by `spreadPages.length`, so a spread advances two and a lone page one, and they still go
  through `goToPage` — which is what keeps running off either end a chapter hop.
- `SPREAD_VIEWPORT` (`min-width: 820px` and landscape) is watched with `matchMedia`. Narrower than
  that renders one page and says so on the setting row, without writing to the stored setting.
- The pair is a flex row inside the existing grid column, `row-reverse` in RTL so the **DOM keeps
  reading order** for a screen reader while the screen mirrors. The height cap stays per image and the
  width cap moves to the pair, which splits it — otherwise `fit: height` overflows sideways.

**Verified** on a 13-page chapter of a title outside the library, at 1400×850: pairs rendered (1,2) →
(3,4) → back to (1,2) with the counter reading "1–2"/"3–4"; the offset control left page 1 alone and
paired (2,3) after it; RTL kept the DOM order and flipped the screen order to 2,1 with the left tap
zone advancing; a 700×950 window fell back to one page, said "the window is too narrow", kept the
stored setting `on`, and restored the pair when widened. The final spread marked the chapter read and
the next turn continued into the following chapter. All test progress reverted afterwards.

---

## 7. Backup and restore

**Status: shipped and merged (PR #13, `8dde20e`).**

*Suwayomi's `BackupMutation`, present in our fork. Nothing in `src` mentions backup — the library, the
source bindings and the tracking links exist in exactly one place today.*

Branch: `feat/backup-restore`

**Behaviour.** Two actions in Settings. **Export** downloads a backup file. **Import** takes one back,
after showing what it contains and warning about anything it references that is not installed.

**Steps.**
1. Export: `createBackup(input: { flags: { ... } })` returns
   `CreateBackupPayload { url }`, and the url is a **relative path**
   (`/api/graphql/files/backup/<filename>`) served by the same origin Vite already proxies — so it is
   an anchor with `download`, not a blob to assemble client-side.
2. Import is the expensive half and the reason this is not purely additive: `restoreBackup` takes
   `backup: UploadedFile`, a **multipart upload**. The urql client (`src/api/client.ts`) is
   `[cacheExchange, fetchExchange]` only and cannot send multipart. Either add
   `@urql/exchange-multipart-fetch`, or hand-roll one `fetch` with a `FormData` GraphQL multipart body
   for this single call. Prefer the hand-rolled POST — one call does not justify a dependency and a
   change to the shared client.
3. Before restoring, `validateBackup` (`BackupQuery`) reports missing sources and trackers. Show that
   as a confirmation step; restoring a backup whose sources are not installed leaves a half-broken
   library.
4. Restore is asynchronous: `restoreBackup` returns `{ id, status }`, and `restoreStatus(id)` polls
   the rest. Show progress from it and refetch the library when it finishes.
5. Both actions live in `SettingsPage.tsx` alongside the existing AniList controls, icon-only with
   `aria-label`.

**Done when:** an export downloads a file, a fresh restore of that file reproduces the library and its
source bindings, and validation warns before restoring a backup referencing an uninstalled source.

---

## 8. Check the library for new chapters

**Status: shipped, built differently from the plan below. The server-side half was dropped as
impossible — see "Why the server's own updater cannot do this".**

*Suwayomi's `UpdateMutation.updateLibrary`, present in our fork. `LibraryPage.refreshFromAniList` pulls
AniList **progress** per title and nothing in the app ever asks a source whether new chapters exist —
`updateLibrary`, `libraryUpdateStatus` and `globalUpdateInterval` appear nowhere in `src`.*

Branch: `feat/library-update-check`

**Behaviour.** A button in the library toolbar that asks every source the library reads from whether
it has published new chapters, showing progress while it runs, and reporting in one line what it
found, what it could not reach, and what it did not check.

### Why the server's own updater cannot do this

Recorded in full because it is not obvious and the whole original plan rested on it:

- `updateLibrary` queues manga through `Updater.addCategoriesToUpdateQueue` →
  `CategoryManga.getCategoryMangaList`, and **both** branches of that query filter on
  `MangaTable.inLibrary eq true` (`CategoryManga.kt:136,143`).
- Our library entries are AniList-seeded stubs carrying `sourceId = "1"` — the legacy **TorBox**
  source from the pre-pivot torrent flow. All 28 of them are the entire contents of the Default
  category.
- The manga that actually hold chapters are the **bound sources** (Weeb Central, Comix, Manga
  District, MangaDex). They are `inLibrary: false` and in no category, by design, so they can never
  enter that queue.

So `updateLibrary(categories: null)` would queue 28 TorBox stubs, ask a torrent source for their
chapter lists, and never touch a source we read from. Putting the bound sources in a category does
not help — the `inLibrary` filter is in the query itself. The only way to make the server-side path
work is to set `inLibrary: true` on the bound sources, which turns them into real library rows
(filled hearts in Discover, extra grid cards, dedup and batch-action fallout); rejected as too large
a blast radius for the benefit.

**Rejected with it, recorded so the scout does not re-propose them:** the `globalUpdateInterval`
setting in Settings (step 5 below), `libraryUpdateStatus` polling, and the
`libraryUpdateStatusChanged` subscription. All three describe a server job that cannot reach our
sources. **There is no automatic background check** as a result — the sweep is manual only.

**What was built instead.** A client-side sweep in `LibraryPage`, over exactly `boundIds` — the same
set `BOUND_UNREAD_QUERY` already counts chapters for:

1. `FETCH_CHAPTERS_MUTATION`, the same `fetchChapters(input: { mangaId })` call the detail page makes
   on open. It returns the chapter list the source now reports, so the number of new chapters is
   `chapters.length − (what BOUND_UNREAD_QUERY last reported)` with no second query. Rows, not
   distinct chapter numbers: a new scanlation of a chapter we hold is still something published.
2. One source at a time, with a `{ done, total }` counter driving the existing
   `.library-sync-button.loading` spin and a live `aria-label`/`title` — the same progress convention
   as the neighbouring AniList button. Parallel requests are how a source starts rate-limiting us.
3. The button stays disabled until `unreadData` has arrived. Sweeping before it does would measure
   against zero and report every chapter already in the library as new.
4. One notice line rather than a notice plus an error: a partial failure is the normal outcome here,
   and hiding the summary behind an error is what loses the count of what was found. Reads e.g.
   `37 new chapters across 1 title · 2 sources could not be checked (Frieren…, Yotaka…) · 19 without
   a bound source.`
5. Failures name the titles. A source behind Cloudflare with no FlareSolverr on `:8191`, a source
   that is down, and one that lists nothing (the server raises `No chapters found` rather than
   returning an empty list) all land here, so the wording stays neutral across the three.
6. Entries with no bound source are counted, not swept: their unread number comes from AniList
   (total − read), and refreshing that is the AniList button's job.

**Verified** against the running server: a sweep of the 7 bound sources reported 5 up to date and
named the 2 that need FlareSolverr — the 5 agreeing exactly is what proves the baseline count right.
The growth branch was exercised with a browser-local binding to a MangaDex title holding no chapters
locally, which reported `37 new chapters across 1 title`; the binding was removed afterwards
(`localStorage` only — no server state was touched).

**Original plan, kept for the record (steps 1–4 superseded, step 5 rejected):**

1. `updateLibrary(input: { categories: null })` updates everything — the server filters the category
   list with `?: true`, so null means all (`UpdateMutation.kt:33-36`). It returns
   `updateStatus: LibraryUpdateStatus` once the job is queued.
2. For progress, **poll the `libraryUpdateStatus` query**, do not use the
   `libraryUpdateStatusChanged` subscription: our urql client has no `subscriptionExchange` and no
   websocket transport, so the subscription would mean new plumbing. The query returns
   `jobsInfo { isRunning totalJobs finishedJobs }`, which is all a progress ring needs.
3. Icon-only button in the existing `.library-toolbar` next to the AniList refresh, with a progress
   ring while `isRunning` and disabled meanwhile.
4. Refetch the library when `isRunning` goes false so new chapter counts appear without a reload.
5. Auto-update interval in `SettingsPage.tsx` via the generic
   `setSettings(input: { settings: { globalUpdateInterval: <Double> } })`. It is a **Double in hours**,
   and `0.0` means disabled (`Updater.kt:157`) — so it is a number with a meaningful zero, not a
   toggle. Note that `SettingsType` is generated into `server/build/generated/`, so grepping the
   server source for a settings field finds nothing; check the generated file.

*(Its "done when" — a progress ring tracking `finishedJobs/totalJobs` and an interval of 0 stopping
the server updating on its own — describes the rejected server-side job and no longer applies.)*

---

## Sections 9–11 — from scout report #14

Surveyed from Suwayomi-WebUI, then re-verified against `main` at `8acc7b2` (post-PR #13). All three
were taken, so report #14 contributes no rejections. Order of attack: **9 → 11 → 10** — the wake lock
and the share action are each an afternoon; the background sampler is the only one with real design
risk, so it goes last.

Three corrections came out of the triage, because each changes what gets built:

- The reader panel's `.reader-setting` rows are **labelled**, not icon-only (`ReaderPage.tsx:415-433`
  — icon, then `<strong>` and `<small>`). The icon-only rule is a *toolbar* convention; inside the
  panel new settings follow the labelled-row style. Section 5 step 4 says otherwise and is wrong.
- `.reader-stage` and `.reader-shell` hardcode `#242629` (`App.css:398-399`); they do not use the
  `--paper`/`--surface` tokens. The reader ignores the Settings theme entirely, so section 10
  overrides one fixed colour rather than fighting the theme system.
- Page URLs are same-origin relative `/api/v1/...` paths, so a canvas drawn from them is not tainted
  and `getImageData` works. Section 10 depends on this.

---

## 9. Keep the screen awake while reading

**Status: shipped.** Built as an explicit on/off toggle (`aria-pressed`, `active` state, the small
text naming the state it is in), which is what was asked for when it was picked up. One deviation:
the row is **not** gated on paged mode — a long strip keeps the screen on for the same reason.

*Suwayomi-WebUI's `useWakeLock.ts`, wired into `Reader.tsx` as `useWakeLock(shouldWakeLockScreen && !isLoading)`.
`wakeLock`, `keepAwake` and `NoSleep` appear nowhere in our `src` — the screen dims mid-chapter like
on any other page.*

Branch: `feat/reader-wake-lock`

**Behaviour.** A setting in the reader panel that stops the device screen dimming or locking while a
chapter is open. Off by default, released the moment the reader is left or the setting is turned off,
and re-acquired if the tab was backgrounded and comes back.

**Steps.**
1. `wakeLock` state persisted to `localStorage['stremio4manga.reader.wakelock']` through a setter
   matching `setMode`/`setFit` (readers at lines 83/87, writers at 130/135). Default **off** — it
   changes device behaviour and should be asked for.
2. Effect holding the `WakeLockSentinel` in a ref: request `navigator.wakeLock.request('screen')` when
   the setting is on and the chapter is ready (`prepared`, line 125), and release it in the cleanup.
3. Re-acquire on `visibilitychange` when `document.visibilityState === 'visible'`. The browser drops
   the sentinel whenever the tab is backgrounded and never restores it on its own — without this the
   setting silently stops working after the first phone call.
4. Feature-detect `'wakeLock' in navigator` and render **no** row when it is missing (insecure
   contexts, older Firefox). A toggle that can never take effect is worse than no toggle.
5. Swallow the rejection from `request()` — it rejects on low battery in some browsers, and a refused
   lock must not surface as a reader error.
6. Labelled `.reader-setting` row in the panel below the fit control (line 426), with the `active`
   class reflecting state the way the mode buttons do.

**Verified** with the real `navigator.wakeLock` wrapped in a counting spy: turning the toggle on took
one lock, turning it off released it, a hidden→visible round trip took a fresh one (2 → 3 requests),
and leaving the reader released it. `aria-pressed` tracked the state throughout.

---

## 10. Auto background colour per page

**Status: shipped.** Two things the plan could not have known, both found while building it, are
recorded under the steps: prefetching makes the `onLoad` sampling point unreliable, and React does not
remove a custom property when the style prop goes away.

*Suwayomi-WebUI's `ReaderSettingBackgroundColor.tsx` adds an "Auto" option beside Theme/Black/Gray/White,
sampling each page's border strips on an `OffscreenCanvas` (`Reader.utils.ts` ~229-253) and caching the
result per page. Our reader has no background setting at all — the surround is the hardcoded `#242629`
at `App.css:398-399`.*

Branch: `feat/reader-auto-background`

**Behaviour.** A background setting in the reader panel with two values: **Fixed** (today's `#242629`)
and **Auto**. In Auto the area around the page takes that page's own edge colour, so a page with a
black or coloured border blends into the surround instead of sitting in a grey frame, and the colour
follows each page turn. Paged mode only.

**Steps.**
1. Sample from the **already-rendered `<img>`** in its `onLoad`, not from a second `new Image()` — the
   image on screen is already decoded and free to read. *(The original reason given here — that
   `withProgress` would risk a second progress write — no longer applies: section 4 removed
   `withProgress`, and that same `onLoad` is now where progress is reported from.)*
2. Draw to a small canvas scaled to ~64px on the long edge. An average colour does not need full
   resolution, and a full-size buffer per page is real memory on a long chapter.
3. Average the four border strips a few pixels in, then clamp toward `#242629` so a bright white page
   does not produce a glaring backdrop. **No `color-thief` dependency** — the app runs on five runtime
   packages, and `utils/backup.ts:1` already set the precedent of hand-rolling rather than adding one
   for a single call.
4. Cache the result in a ref map keyed by the page URL, cleared when the chapter changes (alongside the
   `requestedChapter` reset, line 166), so turning back to an earlier page does not resample it.
5. Apply as a custom property on `.reader-stage` (`style={{ '--reader-bg': color }}`) with
   `App.css:399` reading `var(--reader-bg, #242629)`, and transition it over ~180ms so a page turn
   does not strobe.
6. Strip mode keeps the fixed colour and the row hides there, the way the fit control already hides
   outside paged mode (line 426) — continuous scrolling has no single current page to sample.
7. Wrap the read in a `try`/`catch` and fall back to the fixed colour: pages are same-origin today, but
   a source serving them cross-origin would taint the canvas and `getImageData` would throw. A
   background setting must never be able to break the reader.

### Two corrections found in the building

**`onLoad` alone does not fire often enough — section 4 is why.** A prefetched page is already decoded
by the time React attaches to the `<img>`, so its `load` event has come and gone and `onLoad` never
runs. The same gap appears when the setting is switched on while a page is already on screen. Both are
covered by an effect that reads the element already in the document (`pagedImageRef`, guarded on
`complete && naturalWidth` and on `currentSrc` matching the page it expects), with `onLoad` still
handling the ordinary case of a page that is genuinely still loading.

**The custom property has to be written on every render, never dropped.** Passing
`style={colour ? {...} : undefined}` left the last sampled colour stuck on the element after switching
back to Fixed — React does not reliably remove a custom property when the style prop goes away. It is
always set, to the sampled colour or to the fixed one.

Sampling detail: the blend back toward `#242629` is asymmetric — 0.62 toward dark edges, 0.28 toward
light ones. A dark border is the case worth having, while a white page at full strength turns the
whole window into a lamp. Only the first page of a pair decides the surround; two colours either side
of a spread would fight.

**Verified** on a paged chapter: with the setting on, the surround took the page's edge colour
(`rgb(81 81 85)` against the panel's unchanged `#242629`) and changed as pages turned; switching to
Fixed restored `rgb(36 38 41)` immediately; the choice survived a reload; strip mode both hides the
row and keeps the fixed colour.

---

## 11. Share the manga's source page

**Status: shipped, with an extra piece the plan did not have: without it the button could never
appear for any title. See "realUrl is null for everything".**

*Suwayomi-WebUI's `MangaToolbarMenu.tsx:93-110`, gated by a `navigator.share` feature-detect and calling
`navigator.share({ title, url: manga.realUrl })`. `navigator.share`, `realUrl` and `share` appear
nowhere in our `src`.*

Branch: `feat/share-source-page`

**Behaviour.** An icon-only share action on the manga detail page that opens the OS share sheet with
the title and the manga's real source URL, so a link can be handed to someone without leaving the app.
The action is absent — not disabled — when the browser cannot share or the manga has no source URL.

**Steps.**
1. Add `realUrl` to `MANGA_DETAIL_QUERY` (lines 21-33). One field covers both the library entry and the
   bound source manga, because the same query is reused for `boundId` (line 914).
2. `realUrl` is confirmed on `MangaType` (`Stremio4Manga-Server`, `MangaType.kt:44`) but is
   **`String?` by construction**: it is written only during the full source fetch (`Manga.kt:221`),
   inside a `runCatching` behind `(source as? HttpSource)`, so a non-HTTP source or a failed fetch
   leaves it null. Treat null as "nothing to share".
3. Prefer the bound manga's URL — `boundId ? boundData?.manga?.realUrl : data?.manga?.realUrl` —
   mirroring `activeSourceName` (line 1068). A library entry is often an AniList-seeded stub with no
   source URL at all; the bound manga is the one that has one.
4. Feature-detect `navigator.share` once. It is missing on insecure contexts and on most desktop
   Firefox, and combined with step 2 it decides whether the button renders at all.
5. Call it inside a `try`/`catch`: dismissing the sheet rejects with `AbortError`, which is a normal
   outcome and must not reach the error banner.
6. Icon-only button in the existing `.hero-actions` row (line 1084) with `aria-label` and `title`,
   built like the neighbouring `library-heart-button` — svg only, no text.

### realUrl is null for everything

Step 2 treated a null `realUrl` as an edge case. It is the only case: **8 of 400 manga in the
database have one, and none of them are titles this library reads.** The reason is one argument —
the chapter fetch the app already makes runs `Manga.updateMangaAndChapters(mangaId, updateManga =
false)` (`ChapterMutation.kt:177`), so the source is never asked about the manga itself, and
`updateMangaDatabase` — the only writer of `realUrl` (`Manga.kt:221`) — never runs. Chapters, fetched
by the same call with `updateChapters = true`, all have their `realUrl` populated; manga do not.

So the button needs the url to be fetched once: `fetchMangaAndChapters(input: { id, fetchManga: true,
fetchChapters: false })`, fired from the detail page when the active manga has no `realUrl` yet, and
guarded by a ref so a source that cannot answer is asked once rather than on every render.
`fetchChapters` stays false — the chapter list is `ChapterList`'s business and fetching it from two
places would be two requests for one list. The url is stored, so this is once per title ever.

Two things fall out of it:

- **The target has to come from the meta, not from `boundId`.** `boundId` catches up an effect after
  the detail query lands, and that one render with a stale binding was enough to fire a request at the
  library entry's own source before the real one was known — observed as an entry *and* its bound
  source both being fetched on a single page open.
- **An unbound library entry is skipped entirely.** It is an AniList-seeded stub on the legacy TorBox
  source, which has no page for it; asking spends a request to learn nothing.

A side effect worth knowing: the fetch also refreshes the bound manga's author, status, description
and thumbnail from the source. Sweet Home's bound copy went from `author: null, status: UNKNOWN` to
`HWANG Youngchan, KIM Carnby` / `COMPLETED` on the first open.

**Verified:** a title opened from Discover with no `realUrl` fetched one and shared
`https://mangadex.org/title/…` with its own title; a bound library entry (Ms. Mystic) fetched **only**
the bound source and shared `https://mangadistrict.com/series/ms-mystic/`, leaving the entry's own
`realUrl` null; an unbound library stub (Chainsaw Man) fetched nothing and showed no button; and a
share sheet rejecting with `AbortError` left the page with no error on it.

---

## Sections 12–14 — the rest of scout report #11

The three findings from report #11 that were triaged as "left open, not planned" on 2026-08-12, now
picked up. Re-verified against `main` at `c340d26` (post-PR #22): all three are still entirely absent
from `src`. This time the schema claims were checked against the **running server** rather than
against upstream source, and three of them hide behaviour the plans below have to work around.

- **The Default category is virtual.** `categories` returns `{ id: 0, name: "Default", default: true }`,
  and `category(id: 0).mangas` counts every library manga filed nowhere else — 28 of 28 today, 27 the
  moment one is filed somewhere. `manga.categories` never lists it, and
  `updateMangaCategories(patch: { addToCategories: [0] })` **silently no-ops**: the mutation returns
  the manga with an empty category list and no error. So id 0 is a derived shelf, never an assignable
  target, and it has to stay out of every picker and out of the management list.
- **Enqueuing does not start the downloader.** `enqueueChapterDownloads` came back with
  `downloadStatus.state: STOPPED` and the chapter sitting at `QUEUED`; nothing moved until
  `startDownloader` was called. Every enqueue in the UI has to be followed by a start.
- **A finished download leaves the queue.** Once the chapter was written, `downloadStatus.queue` was
  empty again and the downloader had put itself back to `STOPPED`. What remains is
  `chapter.isDownloaded` and `manga.downloadCount`. A downloads screen reading only the queue shows
  nothing a second after it worked, so "what is on disk" is a second query:
  `chapters(filter: { isDownloaded: { equalTo: true } })`, which the schema accepts.
- `DownloadState` is `QUEUED | DOWNLOADING | FINISHED | ERROR`, `DownloaderState` is `STARTED | STOPPED`,
  and `DownloadType` carries `position progress tries chapter manga` with `progress` a 0–1 float.
- Report #11's note about `libraryUpdateStatusChanged` applies here too: `DownloadUpdate` exists but
  only over a subscription this client has no transport for. Downloads poll, exactly as the backup
  restore does (`SettingsPage.tsx:184-220`).

Both round trips were run against real data and cleaned up after: one chapter of a title outside the
library (`I Violently Level Up`, chapter 9832) was enqueued, downloaded and deleted again, with
`isRead`/`lastPageRead` untouched throughout; a probe category was created, a title filed into it,
removed again, and the category deleted, leaving `categories` back at Default alone.

Order of attack: **12 → 13 → 14**, smallest first. Each is a branch and PR off `main`, deleted after
merge.

---

## 12. Configurable tap zones

**Status: shipped.** Three deviations from the steps below, all recorded under them: the per-region
`chevron` field turned out to be derivable, `leftPage`/`rightPage` were kept rather than removed, and
the overlay needed one CSS line the plan could not have known about.

*Mihon's `ViewerNavigation` subclasses (Default, L-shaped, Kindle-ish, Edge, Right-and-Left, Disabled)
behind `reader_navigation_mode_pager`, plus an invert toggle. `ReaderPage.tsx:646-692` hardcodes
exactly two hit targets and has no alternative.*

Branch: `feat/reader-tap-zones`

**Behaviour.** A picker in the reader panel choosing how the screen is divided into tap targets.
Five maps: **Sides** (today), **Edges** with a centre that shows and hides the controls, **L-shaped**,
**Kindle-ish**, and **Off** for keyboard and panel only. Right-to-left keeps working across all of
them.

**The one deliberate change to today's behaviour.** The current targets are the *margins beside* the
page — `.page-hit.previous/.next` are columns 1 and 3 of the `.paged-reader` grid (`App.css:406,424-425`),
so the page image itself has never been clickable. Region maps only mean anything as an overlay, so
all five render as absolutely positioned regions over the stage, and **Sides** becomes the two halves
of the stage rather than the two margins. That adds a tap target over the edges of the artwork, which
is what every reader with this feature does and the reason a bottom band or an L can exist at all.

**Steps.**
1. A `TapRegion = { role: 'back' | 'forward' | 'panel'; left; top; width; height; chevron: 'left' | 'right' | null }`
   in fractions, and a `TAP_LAYOUTS` table of five named maps, authored left-to-right. `panel`
   regions toggle `panelOpen`, which is a genuine gain on touch: today the panel can only be reopened
   from `.reader-panel-reveal`.
2. Render the map in place of the two `.page-hit` buttons, positioned with percentage `style` and
   keeping the `.page-hit` class so the hover wash, focus ring and disabled state carry over. The
   grid columns collapse to margins with nothing in them.
3. `forward`/`back` resolve to the existing `forwardPage`/`backwardPage`, so running off either end
   stays a chapter hop and spreads still move by two.
4. Right-to-left **mirrors the map** (`left → 1 - left - width`) and flips each region's chevron,
   rather than swapping the roles. Mirroring is what "the other side advances" means for an L-shape
   or an edge strip, where swapping two roles says nothing. `leftPage`/`rightPage` (line 434) go away
   with the two fixed buttons; the keyboard keeps its own mapping off `advance`.
5. **No invert toggle.** Mihon has one because its direction setting and its region map are separate
   axes; ours are not — section 5's right-to-left already flips which side advances, and a second
   control flipping the same thing is two ways to reach four states, half of them identical.
6. Picker in the panel under the direction row: a row of small diagrams **generated from the same
   `TAP_LAYOUTS` data**, so a preview cannot drift from the map it previews. Each is a button with
   `aria-pressed` and a name, following the `.theme-option` swatches in Settings rather than the
   labelled `.reader-setting` rows, because five options do not fit a toggle.
7. Persist to `localStorage['stremio4manga.reader.tap-layout']` through a setter matching
   `setDirection` (line 266); default `sides`. Paged mode only, like the fit and direction rows.
8. **Off** renders no regions at all. `.reader-panel-reveal` and the `H` shortcut are then the only
   way back to the controls, so both have to keep working with the panel closed — check that before
   calling it done.

**Done when:** each of the five maps can be picked and behaves as its diagram says, right-to-left
mirrors all of them, the centre region of Edges opens and closes the panel, and Off leaves a reader
that still turns pages from the keyboard.

### Three corrections from building it

- **`chevron` is derived, not authored.** Step 1 gave every region a chevron field. It has exactly
  two inputs — the role and the direction — so `(role === 'back') === (direction === 'ltr')` decides
  it, and a field that cannot disagree with the map is one fewer thing to keep in step.
- **`leftPage`/`rightPage` stay.** Step 4 had them going away with the two fixed buttons. The arrow
  keys and the panel's ‹ › stepper are *inherently* left-and-right controls and still need them; only
  the tap regions moved to `forwardPage`/`backwardPage`. Direction now reaches the screen two ways —
  the delta for the two controls that have sides, the mirror for the map that has geometry — and both
  say the same thing.
- **The overlay pushed the page off screen.** `.page-hits` spans every column of grid row 1, so the
  auto-placed `.paged-reader img` found no free cell in that row and was placed in a *second* row,
  870px below the fold: a blank reader with a scrollbar. Both the page and `.page-spread` now name
  `grid-row: 1` explicitly, which is what the old `.page-hit.previous/.next` rules were doing all
  along. The overlay is also `position: sticky` rather than absolute — a fit-width page is far taller
  than the screen, and an L-shape's bottom band has to stay at the bottom of the *viewport*, which
  was confirmed by scrolling a 7068px page 1200px down and watching the map hold at y=0.

**Verified** in the running app on a title outside the library: all five maps picked and their
regions measured, both halves turning the page under Sides, the centre of Edges closing and reopening
the panel, the L-shape and Kindle-ish maps mirroring under right-to-left (and the panel's diagrams
mirroring with them), Off leaving no regions at all with the keyboard, `H` and the reveal button
still working, and a double-page spread still pairing after the grid-row change.

---

## 13. User-defined library categories

**Status: shipped.** One change of mind while building, under the steps: the category shelves store
what is *hidden* rather than what is shown.

*`CategoryMutation.kt`'s full CRUD, present in our fork and verified live. `categor` matches nothing
in `src/pages` or `src/api`: `LibraryPage`'s shelves are derived entirely from AniList `status`
(line 1037-1042), so a title cannot be grouped by anything the user decides.*

Branch: `feat/library-categories`

**Behaviour.** Named shelves the reader creates: manage them in Settings, file titles into them from
the library's existing selection mode, and switch the library between grouping by AniList status
(today) and grouping by category. Titles filed nowhere appear under Default, which is the server's
own virtual category and cannot be created, renamed or deleted.

**Steps.**
1. `src/utils/categories.ts` holding the documents and types, following `utils/backup.ts` — they are
   needed by both `SettingsPage` and `LibraryPage` and belong in neither.
2. Settings card **Categories**: the list in `order`, each row offering rename (inline), delete
   (behind a confirmation, since a category holding titles disappears with one click), and move
   up/down through `updateCategoryOrder(input: { id, position })`. Plus a name field that calls
   `createCategory`. Deleting a category never removes a title from the library — say so in the card
   copy, because the button otherwise reads as destructive to the titles too.
3. Default is rendered as a **control-less row** explaining that everything unfiled lives there.
   Excluding it silently would leave the count in the library unexplained; offering controls on it
   would offer three that cannot work.
4. Library grouping toggle in `.library-toolbar` (icon-only, `aria-pressed`, matching the selection
   and sync buttons), persisted to `localStorage['stremio4manga.library.grouping']`. Absent entirely
   until at least one category exists — there is nothing to group by before that.
5. Generalise the existing shelves: `{ key, label, items }[]` built either from `statusNames` as
   today or from `categories` in `order` plus a derived **Default** shelf for entries whose
   `categories.nodes` is empty. The filter tabs and their counts then work unchanged for both, with
   the selection stored per mode — the current `stremio4manga.library.shelf` stays the status one,
   `stremio4manga.library.category-shelf` is the new one, so switching modes does not reset the other.
6. `LIBRARY_QUERY` gains `categories { nodes { id } }`. Membership is read off the card's own entry:
   `deduplicateLibrary` already collapses the several rows a series can have into the one that knows
   the most, and that is the row the card acts on.
7. Batch action **File into…** in `.library-batch-bar`, appearing only when a category exists: pick a
   category, then Add or Remove, both through `updateMangasCategories(input: { ids, patch: … })` in
   one call. Selecting a single cover is how one title is filed — the mode already supports it, so
   there is no second single-title control to build.
8. Never send id 0 anywhere: it is not in the picker, not in the management list's editable rows, and
   `addToCategories: [0]` is a silent no-op that would look like a failed action.

**Done when:** a category can be created, renamed, reordered and deleted from Settings; three titles
selected in the library can be filed into it in one action and removed again; the library grouped by
category shows them on that shelf and everything else under Default; and the AniList grouping is
exactly as it is today.

### The category shelves store what is hidden

Step 5 said the shelf selection is stored per mode, "the same way" for both. It cannot be: the status
shelves are a fixed list of six, so storing the selected ones is safe, but the category list *grows*.
An allow-list would leave every newly created category invisible until someone thought to click its
tab — the shelf would be missing at exactly the moment it was just made. So
`stremio4manga.library.category-hidden` stores the excluded keys and everything else shows, while
`stremio4manga.library.shelf` keeps its allow-list unchanged.

Two smaller decisions fell out of building it:

- **Grouping falls back rather than being switched off.** Deleting the last category hides the
  toolbar toggle and returns the library to its AniList shelves without touching the stored
  preference, so making a category again returns the reader to where they were.
- **The counts differ on purpose.** The Settings card shows 28 for Default and the library shows 25,
  because the library has always hidden titles AniList marks Completed. Settings reports the server's
  own count of what is filed nowhere, which is the number that matters when deciding what to file.

**Verified** against the real library: two categories created, reordered, one renamed; three titles
filed into one in a single action and taken back out; the category shelf and its tab appearing and
updating; a hidden shelf staying hidden across a reload; both categories deleted with their titles
intact and the library falling back to AniList shelves. The library was left exactly as it was found
— 28 titles, none filed anywhere.

---

## 14. Chapter download queue

**Status: shipped.** Step 6's refresh trigger was wrong in a way that made finished downloads
invisible for as long as the queue stayed busy — see the correction under the steps.

*`DownloadMutation.kt`'s enqueue/dequeue/start/stop/clear/reorder/delete, all present and all
verified working on this server. `download|enqueueChapter|Downloader` matches nothing in `src` beyond
the extension install button.*

Branch: `feat/download-queue`

**Behaviour.** Download chapters for offline reading: a control per chapter in the chapter list, a
bulk action for everything the current filter shows, and a Downloads screen with the queue (progress,
order, pause, remove) and what is already on disk. Nothing about reading changes — the server serves
a downloaded page from the same `/api/v1/manga/:id/chapter/:order/page/:n` path the reader already
uses, so a downloaded chapter simply stops hitting the source.

**Steps.**
1. `src/utils/downloads.ts` with the documents, the `DownloadState`/`DownloaderState` types and a
   `describeDownload` helper, mirroring `utils/backup.ts`.
2. `ChapterList`: `CHAPTERS_QUERY` gains `isDownloaded`, and each row gets an icon-only control —
   download when absent, progress while it is in the queue, delete when it is on disk. Enqueue is
   always `enqueueChapterDownloads` **followed by `startDownloader`**, per the finding above.
3. Bulk control in `.chapter-controls`: enqueue every chapter the filter currently shows that is not
   already downloaded, in one call. With the filter on "unread only" that is exactly "download what I
   have not read", which is the request Mihon's "download next N" is really answering.
4. New `/downloads` route and nav entry in `App.tsx`. The page shows the downloader state with
   start/stop and clear, the queue in `position` order (cover, title, chapter, progress bar, `tries`
   when it has retried, `ERROR` when it has failed), per-item dequeue, and move up/down through
   `reorderChapterDownload`. Up/down rather than drag: one control that works on touch and with a
   keyboard beats a drag target that works with neither.
5. A second section listing what is on disk, from `chapters(filter: { isDownloaded: { equalTo: true } })`
   grouped by manga, each with a delete action over `deleteDownloadedChapters`. Without it the screen
   is empty the moment the queue drains, which is the state it will be in almost always.
6. Poll `downloadStatus` while the page is open, on the `SettingsPage.tsx:184-220` timer pattern:
   1s while the downloader is `STARTED` or the queue is non-empty, stopping when it drains so an idle
   tab is not asking every second forever. Refetch the on-disk list once when the queue empties.
7. Progress on a chapter row in the chapter list comes from the same poll, so the control there is
   live while the Downloads screen is elsewhere.

**Done when:** a chapter downloads from its row and the row switches to a delete action; a filtered
bulk enqueue fills the queue and the queue drains while its progress bars move; an item can be moved,
removed, and the whole queue cleared; and a downloaded chapter still reads normally and can be
deleted from the Downloads screen afterwards.

### Refreshing when the queue drains is too late

Step 6 said to re-read the on-disk list "once when the queue empties". Built that way, a queue of ten
downloaded six chapters and the screen went on saying **0 chapters** the whole time: the trigger only
fires when everything is done, which is precisely when nobody is watching any more. Worse, "running"
was defined as `state === 'STARTED' || queue.length > 0`, so pausing a busy queue did not fire it
either.

The signal is the queue's **membership**, not its size or its progress: an entry vanishing is the only
announcement that a chapter reached the disk. `useDownloadQueue` therefore returns `queueKey` — the
queued chapter ids joined — and both the Downloads screen and the chapter list re-read when it
changes. That fires once per chapter finished, not once per poll, and it covers dequeues too.

Three smaller things, all confirmed against the running downloader:

- `reorderChapterDownload`'s `to` is the **0-based index in the queue**, so up and down are
  `index ∓ 1`.
- Pausing puts the in-flight chapter back to `QUEUED` rather than leaving it `DOWNLOADING`.
- Downloads land under the data directory as `downloads/mangas/<source>/<title>/`, and the reader's
  own `/api/v1/manga/:id/chapter/:order/page/:n` keeps serving — nothing in the reader had to change.

**Verified** end to end on a title outside the library: ten chapters bulk-enqueued from the chapter
list with the filter on, live percentages on the rows and on the queue, pause and resume, an item
moved up, one dequeued, the on-disk list growing *while* the queue was still busy, the queue cleared,
one download deleted from its chapter row and the remaining five from the Downloads screen. The
server was left with nothing downloaded, an idle downloader, an empty `downloads/mangas`, and read
state untouched.

---

## Sections 15–24 — from the TachiyomiSY survey (2026-08-14)

Three scouts over `jobobby04/TachiyomiSY` (master `14648c7`) — the reader, the library and browse, and
downloads/updates/tracking/settings — filed 14 findings into `research/inbox.md`. Ten were taken and
are planned below; four were left as **not now** and stay in the report with no section here (crop
borders, the custom brightness overlay, pinch/pan zoom, and saved searches with a results feed).

Every finding was re-verified against `main` at `d47e10e` before triage, and the schema claims were
checked by **introspecting the running server** rather than reading the fork's source:

- `MangaType.genre` is `[String!]!` — real, and section 16 is only a matter of asking for it.
- `MangaType.inLibraryAt` is **`LongString!`**, so "date added" arrives as a *string* and has to go
  through `Number()` before it is compared. Same quirk as `lastReadAt` in the shared context above.
- `UpdateMangaPatchInput` — the real type name; `UpdateMangaPatch` does not exist in the schema — has
  exactly **one** field, `inLibrary`. This is what rules out the two rejections below.
- There is no merged-source type anywhere in the schema.

Order of attack: **15 → 16 → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24**, cheapest first, with the two
that mutate across many titles at the end. Each is a branch and PR off `main`, deleted after merge.

Rejected after inspection (recorded so this is not re-litigated): the **blend-mode colour tint** that
came with section 18 — a colour picker, a strength slider and a five-value blend-mode list is a large
control surface for a narrow audience, and grayscale and invert cover the reason people reach for it;
**merged sources**, which is not a UI change at all (a merged source fans chapter-list calls across
several real sources and interleaves them before a UI ever sees a chapter list, and no such concept
exists in our schema); **manga info editing** and **custom cover upload**, both dead against
`UpdateMangaPatchInput`'s single `inLibrary` field with no cover-upload mutation to call; **related
titles**, which has no `related`/`recommend` field to confirm against either way; and SY's
`MANGA_NON_COMPLETED` update restriction *as SY ships it* — it configures the server's scheduled
updater, which section 8 already established can never reach our sources. Section 15 is that idea
rebuilt against the sweep we actually have.

Also rejected from the reader scout's own sweep, all recorded here rather than re-proposed next week:
the navigation teaching overlay (too close to the tap-zone diagram picker in section 12), `flashOnPageChange`
(e-ink anti-ghosting, for hardware this has no audience on), `readerThreads`/`aggressivePageLoading`/
`cacheSize`/`preloadSize` (loader tuning knobs — section 4's fixed prefetch depth already covers the
need), `readWithVolumeKeys`/`readWithLongTap` (hardware-key bindings with no web equivalent),
`folderPerManga`/`archiveReaderMode` (local-file and CBZ concerns — there is no local library), and
`centerMarginType`/`invertDoublePages`/`dualPageRotateToFit` (refinements on top of section 6 that
are real but marginal).

---

## 15. Skip completed titles in the new-chapter sweep

**Status: shipped, as planned.** The one thing worth recording is the shape of the notice's skipped
count — see the note under the steps.

*This one is a defect in shipped code, not a feature. The manual sweep asks every bound source
whether it has published anything new — including for titles AniList has marked Completed, which by
definition cannot grow.*

Branch: `fix/sweep-skip-completed`

**Behaviour.** The sweep stops spending a request per finished series. Its progress counter counts
only what it will actually check, and the summary line says how many were skipped, so a smaller total
reads as deliberate rather than as titles having gone missing.

**Steps.**
1. **Leave `boundIds` alone** (`LibraryPage.tsx:806`). It is also the variable list for
   `BOUND_UNREAD_QUERY` (line 811), which feeds `unreadByBound` and through it every card's unread
   chip and the continue-reading shelf. Narrowing it would narrow that query too — this is the one
   trap in the finding as it was filed, which proposed exactly that.
2. Derive a second list beside it, `sweepIds`: entries whose `anilistRecord(item)?.status !==
   COMPLETED_STATUS` — the same predicate the display path already applies at `LibraryPage.tsx:1145`
   — mapped through `boundByManga` and deduplicated the way `boundIds` is.
3. `checkForNewChapters` (line 982) iterates `sweepIds`; the `{ done, total }` counter and the
   button's disabled guard (line 1248) both read its length.
4. Add the skipped count to the existing notice line, next to the "without a bound source" clause it
   already carries.
5. When every title is completed, `sweepIds` is empty and the button disables exactly as it does for
   an empty `boundIds` today.

**Done when:** a library with N completed titles issues N fewer requests on a sweep, the progress
total matches what is actually checked, and the notice accounts for the difference.

### The skipped count is `boundIds.length − sweepIds.length`, not a count of entries

Step 4 said to add the skipped count beside the "without a bound source" clause, which is counted off
the deduplicated entries. Counting completed titles the same way would have produced a number that
does not add up with the one beside it: `boundIds` is built from *every* library row and `unbound`
from the deduplicated ones, so a series with two rows is one entry but can be one source. Subtracting
the two lists is exact by construction — it is precisely the requests the sweep no longer makes — and
it is the only number that explains why the progress total shrank. It reads
`No new chapters · 3 completed, not checked · 19 without a bound source.`

A source shared between a completed entry and an unfinished one stays in the sweep: one of the two
can still grow, and dropping it would stop counting chapters for a series that is still running.

---

## 16. Genre chips on the manga detail page

**Status: shipped.** Two deviations from the steps below, both recorded under them: step 4's chip
link had nowhere to land until Discover was taught to read a query out of the url, and step 2's
"prefer the bound manga's list" needed a fallback to be true more often than not.

*Mihon and SY render `manga.genre` as a row of tappable chips under the description. Our server has
carried the field all along — `MangaType.genre` is `[String!]!` — and `MANGA_DETAIL_QUERY` has never
asked for it. `genre` matches nothing in `src`.*

Branch: `feat/detail-genre-chips`

**Behaviour.** The tags a source reports appear under the description as small pills. Tapping one
searches for it, so a title's own tags are a way into finding more like it.

**Steps.**
1. `MANGA_DETAIL_QUERY` (`MangaDetailPage.tsx:30-41`) gains `genre`. The same query is reused for
   `boundId` (line 914), so one field covers both the library entry and the bound source manga.
2. Prefer the bound manga's list, mirroring `realUrl` and `activeSourceName`: an AniList-seeded stub
   has no genres, and the bound copy is the one the source filled in.
3. Render as chips in the hero, below the description.
4. A chip navigates to `/search` with the tag as the query, reusing `SearchPage`'s existing
   per-source search rather than inventing tag-filter plumbing. Sources differ on whether a tag is a
   searchable term; a plain query is the honest common denominator.
5. Render nothing at all when the list is empty — plenty of sources report none, and an empty row of
   chips is a gap in the hero.
6. Styles next to the existing hero rules in `App.css`.

**Done when:** a MangaDex title shows its tags, tapping one runs a search, and a title with no genres
looks exactly as it does today.

### The chips had nowhere to land

Step 4 spends a chip on a link to `/search` and calls that "reusing `SearchPage`'s existing
per-source search". `SearchPage` does not read the url at all: `query`, `submittedQuery` and `mode`
are local state seeded from the empty string, and `useSearchParams` appears nowhere in `src`. A chip
linking to `/search?q=Horror` would have landed on that source's popular list with an empty search
box, which is worse than no chip.

So Discover now seeds all three from `?q=`, in the **initial state** rather than in an effect: an
effect would have let one page open fire two source requests, a POPULAR list and then the search
that replaces it. A ref remembers which tag was applied so a second chip arriving while Discover is
still mounted is honoured without overwriting a search the user has since typed by hand.

### Two lists, and the bound one is not always the fuller one

Step 2's reasoning holds — 27 of the 28 library entries report `genre: []`, so preferring the bound
copy is what makes the row appear at all — but the server says the preference cannot be the whole
rule. Of the seven bound titles in this library **three bound sources report no genres either**
(`.A -dot Alice-`, `My Bias Gets on the Last Train`, `Yotaka Futatabi`), and the 28th entry proves
the other half: `Sweet Home`'s own row carries 14 tags against its bound Weeb Central copy's 6,
because that entry was added from a source before it was rebound. So the bound list wins *when it
has one*, and the entry's stands in when it does not — the tags describe the same series either way.
No title in this library needs that fallback today, since the three genre-less bound copies sit on
genre-less entries; it is there because the two halves of the case both exist.

The row also waits for the bound query rather than falling back while it is in flight. Falling back
early would have drawn `Sweet Home`'s 14 entry tags on every open and replaced them with the
source's 6 a moment later, which is a worse thing to look at than a row that arrives once.

One more thing the field's type does not say: sources repeat themselves. Manga District returns Ms.
Mystic with `Manhwa` and `Webtoons` twice each, so the list is deduplicated before it is drawn —
otherwise the row shows the same chip twice and React has two children with one key.

**Verified** in the running app: `Sweet Home` shows the six tags of its bound Weeb Central copy
rather than the fourteen on its own entry; `Ms. Mystic` shows 11 chips from the 13 Manga District
sends; `Chainsaw Man`, whose entry and binding both report nothing, renders no row at all; and the
`Action` chip lands on Discover with the search box filled in, the SEARCH mode selected and 20
MangaDex results on screen.

---

## 17. Retry a page that failed to load

**Status: shipped.** Two things under the steps: the retry button was unclickable until the panel was
lifted over the tap overlay, and step 5's "progress needs no guard" is true for a single page but not
for a pair.

*SY's `PagerPageHolder` renders an error state with a Retry button that re-requests just that page.
Every `<img>` in `ReaderPage.tsx` has an `onLoad` and **not one has an `onError`** — a page that 404s
or that the source fails to serve renders as a bare broken-image icon, and the only way out is
reloading the reader.*

Branch: `feat/reader-page-retry`

**Behaviour.** A page that fails to load says so and offers to try again, instead of leaving a broken
frame in the middle of a chapter.

**Steps.**
1. `onError` on every page image: the single page, both halves of a spread, and the strip pages.
2. Per-url error state in a state map, cleared alongside the `requestedChapter` reset when the
   chapter changes, the way the backdrop cache already is.
3. A failed page renders a small panel in its place — message plus a retry button — sized so the
   layout does not jump when it recovers.
4. Retry re-requests with a cache-busting suffix (`?retry=<n>`). This is the one request allowed to
   differ from the bare url: section 4 made every page url bare precisely so a prefetch is a cache
   hit, but a failed response may itself be cached, and retrying the identical url would replay it.
5. Progress needs no guard: `updateReaderProgress` fires from `onLoad`, which a failed page never
   reaches, so a page that never loaded is never reported read.

**Done when:** a page forced to fail shows a retry that recovers it, progress does not advance past
it, and a chapter with no failures behaves exactly as before.

### The retry button sat under the tap zones, and a pair does need the guard

**The panel is drawn where the tap map already is.** Section 12's overlay covers the whole stage at
`z-index: 2`, so the region over the middle of the screen took every click aimed at "Try again" and
turned the page instead — the one button on screen that could fix anything was the one button that
could not be pressed. `.paged-reader .page-error` is `position: relative; z-index: 3`, which lifts
only the panel's own box: the zones around it keep working, and the failed page is the one place
where a tap means something else.

**Step 5 holds for a single page and not for a pair.** Progress is reported from the *lead* image's
`onLoad`, and section 6 has it report the last page of the pair — so a spread whose second page
failed would have reported that page, marking a chapter read on artwork that never rendered. The lead
now reports the furthest page on screen that is not in the error map, which is the same index as
before whenever nothing failed.

Two smaller notes:

- The prefetch keeps requesting the **bare** url, so a page that failed is aborted twice on first
  sight — once for the prefetch, once for the visible image. Only the visible one has an `onError`,
  which is the one that matters; a prefetch that fails silently is what a prefetch should do.
- The retry counter is per url and only ever grows, so a page that fails repeatedly asks for
  `?retry=1`, `?retry=2`, … and never re-serves a cached failure.

**Verified** in the running app on a title outside the library, with the page request aborted at the
network layer: page 3 of a paged chapter showed the panel at 420×560 with the tap zones still live
around it, "Try again" fetched `…/page/2?retry=1` and the page rendered; `lastPageRead` sat at 1 while
the page was failed and moved to 2 only once it loaded. The same in strip mode on page 5 of another
chapter — a full-width 1040×900 panel that recovered the same way. All test progress reverted
afterwards.

---

## 18. Grayscale and invert in the reader

**Status: shipped.** Step 5 said to leave the auto background sampling the unfiltered page and to
check that by eye. The eye check failed it — see the note under the steps.

*SY carries `grayscale` and `invertedColors` as one-tap reader settings. Neither exists here: the only
`grayscale(1)` in `App.css` is on the AniList tracking badge.*

Branch: `feat/reader-colour-modes`

**Behaviour.** Two independent switches in the reader options: read the page in grayscale, and invert
its colours. Both apply live, in paged and strip mode alike.

**Steps.**
1. Two settings persisted like the rest (`stremio4manga.reader.grayscale`, `…​.invert`), both off by
   default.
2. Applied as a CSS `filter` on the **page images**, not on `.reader-stage`. The stage carries the
   auto background colour from section 10, and inverting the surround along with the page would fight
   a feature whose whole job is to match it.
3. Both on composes as `grayscale(1) invert(1)`.
4. Rows in the reader options, not gated on paged mode — a long strip inverts for the same reason.
5. The auto background keeps sampling the **unfiltered** bitmap, since `sampleBackdrop` reads the
   decoded image rather than the rendered element. Left that way deliberately: the surround stays the
   page's true edge colour, which is what makes it blend with a page that is itself untouched at the
   edges. Worth re-checking by eye with invert on before calling it done.

**Done when:** both toggle live, compose, survive a reload, and apply in strip mode.

### The surround has to invert with the page

Step 5's reasoning holds only while the page is "itself untouched at the edges" — which is exactly
what invert stops being true. Sampling the raw bitmap and painting that behind an inverted page puts
the artwork back inside a frame that no longer matches it: a dark-bordered page inverts to a light
one and keeps its near-black surround, which is the framing the auto background exists to remove.

So `sampleBackdrop` now returns the **raw border average** and a second function, `backdropCss`,
turns that into the colour actually painted — the same two operations as the CSS filter, in the same
order, and only then the pull back toward `#242629`. Three things fall out of the split:

- **The pull is decided on the colour as it will be seen.** Dark edges are followed closely and
  bright ones held back; judging that on the unfiltered sample would apply the "do not blind them"
  clamp to whichever version of the page is not on screen.
- **The per-page cache survives a change of setting.** It holds samples rather than finished colours,
  so toggling invert re-tints the surround from cache without re-reading a single canvas.
- The filter itself stays on the images, as step 2 said. Putting it on `.reader-stage` would filter
  the surround along with the page and there would be nothing left to reconcile — just a stage whose
  colour CSS has already changed out from under the setting.

**Verified** on a paged chapter with the auto background on: invert alone took the surround from
`rgb(39 40 44)` to `rgb(84 86 86)` (the page's own edge, inverted, then held back from full
brightness), both modes together to `rgb(84 86 88)`, grayscale alone back to `rgb(39 40 43)`, and the
page's computed filter tracked each state — `invert(1)`, `grayscale(1) invert(1)`, `grayscale(1)`.
A reload in strip mode kept both settings and applied `grayscale(1) invert(1)` to the strip images,
with the strip's own fixed surround unchanged.

---

## 19. Download-ahead while reading

**Status: shipped, as planned.** Three small departures under the steps: where the control lives, what
"the next N" is ordered by, and what the once-per-chapter guard is keyed on.

*SY's `autoDownloadWhileReading` (0/2/3/5/10) enqueues the next chapters once the reader is past a
quarter of the current one. Our download queue shipped in section 14 and is called from the chapter
list — but nothing calls it from the reader: `enqueue`/`startDownloader` match nothing in
`ReaderPage.tsx`.*

Branch: `feat/reader-download-ahead`

**Behaviour.** A setting for how many upcoming chapters to keep on disk while reading. Once a quarter
of the way through a chapter, the next few are fetched quietly in the background, so continuing is
instant and works if the connection does not.

**Steps.**
1. Setting persisted to `stremio4manga.reader.download-ahead`, values off/2/3/5/10, default **off** —
   it writes to disk without being asked otherwise.
2. Fire when `page / pageCount > 0.25`, guarded by a ref so it runs once per chapter rather than on
   every page turn.
3. The reader already holds the chapter list (`nodes { id name sourceOrder chapterNumber realUrl }`);
   add `isDownloaded` to it and take the next N by `sourceOrder` that are not already downloaded.
4. `ENQUEUE_DOWNLOADS_MUTATION` then `START_DOWNLOADER_MUTATION` from `utils/downloads.ts`, in that
   order — enqueueing alone leaves the downloader `STOPPED`, which the sections 12–14 preamble
   records as verified against this server.
5. Failures stay silent. This is a background convenience, and a source that will not serve a chapter
   ahead of time is not something to interrupt a chapter over.

**Done when:** reading past a quarter of a chapter with the setting at 3 leaves the next three
chapters on disk, and turning the setting off downloads nothing.

### Where it sits, what "next" means, and when it re-arms

- **It is a row in the Image tab, not a new one.** PR #28 turned the options into a two-tab dialog —
  Layout for the shape of the chapter, Image for how a page is drawn — and download-ahead is neither.
  It goes beside the wake lock, which is not about the image either: those two are the settings about
  the *reading session*, and a third tab holding two rows would be worse than the mild mislabel. Five
  values (Off/2/3/5/10) as a `.reader-choices` row, the same shape as the progress-bar picker.
- **The next N come from the reader's own chapter order, not from `sourceOrder`.** The reader sorts by
  `chapterNumber` and falls back to `sourceOrder` (line 397), and that list is what its next/previous
  chapter buttons walk. Taking "the next three" off a different ordering would let the reader
  download one chapter and continue into another — the two coincide on a well-behaved source and
  disagree exactly where it matters.
- **The guard is keyed on `chapterId:depth`, not on the chapter alone.** Turning the setting from 2 up
  to 5 mid-chapter should fetch the rest; with the chapter as the key the change would do nothing
  until the next chapter, which reads as a broken control.

Two things confirmed while testing rather than assumed: resuming into the middle of a chapter fires
the download on open, which is right — the reader is a quarter of the way in by any measure — and the
downloader still stops itself when the queue drains, so nothing is left running.

**Verified** on a title outside the library: with the setting **Off**, six page turns past the trigger
left `downloadStatus` `STOPPED` with an empty queue and nothing on disk. Set to **3**, reopening the
chapter enqueued exactly the next three (Ch.2, Ch.3, Ch.4), the downloader started itself, and three
further page turns added nothing — one enqueue per chapter, not one per turn. The queue drained to
`STOPPED`, the three chapters were deleted again and the read progress reverted; `downloads/mangas`
is gone from the data directory.

---

## 20. Automatic double-page pairing

**Status: shipped.** Step 1 assumed the spread was still a setting of its own; PR #28 had folded it
into the three-tile layout control in the meantime, so the third value went somewhere else — see the
note under the steps.

*SY's `PageLayout.AUTOMATIC` decides per pair from each page's own decoded size, marking a page
`fullPage` when `height < width` so a wide spread is never forced into a pair. Section 6 pairs by
index parity with a manual offset — a wide splash page lands wherever the offset happens to put it.*

Branch: `feat/reader-auto-spread`

**Behaviour.** A third choice beside single and double: let the reader decide. Ordinary portrait
pages pair as usual; a page that is wider than it is tall is shown on its own, at full width, without
anyone having to shift the offset by hand.

**Steps.**
1. The spread setting becomes three-valued (off / on / auto), migrating the existing boolean key
   rather than adding a second one.
2. Wide test from the decoded image — `naturalWidth > naturalHeight` — read where `sampleBackdrop`
   already reads it (`ReaderPage.tsx:120`), cached per url in a ref and cleared on chapter change.
3. `pairStart`/`spreadPages` consult the cache: if either candidate of a pair is wide, the first page
   is shown alone and the next turn starts the following pair.
4. An undecoded page is not known to be wide, so it pairs as today and re-pairs when the prefetched
   image resolves. A turn must never block on a decode.
5. The offset control stays for `on` and hides for `auto` — deciding is the whole point of auto.

**Done when:** a chapter with a wide splash page shows it alone and pairs everything around it, with
the counter and chapter hops still correct across the solo page.

### The third value is a checkbox under Double, not a fourth tile

PR #28 merged the mode and the spread into one three-tile **Layout** control — Single, Double, Long
strip — where Single and Double are the paged reader with the spread off and on. A fourth tile
reading "Auto" would put two different questions in one row: Single/Double/Strip answer *what shape
is the chapter*, and by-position/by-shape answers *where does a pair start*, which only exists once
Double is chosen. So the tiles are untouched and **Pair by page shape** is a `.reader-check` beneath
them, shown only while Double is selected — the same slot, and mutually exclusive with, **Shift the
pairing**. Both answer the where-does-a-pair-start question, one by hand and one from the artwork, so
showing both at once would be offering two answers to it.

Step 1 still holds underneath: one three-valued `stremio4manga.reader.spread` (`off`/`on`/`auto`),
the same key the boolean wrote, so a stored `on` or `off` carries over with nothing to migrate. The
Double tile reads `spread !== 'off'`, and pressing it only *starts* pairing by position — a reader who
chose by-shape, went to the strip and came back finds it still on.

Two departures from the mechanics as they were planned:

- **The wide map is state, not a ref (step 2).** A ref would record the shapes and change nothing on
  screen; pairing has to re-run when a decode arrives. It is written only when a value actually
  changes, so a page confirming what was already known does not re-render the reader.
- **Pairing is a walk, not arithmetic (step 3).** `pairStart` is parity plus an offset, which cannot
  express "one page back there was wide, so everything after it shifted by one". `autoPairStart`
  walks from the front of the chapter instead, and `backwardPage` walks the same map so that going
  back lands on exactly the screens that going forward showed. Twenty-odd iterations per render on a
  normal chapter, and it is the only arithmetic in the feature.

Step 4's undecoded case is what the prefetch turned out to cover: the four-page lookahead from
section 4 now records each page's shape as it decodes, so by the time a turn reaches a wide page its
shape has been known for several screens. A page nothing is known about still pairs as it would have
and re-pairs when the image lands.

**Verified** on a 13-page chapter at 1400×850 with a wide page put in the middle of it (page 6 served
the chapter's own 1600×1400 splash page): **by position** it read 1–2, 3–4, 5–6, 7–8, 9–10 — the wide
page jammed into a pair — and **by shape** the same chapter read 1–2, 3–4, 5, 6, 7–8, giving the wide
page a screen of its own and its would-be partner one too. Going back retraced the same screens
(7–8, 6, 5, 3–4, 1–2), the chapter's real wide last page stood alone, and turning past it continued
into Ch.2. The offset checkbox is absent under by-shape and returns when it is switched off; a
700×950 window fell back to one page and kept the stored setting at `auto`. Test progress reverted
afterwards.

---

## 21. Auto-scroll in long-strip mode

**Status: shipped.** One thing the plan could not have known — the resume anchor fights the loop —
and two decisions about what "stop" means, all under the steps.

*SY's `autoscrollInterval`/`smoothAutoScroll`. Strip mode here only ever moves on the reader's own
input — no interval, no rAF loop, no autoscroll term anywhere in the file.*

Branch: `feat/reader-autoscroll`

**Behaviour.** Hands-free reading for long strips: turn it on, pick a speed, and the page scrolls
itself. Any touch of the wheel, the screen or the keyboard hands control straight back.

**Steps.**
1. Speed setting persisted like the others, off by default, strip mode only.
2. A `requestAnimationFrame` loop calling `stage.scrollBy` — smooth rather than stepped, since a
   stepped advance in a continuous strip is exactly what strip mode exists to avoid.
3. Cancel on `wheel`, `touchstart` and `pointerdown`, reusing the release pattern the strip anchor
   already uses. Cancelling means stopping, not pausing: restarting is one tap.
4. Stop at the end of the strip. Do not roll into the next chapter — the strip end panel is an
   explicit action and should stay one.
5. Release the loop when the reader unmounts or the mode changes, and pair it with the wake lock in
   the options copy: a screen that dims halfway through an auto-scroll is the obvious complaint.

**Done when:** it scrolls hands-free at the chosen speed, any manual input stops it, and it stops at
the end of the chapter rather than continuing.

### The resume anchor has to be released, and "stop" needed defining twice

**The strip anchor would have dragged it back.** Section 1's resume holds the page it opened on at the
top of the stage, re-pinning it on every scroll event until the reader wheels, taps or presses a
scroll key — none of which auto-scroll does. Left alone, the loop scrolls a few pixels and the anchor
puts them back, forever. Starting the loop releases the anchor (`setStripAnchor('free')`), which is
also the honest reading of it: the strip is now moving, so there is nothing left to hold.

Two decisions the steps left open:

- **At the end it idles rather than cancelling itself.** Step 4 says stop at the end and do not roll
  into the next chapter, which it does — but the loop keeps running and simply declines to scroll.
  A strip grows while lazy images below settle, so a loop that killed itself on first reaching the
  bottom could stop several screens short of the real end. The setting also survives into the next
  chapter, so opening one deliberately picks up where the reader left off.
- **A tap on a control is not a manual scroll.** Step 3's `pointerdown` cancel would otherwise fire on
  the reveal button, which sits on the stage — opening the panel would cancel the setting the panel
  exists to change. Taps landing inside a `button` are ignored. This wants `event.target instanceof
  Element`, **not** `HTMLElement`: these buttons are an `svg` with a `path` in them, and an
  `SVGElement` is not an `HTMLElement`, so the `HTMLElement` version of the guard silently never
  matched.

Speed is expressed as **seconds to travel one screen** (slow 14, medium 8, fast 4.5) rather than
pixels per second: the strip pages here render some 13,000px tall, and a pixel rate that suits a
phone is a standstill on a desktop. The sub-pixel remainder is carried between frames, or the slow
setting rounds down to zero every frame and never moves at all.

**Verified** on a strip chapter at 1400×900: off, the strip did not move on its own; at medium it
travelled 451px in four seconds against the 450 the setting asks for, and at fast 401px in two.
A wheel gesture, a tap on the strip and `ArrowDown` each stopped it and wrote `off`; opening the
controls from the reveal button did not, and it kept scrolling through the panel opening. Run into the
end of a chapter it settled at the bottom and stayed there — same chapter, same URL, setting still on
— with no hop into the next one. All test progress reverted afterwards.

---

## 22. Library sort order

**Status: shipped.** Two deviations, both under the steps: last read comes off the bound source's
own chapters rather than the continue-reading shelf's query, and step 5's single icon-only control
became an icon-only trigger over a named menu — four orders cannot be four presses of one button.

*SY orders each shelf by title, date added, unread count, last read and more. Our shelves have a
filter and a grouping toggle but **no ordering at all** — `shelf.items` renders in whatever order
`LIBRARY_QUERY` and `deduplicateLibrary` happen to produce.*

Branch: `feat/library-sort`

**Behaviour.** A control in the library toolbar choosing how cards are ordered inside every shelf —
by title, by when it was added, by how much is unread, or by how recently it was read — with a
direction toggle. The choice is remembered and applies to both groupings.

**Steps.**
1. One setting, `stremio4manga.library.sort`, holding the order and the direction.
2. `LIBRARY_QUERY` gains `inLibraryAt`. It is **`LongString!`**, so it arrives as a string: compare
   `Number(inLibraryAt)`, exactly as section 1 had to for `lastReadAt`.
3. Unread reuses the per-card count the shelf covers already derive; last read reuses the
   `lastReadAt` data the continue-reading shelf already pulls. Neither needs a new query.
4. Sort `shelf.items` **after** `deduplicateLibrary`, so the row that survives deduplication — the one
   that knows the most — is the row that carries the sort key.
5. Icon-only control in `.library-toolbar` beside the sync and selection buttons, matching that
   toolbar's convention, with the direction as a second press rather than a second control.
6. Default to title ascending, which turns today's arbitrary order into a deterministic one.

**Done when:** each order and both directions work, under status grouping and category grouping
alike, and the choice survives a reload.

### Last read comes off the bound source, not off the shelf's query

Step 3 said last read "reuses the `lastReadAt` data the continue-reading shelf already pulls". It
cannot: that query lives inside `ContinueReadingShelf`, and it is `first: 60` **chapters** — enough
for eight cards, nowhere near enough to order 25 titles, since a handful of series can eat all 60
rows between them. Lifting it to the page would have meant a second copy of a capped list.

`lastReadAt` was added to `BOUND_UNREAD_QUERY`'s chapter selection instead: one more field on a
query the page already runs, and the newest stamp across a bound source's chapters is exactly "when
this series was last picked up", with no cap at all. The cost is that history sitting on a source
the binding has since moved off does not count — the same blind spot the shelf covers with its
title fallback — so such a title sorts as never read. That is the rarer case and the honest one:
the card *reads* from the bound source.

### Four orders are not four presses of one button

Step 5 asked for one icon-only control with "the direction as a second press". Direction as a second
press is right and shipped; the four orders are not, because a single button cycling eight states
tells the reader nothing about what the next press does. The toolbar keeps its icon-only trigger and
opens a small menu of named orders — the house rule is about the *toolbar*, and a list of real
choices is prose, exactly as the batch bar's confirm step is.

The menu is a `role="group"` of buttons behind `aria-expanded`, deliberately not a `role="menu"`:
that role promises roving tabindex, arrow keys and typeahead, and one that does not keep the promise
is worse than none. It also **stays open after a choice**, which is what makes the second press
reachable at all.

Three things came out of a design review of it, all of which changed the build:

- **The trigger's arrow reports the direction.** It was drawn descending whatever the state, so the
  default (Title, A–Z) showed a down arrow — the button's only visual output, wrong half the time,
  and the reason the flip gesture was invisible once the menu closed.
- **Only the active row states a direction.** Every row showing one read as four facts about the
  library rather than one fact and three offers, and a screen reader — with no highlight to go by —
  heard "Title, A–Z" asserted on rows that were not in force. Inactive rows carry it in the mood of
  an action instead ("Sort by Title, A–Z"), where it belongs.
- **Hover had been styled `--aqua-soft`, the same as the selection.** Every row looked chosen as the
  cursor crossed it. Hover is `--paper` now, and aqua means chosen.

Escape returns focus to the trigger rather than dropping it on the body, and the sorted-by line is
announced through a `role="status"`, since the grid reorders silently behind the menu.

Two smaller decisions:

- **Each order starts at the end it is normally read from** — title A–Z, but date added, unread and
  last read all largest-first. Starting every order ascending would have meant a second press on
  three of the four before they said anything useful.
- **Ties break on the title**, so every order is total. Otherwise the tiebreak would be the arbitrary
  row order this feature exists to replace.

**Verified** against the real library (28 titles, display-only — nothing was written): title A–Z and
Z–A; date added, which is the sharpest test here because 26 of the 28 rows share one `inLibraryAt`
from the AniList import, so the two that do not are the only ones that may move — and they did,
`The Journey of a Dark Elf` and `My Bias Gets on the Last Train` to the front, `Sweet Home` (the
oldest) to the back; unread in both directions, matching every chip on screen exactly, with the two
titles tied at 75 falling back to the title; last read, which put the five titles with reading
history first in the order the continue-reading shelf has them. The choice survived a reload, and a
probe category confirmed the category shelves order identically before it was deleted again.

**Status: shipped.** One step could not be followed and one question the steps left open had to be
answered, both recorded below: Discover has nothing to add a title with, and the library the warning
compares against is fetched by the button rather than by the page.

*SY looks up library manga with the same title before favouriting and opens a dialog offering to open,
migrate or add anyway. Our heart button calls `toggleLibrary` immediately; the two pieces this needs —
`relevantTitleMatches`/`titleSimilarity` in `utils/titleMatch.ts` and `deduplicateLibrary`'s title
normalising — exist already and neither is consulted at add time.*

Branch: `feat/duplicate-add-warning`

**Behaviour.** Adding a series that already appears in the library under another source asks first,
showing the copy that is already there with the choice to open it instead, add anyway, or cancel.
Today this silently produces two library rows that only get collapsed for display afterwards.

**Steps.**
1. Only on the way **in**: `inLibrary: true`. Removing never asks.
2. Before the mutation, match the title against the library with `titleSimilarity`, using the same
   normalising `deduplicateLibrary` applies so the two agree on what counts as the same series.
3. Above the threshold, show the existing entry — cover, the source it reads from, its unread count —
   with open / add anyway / cancel. Below it, add without a word.
4. The threshold matters more than the dialog: a false positive on every add is worse than the
   duplicate it prevents. Reuse the value `relevantTitleMatches` already trusts rather than inventing
   a second one.
5. Reachable from both places a title is added — the detail page hero and Discover.

**Done when:** adding a series already in the library from a second source warns and can open the
existing entry instead, and an unrelated title is added with no interruption.

### Discover never adds anything

Step 5 asks for the warning in "both places a title is added — the detail page hero and Discover".
Discover adds nothing: every card in its grid is a `<Link to={/manga/:id}>`, and the only
`inLibrary: true` written anywhere in `src` is the hero's heart. The library page writes the flag
too, but only `updateMangas(patch: { inLibrary: false })` — the batch *remove*. So there is one way
into the library in this app, every route to it lands on the detail page first, and covering the
heart covers Discover by construction. The "In library" chip Discover paints on a cover is a
read of `inLibrary`, not a control.

### The library the warning reads, and what it costs

The steps say to match against the library without saying where the library comes from, and this is
the part with a price on it. The detail page is opened to *read* far more than to add, so a
library-wide query wired into the page would be paid on every open to serve the rare press — and
`LIBRARY_QUERY` on the library page is not reusable from here anyway, since it pulls categories and
track records this has no use for.

So the button fetches it: one `LibraryTitles` query issued from the click handler, `cache-first`,
carrying only what matching and the dialog need. urql's document cache does the rest, and the add
mutation is what keeps it honest — `updateManga` returns a `MangaType`, which invalidates every
cached query holding one, so a title added in this session cannot be missing from the next check.
Measured in the browser by counting the requests: the first press after a mutation refetches, the
second press does not, and both warn.

A second query fills the dialog in *after* it is on screen. Everything the warning says about a
match — the source it reads from, how much is unread — lives on the manga that entry reads from
rather than on the library row, which is usually an AniList-seeded stub on the legacy TorBox source
with no chapters at all. It is asked only when there is a warning, only for the one or two entries in
it, and the dialog does not wait for it.

Unread is counted the way the library counts it: distinct chapter numbers above the read-through,
never rows, because a source carrying several scanlations of one chapter would double the number.
Read-through takes the best of the entry's tracker, the reading copy's tracker and its own read
flags — Sweet Home's entry says 119, the bound copy's record says 122, and 122 is the answer.

### Two rows for one series must warn once

The library holds several rows per series by design — an AniList import and a source search each
make their own, and `deduplicateLibrary` collapses them for display only. Matching against the raw
rows would have listed Sweet Home twice in a dialog whose entire point is that one series is enough.
The rows are grouped first, on the identity `deduplicateLibrary` uses: the AniList id when a tracker
has claimed the row, the normalised title when none has, keeping the bound row because that is the
copy being read and the one worth offering to open.

That normaliser is now exported from `utils/titleMatch.ts` — the same one `titleSimilarity` folds
titles with — rather than reaching into `LibraryPage`'s private `titleKey`. The two agree on
everything except `&`, which `titleMatch` folds to "and". `LibraryPage` was deliberately left on its
own copy: swapping it would change which cards its shelves collapse, and that is not this section's
business to change.

**Verified** in the running app against the real library, which was left exactly as it was found (28
entries, same ids). Adding Sweet Home from Weeb Central — the very copy the library entry is bound to
— warned with the entry, "Reads from Weeb Central · 18 unread" and a working "Open it instead";
Cancel left the library at 28 and the manga out of it; Add anyway took it to 29 and the heart to
"Remove from library"; removing it asked nothing and put it back to 28. A MangaDex "Burn the Witch"
warned about **both** library entries of that name, which is right — they are two distinct AniList
series and the library keeps them apart on purpose — and the heading softens to "You may have this
series already" when more than one matched. "Action Kamen" was added and removed with no dialog at
either end.

---

## 24. Mass migration

**Status: shipped.** Step 4 was incomplete in a way that would have blanked every card it touched —
the incoming source's chapters have to be fetched whether or not there is progress to carry. That
and two other corrections are under the steps.

*SY lists the sources the library reads from, each with a count, and walks every title on one to the
next. We have the per-title version — `FindOnSource` plus `bindTo`, with section 2's progress
carry-over — but the batch bar offers only mark caught up, file into a category, and remove.*

Branch: `feat/library-mass-migrate`

**Behaviour.** Move several titles from one source to another in one pass: select them, choose the
destination, confirm the matches it found, and it rebinds them all — carrying read progress the same
way a single rebind does.

**Steps.**
1. A **Change source…** action in the existing selection-mode batch bar, so it reuses the selection
   the library already has rather than adding a screen.
2. Per title, `fetchSourceMangaBulk` (`MangaDetailPage.tsx:86-88`; `sources: [LongString!]!`,
   `type: SEARCH`) against the chosen destination with the title as the query.
3. Rank with `sortByTitleSimilarity` and show a **confirm list**: each title, its proposed match, and
   a checkbox — on by default above the similarity threshold, off below it. Nothing is applied
   silently; this is the step that separates a useful batch from an unrecoverable one.
4. Applying calls the same `SetSourceBinding` mutation the per-title flow uses
   (`boundMangaId: String!`), then section 2's carry-over per title.
5. Sequential with a progress counter, never parallel — the same rate-limit reasoning as the sweep in
   section 8.
6. Report per title and let the batch finish: a source that cannot answer for one title must not cost
   the other nine, the same pattern as `refreshFromAniList`.

**Done when:** three titles on one source can be moved to another in a single pass, each match
confirmed first, read progress carried, and a failure on one leaving the rest migrated.

### The incoming source's chapters have to be fetched every time, not only to carry progress

Step 4 made the chapter fetch part of the carry-over, so a title with nothing read skipped it. Built
that way, the first migration left the card with **no unread chip and no chapter total**: the
library counts unread against the *bound* source's chapters, and a catalogue nobody has asked for a
chapter list yet has none. Verified in the running app — the freshly bound ComicK copy came back
`chapters: 0` and the card went blank until the title was opened.

`fetchChapters` now runs for every title moved, and the same answer it returns is what the
carry-over compares against the read-through, so it is still one call either way. A source that
will not list them is named in the notice (`no chapter list yet for …`) rather than failing the
move: the binding is saved and correct, only the counts are missing until the next sweep.

### A destination can answer with the title's own row

A title added straight from Discover *is* a row on some catalogue, so searching that catalogue for
it returns the library entry itself. Writing that id as the entry's binding would invent a
"bound to myself" state nothing else in the app understands. It deletes the binding instead —
reading from your own catalogue is exactly what having none means — which is also what
`MangaDetailPage.bindTo` does when the picker's own entry is chosen. `DELETE_SOURCE_BINDING_MUTATION`
moved into `utils/bindings.ts` beside `SET_` for it.

### Shared with the detail page rather than copied

Three pieces the plan named as living in `MangaDetailPage` were lifted, following `utils/backup.ts`:
`FETCH_SOURCE_MANGA_BULK_MUTATION`, `SOURCES_QUERY` and the source-manga types into `utils/sources.ts`;
`SET_SOURCE_BINDING_MUTATION`, `DELETE_SOURCE_BINDING_MUTATION`, the meta key and `sourceBindingFromMeta`
into `utils/bindings.ts`. `sortByTitleSimilarity` was already shared. The detail page imports them
now and holds no copy, so the two flows cannot drift on what a binding is.

Three smaller decisions:

- **The confident/loose split reuses `relevantTitleMatches` rather than a second threshold.** It
  ranks identically to `sortByTitleSimilarity`, so a non-empty result means the top hit cleared the
  bar the detail page's picker already trusts. Below it the row still shows what was found and stays
  tickable — it is only unticked, and labelled, so the reader looks at it. Verified: MangaPill's best
  answer for *I Violently Level Up* was an unrelated *I Shoujo*, correctly unticked with the
  primary action reading `Move 0 to MangaPill` and disabled.
- **One notice line, no separate error**, for section 8's reason: a partial failure across a dozen
  titles is a normal outcome, and hiding the summary behind an error loses the count of what did move.
- **The AniList record is not rebound here.** A single rebind on the detail page has an effect that
  binds the track record onto the new source right after; a migration from the library does not, so
  the record follows on the next visit to the title's page. Progress display is unaffected — the
  library reconciles against the *entry's* record, which never moved — but a chapter read on a
  freshly migrated source does not reach AniList until its detail page has been opened once. Left
  that way deliberately: the alternative is a second mutation per title, on the flow that is already
  the slowest thing in the batch bar.

**Verified** end to end. The read-only half ran against the real library: three unbound titles
selected and searched on MangaDex in one pass, each matched (including `Gal to Tsuchinoko` →
`Gal & Tsuchinoko`), then cancelled — **nothing was applied to a real title, and no binding or read
state of the library was touched**.

The write half ran entirely on *I Violently Level Up* (manga 45, MangaDex), a title **outside** the
library, added to it for the test and removed afterwards: migrated to ComicK Fanmade, then to Manga
Demon (whose 70 chapters were fetched by the move, which is what the correction above is about, and
whose card then read 67 unread after three chapters were marked read directly), then back to ComicK
Fanmade, which reported `Moved 1 title to ComicK Fanmade · 5 chapters marked read` — five *rows* for
a read-through of 3, because that catalogue carries three scanlations of chapter 1, which is the
same row-counting the detail page's carry-over does. Weeb Central's `Nothing found here` covered the
no-match row: checkbox disabled, action disabled.

Afterwards the library was back to 28 entries, manga 45 out of the library with its binding meta
deleted and no read chapters, and every chapter flag set during the test cleared on both source
copies. The two source rows the searches created (ComicK 7691, Manga Demon 7783) remain in the
database with their chapter lists, unread and not in the library — ordinary search residue, the same
as any use of the detail page's picker leaves.

---

## Sections 25–28 — unplanned work, written up after the fact

Unlike every section above, these four were never surveyed, planned or triaged: they were found as
uncommitted changes in the working tree on 2026-08-16, sitting on a base fourteen commits behind
`main`, and were rebased onto `bf5eeea` and landed together. They are recorded here to the same
standard as the planned work, because the weekly scout reads this file and would otherwise re-file
all four as fresh findings.

Their common theme is that the server already knew all of it — `tracker.user`, `manga.source`,
`chapter.uploadDate` — and the UI had simply never asked. No server change was needed for three of
them; the fourth was already merged (`Stremio4Manga-Server` PR #2, *Report the connected tracker
account over GraphQL*), which is what left the client half stranded in the first place.

One conflict resolution worth recording: PR #32's mass migration had added `sourceName: string | null`
to `BoundState` to name the source it migrates away from, and section 26 adds the fuller `source`
object from the same query node. The two were collapsed into one field rather than carried side by
side, and `fromSource` now reads `?.source?.name`.

---

## 25. The AniList connection as an account banner

**Status: shipped.** One thing could not be verified in this environment — see the note under the
steps.

*The connection was a `.settings-card` row reading "Connected" or "Not connected", which is the one
thing about it that was never in doubt. `tracker.user` had been available since the server's PR #2
and nothing ever asked for it.*

**Behaviour.** The connection heads the Settings page as an account banner: the avatar and username
AniList reports, how many titles are tracked, when the library last pulled progress down, and how
those titles split across the shelves. Import and Disconnect ride along on the right.

**Steps as built.**
1. `SETTINGS_QUERY` gains `user { name avatarUrl }`. It is resolved from AniList the first time it
   is asked for, so a connection made before the server cached the profile still fills in, and it
   stays null when AniList cannot be reached.
2. `TRACKED_TITLES_QUERY` counts library manga by **distinct `remoteId`**, not by row: a series
   imported from AniList and the same series added from a source are two rows pointing at one
   record, and counting rows would report the library as bigger than it is.
3. The last-sync stamp lives in **global meta**, not `localStorage`, under
   `stremio4manga.anilist-last-sync` — a sync run on the desktop is a sync as far as the phone is
   concerned. Both things that talk to AniList move it: the library's sync button and the Settings
   import, because an import is a sync that happens to pull the whole list.
4. The library stamps it **even when some titles failed**. Settings answers "when did this last
   run", not "when did it last run perfectly".
5. `statusNames` and the tracker id move out of `LibraryPage` into `src/utils/tracking.ts`, since
   Settings and the library both need them now and neither is a sensible home for the other's copy.
6. `TrackerAvatar` falls back to the username's initial. The avatar is served by AniList's own CDN
   rather than proxied by us, so a blocked or dead image must not leave a broken-image icon sitting
   in the card.

**Verified** against the running server: the banner read `AniList · Connected`, the username
`Mitsukuri` as returned by `tracker.user`, `27 titles tracked` (against 28 library rows — the
difference is exactly the duplicate `remoteId` the count is designed to collapse), `Last sync 3 days
ago`, and the shelf split `Reading 9 · Planning 12 · On Hold 4`.

**The avatar image path is verified now** (2026-08-16). It was left unverified because the automation
browser blocks the CDN — the failure is `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` on
`s4.anilist.co/…/b211220-PkUkvt8SyOVI.png`, a *response*-stage block, which is why stubbing the
request did not help: the request never reaches a stub, so the `<img>` fails, `onError` fires, and the
`M` fallback renders. That much was already known.

What the branch needed was a URL this browser will keep, so the component was handed one directly (a
same-origin asset) and the rest left alone. It rendered the real image: `complete: true`,
`naturalWidth: 522`, drawn into the banner's 84×84 box with `object-fit: cover` and the app's own
`7px 7px 20px` corner, `alt=""`, and **no** `.tracker-avatar-blank` anywhere on the page. The `<img>`
branch has now been seen, not just read.

**Why it was tested that way, and what that does not prove.** The origin of the URL is not part of what
the branch does — it renders an `<img>` and falls back when the image errors — so feeding it a loadable
URL exercises the whole path except the hostname. What remains untested is only that AniList's CDN
answers from *this* browser, which is an environment fact and not ours. Two dead ends are recorded so
they are not tried again: dev-browser's sandbox rejects `page.addInitScript` outright, and a
`page.route` handler is never invoked — the request is intercepted and then hangs forever, which looks
exactly like a slow image.

---

## 26. Badge each library card with the source it reads from

*A shelf of covers said nothing about where any of them came from, which is the first thing wanted
when two rows are the same series on different catalogues, or when a sweep reports that one source
could not be reached. `manga.source` was never in `LIBRARY_QUERY`.*

**Behaviour.** Each card names the catalogue its chapters come from, with the source's own icon,
under the title.

**Steps as built.**
1. `LIBRARY_QUERY` gains `source { id name iconUrl }` and `chapters { totalCount }`;
   `BOUND_UNREAD_QUERY`'s existing `source { name }` widens to the same three fields.
2. The badge names the **bound** source when there is one, and the entry's own only when that entry
   actually carries chapters. An AniList-seeded stub sits on the legacy TorBox source (`sourceId
   "1"`), and naming it would point at a catalogue the title cannot be read from — the same
   reasoning section 11 used to skip unbound entries entirely.
3. It goes **under the title, not over the cover**: the cover's bottom corner already belongs to the
   progress chip, and a source name squeezed in beside it truncates to "Weeb …", which tells the
   reader nothing.

**Verified** in the running app: 7 of 25 cards carried a badge — exactly the 7 bound sources the
sweep in section 8 reports on — reading Weeb Central, Manga District and Comix, each with its source
icon loaded. The unbound AniList stubs showed none, which is the intended silence.

---

## 27. Count what is unread on the continue-reading covers

**Status: shipped.** The two surfaces do not always agree, and the reason is recorded below — it is
a property of the data, not a defect.

*The shelf showed a progress bar but never a number, so a title two chapters behind and one twenty
chapters behind looked the same at a glance — which is the glance the shelf exists for.*

**Behaviour.** Each continue-reading cover carries the count of chapters left, in the left corner,
disappearing once the title is caught up.

**Steps as built.**
1. `unreadCount()` counts **distinct chapter numbers** above the read-through, never rows — a source
   carrying six scanlations of one chapter would otherwise report six chapters left. Same counting
   the library cards have always done, and for the reason already recorded on `BOUND_UNREAD_QUERY`.
2. A source with no chapters of its own falls back to AniList's total minus what it has read, and
   returns null when AniList does not know the total either. Null renders nothing.
3. The badge takes the **left** corner because the hide chip already owns the right one on these
   cards, and is suppressed once caught up: the bar says that in colour, and a number beside a full
   bar reads as a contradiction.

### The shelf and the cards agree only where the entry is bound

Checked title by title against the running library: of the five titles appearing on both surfaces,
four matched exactly — Sweet Home 18, WITCHRIV 1, Ms. Mystic 70, and 78 on a fourth. The fifth showed
**195 on the shelf and nothing on its card**, and the asymmetry is correct: its library entry
(manga 3662) is an unbound AniList stub on the TorBox source with `chapters.totalCount: 0`, no
`stremio4manga.source-binding` meta, and an AniList record carrying `totalChapters: 0` — so
`unreadFor` has nothing to compute from and rightly says nothing. The shelf's 195 comes from the
source copy actually being read, which does have a chapter list. Two different objects, and the
shelf is reporting on the one the reader touched.

**Verified:** all 8 shelf covers carried a count, and the four bound titles matched their cards to
the number.

---

## 28. Show when the source published each chapter

*A chapter list gave the name, the scanlator and a page count, but never a date — so there was no way
to tell a series that updated this week from one that stopped two years ago without leaving the page.
`uploadDate` was never in `CHAPTERS_QUERY`.*

**Behaviour.** Each chapter row carries its publication date, in the reader's own locale, beside the
chapter name.

**Steps as built.**
1. `CHAPTERS_QUERY` gains `uploadDate`. It is a GraphQL `Long`, so it arrives as a **string** of
   milliseconds and goes through `Number()` before it is a date — the same quirk as `lastReadAt` and
   `inLibraryAt` above.
2. `formatUploadDate` returns null for a non-positive or unparseable stamp, and those chapters show
   nothing at all. Plenty of scrapers leave `uploadDate` at 0, and a column of `1 Jan 1970` next to
   every chapter is worse than an empty space.
3. Rendered as a `<time datetime>` with the full stamp on `title`, sitting with the chapter **name**
   rather than with the page count: it says something about the chapter itself, not about how long it
   takes to read.

**Verified** on Sweet Home (manga 138, 141 rows in the list): every row carried a date, reading
`Dec 15, 2025, 12:21 PM`, with `datetime="2025-12-15T12:21:38.396Z"` matching the raw
`uploadDate: 1765801298396`, and the tooltip reading `Published 12/15/2025, 12:21:38 PM`.

**The null branch is verified now** (2026-08-16). No chapter in this database has an `uploadDate` of 0
(`chapters(filter: { uploadDate: { equalTo: "0" } })` still returns nothing) and none can be given one
— `UpdateChapterPatchInput` does not carry the field — so the guard was fed its three inputs at the
call site instead, on the chapter list of `I Violently Level Up`: `"0"`, `"banana"` and `""`.

All three rendered **no `<time>` element at all** — not an empty one, not `1 Jan 1970` — on rows 1, 2
and 3, while rows 4 and 5 carried their real stamp (`May 26, 2021, 12:00 AM`,
`datetime="2021-05-25T23:00:00.000Z"`). The rows were otherwise untouched: name, scanlator and page
count all sat where they always do, which is the actual claim — that a missing date costs the row
nothing. `""` is worth noting as a fourth case the original guard was not written for and handles
anyway: `Number("")` is 0, so it lands in the `<= 0` branch rather than the `NaN` one.

---

## 29. Delete downloaded chapters once they are read

**Status: shipped as option C — explicit only.** Specified on 2026-08-16 with three shapes to choose
between; **C was chosen**, and it dissolves most of the plan below: with nothing deleting on its own
there is no setting to default to off, no keep-count and no exclusion list. What that leaves is
recorded under "What C turned out to be", and the two sub-decisions the choice made moot are marked
where they appear.

*TachiyomiSY's `SettingsDownloadScreen.kt` → `getDeleteChaptersGroup`: `removeAfterMarkedAsRead`,
`removeAfterReadSlots`, `removeBookmarkedChapters` and a category-exclusion list, implemented in
`data/download/DownloadManager.kt` → `cleanupChapters`. We have `deleteDownloadedChapters` wired
only to the manual delete buttons on the Downloads screen and the chapter row (section 14) —
nothing hooks it to a chapter becoming read.*

Branch: `feat/delete-after-read`

**Behaviour** *(as specified — narrowed by the choice of C: the removal is asked for, not automatic)*.
Downloaded chapters are removed from disk once they have been read, keeping a configurable number of
recent ones, so a long series does not accumulate everything ever read.

### What was checked against the running server

- `deleteDownloadedChapters(input: { ids })` and `chapters(filter: { isDownloaded: { equalTo: true } })`
  both work — section 14 uses them already, so no new server surface is needed.
- `ChapterType.isBookmarked` **exists and is filterable**, so SY's "spare bookmarked chapters"
  exclusion is buildable. But `chapters(filter: { isBookmarked: { equalTo: true } })` returns
  `totalCount: 0` and nothing in `src` ever writes the field — the guard would protect nothing
  today. It is one filter clause, so the question is whether to carry a no-op for the future.
- Categories exist since section 13, so a category-exclusion list has something to exclude by.
- The REST batch edit accepts `delete: true` alongside `isRead` in a single call
  (`Chapter.ChapterChange`), but our UI does deletion over GraphQL and read state over
  `updateChapters`; mixing in the REST path for one feature is not worth it.

### The hard part: the app is not told when a chapter becomes read

This is why the finding was left unfiled, and it constrains every option below. A chapter becomes
read in **two different places, only one of which the client knows about**:

- **In the reader** — `updateReaderProgress` PATCHes progress and the **server** sets `isRead` when
  the reported index is the last page (`Chapter.updateChapterProgress`, the same mechanism section 4
  had to correct `withProgress` for). The client sends a page number and is never told that a
  chapter flipped to read. This is how nearly every chapter gets read.
- **On the detail page** — `updateChaptersRead({ ids, isRead: true })` from mark-read, mark-caught-up
  and the batch actions. This one *is* client-side and does know.

So "delete when marked read" cannot simply hang off a client event: the dominant path has no event
to hang off.

### The decision — **C was chosen**

Pick one; the rest of the plan follows from it.

**A — Sweep on open.** Recompute on the detail page and after the reader closes: list the manga's
downloaded chapters, drop the ones read beyond the keep-count. Simple, no new server surface, works
identically for both read paths because it reads state rather than watching for changes. The cost is
that deletion is *deferred* — the disk is not reclaimed at the moment the chapter is finished, but
the next time that title is opened.

**B — Sweep on open, plus an immediate pass in the reader.** As A, but the reader also fires a
cleanup when it turns the last page, so the common case is immediate. Costs one more code path in
`ReaderPage.tsx`, and that path has to agree exactly with A's or the two disagree about what to
keep.

**C — Explicit only.** ← **chosen.** No automatic deletion; a "clean up read chapters" action on the
Downloads screen and per title. Nothing can delete anything without being asked, which given the risk
(this feature deletes user data unprompted) is the conservative reading of the same need.

Also to choose, independent of A/B/C — **both moot under C**:

- ~~**Keep-count**: delete immediately once read (SY's slot 0), or keep the last N read chapters
  (SY offers 1/2/3/4/5).~~ A keep-count exists to protect a re-read from a background sweep nobody
  asked for. Nothing sweeps here, so the reader decides *when* instead of configuring *how much*, and
  the per-chapter delete button from section 14 is still there for finer aim.
- ~~**Exclusions**: category exclusions, and the bookmarked guard.~~ An exclusion list narrows an
  automatic pass. Every deletion here already names its own scope — one title, one filter, or
  everything on disk — so a second, invisible scope could only contradict it.

**Both things that were to hold whichever way it went still do.** Nothing deletes without being
asked, which under C is the whole mechanism rather than a default. And deletion never touches read
state: `deleteDownloadedChapters` only removes files, so a deleted chapter stays read and
re-downloadable, which is what makes the action recoverable at all.

**Done when** *(as specified, superseded by the verification below)*: reading past the keep-count on a
downloaded series leaves exactly the configured number of read chapters on disk, an excluded category
keeps everything, and turning the setting off deletes nothing.

### What C turned out to be

Three actions, each naming its own scope, each asking once before it deletes. No setting was added:
there is nothing to configure about a button that only ever runs when it is pressed.

1. **`utils/downloads.ts`** — `DOWNLOADED_CHAPTERS_QUERY` gains `isRead`, and both surfaces phrase the
   question through one `cleanupQuestion()` plus a shared `CLEANUP_REASSURANCE` ("They stay read, and
   can be downloaded again"), so the same destructive action is not worded two ways. No new mutation:
   `deleteDownloadedChapters` from section 14 already does the work.
2. **Downloads screen, per title** — a second delete beside the existing delete-everything, offered
   only when a title holds *both* read and unread downloads. With everything read the two would delete
   the same files, and two buttons for one outcome is worse than one. The row's own line reports it:
   `4 chapters · 2 read · newest Chapter 4`.
3. **Downloads screen, everything** — an action in the "On this device" heading covering every read
   chapter across every title, which is the one press that reclaims the disk. It disappears when
   nothing on disk is read, so an empty action never sits there.
4. **Chapter list** — an icon-only control in `.chapter-controls`, scoped to what the filter is
   showing, exactly like the download-all button beside it. With the filter on "read only" the pair
   reads as the whole chore: download what I have not read, delete what I have.
5. Both confirmations are a `.notice.cleanup-notice` row — the question, a danger **Delete**, a quiet
   **Keep** — following the library batch bar's confirm rather than inventing a dialog. Arming is
   reversible and is *not* the deletion; the chapter-list button also carries `.armed` and
   `aria-expanded` so the state is visible without reading the notice.
6. The two bins had to stop looking alike. A bin holding a tick is indistinguishable from a plain bin
   at 16px, so the read-cleanup icon is a **narrower** bin with the tick outside its top corner: the
   silhouettes differ, which is the only thing that reads at that size.

### The two surfaces do not count "read" the same way, on purpose

The chapter list deletes what **it marks read** — `read`, not `chapter.isRead` — so it includes rows
read through AniList's progress, which are the rows wearing a Read marker on screen. The Downloads
screen has no AniList reconciliation and no per-title track record to reconcile against, so it counts
`isRead` from the server.

The divergence is real and was watched happening: with chapter 6 read and chapters 4–6 downloaded, the
chapter list offered **3** (4 and 5 are under the read-through) while the Downloads screen offered
**1**. Each surface offers exactly what it is showing, which is the property worth keeping — a button
that deletes more than the list it sits in says is read would be the actual defect. Fetching track
records for every title on disk to close the gap would be a second query in aid of a number nobody
compares.

**Verified** end to end against the running server on `I Violently Level Up` (manga 7783, outside the
library), with four chapters downloaded and two marked read: the per-title action deleted exactly the
2 read files and left the 2 unread ones, both keeping `isRead: true`; the heading action then deleted
the 1 read chapter left and vanished when nothing read remained; the chapter list, with chapter 6 read
and 4–6 on disk, offered 3, disarmed on **Keep** with all 3 still on disk, deleted all 3 on **Delete**,
left the six Read markers standing and the download-all count back at 70 from 67. Singular and plural
wording were both seen ("1 read chapter", "2 read chapters"), the control disappears under the unread
filter and returns under "read only", and no action produced an error banner. The server was left as
found: nothing downloaded, nothing read on that title, an idle downloader and an empty
`downloads/mangas`.

---

## 30. The backup scope pass — nothing is missing, but the UI hides that backups already run

*Recorded as a finding, not a feature. `research/inbox.md` left "TachiyomiSY's backup screen and
`BackupCreator` internals (extra scope beyond what our `createBackup`/`restoreBackup` already
covers)" as worth a dedicated pass. Run on 2026-08-16 against the running server and a real backup
file.*

**Nothing is missing from the export.** `PartialBackupFlagsInput` carries exactly seven flags —
`includeManga`, `includeCategories`, `includeChapters`, `includeTracking`, `includeHistory`,
`includeClientData`, `includeServerSettings` — and **all seven default to `true`**
(`BackupFlags.DEFAULT`, `server-config/.../BackupFlags.kt`). `SettingsPage` sends
`createBackup(input: {})`, which falls through to that default. So the export is already maximal and
there is no scope to add. Any SY backup option beyond these has no counterpart to map onto.

**Our own client data is in there, verified rather than assumed.** `includeClientData` covers global
meta, per-manga meta and per-chapter meta (`BackupGlobalMetaHandler`, `BackupMangaHandler:85,120`).
Decompressing a real backup off disk and searching it found **8 occurrences of
`stremio4manga.source-binding`** and the `stremio4manga.anilist-last-sync` stamp added in section 25
— so the source bindings the whole app depends on, and the new sync stamp, are both being backed up.

**One genuine hole, and it is not the server's.** A binding that was only ever written to
`localStorage` (the `boundSourceId` fallback, `LibraryPage.tsx`) exists in no backup at all, because
no backup can see the browser. Bindings saved to manga meta are safe; browser-only ones are not.
Worth knowing before trusting a restore.

**What the pass actually turned up: automatic backups have been running the whole time, and nothing
says so.** `settings.backupInterval` is 1 (day), `backupTime` `00:00`, `backupTTL` 14 days, and
`%LOCALAPPDATA%\Tachidesk\backups` holds seven `.tachibk` files written daily since 2026-08-09. The
UI mentions none of it: `SettingsPage` offers a manual export and an import, and a reader would have
no way to know their library is already snapshotted nightly.

So the item worth building is **not** more backup scope but surfacing what exists: when the last
automatic backup ran, how many are kept and for how long, and the interval/time/TTL controls
(`backupInterval`, `backupTime`, `backupTTL` are all on `SettingsType` and settable through the
generic `setSettings`). Restoring *from* one of the existing auto-backups is the natural companion,
and unlike section 8's rejected server job this one has no source-reachability problem — the backup
job is server-local and demonstrably works.

~~**Not planned here**~~ — **built on 2026-08-16**, in two halves. The finding above stands unchanged:
nothing was added to the export, because there was nothing missing from it.

### The server had to answer first

`backupInterval`, `backupTime` and `backupTTL` were already readable through `settings`. The two things
that would make a nightly backup *visible* were not readable at all:

- **When the job last ran** lives in a `SharedPreferences` key (`ProtoBackupExport`'s
  `lastAutomatedBackup`), used by the scheduler to decide whether it missed a slot while the server was
  down, and exposed nowhere.
- **What it left on disk** lives in a directory nothing serves, so no client could list it, and
  `restoreBackup` takes an `UploadedFile` — getting a nightly backup back would have meant finding the
  file on the server's own machine and posting it in again.

So `Stremio4Manga-Server` PR #3 adds `automatedBackups` (`lastRun` plus the files, newest first, with
size and timestamp), `validateAutomatedBackup(filename)` and `restoreAutomatedBackup(filename)`. Both
new entry points resolve the name **by matching the listing** rather than by joining it onto the backup
directory, so `..`, an absolute path or a drive letter cannot reach a file the listing never offered —
verified by both refusing `../../database.mv.db` and `nope.tachibk`. The three `Long` fields arrive as
`LongString`, so they are strings and go through `Number()`, the same quirk as `lastReadAt` and
`uploadDate`.

### What the UI shows

A **Automatic backups** card in Settings, below Restore:

1. One status line built from the server's own numbers: `Every day at 00:00, kept 14 days · last run
   18 h ago`, with `formatSince` from `utils/tracking` so it reads like the AniList banner's stamp. With
   the interval at 0 it reads `Switched off — nothing is being backed up on its own`, and the list of
   what is already kept stays: switching the job off does not delete what it wrote.
2. The schedule itself — interval in days, time of day, TTL in days — with 0 spelled out in both places
   it means something different: `days (off)` for the interval, `days (forever)` for the TTL. Saving is
   disabled until something actually changes, and the card **re-reads** after saving rather than
   trusting the numbers it just sent, because changing the interval reschedules the job server-side and
   can make it run immediately if it decides it missed a slot.
3. The files, newest first, each with its date and size and a restore action. Dates are worded like the
   chapter list's (`Aug 16, 2026, 12:09 AM`, no seconds) — which night a backup is from is the question.
4. Restoring one goes through **the same confirmation the file picker already uses**: validate first,
   show what the backup references that this server lacks, then `Overwrite library`. The panel is
   rendered inside whichever card started it, so the question appears where it was asked rather than in
   the other card further down the page; the chosen row is highlighted while it is being asked about.
5. **No scope switches.** The seven `autoBackupInclude*` settings are all on, so the nightly copy is
   already maximal, and a row of toggles for narrowing one's own safety net is not worth building. What
   the card does instead is *say* when one of them is off — `Leaving out tracking, history — those are
   not in the nightly copy` — which is the case worth surfacing.

**Verified** against the running server (v2.3.2256, rebuilt for this). The card listed the 7 real
backups with sizes and `last run 18 h ago`. Validation of the newest reported nothing missing and put
the confirm panel in the automatic-backups card, not the Restore card; Cancel cleared it and
unhighlighted the row.

The restore itself was exercised **on a backup taken of the state as it then was**, so it could not
change anything it should not: the progress line moved through `Restoring titles… 10/31` to `Restore
complete`, the Done panel appeared, and the library was identical either side — 28 titles, 1 category,
179 read chapters. The probe file was deleted afterwards and the listing is back to the 7 the job wrote.

The schedule was saved twice and put back: `1 day / 00:00 / 14` → `2 days / 21` → `0 / 0` (which read
`Switched off`, list intact) → back to `1 / 00:00 / 14`, confirmed against `settings` each time, with no
stray backup triggered and `lastRun` untouched.

**Still true, and not solved by any of this:** a source binding that was only ever written to
`localStorage` is in no backup, automatic or manual, because no backup can see the browser.

---

## Sections 31–34 — the four the TachiyomiSY survey left as "not now"

Report from 2026-08-14 filed 14 findings; ten became sections 15–24 and four were parked as **not now**
rather than rejected: crop borders, the custom brightness overlay, pinch/pan zoom, and saved searches
with a results feed. Picked up on 2026-08-16, in that order — the first two are an afternoon each, zoom
is the largest reader change since the tap maps, and saved searches is the only one that is not in the
reader at all.

All four were re-verified absent against `main` at `cdb1b43` before starting: `crop`, `brightness`,
`touch-action`, `pinch` and `saved-search`/`savedSearch` match nothing anywhere in `src`. Each is a
branch and PR off `main`, deleted after merge.

---

## 31. Dim the page below the screen's own brightness

**Status: shipped.**

*TachiyomiSY's `ReaderPreferences.customBrightness`/`customBrightnessValue`: an in-reader dimmer for
reading in the dark without touching the system backlight. Nothing in `ReaderPage.tsx` or `App.css`
mentioned brightness, and the panel had no slider of any kind — every numeric control in it was a
stepper.*

Branch: `feat/reader-brightness`

**Behaviour.** A slider in the reader panel's Image tab darkens the page and its surround, past what
the device's own brightness allows. Off by default, remembered between sessions, and it never gets in
the way of a page turn.

**Steps as built.**
1. `dim` state (percent) persisted to `localStorage['stremio4manga.reader.dim']` through a setter
   matching `setGrayscale`/`setInvert`, clamped on the way in *and* on the way out — a hand-edited
   value is the one input a slider cannot protect itself from.
2. Capped at **80%**, not 100. A fully black stage would hide the artwork and the reason it went black,
   leaving nothing on screen to aim at but the slider that caused it.
3. A fixed overlay over the reading surface, `pointer-events: none`, at `z-index: 3` — above the page
   and the tap map (2), below the footer (15) and the panel (30). So the **controls stay legible enough
   to turn it back down**, which is the difference between a dimmer and a fault.
4. Fixed rather than in flow, for the reason the tap map is sticky: a long strip is many screens tall,
   and an in-flow overlay would dim its own first screenful and scroll away.
5. `.reader-range` is the panel's first slider — its own control rather than a `.reader-choices` row,
   because a dimmer is a quantity and a row of presets is either coarse or twenty buttons wide. It
   carries a reset button that disables itself at 0, so "back to full brightness" is one press rather
   than a drag to the end.

**Verified** in the running app on a chapter of a title outside the library: at 40% the overlay measured
1247×1652 against a 1567px window — exactly the stage, stopping at the 320px panel — with
`pointer-events: none` and `z-index: 3`; the page visibly darkened while the panel and the page counter
did not; a tap zone still turned the page 1 → 2 straight through the overlay; the setting survived a
reload at 0.4 opacity; and the reset put it back to 0, removed the overlay entirely and disabled itself.

---

## 32. Trim the solid margin around a page

**Status: shipped.** Three things the plan could not have known, all found by measuring the result
rather than by reading it — a watermark defeats a naive scan, a shaped box cannot be sized like an
image, and a definite height plus a clamping cap stretches rather than shrinks.

*TachiyomiSY's `ReaderPreferences.cropBorders`/`cropBordersWebtoon` and `PagerConfig.imageCropBorders`:
auto-trim the flat margin around each page so the artwork fills the screen. Nothing in `src` mentioned
cropping, though `sampleBackdrop` (section 10) already read a page's decoded pixels — to pick a surround
colour, never to trim the page.*

Branch: `feat/reader-crop-borders`

**Behaviour.** A toggle in the Image tab. With it on, the flat border around each page is measured and
taken off, and the layout gives the artwork the room the margin was using. Every layout: single, double
and long strip. Off by default, and pages with no margin are left exactly as they are.

**Steps as built.**
1. `measureCrop` walks in from each edge of a 96px sample of the decoded page, keeping lines that match
   the colour that side's own outermost line started with — so a white margin at the top and a black one
   at the bottom are both found, rather than neither.
2. Each side is capped at 35%, and **every side hitting its cap means no crop at all**: that is the
   signature of a page that is entirely flat colour, where "cropping" would be inventing a frame.
3. Measured in `notePageSize`, the one place every decoded page already passes through — the page on
   screen, its partner in a pair, a strip page, and the prefetch's own `Image` objects — and only when
   the setting is on. Cached per url, cleared with the chapter.
4. Switching it on mid-chapter measures what is already in the document, because those images decoded
   before there was anything to hear their load event. The same gap, in the same shape, as section 10's
   first correction.
5. The row reports what it found — *Trimmed on 6 of the 21 pages seen so far* — because a toggle that
   does nothing visible on a chapter with no margins otherwise reads as broken rather than as honest.

### A watermark in the margin stopped the scan dead

The first scan stopped at the first line that was not solid, which is correct for a clean scan and wrong
for a real one: this source stamps `MANGAGREAT.COM` across the bottom margin, so the scan halted at the
watermark and left the whole band behind it in place — 50px of 262 came off. The fix is to take the
**furthest** border line rather than the first mismatch, allowing a gap of up to 4% of the page inside a
run. A watermark is a short interruption with more margin behind it; artwork is an interruption that
never ends. The same page then trimmed 278px and 131px, and the artwork reached the top of the screen.

### A shaped box cannot be sized the way an image is

The trim has to reclaim layout space, not just hide pixels — a `transform` on the image would leave its
old box, and the whitespace, in the layout. So the image is wrapped, and the wrapper carries the sizing,
shaped by `aspect-ratio` to the kept region while the image inside is blown up by the inverse of the
trim and pulled up and left. Two attempts failed first, both because a `div` has no intrinsic size to
bring to CSS's negotiation where a replaced element does:

- `width: min(100%, 1100px)`, copied from the image rule, is **circular** inside the `auto` grid column
  and resolved to zero: the wrapper measured 0×0.
- A definite `height` plus a clamping `max-width` does not shrink the box, it **breaks the ratio** —
  1139×1622 for a page that should have been 1139×1352, stretching the artwork.

What works is sizing by width in viewport maths and leaving the height to `aspect-ratio`:
`width: min(<room>, <available height> * aspect)`. The shared half of the rule — shape and clipping —
had to move out of `.paged-reader`, too: a strip page is not inside it, and the wrapper came out 1040×0.

**Verified** in the running app on a chapter of a title outside the library, whose pages carry wide grey
bands top and bottom: 6 of 21 pages were trimmed and the rest left alone. In **fit height** the wrapper
came out 1139×1201 and in **fit width** 1100×1159, both matching the measured aspect to within 0.02 and
both inside the screen, with the inner image at its own natural ratio — no stretching in either. In
**long strip** all six trimmed pages rendered with `overflow: hidden` and the artwork flush to the top.
Grayscale still reached a trimmed page (`filter: grayscale(1)` on the inner image) and went away again.
Turning the setting off restored the plain image, turning it back on and reloading re-measured from
scratch, and the toggle's own row tracked the count throughout.

---

## 33. Zoom into a page, and pan around it

**Status: shipped.** One defect found by testing rather than by reading — the keyboard walked straight
past the paged-only guard — plus three of SY's four knobs deliberately not built.

*TachiyomiSY's `imageScaleType`/`zoomStart`/`navigateToPan`/`landscapeZoom` and `PagerConfig.imageZoomType`.
Inkstream had two fit modes and nothing else: no pinch, no double tap, no `transform: scale`, no
`touch-action` — a page could only ever be seen at its fit size, so small dialogue could not be read at
all.*

Branch: `feat/reader-zoom`

**Behaviour.** In paged mode a page can be zoomed to 4× and dragged around: pinch, double tap, double
click, ctrl/⌘ and the wheel, or `+` `−` `0` from the keyboard. The zoom belongs to the page being looked
at — turning the page puts it back to fit — and a badge in the corner says how far in it is and puts it
back when pressed.

**Steps as built.**
1. `zoomAbout` keeps whatever is under the gesture where it is, in one piece of arithmetic shared by the
   pinch midpoint, the tap position and the keyboard's implicit centre. `clampPan` then holds the page
   over the stage: it can be dragged until its edge meets the stage's, and an axis where the page is
   smaller than the stage is pinned to the middle, so zooming out always lands centred.
2. Not persisted. A zoom is a moment, not a preference — it resets on a page turn, a chapter, a layout
   change and a fit change.
3. The transform is handed to CSS as custom properties on the stage rather than to an element, because
   the page is an image, a *trimmed* page (section 32) or a *pair* (section 6) depending on the layout,
   and one rule over the three beats threading a style through three render paths. It applies only
   while `.zoomed` is on the stage: a permanent `scale(1)` would put every page on its own raster layer
   for nothing.
4. Clamping measures the page through the same selector the CSS transforms, and divides the measured
   rect by the scale in force — a `getBoundingClientRect` is taken *after* the transform, and clamping
   against an already-zoomed box would let the page drift further on every gesture.
5. **A pan is not a tap.** A drag past 8px sets a flag that the tap regions check, so dragging a zoomed
   page to the left does not turn the page when the finger comes up. A genuine tap still turns it, and
   the zoom goes with it — the alternative, suppressing the regions while zoomed, leaves a zoomed reader
   with no way forward.
6. `touch-action: none` only while zoomed, so a pinch is ours rather than the browser's while a
   fit-width page still scrolls by touch at rest.
7. Keyboard `+ − 0` and a `+ − 0 zoom` entry in the panel's shortcut strip: a gesture nobody can see is
   a feature only a touchscreen has.

**Not built, on purpose.** SY's `zoomStart` corner (auto/left/right/centre) exists to place an automatic
zoom on a phone; with pinch and double tap the reader chooses the point, and a setting for it would
configure something already being said by hand. `landscapeZoom`'s auto-zoom-to-fill is the same idea by
another name. `navigateToPan` — a mode where the tap zones pan instead of turning pages — is what step 5
does without a mode: a drag pans, a tap turns.

### The keyboard walked past the paged-only guard

The pointer handlers all checked `zoomable` (paged only, because a long strip is already a scroller and a
transform would fight the scrolling it is built on). The keyboard did not, and nothing on screen moved —
only `.paged-reader` children transform — so it looked harmless: `+` in a strip raised the badge, set
`touch-action: none` on the scroller and **would have stopped a long strip scrolling by touch**. The
guard now sits in `applyZoom`, the one funnel every path goes through, rather than at each entrance.

**Verified** in the running app on a chapter of a title outside the library. Keyboard: 1 → 2 → 2.5 → 2 →
reset, with the transform, the badge and `touch-action` all following. Double click at a point zoomed
about that point (pan 224, 326 rather than 0, 0). A drag panned and stopped exactly on the clamp — 476px
against a computed limit of 476 for a 1100×2105 page at 2× on a 1247×1652 stage — and the page did not
turn when the drag ended over a tap zone, while a real tap on the same zone turned it 4 → 5 and dropped
the zoom to 1. Ctrl+wheel went 2 → 2.24 → 2 about the pointer. Pinch and double tap were driven through
synthetic `pointerType: 'touch'` events, because the automation browser has no touch input to give
(`hasTouch must be enabled`): pinching out took 1 → 2 → 3 exactly as the distance ratio says, pinching
back in landed at 1, and a double tap toggled 1 → 2 → 1. In long strip the whole thing stays inert —
`--page-zoom: 1`, no badge, `touch-action: auto` — and paged mode zooms again on return.

---

## 34. Saved searches, and a feed of what they find

**Status: shipped.** Two departures from the scout's sizing, both deliberate — the list is kept on the
server rather than in the browser, and the feed collapses. One unrelated defect was found while testing
it and fixed on the way past: Discover was rendering mojibake.

*TachiyomiSY's `FeedScreen`/`FeedScreenModel` over `SavedSearch`: pin a search, and a Feed screen shows
each pinned search's current top results as its own shelf. `SearchPage` had no way to keep a query at
all — `query`/`submittedQuery` were plain state, gone on navigation — and nothing in `src` matched
`saved-search`/`SavedSearch`.*

Branch: `feat/saved-searches`

**Behaviour.** A search that has been run can be saved from the pill it was typed into. Saved searches
appear at the top of Discover as one shelf each, showing what that search finds today, with a control to
run it again in the console and one to forget it. The section is absent until something is saved.

**Steps as built.**
1. `utils/savedSearches.ts` holds the documents, the type and the list arithmetic, following
   `utils/backup.ts` — needed by the page and worth keeping out of it.
2. **The list lives in global meta, not `localStorage`.** The scout sized this as a browser-held list;
   section 25 already established the better answer for exactly this shape of data — a search saved on
   the desktop is one you want on the phone — and section 30 found the corollary: `includeClientData`
   puts global meta in every backup, while a browser-only list is in no backup at all.
3. A malformed meta value is read as an empty list rather than as an error. This is a convenience
   feature, and a value someone edited by hand must not be able to stop Discover from loading.
4. Saving is offered **only once a search has been run** — `effectiveMode === 'SEARCH'` with a submitted
   query — because "popular on this source" is not a search and there would be nothing to re-run. The
   same button unsaves, filled when it is on.
5. Writes re-read from the server rather than trusting themselves: the list is shared, and another
   browser may have added to it since this one loaded.
6. **The feed asks sources one at a time**, through a module-level promise chain, whatever order the
   shelves mounted in. Section 8's sweep already established what parallel requests do to a source.
   Results are cached per search for the session, so leaving Discover and coming back asks nothing.
7. **It collapses, and collapsed it costs nothing.** The shelves unmount, so no source is asked while
   the section is closed — a feed is a screenful of requests, and it should only run while it is being
   looked at. The choice is remembered in `localStorage`, which is right for this one: it is about this
   screen on this device, not about what is saved.
8. A search whose source is no longer installed says so on its own shelf and offers only *forget* — the
   sourceName is stored with the id precisely so that shelf can name it without the source list.
9. Each shelf is **one row, scrolled sideways** rather than a wrapping grid: several shelves of eight
   would each spill an orphan onto a second row and push the next shelf off the screen.

### Discover was rendering mojibake, and had been for a while

Found while reading the results heading during this work: `Results for “dungeon”` was rendering as
`Results for â€œdungeonâ€`. Three of `SearchPage.tsx`'s strings held UTF-8 bytes that had been decoded
as **Windows-1252** and written back — the smart quotes in that heading and two ellipses in loading
copy. Worth recording as a method note as much as a fix: the corruption is invisible through a terminal
that decodes the same way it was broken, and it was only *provable* by reading the rendered DOM's
codepoints (`e2 20ac 153` where `201c` belonged). Repairing it needed a per-byte rebuild rather than one
string replacement, because cp1252 leaves `0x9d` undefined and whatever damaged the file fell back to
Latin-1 for that byte alone — so the closing quote was mangled differently from the opening one.

**Verified** against the running server. Searching MangaDex for `dungeon` and saving it raised the
section with one shelf; a second search (`slime`) made two, newest first, each naming its source. On a
fresh load the feed filled from the server-held list with 8 covers a shelf, one source call at a time.
Running a shelf's search put `dungeon` back in the console with the save control already showing as
saved. A search planted on a made-up source (written straight into the meta) rendered
`A Source Long Gone is not installed on this server.` with *forget* as its only action, and forgetting
it took it off the server. Collapsing unmounted both shelves, survived a reload as one heading line, and
expanding brought them back. The heading's quotes now come out as `201c`/`201d`. The test searches were
cleared from the server afterwards, and the library's own state — 179 read chapters, nothing downloaded
— was untouched throughout.

---

## 35. Open the series on AniList from inside the reader

**Status: shipped.**

*Asked for directly rather than found by a survey: a second link beside "Open on the source site", for
the series as AniList knows it. The panel header already had the outward trip to the source; AniList
was reachable only by leaving the reader, going back to the detail page and finding it there.*

Branch: `feat/reader-anilist-link`

**Behaviour.** An AniList mark in the reader panel header, immediately after the source link, opening
the series on AniList in a new tab.

**Steps as built.**
1. `READER_QUERY` gained `trackRecords { nodes { trackerId remoteUrl } }` on the manga. No second
   query and no bound-copy dance: the reader is *already* showing the source-bound copy, and the
   bound copy is the one that carries the record — the detail page's reconciliation puts it there.
2. **A fallback rather than an absence.** The neighbouring source link is absent when `realUrl` is
   null, because a source with no page for the chapter leaves nothing to point at. AniList has no
   such state — a search on the title always exists — so an untracked title links to
   `anilist.co/search/manga?search=…` instead of vanishing. The two cases say which they are in the
   label: *Open on AniList* / *Open this title on AniList* against *Find on AniList* / *Search for
   this title on AniList*.
3. The mark is filled, not stroked. Every other `.reader-panel-icon` is a 1.7-weight line drawing, but
   AniList's logo is a solid glyph and outlining it at 19px turns it to mush — so `.anilist-link` gets
   `fill: currentColor; stroke: none`, a shade smaller so the two read as the same weight side by
   side, and the brand blue on hover to match `--anilist-blue` on the detail page.

**Verified** in the running app, on already-read chapters only, so no reading progress moved. Tracked
(*Frieren*, Weeb Central) rendered three header actions in order — source link, `anilist-link` →
`https://anilist.co/manga/118586`, collapse — and untracked (*Ms. Mystic*, KaliScan) gave
`https://anilist.co/search/manga?search=Ms.%20Mystic` under the *Find on AniList* label.

**A deploy trap worth writing down.** Copying `dist/` over the served webUI directory is not enough to
see a UI change at `:4567`: the server holds `index.html`, so it keeps serving the previous bundle from
a directory that already has the new one. The restart is required — and the first one silently did not
happen, the port still held by a process started hours earlier while the stop script reported success.
Both were caught only by re-reading the served `index.html` for the hash the build had just produced.
Check the artifact the running system serves, not the one the build wrote.

---

## 36. Zoom you can see, and keys you can change

**Status: shipped.**

*Asked for directly: a way to zoom while reading, and keybinds that can be configured the way
MangaDex's reader configures them. Zoom already existed after section 33 — but only under a pinch, a
double click, ctrl and the wheel, or `+ − 0`, none of which is visible, and none of which worked in a
long strip at all. The keyboard was a pile of `event.key ===` checks with nothing behind it: sixteen
keys, none of them changeable, and two chapter hops that had no key in the first place.*

Branch: `feat/reader-zoom-and-keybinds`

**Behaviour.** A **Zoom** stepper in the reader panel — `−`, a readout, `+` — where the readout says
how far in you are and puts it back to fit when pressed, matching the badge on the stage. It works in
every layout, including long strip. And a third tab in the reader options, **Keys**, listing sixteen
actions with the chords bound to each: press `+` on a row and the next key you press is bound to it,
click a chord to take it away, and one button puts the lot back.

### Zoom

**A long strip zooms by width, not by transform.** Section 33 stopped at paged mode for a good
reason — a strip *is* the scroller, and a transform on it fights the scrolling it is built on. The
answer is not to transform it: what a reader wants from a strip is a wider or a narrower column, so
the same controls multiply `.strip-reader`'s width instead. Past 100% the stage's own `overflow:
auto` supplies the horizontal panning, so it needed no code at all, and `touch-action` stays `auto`
there — the exact trap section 33 found, where a paged-only guard was missing and a zoom in a strip
would have stopped it scrolling by finger.

The width rule multiplies the width the strip would otherwise have, `min(100%, 1040px)`, so at 1 it
computes exactly the unzoomed strip and the two ends of the range cannot drift apart.

**The strip's zoom is a preference; a paged zoom is still a moment.** Section 33's rule — a zoom
belongs to the page being looked at and goes with it — holds for a page, and not for a strip: a
strip's width belongs to the strip, not to whatever the marker happens to be over. So the strip's is
persisted (`stremio4manga.reader.strip-zoom`, 0.5×–3× in quarters) and the paged one still is not.
That also forced the reset effect apart: `page` in a strip is the marker walking down the chapter as
it scrolls, so resetting on it would have undone the width on the reader's own first scroll.

**Controls, because none of the three ways in was visible.** Pinch is a touchscreen's, ctrl and the
wheel is a mouse's, `+ −` is a keyboard's. A reader who wanted a closer look at a panel had nothing
on screen to press, and a reader who pinched by accident had only the badge.

### Keys

**Actions, not keys.** Every key the reader answers to is now a named action with a *list* of chords
bound to it, and the reader dispatches by looking the action up. The list is not a nicety: the
defaults already need it — a strip scrolls forward on Space *and* on PageDown, zooming in has always
answered to both `+` and `=` — and taking a key away should not have to mean putting another in its
place. The panel's shortcut strip reads the same map, so it cannot describe a rebound key by the key
it used to be.

**Shift is part of a chord only for keys with no character of their own.** On a printable key the
shift is already in the character the browser reports — `+` is Shift and `=` on most layouts — so
recording it would produce `Shift++`, a chord nobody could name. Non-printable keys keep it, which is
the only way `Shift+Space` (a screen backwards, which the strip has always done) can exist.

**One key, one action.** Binding a chord that is already taken moves it, and the dialog says which
row it came off. A chord left on two rows would fire whichever the dispatch reached first, which is a
coin toss dressed up as a setting.

**Escape is the reader's own** — it closes the dialog and abandons a recording, and cannot be bound.
While a row is listening, Escape belongs to the row: closing the whole dialog instead would be a
surprise. The recording listener runs in the **capture** phase, because the row being bound is a
button with focus and Space or Enter would otherwise activate it rather than be recorded.

**Three keys the reader never had.** Previous and next chapter (`,` and `.`) — reachable before only
by running off the end of a chapter, or by the panel — and the options dialog (`s`), reachable only
by the cog. The spread offset (`o`) is MangaDex's `offsetSpread` under our own name.

**The page keys stay spatial.** `pageLeft`/`pageRight` rather than forward/backward, because that is
what the reader already does: the panel's arrows and the tap zones both mirror with a right-to-left
direction, and renaming the actions semantically would have silently swapped the arrows for every
right-to-left reader. The keys tab says so under the group rather than in each row.

### A removal computed against the render, not against the previous state

Taking two chords off one row faster than a render lands between the clicks put the first one back:
both clicks computed their new list from the same closed-over `keybinds`, so the second overwrote the
first. Found by driving it from the automation browser, where two clicks land in one tick — but two
chips are close enough together that a person could do it. `removeChord` now takes the functional
form of the setter.

**Verified** in the running app against *Berserk of Gluttony* (`mangaId` 37, outside the library,
every chapter at zero — the reader writes progress for real, so the test subject and its reset are
part of the procedure). Paged: the stepper went fit → 2× → 2.5× → fit with `--page-zoom`, the badge
and the disabled ends all following, `+ − 0` did the same from the keyboard, and a page turn dropped
it back to fit with the transform gone. Long strip: 1040px → 1300 → 1560 → 1820 as the stepper went
up and 780 → 520 as it went down, `scrollWidth` growing past the stage each time so the panning was
the browser's, `touch-action` staying `auto` throughout, the level surviving five PageDowns and the
marker moving with them, and the value in `localStorage`. Keys: `d` bound to *Page on the right* then
re-bound to *Page on the left*, which took it off the first row and said so, and then turned the page
2 → 3 while `→` turned it 3 → 2 — the right-to-left mirroring intact. Escape cancelled a recording
with the dialog still open and nothing bound. Both chords stripped off *Screen down* left it reading
*No key*, with Space and PageDown then inert while ArrowDown still scrolled; the reset put both back
and disabled itself. `,` and `.` hopped chapters, `o` toggled the pairing offset, `h` and `s` toggled
the panel and the dialog.

**Not built.** MangaDex's `immersiveMode` has nothing to bind to here — the reader has no fullscreen
of its own, and adding one to hang a keybind off would be the tail wagging the dog. Chorded modifiers
are recordable and dispatch correctly, but nothing is bound to one by default: a reader who wants
Ctrl+something can say so, and shipping defaults that collide with the browser's own would not be a
favour.

## 37. A search result opens on the source you searched

**Status: shipped.**

*Asked for directly: picking a title in Discover should put it on the catalogue the search was run
against. It did not. Discover's results are rows of the source being searched, but a row that also
carries a source binding is read from wherever that binding points — so searching MangaDex for Sweet
Home and pressing it opened Weeb Central's chapters, which is the one catalogue the reader had not
just asked.*

Branch: `feat/discover-opens-on-searched-source`

**Behaviour.** A result card carries the catalogue it was found in (`/manga/:id?source=<sourceId>`),
and a title opened that way is read from that catalogue: any binding pointing elsewhere is dropped,
persisted like every other source change, and undoable from a notice for as long as the page is open.
Nothing happens to the great majority of results, which have no binding to move off in the first
place.

**The marker is a claim about the navigation, not about the title.** The detail page has no way of
knowing how it was reached, and "this row belongs to a source" is not the same fact as "the reader
just asked that source for it" — a title bound to Weeb Central is still a MangaDex row. So the source
travels in the url, and it is honoured only when the row really is that source's own copy: a marker
that outlived its navigation is ignored rather than acted on, and it is consumed on arrival so a
reload — or a reload after an undo — cannot put the title through the switch twice.

**A catalogue that lists a title need not carry chapters of it.** The first build unbound on sight and
was caught by the very case that motivated the section: MangaDex lists Sweet Home, has no chapters of
it, and the switch traded a binding that read for a page saying *No readable source*. So the
catalogue is asked before anything is unbound — the row's chapters, then one `fetchChapters` if the
database has none, which answers "No chapters found" as an error rather than an empty list — and a
source with nothing to offer keeps the binding it found and says so: *MangaDex has no chapters for
this title, so it is still read from Weeb Central.* Ignoring the click is a better answer than
honouring it into a dead end.

**Undoable, because this is the one source change nobody asked for.** Every other binding is chosen in
the picker; this one happens on a tap meant only to open a title, so it reports itself in the same
notice the progress carry-over uses, with the same undo and dismiss controls — and the undo writes the
old binding straight back rather than sending the reader through the picker to find a source the title
was already on.

**The picker names the catalogue that came up empty.** The section shipped, and the first report
back was that the app had ignored the source that was searched — on titles MangaDex lists but has no
chapters of (Komi, Frieren, Sweet Home: licensed, pulled). It had not: those titles have no binding to
move off, so the switch above never runs and the reader lands on the ordinary *No readable source*
picker. Which reads, on a page reached by searching MangaDex, exactly like the choice being thrown
away. The eyebrow now names it — *MangaDex has no chapters for this title* — for any entry whose own
catalogue is a real source; a library stub sitting on the pseudo source has no catalogue worth naming
and keeps the old wording.

**Not built.** No carry-over of read progress in either direction. The picker's carry-over exists
because choosing a new source is a deliberate migration of a title being read; this is a navigation,
and marking chapters read on a catalogue the reader only glanced at would be exactly the silent
rewrite section 14 refused to make.

---

## 38. The app speaks Portuguese

**Status: shipped.**

*Asked for directly: an option in Settings to put the app into European Portuguese. Every string on
screen was English, apart from four in the library that had been written in Portuguese by hand and
sat there in the middle of an English page.*

Branch: `main`

**Behaviour.** A **Language** card in Settings, beside Theme, with two controls — `EN` and `PT` —
and the whole interface changes on the press. The choice lives in `localStorage`
(`stremio4manga:language`), like the theme, and `<html lang>` follows it.

**Strings are keyed by their own English.** `t('Continue reading')` rather than
`t('library.continue')`: the source stays readable, a missing translation falls back to the English
it was written in instead of to a dotted key, and rewording a sentence does not mean renaming it in
two places. `src/utils/translations.ts` holds the European Portuguese for all of it — some 680
entries — grouped by the screen they belong to.

**`t` is a plain function, and the root re-keys on the language.** A hook would have meant threading
a context through every component that says anything, and `t` could then only be called during a
render — no `aria-label` built in a callback, no string assembled in an event handler. Instead the
module holds the current language, `t` reads it at call time, and `App` subscribes once with
`useLanguage` and keys the layout on it: switching remounts the tree and every `t` call is made
again. It costs a remount on a preference that changes about twice in a lifetime.

One rule follows from `t` reading at call time, and it is the whole trap of this design: **never call
it at module scope.** A constant array of labels evaluated on import freezes whatever language the app
started in. The existing constants — the sort orders, the tap layouts, the progress-bar labels, the
keybind names, the auto-scroll speeds — stay English at rest and are translated where they are
rendered, `t(option.label)`, which is also why those tables did not have to change at all.

**What does not translate.** Titles, chapter names, genres, scanlator names, source names — anything a
source published. Translating those would be inventing them. Dates were already locale-aware through
`toLocaleDateString(undefined)` and follow the browser rather than this setting, which is right: the
language of the app is not the same question as the format of a date.

**Plurals are chosen at the call site.** `t(count === 1 ? '{count} title' : '{count} titles', { count })`
— two entries rather than a plural engine. Portuguese and English agree on where the boundary falls,
and a rule for languages that disagree can be added when one of them is.

**The four Portuguese strings already in the library page** — the unread chips and the AniList sync
error — became English keys with the Portuguese as their translation, so the English side is no longer
half-translated either.

---

## 39. Only show what the source can actually serve

**Status: shipped.**

*Asked for directly, and correctly: "if it appears in popular inside MangaDex, why can I not click it
and have it read from MangaDex?" Because MangaDex lists series it has no chapters of. Half of its
first page of popular titles is like that — Solo Leveling, Slime, Frieren, One-Punch Man, Nagatoro,
My Dress-Up Darling — all takedown-removed, all still ranked, each one a card that leads nowhere.
Section 37 made the dead end explain itself; this stops the reader reaching it.*

Branch: `feat/verify-chapters-before-showing`

**Behaviour.** A result the source has no chapters of does not stay on screen. Cards appear with the
page, and the ones that come back empty leave as the answers arrive; the grid tops itself up from the
next page so a search that loses half its results is still a full page. The verdict is written down,
so the second visit to a catalogue is clean immediately and costs nothing.

**The source cannot be asked to filter this itself.** MangaDex does expose a *Has available chapters*
filter, and it does not work for this: filters reach only the search endpoint, so the popular and
latest lists ignore them entirely (verified — a Korean-only filter returns the same Japanese titles),
and on search the filter still returns One-Punch Man, because MangaDex counts availability across
every language while the installed source is English. Its *Show unavailable chapters* preference
changes nothing either: for these titles there is no chapter record at all, available or not. So the
question has to be asked per title, and the answer kept.

**Three states, and only one of them costs a request.** Chapters already in the database mean the
source carries the title. A `stremio4manga.no-chapters` marker on the manga's meta, less than a week
old, means it was asked and had none. Everything else is unknown and gets asked. Both facts ride
along in the browse query itself — `chapters { totalCount }` and `meta` on each result — so a page of
already-known titles is filtered with no extra call whatsoever.

**Shown first, taken away after.** Holding the grid until every title had answered would mean a
Discover that shows nothing for seconds on an API and the best part of a minute on a scraper. The
cards leaving on their own would read as a bug, so the count says what is happening: *checking 7
titles for chapters…*.

**One question at a time, to any source.** The queue that section 34 built for the saved-search
shelves now carries these too, and is shared: twenty questions to one source is exactly the shape
that made sources start refusing in section 8's sweep.

**The detail page writes the marker too.** A title opened from Discover whose own catalogue turns out
to be empty is the same answer the browse check would have got, so it is recorded there as well —
your clicks teach the grid.

**What it costs, measured.** A check is 110–500 ms on MangaDex and 400–1850 ms on Weeb Central. A
first visit to MangaDex's popular list settles in about six seconds; Weeb Central's 32 results took
55 seconds and kept all 32 — a scraper only lists what it hosts, so it never lies, and the whole
minute bought nothing. It also writes every checked title's chapter list into the database, which is
what makes those titles open instantly afterwards and what took the chapter table past 28,000 rows.
The obvious refinement — stop checking a source that has answered "yes" for everything it was ever
asked — is not built yet.

---

## 40. Several people, one server, nothing shared

Running this on a real server, reachable from outside the house, needed two things the app did not
have: a way to sign in, and a way for more than one person to use it without seeing each other.

**What was already server-side.** The AniList connection and the saved searches were never
browser-local — the token lives in the server's `tracker` preferences and the searches in global
meta, both of them for the reason section 33 gives. So nothing had to be migrated. The gap was
narrower and worse: the UI had no authentication of any kind, so the server had to run with
`authMode = NONE` on `0.0.0.0` for the app to work at all.

**Why not multi-user inside the server.** Suwayomi is single-tenant at the schema level. There is no
user table, `UserType.Admin(1)` is a constant, and `inLibrary`, the read state, the categories, the
track records and the meta are one global set. About a hundred call sites take a user id and discard
it. Making that real means migrating eight tables, changing the backup format, and forking away from
upstream for good.

**One instance per person instead** (`gateway/`). A small Node process — no dependencies, on purpose,
since it is the thing facing the internet — signs people in and reverse-proxies each of them to a
Suwayomi JVM started with its own `-Dsuwayomi.tachidesk.config.server.rootDir`. The separation is the
filesystem's, so nothing can leak between two people because there is nothing shared to leak through.
Instances bind to loopback and additionally want Basic Auth with a secret regenerated at every start,
so a wrong bind address is not by itself a breach.

**Why the app needed almost no change.** The gateway authenticates with a same-origin session cookie,
not a bearer token, and that is what makes it cheap: the browser attaches the cookie by itself to the
GraphQL posts, to the reader's REST progress update, and to every `<img>` that pulls a cover or a
page. A token in an `Authorization` header would have covered the first two and left every image
unauthenticated. The whole client-side story is `src/api/session.ts`: one `fetch` wrapper that turns a
401 into a trip back to the sign-in page, and an account card that renders nothing at all when there
is no gateway in front — so one build still serves a plain local server.

**`SameSite=Lax`, not `Strict`.** AniList finishes its OAuth flow with a top-level navigation from
`anilist.co` back to `/handle/oauth/result`. `Strict` withholds the cookie on exactly that hop, and
the callback would land signed out. This one is load-bearing.

**Accounts came from the command line only** — see section 41, which opened that up.

**The account card stopped being a card.** It was first built out of the AniList banner's own markup,
which made two indistinguishable panels sitting on top of each other — and they are not the same kind
of thing: one is who you are on this server, the other is an external service you connected. The fix
was not to restyle the panel but to remove it. The account is now the page's byline: an open strip
under the headline, closed by a hairline, with everything it owns below that line. The AniList banner
keeps the filled-card look precisely because it *is* one of those owned things, and it was not touched
at all. The one round thing on a page where every cover, avatar and tile is a notched rectangle is the
person using it.

**A password change had to actually mean something.** The first version persisted sessions across a
restart, which meant `users.js passwd` changed the next sign-in and left every already-signed-in
device working. Each account now carries a `passwordChangedAt` stamp and each session its issue time;
a session older than the stamp is refused. Verified: old session 401s after the restart, old password
is refused, new password works.

**Verified against two live accounts.** Same meta key written through two sessions, two different
values, neither visible to the other. Direct requests to `127.0.0.1:4611` and `:4612` answer 401.
Both sockets listen on `127.0.0.1` only. Cross-origin and header-less POSTs are refused; `..` in a
static path, encoded or not, falls through to the SPA index rather than reaching the config. Cold
sign-in, including starting the JVM, takes about seven seconds.

---

## 41. People can let themselves in

Section 40 provisioned accounts from the command line only, and said so in as many words. That was
the wrong shape for a server other people are meant to join: every new person meant the admin at a
terminal.

**The page.** `/gateway/register` — own username, own password, account created and signed in
without anyone touching a shell. Same document style as the sign-in page, same theme and language
keys, and the two link to each other.

**Why it is not simply open.** Here an account is not a row in a table. It is a JVM and a database,
so an open form on a public domain is a resource-exhaustion vector at one HTTP request per JVM.
`registration.mode` therefore has three settings — `off`, `invite`, `open` — and the default is
`invite`. `registration.maxUsers` is a hard ceiling enforced in every mode, `off` included, so even
a leaked code cannot fill the disk.

**Invite codes.** Sixteen characters in groups of four, easy to read out over the phone. Only the
SHA-256 is stored, so the line the CLI prints is the one place the code exists; lose it and mint
another. SHA-256 rather than scrypt is the right call here and not a shortcut — the code is 128 bits
this machine generated itself, so there is no dictionary to run at it.

**Read off disk, not from boot.** The first version held the invite list from startup, which meant
minting a code required a restart — dropping everybody's running instance so that one person could
join. The registration rules are now read from the config at the moment they are needed, so a new
code works immediately and `mode` and `maxUsers` can be changed the same way. Users stay in memory:
registration adds them at runtime and re-reading would fight that.

**Registrations are serialised.** Two at once would each read the same user list, compute the same
next free port, and put two people on one server — the exact failure this design exists to prevent.
A promise chain is enough in a single process.

**Where the limiter counts.** Not at the top of the handler, which was the first attempt: a name with
a space in it and a password one character short would burn two of the five attempts and lock out the
person registering rather than anyone attacking. It counts from the invite check onwards, where an
attempt is either a guess at a code or a new JVM.

**Both routes share `provision.js`.** The CLI and the page end in the same function, so an account is
the same thing whichever way it was made — a registration that allocated a port the CLI had already
used would be exactly the leak the separation is for.

**Verified.** Two accounts registered through the HTTP API on ports 4600 and 4601 with separate
databases and separate saved searches, neither visible to the other. Invite replay refused, expired
and spent codes indistinguishable from wrong ones, reserved usernames refused, taken usernames
refused, cross-origin registration refused, the `maxUsers` ceiling holds against a valid code, and
the guessing burst locks after five. All three modes switched with the gateway running and took
effect on the next request. Registration including a cold JVM start: about five seconds.

---

## 42. A login that behaves like a login

Two gaps were left by sections 40 and 41: standing a server up still needed a terminal, and a
forgotten password still needed the admin.

**Claiming the server.** A gateway with no accounts sends every page to `/gateway/setup`, where the
first account is made. What makes that safe is not a token to copy but *where the request comes
from*: while unclaimed, the offer is only accepted from loopback or a private network, which is where
somebody setting up their own server actually is. On a public domain that closes the window between
starting the gateway and claiming it. `setup.allowFrom: "any"` opens it deliberately.

**A caught mistake.** The funnel was first placed after the sign-in route, so `/gateway/login` still
answered with a form on an unclaimed server — the exact dead end the page exists to remove. It runs
before the route now.

**Mail, by hand.** `src/mail.js` is enough SMTP to hand one message to a relay: implicit TLS or
STARTTLS, `AUTH PLAIN`/`LOGIN`, RFC 2047 subject encoding, multipart/alternative, dot-stuffing. Same
reasoning as the rest of the gateway — this process holds a mailbox credential, and a dependency tree
is a poor place to put one. It refuses to send credentials over an unencrypted connection, so a
misconfigured port fails loudly rather than quietly leaking.

**The bug the test found.** Node reports a failed connect as an `AggregateError` whose `message` is
**empty**, with everything useful in `code` and the nested errors. Passed straight through, the
diagnostic for the single most common misconfiguration was a bare `FAILED:` and nothing else. Now the
host, the port and every underlying code go into the message. Found by pointing `mailtest` at a relay
that was not running — which is why that command exists.

**Not telling strangers who is here.** Asking for a reset link gives the same answer whether the
address is on an account or not, *and the same response time*: the reply is sent before the mail goes
out, because sending takes seconds and not sending takes none. Links last an hour, work once, and
only one is live per account. Completing a reset signs out every session that account had open —
somebody resetting a password often believes it was learned by another person.

**Where the limiter sits, again.** Reset requests are rationed harder than registrations, because the
cost lands on somebody else: every request puts a message in another person's inbox.

**Recovery from inside the app.** An account made before the relay existed would otherwise have needed
a terminal to become recoverable, so the account strip from section 40 gained an editable address
row — icon-only, in place, hidden entirely when the server has no relay.

**A half-filled relay is worse than an empty one.** Configuring a real Gmail account found this:
the check for "can this server send mail" looked only at the host and the from address, so a relay
with a username and no password yet counted as ready. It would have put "forgot your password?" on
the sign-in page and a recovery field in Settings, both failing at the last step. A relay that is
missing its password now counts as not configured, because the alternative is making a promise. The
two messages that report the state were wrong in the same way — both said "set smtp.host and
smtp.fromAddress" while those were plainly already set — and now name the field actually missing.

**Verified.** Against a throwaway SMTP server written for the purpose (TLS, `AUTH PLAIN`, message
captured to disk): subject encoded and decoded back to its accents intact, both MIME parts correct,
envelope right. Whole flow driven end to end — unknown address sends nothing, real address delivers a
link, dead link offers no form, `Referrer-Policy: no-referrer` on the reset page, reset succeeds, old
session 401s, token replay refused, old password refused, new password works. First-run: every page
funnels to setup, a claim from a forwarded public address is refused, a second claim is refused, and
the setup page redirects once claimed.

---

## 43. Back to a login, and nothing else

Sections 41 and 42 grew a registration page, invite codes, a first-run claim and password recovery by
e-mail. All of it is gone. The requirement changed to the narrowest possible one — username and
password, accounts created on the server, no way to make one from a browser — and the honest way to
meet "no possibility" is to remove the capability, not to add a setting that turns it off.

**What went.** `mail.js`, `messages.js`, `resets.js`, `invites.js`, `onboarding.js`; the register,
setup, forgot and reset routes; `/gateway/me/email`; the `smtp`, `registration`, `setup` and `invites`
config blocks; the recovery-address row in Settings. The sign-in page is unchanged apart from losing
its two links — same mark, same theme, same language handling.

**The page still funnels everything.** An unauthenticated navigation to any of the removed paths
redirects to sign-in, and an unauthenticated fetch gets a 401, so nothing is left half-present.

**Accounts moved to SQLite.** Prompted by the right question: is a JSON file the right place for user
data? The answer was yes for the settings and no for the state, so they were split — `gateway.db`
holds accounts and sessions, `gateway.config.json` keeps the deployment settings a person edits by
hand. `node:sqlite` is built into Node, so the gateway still has no dependencies.

**The defect that justified it, reproduced first.** Two processes writing the config with a hundred
milliseconds of overlap — the cost of one scrypt hash — lost an account outright, with both callers
told they had succeeded; on Windows the loser could also fail on the rename. Now the port and the data
directory are UNIQUE columns and account creation is one transaction, so the same race fails loudly
instead of silently. The migration moves accounts out of the config and keeps the old file beside it,
because two sources of truth for who may sign in is the defect the move was meant to remove.

**Verified.** The account migrated with its hash byte-identical, the config no longer lists users,
open sessions carried across, the removed routes redirect to sign-in, the sign-in page offers no way
to make an account, and a new account created from the CLI signs in with no restart — because the
gateway reads accounts from the database on each attempt rather than from a copy loaded at boot.

---

## 44. A preference belongs to the person, not to the browser

Every setting the app had lived in `localStorage`, which belongs to a *browser profile*. That was
always slightly wrong and became plainly wrong with the gateway: two people sharing a machine inherit
each other's reading setup, one person on a second device inherits nothing, and clearing cookies and
site data takes the lot. None of those is a bug anybody would report as one — they read as the app
being forgetful.

**The store of record is the account's global meta**, the same place saved searches and the AniList
sync stamp already live, so preferences travel in the backup with them. `src/utils/settings.ts` holds
the whole of it: `preference` and its four typed wrappers — `choice`, `flag`, `quantity`,
`structured` — each returning a subscribable handle the pages read through `useSyncExternalStore`.

**`localStorage` did not go away, it changed job.** It is a mirror, written on every change and read
once at import, so the first paint has the right theme, the right language and the right reader
layout instead of painting defaults and snapping. It is a cache and is treated as one: the server's
answer replaces it as soon as it arrives, and losing it costs one frame rather than a setting. That
is what lets `theme` and `i18n` — the two that must be right before React runs — go through the same
store as everything else.

**One meta key, not a row per setting.** One query, one mutation, and it cannot half-apply. The trade
is that two tabs changing different settings inside the same second let the later write win the pair,
which is acceptable for state a person changes a handful of times a year. Writes are debounced 800 ms
so dragging a slider is one write, and short enough to survive closing the tab after it.

**The old keys are migrated once.** `migrateLegacySettings` runs before the first query lands, so the
carried values sit in the "changed here" set and survive adoption; then it deletes the old keys, which
is what makes it run exactly once. Without it the move would have read to everybody as the app
forgetting their settings on upgrade — the one outcome that would have made the change look like a
regression.

**Reader zoom went the other way, deliberately.** It is not in the account settings but in the
manga's own meta, because a zoom that suits one long strip is wrong for the next title and right for
that one on every device. A title that was never zoomed has no key at all, so "never zoomed" and
"zoomed back to 100%" stay distinguishable.

**Settings and Sources were rebuilt on top of it.** Settings becomes a rail with tabbed panes —
AniList, Categories, Backup & restore, Appearance, Language — instead of one long column. Sources
gets a find-and-add flow with the keiyoushi catalogue paged in sixty rows at a time as the list is
scrolled, rather than several thousand rows rendered at once. Both are in the Portuguese locale.

**Verified.** `npm run lint` clean and `npm run build` green; the panes render, the theme switches in
both directions, and the layout holds at a 700px viewport.

---

## 45. A server does not run in a terminal somebody left open

`node src/main.js` is fine for a shell you are watching, and the wrong way to run a server: the
process dies with the window and nothing brings it back. The gateway gets what the single-user server
already had — `start-gateway.cmd` → `start-gateway.vbs` → `gateway-tray.ps1`, an icon beside the
clock and no console at all, not even a flash of a black one.

The menu opens the app, opens `state/gateway.log`, lists the accounts, restarts, and in **Sair** stops
the gateway *and every instance*. The tooltip counts the instances that are up, which on a shared
server is the question actually worth asking.

**Two things it does that are easy to get wrong by hand.** It stops the instances before the gateway,
because killing the parent first leaves 512 MB JVMs orphaned, each holding one person's database and
one port — and it finds them as children of the gateway process rather than by guessing at the 4600
range. And it takes over a port already held, but only when the holder is a `node` process running
`main.js`; anything else and it refuses and names what it found, rather than killing a stranger's
server for being on 8080.

**The failure it exists to prevent is a silent one.** Node reports a failed bind as an unhandled
`error` event, so a gateway started while another already holds the port dies with "it exited" and no
reason given — in exactly the situation somebody is most likely to hit, replacing a server they
started by hand.

**A filter over command lines matches the process running it.** `stop-gateway.cmd` selects the tray
by the script name in its command line, and the command line of the PowerShell evaluating that filter
contains the same string, so without an explicit `-ne $PID` the script kills itself — before printing
anything, which is why the symptom is "it did nothing". The same latent defect was found and fixed in
the workspace's `stop-server.cmd`. The gateway itself is found by its configured port instead, since
`node.exe src/main.js` is too common a command line to kill by resemblance.

**`ACCOUNTS.md` and `DEPLOY.md`** carry what the README should not: the whole lifetime of an account
— where the row and the scrypt hash land, why a removed account's port is not reused — and the whole
of a deployment: the config a public server needs, the two keys that must be *deleted* rather than
set because they derive or default correctly, the jar, TLS, and moving an existing library in.

**Verified.** Start took over a gateway already running in a console, health returned `ok`, stop freed
the port and removed the icon, and start again brought it back.

---

## Sections 46–51 — the 2026-08-17 scout, triaged

Seven findings, re-verified against `main` at `af09ee8` before any of them was decided. All seven were
still genuinely absent; every line number in the report had drifted, and **two of its cost estimates
were wrong in the cheap direction**, which changed how two of them are built here:

- The report proposed rebuilding a client-side fan-out for the cross-source search. This fork has
  `fetchSourceMangaBulk` (`SourceMutation.kt:302-328`), and `MangaDetailPage` already drives it with
  chunking, per-source progress and per-chunk error handling. Section 51 extracts that rather than
  writing it twice.
- It hedged that an AniList mean score "would need a `score` field added to the tracker query".
  `TrackRecordType.score` is already there (`TrackType.kt:88`).

One more of its premises was simply wrong: it described the library filter as free because
"`LIBRARY_QUERY`'s title/author fields" are already fetched. `LIBRARY_QUERY` fetches no author
(`LibraryPage.tsx:30-56`). It is still one field on a query the page already runs, but it is a field
that has to be added.

---

## 46. Find a title in the library without scrolling to it

**Status: shipped** (PR #63, merged as `ef59c2e`). Built on `feat/library-search` together with
section 47 — one departure, under the steps.

*Mihon's library search bar (a query language since v0.20.2), Kavita's Smart Filters, Komga's
title/author box. `LibraryPage.tsx` has no search state of any kind — the only `<input>` on the page
is the migrate panel's selection checkbox, and `.library-toolbar` (line 1581) holds the count, the
sort menu, the sync button and the selection toggle.*

Branch: `feat/library-search`

**Behaviour.** A field in the library toolbar narrows whatever the shelves are currently showing —
status shelves or category shelves — to titles whose name or author matches, on top of the sort order
and the shelf-visibility settings already in force. A row of genre chips sits with it: tapping one
narrows further, tapping it again releases it. An empty field and no chip is the library exactly as it
is today.

**The count already reports it.** `library-count` switches to `visible / total` the moment anything is
hidden (line 1582), so the filter needs no readout of its own — the same number that explains a hidden
shelf explains a filtered one.

**Mihon's operator syntax stays out.** `added>=2024-01-01 && unread>0` is a second language to learn,
in a box whose whole value is that a title can be typed into it without thinking. If a real need for
one of those queries turns up, it belongs in the sort menu as an order, not in the search box as
grammar.

**Steps.**
1. Add `author` and `genre` to `LIBRARY_QUERY` (`LibraryPage.tsx:30`). Both are on the fork's
   `MangaType` — `author: String?` (`MangaType.kt:37`) and `genre: List<String>` (`:39`) — so this is
   one more field on a query the page already runs, not a second request.
2. The filter is **plain `useState`, not a preference.** Sort order and shelf visibility live in the
   account settings because they describe how someone likes their library; a search term describes
   what they are doing this minute, and finding it still applied a week later on another device would
   read as titles having disappeared.
3. Filter where `visibleShelves` is reduced into `visibleCount` (`LibraryPage.tsx:1536`), so shelf
   visibility, the sort order and the filter compose instead of each re-deriving the list.
4. Match with `String.prototype.normalize('NFD')` and the combining marks stripped, case-folded — the
   library mixes Portuguese titles with romanised Japanese, and typing `sao` should find
   `Sword Art Online: Progressive`.
5. The chips are the union of `genre` across the library, sorted by how many titles carry each and
   scrolled sideways in one row — a library of a few hundred titles has more genres than fit, and a
   wrapping block of them would push the shelves off the screen.
6. `There are no titles on this shelf.` (line 1977) is the wrong sentence when a filter emptied it.
   Say which filter did it and offer to clear it, so nobody concludes their library broke.

### Folding the marks is not what finds `sao`

Step 4 gave one rule and one example, and the rule does not produce the example. Normalising to NFD
and dropping the combining marks is what makes `soma` find `Sōma` and `sao` find `São` — real, and
shipped — but `Sword Art Online: Progressive` has no marks in it and no substring `sao` anywhere.
The example the step names is an acronym, which no amount of folding turns into a substring.

So the field matches three ways rather than one: the folded title contains the term, the folded
author contains it, or the title's **initials start with** it. Prefix rather than contained, so
three letters have to open the title's own initials instead of surfacing somewhere inside a long
one. `titleKey` was deliberately not reused for the folding: it collapses punctuation to spaces,
which is right for deciding that two rows are one series and wrong for a substring test — it would
stop `Re:Zero` answering to `re:z`.

The chips are AND, not OR. "Tapping one narrows further" only reads as narrowing if every chosen
chip has to hold; a union would widen the shelves with each tap, which is the opposite of what the
word says.

---

## 47. The sweep names the chapters it found

**Status: shipped** (PR #63, merged as `ef59c2e`). The branch named below was never cut: this went
out on `feat/library-search` with section 46, because both change the same page. Two departures,
under the steps.

*Mihon's Updates screen lists every newly-available chapter individually — cover, title, chapter name,
time — each a direct tap-to-read link. `checkForNewChapters` (`LibraryPage.tsx:1141`) fetches each
bound source's full chapter list and reduces it to `grown = chapters.length - before` (`:1168`); the
chapters themselves are dropped, so `N new chapters across M titles` is all that is left of the pass.*

Branch: `feat/new-chapter-feed`

**Behaviour.** After a sweep, the chapters it found are listed — cover, title, chapter name, when the
source published it — newest first, each one opening straight into the reader. The list is what the
sweep just found, not a running history: it appears when a sweep finds something and is replaced by
the next sweep's answer.

**It is a diff, not a delta.** The current code subtracts two counts, which answers *how many* and
cannot answer *which*. `BOUND_UNREAD_QUERY` already holds every known chapter id per bound source
(`chapters { nodes { id … } }`, line 77), so the set difference against what the sweep fetched names
the new chapters exactly — and it stays correct where the count does not, when a source removes one
chapter and adds two.

**Steps.**
1. Widen the sweep's selection: `fetchChapters(input: { mangaId })` at `LibraryPage.tsx:156` currently
   takes `{ id chapterNumber isRead }`; add `name uploadDate scanlator`. Same request, more fields —
   the sweep already pays for this call one source at a time.
2. Build `before` as a `Set` of chapter ids from `unreadByBound` instead of a count, and keep the
   fetched chapters whose id is not in it. The count the notice prints comes off the same set, so the
   line and the list can never disagree.
3. Render below the toolbar, reusing the recent-reads card shape (`recent-shelf`, line 677) rather
   than a new one — this is the same object, a chapter with its cover and a way in.
4. `uploadDate` is the string-encoded epoch this schema uses everywhere; section 28 already has the
   formatter and the zero-date guard for a source that reports no date at all. Reuse it, do not
   re-derive it.
5. Keep it in memory only. It is the result of an action just taken, and a feed that survived a reload
   would have to answer what "new" means hours later — a question Mihon answers with a history table
   and this app has no reason to grow one for.
6. Sources that could not be reached keep the line they already have (`:1165`). A feed of what was
   found must not quietly imply the sources that failed found nothing.

### A chapter cannot be opened by name

Step 1 asked for `name uploadDate scanlator`, and those are the three the card *shows*. They are not
enough to open one: the reader's route is `/manga/:mangaId/chapter/:chapterIndex`, and that index is
`sourceOrder`, not the chapter number and not the id. A list of chapters that could be read but not
opened would have missed the whole point of the section, so `sourceOrder` went into the selection
with them. Still one request either way — `fetchChapters` was already returning the source's entire
chapter list, and this only widens what is asked of each row.

### The formatter was section 28's, but it was not shared

Step 4 said to reuse section 28's formatter rather than re-derive it, which was the right
instruction and could not be followed as written: `formatUploadDate` was a private function inside
`MangaDetailPage.tsx`, reachable from nowhere else. It moved to `utils/progress.ts`, beside
`chapterTotalLabel` and `formatChapterNumber` — the module both pages already import for exactly
this kind of chapter-shaped formatting. The detail page now imports what it used to own, unchanged
down to the zero-date guard.

---

## 48. Mark a chapter to come back to

**Status: shipped** (PR #62, merged as `fd6949c`). Two things the plan could not have known, both
under the steps: there was no selection menu to hang a bulk action off, and section 29's struck guard
stays struck for a reason that was never about this field.

*Mihon flags a chapter with a bookmark on its row plus bulk bookmark/unbookmark, and can filter the
list to bookmarked-only, independently of read state. Nothing in `src` writes `ChapterType.isBookmarked`
— every `bookmark` hit is the `--bookmark` colour token or the saved-search pin copy. Section 29
noticed the same absence from the other side and struck its "spare bookmarked chapters" guard because
the field was never written; bookmarking itself was never proposed.*

Branch: `feat/chapter-bookmarks`

**Behaviour.** An icon on a chapter row marks it, and marks it again to clear it — a cliffhanger, the
chapter an arc starts at, one worth rereading. It has nothing to do with read state: a bookmarked
chapter can be read, unread, downloaded or not. The chapter filter grows a fourth position that shows
only the marked ones.

**Verified against the fork, not upstream.** `UpdateChapterPatch.isBookmarked` exists and is written
(`ChapterMutation.kt:46`, `:104-105`), `ChapterType.isBookmarked` is on the read side
(`ChapterType.kt:36`), and `chapters(filter: { isBookmarked: { equalTo: true } })` is a real
`BooleanFilter` (`ChapterQuery.kt:165`). No server work.

**Steps.**
1. `UPDATE_CHAPTERS_BOOKMARK_MUTATION` alongside `UPDATE_CHAPTERS_READ_MUTATION`
   (`MangaDetailPage.tsx:145`):
   `updateChapters(input: { ids: $ids, patch: { isBookmarked: $isBookmarked } })`. Same shape as the
   read one, so the selection menu gets bulk mark and unmark for free.
2. `isBookmarked` onto the chapter selection at `MangaDetailPage.tsx:67` and onto `ChapterNode`
   (`:198`).
3. The control is icon-only, beside the download control on the row (`:793`), following the rest of
   the app's chapter row — outline when clear, filled when set, with the state in `aria-label` since
   nothing else carries it.
4. `cycleFilter` (`:467`) becomes four states: `all → unread → read → bookmarked → all`. One more stop
   on a control that is already a cycle, rather than a second control competing with it for the same
   corner.
5. Filter client-side over the chapters already loaded, like the other three positions do. The server
   filter exists, but the page holds the whole list already and a second query could only disagree
   with it.
6. `No bookmarked chapters.` needs its own empty line at `:825`, which currently only knows about read
   and unread.

### There was no selection menu to get anything for free

Step 1 justified the list-shaped `ids` argument by the bulk mark it would hand a selection menu. That
menu does not exist: nothing in `MangaDetailPage` selects chapters, and the only two callers of
`UPDATE_CHAPTERS_READ_MUTATION` are the source-switch carry and its undo, both of which build their
own id lists. The mutation was written to take a list anyway — it is the shape the server offers and
the shape the read one already has, so a bulk action, if one is ever proposed, has nothing to change
here — but it buys nothing today, and the row control passes a list of one.

Everything else the section asserted about the fork held exactly, line numbers included:
`UpdateChapterPatch.isBookmarked` at `ChapterMutation.kt:46` and written at `:104-105`,
`ChapterType.isBookmarked` at `ChapterType.kt:36`, the `BooleanFilter` at `ChapterQuery.kt:165`. The
patch is shared by `updateChapter` and `updateChapters` alike, so the plural form needed no widening.

### Section 29's guard stays struck, for the reason that was never about the field

Section 29 struck SY's "spare bookmarked chapters" exclusion twice over: the field was never written,
*and* an exclusion list only narrows an automatic pass, while every deletion under option C already
names its own scope. This section falsifies the first reason and leaves the second standing, which is
the one that decided it — so nothing in section 29 changes.

What did change is better than the guard would have been. The chapter list's cleanup button is scoped
to `displayedChapters`, so the fourth filter position scopes it too: filtering to the marked chapters
shows exactly which downloads a cleanup would take, in the list it would take them from. A guard would
have been an invisible rule; this is the same rule, visible, and the reader points it.

---

## 49. The library, counted

**Status: shipped** (PR #64, merged as `32d9b90`). The triage was right that `TrackType.kt:88`
already carries `score`; what it missed is that the two queries could not be imported, only copied —
both under the steps.

*Mihon's Stats screen: library size, completed titles, chapters read against total, downloads, tracked
titles. Nothing in `src/pages` has a rollup — the only `stats` hit is the `anilist-stats` block in the
AniList banner (`SettingsPage.tsx:1014`), and per-screen counts never add up to a library-wide one.*

Branch: `feat/library-stats`

**Behaviour.** A pane in Settings, beside AniList and Categories: how many titles the library holds,
how many are complete, how many chapters have been read out of how many exist, how many chapters are
on disk, how many titles AniList is tracking, and the mean score across the tracked ones.

**Every number is counted the way the shelves count.** The library's chapter counts deliberately
ignore `chapters.totalCount`, because a source carrying several scanlations of one chapter inflates it
badly — Frieren reports 316 rows for 152 chapters, and the comment at `LibraryPage.tsx:59` is the
record of it. A stats pane counting rows would contradict every badge on the library page and look
like one of the two was broken. So the read and total counts come from distinct chapter numbers per
bound source, exactly as the shelves derive theirs.

**Chapters on disk are the exception, and are rows on purpose.** A file is a file: two scanlations
downloaded are two things occupying space, so
`chapters(filter: { isDownloaded: { equalTo: true } }) { totalCount }` is the right count for that line
and the wrong one for every other line on the pane.

**Steps.**
1. A sixth tab in the rail beside `anilist | categories | backup | appearance | language`
   (`SettingsPage.tsx:443`, rendered at `:1030-1035`).
2. Reuse `LIBRARY_QUERY` and `BOUND_UNREAD_QUERY` verbatim through the same client. urql serves them
   from cache when the library page has been visited, and both are queries this app already trusts —
   a third, differently-shaped stats query would be a second definition of the same truth.
3. Title count and completed count come off `LIBRARY_QUERY`; completed reads
   `anilistRecord(item)?.status === COMPLETED_STATUS` (`LibraryPage.tsx:239`), the same test the sweep
   uses to skip a title.
4. Chapters read and total: count distinct `chapterNumber` per bound source from `BOUND_UNREAD_QUERY`,
   reconciled against AniList read-through exactly as `LibraryPage` does, so the pane and the shelf
   chips report the same numbers.
5. Chapters on disk: one `chapters(filter: { isDownloaded: { equalTo: true } }) { totalCount }`.
6. Tracked titles and the mean score come from `trackRecords`, with `score` added to the selection
   (`TrackRecordType.score: Double`, `TrackType.kt:88`). **The field is non-null**, and an unscored
   record reads as `0` — the mean has to exclude zeros, or a library where two titles are scored and
   forty are not reports a mean of nearly nothing. Say how many titles the mean is over.
7. Read *duration* stays rejected (line 27). Every number here is a count over data the app already
   holds; the duration one needs a schema change to produce a number nobody acts on.

### The two queries could not be imported, only copied

`LIBRARY_QUERY` and `BOUND_UNREAD_QUERY` are module-private constants inside `LibraryPage.tsx`, and
exporting them means editing a file two other sections were rewriting at the same time. So they were
copied, byte for byte, into a new `src/utils/libraryStats.ts` — and with them the rule the shelves
group rows by, because a series carried by an AniList import *and* by a row added from a source is
one title, and counting both would have inflated every number on the pane. The copy costs nothing at
runtime: urql keys its cache on the document text, so an identical string is the same request and
the pane opens on the library page's own response. It costs something in maintenance, which the file
says out loud: whichever copy is changed, the other has to change with it. The right home is one
module both screens import, and that file is it — the library page can be moved onto it once the
sections editing it have landed.

### `TrackType.kt:88` held, and the mean is taken where the count is

`val score: Double` sits at line 88 exactly as the triage claimed, non-null, so the zero-exclusion
rule stands as written: an unscored record reads as `0`, AniList has no zero on any of its scales,
and averaging those in would report a library with three scored titles out of forty as scoring almost
nothing. The field went onto `SettingsPage`'s existing `TRACKED_TITLES_QUERY` rather than onto a root
`trackRecords` query, because that query is already the one the connection pane counts tracked titles
with, deduplicated per `remoteId` — a mean taken over a different set from the count printed beside it
would be two answers to one question.

---

## 50. Ask a source the questions it knows how to answer

**Status: shipped** (PR #65, merged as `9a742a8`). Every line reference in the report held. Three
things found while building, all under the steps: the union had to be asked for sideways, the
recursion stops one level deep because that is as far as the server applies it, and an untouched
search stays the old request rather than becoming a new one with an empty variable.

*Suwayomi-WebUI's `SourceOptions.tsx` renders a per-source filter panel — checkbox, tri-state, select,
sort and text — built from `source.filters`. `SearchPage.tsx`'s `FETCH_SOURCE_MANGA_MUTATION` (line 29)
sends `source, type, page, query` and nothing else; `filters` appears nowhere in the file.*

Branch: `feat/source-filters`

**Behaviour.** A panel beside the search pill carries whatever the selected source reports it can
filter by — content rating, genre or tag toggles, publication status, sort order, sometimes a second
text field — and the search is sent with those choices applied, so the narrowing happens at the source
instead of being eyeballed in the results.

**This is the biggest of the six, and it is a rendering problem, not a plumbing one.** Both ends exist
on this fork: `SourceType.filters(): List<Filter>` (`SourceType.kt:78`) and
`FetchSourceMangaInput.filters: List<FilterChange>?` (`SourceMutation.kt:247`). What costs is that
`Filter` is a sealed union of eight shapes — `HeaderFilter`, `SeparatorFilter`, `SelectFilter`,
`TextFilter`, `CheckBoxFilter`, `TriStateFilter`, `SortFilter`, `GroupFilter` (`SourceType.kt:145-200`)
— and `GroupFilter` nests `Filter` inside itself, so the panel is recursive.

**Steps.**
1. Query the union with inline fragments off `sources.nodes.filters`, `__typename` included, taking
   `name` everywhere plus `values`/`default` on select and sort, `default` on text, checkbox and
   tri-state, and `filters` on group for the recursion.
2. `FilterChange` is **not** a polymorphic input — the sealed version is commented out in the source
   (`SourceType.kt:250-286`). What the schema takes is one flat input:
   `{ position, selectState, textState, checkBoxState, triState, sortState { index ascending }, groupChange }`
   (`:288-296`), with `triState` one of `IGNORE | INCLUDE | EXCLUDE`.
3. **`position` is the index in the source's own filter list, headers and separators included.**
   `updateFilterList` looks the filter up by `filterList[change.position]` (`SourceType.kt:305`), so
   the panel must send the index as returned, never the index of the controls it decided to render.
   Dropping headers from the rendering while renumbering the rest is how the wrong filter gets applied
   silently.
4. A group sends `groupChange` carrying the child's own `position` — the recursion goes down the input
   as well as the output.
5. Filters live next to the source, not next to the query: switching source discards them, because a
   position means something different in another source's list. The panel is closed by default and
   summarises how many filters are set while collapsed.
6. Defaults are sent as absent, not as their default value: a search with nothing touched must be the
   search that is sent today, byte for byte.
7. Sources reporting an empty list get no panel at all rather than an empty one.

### Every line reference held, and the union still had to be asked for sideways

The seven file:line references in this section were all still exact on the fork — `filters()` at
`SourceType.kt:78`, the eight shapes at `:145-200`, the commented-out sealed `FilterChange` at
`:250-286`, the flat one at `:288-296`, `filterList[change.position]` at `:305`, and
`FetchSourceMangaInput.filters` at `SourceMutation.kt:247`. Nothing drifted; the schema is exactly
what the section described.

What the section did not say is that `Filter` is a **union**, not an interface. graphql-kotlin maps a
marker interface — one with no members of its own, which `sealed interface Filter` is — to a union,
and a GraphQL interface with no fields would not be a legal type in the first place. So there is no
shared `name` to select at the top: every field, `name` included, comes out of its own inline
fragment. That in turn walks into the response-shape rule: `default` is an `Int` on a select, a
`String` on a text field, a `Boolean` on a checkbox and an object on a sort, and four fields of
different types cannot share one response key. Each one is aliased apart — `selectDefault`,
`textDefault`, `checkBoxDefault`, `triStateDefault`, `sortDefault` — or the query is rejected before
it is ever sent. The input type is named `FilterChangeInput`: graphql-kotlin appends the suffix to an
input object whose class name does not already carry it, which `UpdateExtensionPatchInput` in
`SourcesPage.tsx` was already relying on.

### The recursion is one level deep, because that is all the server can apply

Step 4 asks the group's change to carry the child's own `position`, and it does. But the panel is
recursive only in shape, not in depth: a GraphQL document cannot recurse into a union forever, and
there is nothing to recurse into. `updateFilterList`'s group branch (`SourceType.kt:334-361`) knows
how to set a checkbox, a tri-state, a text field or a select inside a group and nothing else — a
group nested in a group falls through its `when` and does nothing. So the query asks for one level of
children and the renderer draws one level of children, which is the whole of what could ever be sent.

### The untouched search is the old request, not a new one with an empty variable

Step 6 says a search with nothing touched must be the search that is sent today. Hanging an optional
`$filters` on the existing mutation would have satisfied the server — an absent variable arrives as
null and `updateFilterList` does nothing — but it would have changed the document every search on the
app makes, including the saved-search shelves. The filtered search is a second document instead, and
the plain one is still what goes out until something in the panel is actually moved. Moving a control
back to where it started deletes it from the set rather than sending it at its default, so the count
on the button and the contents of the request agree.

One thing was added that the section did not ask for: with filters set, a search runs on an **empty
query**. `getSearchManga("", filters)` is how a source is browsed by tag rather than by title, and
refusing to send it would have made half the panel unreachable. With no filters set an empty box is
still nothing to ask, exactly as before.

---

## 51. One title, every source that has it

**Status: shipped** (PR #65, merged as `9a742a8`). The branch named below was never cut: this went
out on `feat/source-filters` with section 50. The extraction the triage called for became a hook
rather than a lifted function, and it grew a second answer the bind flow never needed — both under
the steps.

*Suwayomi-WebUI's `SearchAll.tsx` fires one query across every installed source, one shelf per source,
each loading and failing independently. `SearchPage.tsx` is single-source: `sourceId` is one
`useState` (line 204), defaulted to a preferred source (`:253-258`), and nothing in the file loops over
the installed list.*

Branch: `feat/global-search`

**Behaviour.** Type a title once and see which installed sources actually carry it — a shelf per
source, each arriving when it arrives, each failing on its own without taking the others down. Useful
before deciding which source to bind a title to, and before a migration.

**The machinery is written; it is in the wrong file.** `MangaDetailPage.runSearch` (`:1038`) already
does exactly this for the bind flow: chunked `fetchSourceMangaBulk` calls, a `top | all` scope, a
run-id guard against a stale run overwriting a newer one, per-source progress, per-chunk transport
failure counted against every source in the chunk, and a session cache. The scout sized this as a
fresh client-side fan-out over `queueFeedFetch`; that would be a second implementation of a solved
problem, and the two would drift.

**Steps.**
1. Lift `runSearch` and its cache helpers (`readSourceSearchCache`/`writeSourceSearchCache`,
   `MangaDetailPage.tsx:290-330`) into `src/utils/sourceSearch.ts`, keeping the behaviour identical and
   leaving `MangaDetailPage` calling into it. The extraction lands first and changes nothing on its
   own — a refactor that can be verified against the bind flow before anything new depends on it.
2. `SearchPage` gets an all-sources mode beside the source pill, running the same call with the
   installed list as its batch: `fetchSourceMangaBulk(input: { sources, type: SEARCH, page: 1, query })`
   returning `results { source mangas { … } hasNextPage error }` (`SourceMutation.kt:302-328`).
3. One shelf per source that answered, scrolled sideways, in the shape section 34's feed already
   established — and for the same reason it chose that shape: several wrapping grids push each other
   off the screen.
4. A source's `error` is shown on that source's shelf and nowhere else. A global search where one dead
   source produces one page-level error is worse than no global search.
5. Sources with no hits collapse to a line rather than an empty shelf, and the summary says how many
   answered, how many had nothing and how many failed.
6. Results keep section 37's rule: a card opens on the source it was found in (`/manga/:id?source=…`),
   which is the whole point of having searched several.
7. It reuses the session cache from step 1, so leaving the page and coming back does not re-ask a
   dozen sources.

**Rejected from the 2026-08-17 scout, recorded so it is not re-proposed:** **ordered cross-series
reading lists** (Kavita's readinglists, Komga's readlists) — storing an ordered
`{ mangaId, chapterId }[]` in global meta is the easy half, but with a list active the reader would
have two authorities on what "next chapter" means, and every control that walks chapters — the turn
regions, the chapter select, the carry-over that marks skipped chapters read — would have to ask which
one is in force. That is a structural change to the reader for curated crossover orders, which have
never come up in use here.

### The extraction became a hook, and grew a second answer

`runSearch` is not a function that can be lifted on its own — it sets seven pieces of component state
while it runs, which is the point of it. `src/utils/sourceSearch.ts` exports `useSourceSearch`
instead: the state, the refs, the run-id guard and the cache live there, and `MangaDetailPage` keeps
only the loose-match toggle, which is a display choice about its own results rather than part of the
search. That first commit changed nothing on screen, as the step said it would.

The all-sources mode then needed something the bind flow never did: **who did not answer**. The bind
flow throws away a source that found nothing, because a shelf with nothing on it is not worth
drawing; a search across every catalogue has to be able to say "twelve answered, nine had nothing,
two could not be asked". So the hook now records an outcome per source — hits, empties and failures
alike — and derives the hit list from it. The cache went to version 3 to store the same, which costs
one re-search on an entry saved by an older build.

The cache key stopped being a manga id and became a slot name. The detail page passes the id, so its
entries keep exactly the key they had; Discover passes one fixed slot and overwrites it, because a
slot per query would let a session of searching fill the browser's storage, and the entry already
records the query it answered so a different one simply misses.

### A source that fell over has no shelf to put its error on

Step 4 asks for the error on that source's shelf. A source that failed has no results, so it has no
shelf — it collapses to a line of its own carrying its own message, next to the one line that names
every source that answered with nothing. Neither ever becomes a page-level error, which is what the
step was actually protecting against.

---

## Sections 52–56 — the 2026-08-24 scout, triaged

Seven findings, re-verified against `main` at `eaafc43` before any of them was decided. All seven were
still genuinely absent — nothing had shipped since the report was filed — and **the two the report
hedged were the two that mattered**. Both hedges were about this fork's server, which the scout
session could not see; both collapsed against the checkout sitting beside it:

- It called multi-tracker support "UI-only *if* this fork's server exposes other trackers". It does.
  `TrackerManager.kt:10-34` registers six over the same surface AniList already uses — MyAnimeList 1,
  AniList 2, Kitsu 3, Shikimori 4, Bangumi 5, MangaUpdates 7 — with Komga, Kavita and Suwayomi
  declared and commented out.
- It called KOReader sync "the expensive path" if the server-side feature had not been pulled in. It
  has been, in full: `koSyncStatus` plus `connectKoSyncAccount`, `logoutKoSyncAccount`,
  `pushKoSyncProgress` and `pullKoSyncProgress`, all wired in at `TachideskGraphQLSchema.kt:103,123`,
  with seven `koreaderSync*` fields already on `SettingsType`. Section 56 is a UI section only.

One premise was wrong in the other direction, and section 53 is built around the correction: it is
not `boundSourceId()` that names a card's source. That helper returns the **bound manga id**
(`bindings.ts:30-34`), not a source id. What a card actually shows is resolved at
`LibraryPage.tsx:2126` — the bound entry's source, falling back to the entry's own only when the
entry has chapters of its own — and a filter keyed on anything else would disagree with the badge
printed beside it.

Five of the seven were taken and are the sections below. The other two — named colour palettes, and
tracking beyond AniList — were neither taken nor rejected, so they get **no entry here on purpose**:
an undecided finding recorded in this file would read as settled. They stay live on scout issue #67,
which is left open for them.

---

## 52. A shelf that picks for you

*Suwayomi-WebUI PR #1129 adds a random library sort, sorted before filtering so the order holds while
the filters move. `SORT_ORDERS` (`LibraryPage.tsx:275-280`) has exactly the four orders section 22
built — title, date added, unread, last read — and no `random` appears anywhere in the file.*

Branch: `feat/library-random`

**Behaviour.** A fifth entry in the sort menu shuffles the shelves. It is the one order with no two
ends to read from, so the second press on it does not reverse anything — it shuffles again, which is
the only thing a reader pressing "Random" twice can mean. The order holds while the search field and
the genre chips are used, and it is drawn fresh on every visit: a shuffle remembered across sessions
has stopped being a shuffle.

1. `SortOrder` (`:268`) gains `'random'`, and `SORT_ORDERS` (`:275-280`) a fifth entry whose two
   `ends` read the same — there is no ascending shuffle.
2. A seed in component state beside `sort` (`:882`), drawn on mount. `chooseSort` (`:1678-1684`)
   special-cases it: picking `random` when `random` is already in force re-seeds instead of flipping
   `direction`.
3. `sortLibrary` (`:1584-1590`) orders on a deterministic hash of `(seed, item.id)` when the order is
   `random`, with the direction multiplier not applied. Deterministic is the whole point: the sort
   runs once, before the shelves are cut out of it (`:1595-1617`), and every keystroke in the search
   field re-renders the page — a `Math.random()` comparator would reshuffle the grid under the
   reader's hands and is not a valid comparator besides.
4. Keep the title tie-break (`:1588`) for hash collisions, so the order stays total.
5. `SORT` (`:286-291`) persists the order but never the seed; reviving `random` from storage draws a
   new one. `sortSummary` (`:1686`) reads the shuffled end, and the option's hint says that pressing
   it again shuffles rather than reverses — the other four orders have trained the opposite.

---

## 53. Only the sources you are actually reading

*Suwayomi-WebUI PR #1131 (closing its issue #1057) adds a three-state source filter to the library.
Section 26 put the source name and icon on every card as a badge, but the badge is read-only:
`LibraryPage.tsx` has no source-based filter, and section 46's search matches title, author and
genre only.*

Branch: `feat/library-source-filter`

**Behaviour.** A row of source chips sits with the genre chips. Tapping one narrows the shelves to
the titles read from that source, tapping it again releases it. Choosing several **widens** rather
than narrows — the opposite of the genre chips, and deliberately so: a title carries many genres, so
requiring all of them is a narrowing that means something, but a title is read from exactly one
source, so requiring two sources would empty every shelf on the page.

1. No query work. `LIBRARY_QUERY` (`:29-56`) already fetches `source { id name iconUrl }` for the
   badge, and `BOUND_UNREAD_QUERY` (`:72-84`) fetches the same for the bound entry.
2. Lift the badge's own resolution out of the card. `:2126` computes
   `bound?.source ?? (item.chapters.totalCount > 0 ? item.source : null)`; make that a `cardSource`
   helper next to `boundSourceId` (`:403-405`) and have the badge and the filter both call it. A chip
   that disagreed with the badge under it would read as a bug in the badge.
3. Build the chip list the way `genreCounts` (`:1625-1631`) builds its own: count over the sorted
   `manga` list, commonest first, ties on name. A title whose source resolves to `null` is counted
   under no chip and matched by no chip — it is not silently filed under the entry's own catalogue.
4. State beside `genreFilters` (`:889`). Source ids are **strings** on this schema, not ints
   (`source { id }` is `String`; see `MangaDetailPage.tsx:212`), so the list is `string[]` — the one
   scalar quirk in this section.
5. `matchesFilter` (`:1637-1642`) gains a clause that is an `includes` over the chosen ids, not an
   `every`, per the behaviour above; `filtering` (`:1634`) gains the same emptiness test so
   `library-count` switches to `visible / total` (section 46) without a readout of its own.
6. `clearFilter` (`:1653-1656`) clears the source chips too — one control puts the library back.
7. The chips carry the source icon alongside the name, matching the badge; `aria-pressed` carries the
   chosen state, as the genre chips already do.

---

## 54. A note to yourself on a title

*Suwayomi-WebUI PR #1144 attaches a free-text note to a manga, stored as metadata, shown above the
description. `MangaDetailPage.tsx` has no notes field — the one `note` in the file is a code comment
about the no-chapters marker (`:1163`).*

Branch: `feat/manga-notes`

**Behaviour.** The detail page gets a line the reader can write on — *stopped at 40, the art changes*,
*this is the one with the bad translation*, a spoiler warning to self — kept separate from anything
AniList reports and stored on the server, so it is the same note on the phone as on the desktop.
Nothing shows when there is no note but the control to start one.

1. `src/utils/bindings.ts` gains `MANGA_NOTE_META_KEY = 'stremio4manga.note'`, a set/delete pair
   modelled exactly on `SET_SOURCE_BINDING_MUTATION` (`:11-17`) and `DELETE_SOURCE_BINDING_MUTATION`
   (`:20-27`), and a `noteFromMeta` beside `sourceBindingFromMeta` (`:30-34`):

   ```graphql
   mutation SetMangaNote($mangaId: Int!, $value: String!) {
     setMangaMeta(input: { meta: { mangaId: $mangaId, key: "stremio4manga.note", value: $value } }) {
       meta { key value mangaId }
     }
   }
   ```

   `$mangaId` is `Int!` and `$value` `String!` — the same shape the binding and the chapter view
   (`:62-68`) already use, so this is a third key on infrastructure that exists.
2. Clearing a note **deletes** the meta rather than writing `""`, following the binding's own rule
   (`bindings.ts:19-20`): there is no empty-note state worth distinguishing from an absent one, and
   inventing one leaves a key behind on every title the reader ever thought about annotating.
3. No new query. The detail query already selects `meta { key value }` (`MangaDetailPage.tsx:53`), so
   the note arrives with the page.
4. The note belongs to **the manga the page is showing** — the `id` from `useParams`, which is the
   library entry when the page was opened from the library. This is deliberately *not* the rule
   tracking follows (a `TrackRecord` lives on the bound source manga): a note is the reader's, not the
   catalogue's, and rebinding a title to a different source must not orphan it.
5. Render above `<p className="summary">` (`:1518`). With no note: an icon-only button, per the house
   style, with the label on `aria-label`/`title`. With one: the text, and the same button as a pencil.
   Editing is a `<textarea>` with save and cancel.
6. Save optimistically — local state first, then the mutation — the way the chapter-view preference
   does (`:265`), and save on blur as well as on the explicit control. One round trip is cheap; a note
   lost to a mistimed navigation is not.

---

## 55. A reader with nothing else on the screen

*Suwayomi-WebUI commit `093ef6f` adds a reader setting that requests real browser fullscreen on
opening a chapter and releases it on leaving. Nothing in `src` mentions `fullscreen` at all. Section
36 declined to build a keybind for "immersive mode" on the grounds that "the reader has no fullscreen
of its own" — that was a decision about not inventing a feature to hang a shortcut off, not a
rejection of this.*

Branch: `feat/reader-fullscreen`

**Behaviour.** A toggle in the reader's Screen options, beside "Keep the screen awake". With it on,
opening a chapter takes the browser itself out of the way — address bar, tab strip and all — and
leaving the reader gives it back. Off is what happens today.

1. `const FULLSCREEN = flag('reader.fullscreen', false)` beside `WAKE_LOCK` (`:605`), and a
   `fullscreenSupported` const beside `wakeLockSupported` (`:609`) reading `document.fullscreenEnabled`.
   Same rule, stated in the wake lock's own comment (`:608`): a toggle that can never take effect is
   worse than no toggle, so an unsupported browser gets no row.
2. **Fullscreen needs a user gesture; the wake lock does not.** This is the one place the wake-lock
   pattern does not transfer. Requesting on `prepared` alone (the wake lock's trigger, `:994`) works
   for a chapter opened by a tap and silently fails for one reached by a deep link on a cold load —
   which is the case the toggle is most wanted for. So arm on `prepared` and request on the first tap
   or keypress inside the reader while the flag is on and the document is not already fullscreen.
3. `document.documentElement.requestFullscreen()` inside a `try`/`catch` that swallows the rejection,
   for the reason the wake lock gives at `:1002` — iOS Safari refuses outright, and a refusal is not a
   reader error. Release on leaving the reader, mirroring the wake lock's cleanup (`:1013-1018`).
4. **The reader can leave fullscreen without touching the toggle** — Esc, or the browser's own
   control. Listen for `fullscreenchange` and do not fight it: leave the flag on so the next chapter
   arms again, but never re-request in place, or Esc stops working inside the app.
5. The row goes in the existing `reader-options-group` labelled Screen (`:2484-2496`), same
   `reader-check` markup and `aria-pressed`, gated on `fullscreenSupported`.
6. With a fullscreen of its own, the reader now has something for section 36's keybind table to bind:
   add it as an action beside `toggleControls` (`:137`) rather than leaving it mouse-only.

---

## 56. The e-ink device reads the same page

*Suwayomi-Server issue #1813 added KOReader Sync protocol support upstream; Kavita and komga carry the
same capability independently. Nothing in `src` mentions KOReader or a sync server.*

Branch: `feat/koreader-sync`

**Behaviour.** A card in Settings signs the server in to a KOReader Sync service — the public
`sync.koreader.rocks` or a self-hosted one — and from then on the page a chapter is left on travels
both ways: progress made in Inkstream shows up on a KOReader e-ink device, and progress made there is
waiting when the chapter is opened here. Independent of the AniList link, which tracks chapters, not
pages.

**This is a UI section.** The report hedged that the server side might need pulling in first; it is
already here, on `personal`, and every operation below was read off the fork's own source and
confirmed wired into the schema at `TachideskGraphQLSchema.kt:103,123`. All five are `@RequireAuth`:

```graphql
query   { koSyncStatus { isLoggedIn serverAddress username } }
mutation { connectKoSyncAccount(input: { serverAddress: $address, username: $user, password: $pass }) {
             message status { isLoggedIn serverAddress username } } }
mutation { logoutKoSyncAccount(input: {}) { status { isLoggedIn serverAddress username } } }
mutation { pushKoSyncProgress(input: { chapterId: $chapterId }) { success chapter { id lastPageRead } } }
mutation { pullKoSyncProgress(input: { chapterId: $chapterId }) {
             chapter { id lastPageRead } syncConflict { deviceName remotePage } } }
```

**The scalar quirk that will bite.** `chapterId` is the chapter's **database id**, not the
`sourceOrder` the reader's URL carries. `updateReaderProgress` (`ReaderPage.tsx:506-514`) works in
source order against the REST endpoint, and passing that same number here would silently sync the
wrong chapter. The right id is already in hand — `fetchChapterPages` returns `chapter { id … }`
(`:68`).

1. The Settings card, modelled on the AniList banner and its `SETTINGS_QUERY`/`LOGOUT_TRACKER_MUTATION`
   pair (`SettingsPage.tsx:80-101`): address, username and password into `connectKoSyncAccount`;
   once `koSyncStatus.isLoggedIn`, the address and username with a disconnect that calls
   `logoutKoSyncAccount`. The password is never read back — `koSyncStatus` deliberately returns no
   key. Default the address field to `https://sync.koreader.rocks/`, which is the server's own default
   (`ServerConfig.kt:715`).
2. `koSyncStatus` gates everything else. Signed out, the reader does no sync work at all and issues no
   mutation; the card is the only surface that ever touches the account.
3. **Push.** After `updateReaderProgress` (`:506-514`) writes a page, fire `pushKoSyncProgress` with
   the chapter's database id, debounced on the settled page rather than fired per scroll tick — the
   strip would otherwise push once per frame.
4. **Pull.** On chapter open, after `fetchChapterPages` returns and *before* the reader restores
   `lastPageRead` (`:960`), call `pullKoSyncProgress`. The mutation writes the row itself when it
   decides to (`KoreaderSyncMutation.kt`, on `syncResult.shouldUpdate`), so the reader takes the page
   off the payload it gets back instead of deciding for itself which side is newer.
5. **Conflict.** `syncConflict { deviceName remotePage }` comes back non-null only when the server's
   strategy is `PROMPT` (`KoreaderSyncConflictStrategy`). Show it as a dismissable line over the page —
   the device name and the page, with a jump to it — never a modal. A dialog on chapter open blocks
   the one thing the reader came for.
6. Strategy is server state, not UI state: `koreaderSyncStrategyForward` and
   `koreaderSyncStrategyBackward` are on `SettingsType` and set through the settings mutation the app
   already uses. Two choice rows in the same card. Leave `koreaderSyncPercentageTolerance` and
   `koreaderSyncChecksumMethod` alone — `BINARY` is the right default (`ServerConfig.kt:786`) — and
   ignore `koreaderSyncStrategy` entirely: it is deprecated on the schema, kept for migration.
7. `koreaderSyncDeviceId` is not offered as a field. A device id the reader can retype is a device id
   that can collide with another client's, and the sync service uses it to decide whose progress it is
   looking at.

---

## Working notes

- Lint with `npm run lint` (oxlint) and typecheck via `npm run build` before each PR.
- **The automation browser cannot fake a response.** `page.route` handlers are never invoked — the
  request is intercepted and then hangs, which reads as a slow image or a page that never loads — and
  `page.addInitScript` is rejected by the sandbox outright. A branch whose input the server cannot
  produce (a zero `uploadDate`, a reachable avatar host) is therefore exercised **at the call site**,
  with the edit reverted straight afterwards; sections 25 and 28 were both verified that way.
- Comments explain *why*, matching the density already in these files — the existing comments about
  duplicate scanlations and AniList reconciliation are the house style.
- Nothing Claude-attributed in commit messages or PR bodies.
