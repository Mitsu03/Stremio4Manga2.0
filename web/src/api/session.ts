/**
 * Talking to the gateway, when there is one.
 *
 * The app is deployed two ways: straight against a local server with no authentication, and behind
 * the gateway (`gateway/`), which signs each person in and routes them to their own Suwayomi
 * instance. Everything here degrades to nothing in the first case — `gatewayAccount()` simply
 * resolves to null, and the 401 handling never fires — so one build serves both.
 *
 * There is no token anywhere in this file, and that is the point. The gateway authenticates with a
 * same-origin session cookie, which the browser attaches on its own to the GraphQL posts, to the
 * reader's progress updates, and to every `<img>` that loads a cover or a page. A bearer token would
 * have covered the first two and left the images unauthenticated.
 */

export interface GatewayAccount {
  username: string
  displayName: string
}

/**
 * Send the browser to sign in again, remembering where it was.
 *
 * Latched, because a single expired session will usually produce a burst of 401s — every query on
 * the page at once — and each one must not queue up its own navigation.
 */
let redirecting = false

export function goToLogin(): void {
  if (redirecting) return
  redirecting = true
  const here = window.location.pathname + window.location.search
  window.location.assign(`/gateway/login?redirect=${encodeURIComponent(here)}`)
}

/**
 * `fetch` for anything that talks to the server.
 *
 * A 401 means the session ended — the cookie expired, or someone signed out on another device — and
 * the only useful response is to go and sign in again. Without this the app would sit there showing
 * an empty library and a stack of failed requests.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { credentials: 'same-origin', ...init })
  if (response.status === 401) goToLogin()
  return response
}

/**
 * Who is signed in, or null when the app is not running behind a gateway.
 *
 * A failure of any kind means "no gateway": this is how the app tells the two deployments apart, so
 * it must never turn a missing endpoint into a visible error.
 *
 * The content type is checked rather than the status, and that is not belt-and-braces. Suwayomi
 * serves its index page for any path it does not recognise, so asking a plain server for
 * `/gateway/me` gets **200 and a page of HTML** — a status check alone would read that as a
 * successful answer and go on to parse it.
 */
export async function gatewayAccount(): Promise<GatewayAccount | null> {
  try {
    const response = await fetch('/gateway/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    if (!response.headers.get('content-type')?.includes('application/json')) return null
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object') return null
    const account = body as Partial<GatewayAccount>
    if (typeof account.username !== 'string') return null
    return { username: account.username, displayName: account.displayName || account.username }
  } catch {
    return null
  }
}

/** End the session and go back to the sign-in page. */
export async function signOut(): Promise<void> {
  try {
    await fetch('/gateway/logout', { method: 'POST', credentials: 'same-origin' })
  } catch {
    // Even if the request never landed, sending the person to the login page is the right next step.
  }
  window.location.assign('/gateway/login')
}
