import { choice } from './settings'

export type ThemePreference = 'system' | 'light' | 'dark' | 'tokyo-night' | 'sepia'

/** A palette is what `index.css` keys off; `system` is not one, it resolves to one. */
export type ThemePalette = Exclude<ThemePreference, 'system'>

// Every palette declares whether it is a light one or a dark one, because `data-theme` and
// `color-scheme` stopped being the same answer the moment a third palette existed. `data-theme`
// takes the palette's own name — that is what the token blocks are keyed on — and `color-scheme`
// takes the flavour, which is what makes scrollbars, form controls and the browser's own chrome
// match. A dark palette that forgets its flavour gets white scrollbars.
export const THEME_FLAVOURS: Record<ThemePalette, 'light' | 'dark'> = {
  light: 'light',
  dark: 'dark',
  'tokyo-night': 'dark',
  sepia: 'light',
}

export const THEME_PALETTES = Object.keys(THEME_FLAVOURS) as ThemePalette[]

// Kept with the rest of the account's settings rather than in this browser ([[settings.ts]]): the
// theme is one of the two that has to be right in the very first frame, which is what the mirror
// there is for. The options array is also the validator — `choice()` returns the fallback for
// anything not in it — so a palette added to the type but not to `THEME_FLAVOURS` reads as
// "system" forever and nothing says so.
const THEME = choice<ThemePreference>('theme', 'system', ['system', ...THEME_PALETTES])
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)')

export function getThemePreference(): ThemePreference {
  return THEME.get()
}

export function applyTheme(preference: ThemePreference): void {
  const palette: ThemePalette =
    preference === 'system' ? (darkModeQuery.matches ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = palette
  document.documentElement.dataset.themePreference = preference
  document.documentElement.style.colorScheme = THEME_FLAVOURS[palette]
}

export function setThemePreference(preference: ThemePreference): void {
  THEME.set(preference)
  applyTheme(preference)
}

export function initializeTheme(): void {
  applyTheme(getThemePreference())
  // Three things can change the answer: the system flipping to dark while the setting is "system",
  // the reader choosing a theme, and the server's copy arriving and disagreeing with the mirror this
  // page painted with — which is the one that only exists now the setting lives on the account.
  THEME.subscribe(() => applyTheme(getThemePreference()))
  darkModeQuery.addEventListener('change', () => {
    const preference = getThemePreference()
    if (preference === 'system') applyTheme(preference)
  })
}
