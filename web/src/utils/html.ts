/**
 * Converts untrusted HTML received from upstream services into display text.
 *
 * The result is rendered by React as a text node, never as HTML. Parsing in a
 * detached document also decodes common HTML entities without permitting any
 * scripts, event handlers, or embedded content to reach the page.
 */
export function htmlToPlainText(html: string): string {
  const withLineBreaks = html.replace(/<\/?(?:br|p|div|li|h[1-6])\b[^>]*>/gi, '\n')
  const document = new DOMParser().parseFromString(withLineBreaks, 'text/html')

  return document.body.textContent?.replace(/\s*\n\s*/g, '\n').trim() ?? ''
}
