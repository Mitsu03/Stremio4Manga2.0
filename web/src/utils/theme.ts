import { choice } from './settings'

export type ThemePreference = 'system' | 'light' | 'dark'

// Kept with the rest of the account's settings rather than in this browser ([[settings.ts]]): the
// theme is one of the two that has to be right in the very first frame, which is what the mirror
// there is for.
const THEME = choice<ThemePreference>('theme', 'system', ['system', 'light', 'dark'])
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)')

export function getThemePreference(): ThemePreference {
  return THEME.get()
}

export function applyTheme(preference: ThemePreference): void {
  const resolved = preference === 'system' ? (darkModeQuery.matches ? 'dark' : 'light') : preference
  document.documentElement.dataset.theme = resolved
  document.documentElement.dataset.themePreference = preference
  document.documentElement.style.colorScheme = resolved
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
