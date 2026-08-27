/**
 * The language the app speaks, and the one function that speaks it.
 *
 * Strings are keyed by their own English text rather than by an invented identifier: the source
 * stays readable, a missing translation falls back to the English it was written in instead of to a
 * dotted key, and nothing has to be renamed on both sides when a sentence is reworded.
 *
 * `t` is a plain function, not a hook, so it can be used anywhere a string is built — inside
 * callbacks, in `aria-label`s, in a template literal. What makes a language change repaint the app
 * is `useLanguage` at the root: the layout is keyed on it, so switching remounts the tree and every
 * `t` call is made again. It costs a remount on a preference that changes once in a blue moon, and
 * it buys not having to thread a context through nine hundred call sites.
 *
 * One rule follows from `t` being read at call time: **never call it at module scope.** A constant
 * array of labels evaluated on import freezes the language the app happened to start in; those
 * belong in a function, or the translation belongs at the point the label is rendered.
 */
import { PT } from './translations'
import { choice } from './settings'

export type Language = 'en' | 'pt'

// On the account rather than in this browser ([[settings.ts]]). Along with the theme it is one of the
// two settings that has to be right in the first frame, so it is read through the mirror there.
const LANGUAGE = choice<Language>('language', 'en', ['en', 'pt'])
const LANGUAGE_TAGS: Record<Language, string> = { en: 'en', pt: 'pt-PT' }

export function getLanguage(): Language {
  return LANGUAGE.get()
}

export function setLanguage(language: Language): void {
  LANGUAGE.set(language)
  document.documentElement.lang = LANGUAGE_TAGS[language]
}

export function useLanguage(): Language {
  return LANGUAGE.use()[0]
}

/**
 * The English text, translated when the app is in another language, with `{name}` placeholders
 * filled from `vars`. An untranslated string comes back exactly as it was written.
 */
export function t(text: string, vars?: Record<string, string | number>): string {
  const translated = LANGUAGE.get() === 'pt' ? PT[text] ?? text : text
  if (!vars) return translated
  return translated.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name]
    return value === undefined ? whole : String(value)
  })
}

export function initializeLanguage(): void {
  const tag = () => { document.documentElement.lang = LANGUAGE_TAGS[getLanguage()] }
  tag()
  // The server's copy can disagree with the mirror this page painted with. `useLanguage` re-renders
  // the tree on its own; this is the document attribute, which no component owns.
  LANGUAGE.subscribe(tag)
}
