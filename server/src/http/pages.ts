/**
 * The sign-in page — the only page that exists before anyone is signed in.
 *
 * Served from here rather than built into the React app, because it has to work
 * before any of the app is allowed to load. It is a single self-contained
 * document: no bundle, no imports, nothing that could fail to load and leave
 * somebody unable to get in.
 *
 * It reads the same two `localStorage` keys the app writes, so the theme and the
 * language a person chose inside the app are the ones they meet at the door.
 *
 * There is no way to make an account from here, and that is the design rather
 * than an omission. Accounts are created on the server with `s4m users add`, so
 * nothing reachable from the internet can bring one into being.
 */

const STRINGS = {
  en: {
    signIn: 'Sign in',
    username: 'Username',
    password: 'Password',
    working: 'Signing in…',
    starting: 'Starting your server. The first sign-in after a restart takes a moment.',
    bad: 'Wrong username or password.',
    locked: 'Too many attempts. Try again in {minutes} min.',
    offline: 'The server could not be reached.',
  },
  pt: {
    signIn: 'Iniciar sessão',
    username: 'Utilizador',
    password: 'Palavra-passe',
    working: 'A entrar…',
    starting: 'A arrancar o teu servidor. O primeiro acesso depois de um reinício demora um momento.',
    bad: 'Utilizador ou palavra-passe incorretos.',
    locked: 'Demasiadas tentativas. Tenta outra vez daqui a {minutes} min.',
    offline: 'Não foi possível contactar o servidor.',
  },
};

const STYLE = `
:root {
  --ink: #18233d; --ink-soft: #526078; --paper: #f4f6fb; --surface: #ffffff;
  --line: #dce2ee; --aqua: #25a8a6; --aqua-ink: #126a68; --error: #9f2937;
  --shadow: 0 18px 50px rgba(32, 48, 78, 0.12); --on-aqua: #ffffff;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --ink: #e8edf7; --ink-soft: #9da9bd; --paper: #0d1424; --surface: #151f32;
  --line: #2a3954; --aqua: #52cbc6; --aqua-ink: #87ddd9; --error: #ff9da7;
  --shadow: 0 20px 55px rgba(0, 0, 0, 0.32); --on-aqua: #0d1424;
  color-scheme: dark;
}
/* Each named palette needs its ten tokens here as well as its full set in web/src/index.css.
   This page paints before any bundle exists, so a palette missing from this block signs somebody in
   through a door painted in a theme they did not choose. */
:root[data-theme="tokyo-night"] {
  --ink: #c0caf5; --ink-soft: #9aa5ce; --paper: #1a1b26; --surface: #1f2335;
  --line: #2f344d; --aqua: #7dcfff; --aqua-ink: #a9dfff; --error: #ff8ea2;
  --shadow: 0 20px 55px rgba(0, 0, 0, 0.4); --on-aqua: #16161e;
  color-scheme: dark;
}
:root[data-theme="sepia"] {
  --ink: #3b2f24; --ink-soft: #7a6a58; --paper: #f4ecdd; --surface: #fdf6e8;
  --line: #e0d3bd; --aqua: #2f8f86; --aqua-ink: #1d6259; --error: #9a3427;
  --shadow: 0 18px 50px rgba(90, 70, 45, 0.14); --on-aqua: #ffffff;
  color-scheme: light;
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  color: var(--ink); background: var(--paper);
}
main {
  width: 100%; max-width: 22rem; background: var(--surface); border: 1px solid var(--line);
  border-radius: 18px; box-shadow: var(--shadow); padding: 32px 28px 28px;
}
h1 { margin: 0 0 22px; font-size: 1.35rem; letter-spacing: -0.01em; }
label { display: block; font-size: 0.78rem; font-weight: 600; color: var(--ink-soft); margin-bottom: 6px; }
input {
  width: 100%; padding: 10px 12px; font: inherit; color: var(--ink);
  background: var(--paper); border: 1px solid var(--line); border-radius: 10px;
}
input:focus-visible { outline: 2px solid var(--aqua); outline-offset: 1px; border-color: var(--aqua); }
.field { margin-bottom: 16px; }
button {
  width: 100%; padding: 11px 14px; font: inherit; font-weight: 600; color: var(--on-aqua);
  background: var(--aqua); border: 0; border-radius: 10px; cursor: pointer;
}
button:hover:not(:disabled) { background: var(--aqua-ink); }
button:disabled { opacity: 0.6; cursor: progress; }
.note { margin: 14px 0 0; min-height: 1.2em; font-size: 0.82rem; line-height: 1.45; }
.note[data-kind="error"] { color: var(--error); }
.note[data-kind="info"] { color: var(--ink-soft); }
`;

// The theme is applied before first paint, from the same key the app uses, so
// nobody gets a flash of the light card on the way to a dark one. The list of
// palettes is the same one `web/src/utils/theme.ts` validates against, and a name
// that is not on it resolves the way "system" does rather than being stamped on
// the document — which is also what happens to a value written by a newer build.
const PALETTES = ['light', 'dark', 'tokyo-night', 'sepia'];
const BOOTSTRAP = `
(function () {
  try {
    var palettes = ${JSON.stringify(PALETTES)};
    var pref = localStorage.getItem('stremio4manga:theme') || 'system';
    var dark = matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme =
      palettes.indexOf(pref) === -1 ? (dark ? 'dark' : 'light') : pref;
  } catch (e) {}
})();
`;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * JSON destined for a `<script>` body.
 *
 * `<` has to go: the redirect comes from a query string, and `</script>` inside
 * a string literal ends the element as far as the HTML parser is concerned —
 * which is how an "only ever a path" value turns into script injection.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function loginPage(options: { redirect?: string } = {}): string {
  const redirect = options.redirect ?? '/';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml('Sign in')} - Stremio4Manga</title>
<style>${STYLE}</style>
<script>${BOOTSTRAP}</script>
</head>
<body>
<main>
  <h1 id="heading">Sign in</h1>
  <form id="form" autocomplete="on">
    <div class="field">
      <label for="username" id="l-username">Username</label>
      <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    </div>
    <div class="field">
      <label for="password" id="l-password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    <button id="submit" type="submit">Sign in</button>
  </form>
  <p class="note" id="note" role="status" aria-live="polite"></p>
</main>
<script>
(function () {
  var strings = ${jsonForScript(STRINGS)};
  var lang = 'en';
  try { lang = localStorage.getItem('stremio4manga:language') === 'pt' ? 'pt' : 'en'; } catch (e) {}
  var s = strings[lang] || strings.en;
  document.documentElement.lang = lang === 'pt' ? 'pt-PT' : 'en';

  var note = document.getElementById('note');
  function say(text, kind) {
    note.textContent = text;
    note.setAttribute('data-kind', kind);
  }

  // Every visible string is re-applied from the browser's own language choice,
  // which the server could not know when it rendered the page.
  function label(selector, text) {
    var el = document.querySelector(selector);
    if (el) el.textContent = text;
  }

  document.title = s.signIn + ' - Stremio4Manga';
  label('#heading', s.signIn);
  label('#l-username', s.username);
  label('#l-password', s.password);
  label('#submit', s.signIn);

  var form = document.getElementById('form');
  var button = document.getElementById('submit');
  var redirect = ${jsonForScript(redirect)};

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    button.disabled = true;
    say(s.working, 'info');

    // A cold start can take a while, so the wait gets an explanation rather than
    // a spinner that says nothing.
    var slow = setTimeout(function () { say(s.starting, 'info'); }, 2500);

    fetch('/gateway/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
        redirect: redirect
      })
    }).then(function (response) {
      return response.json().then(function (body) { return { status: response.status, body: body }; });
    }).then(function (result) {
      clearTimeout(slow);
      if (result.status === 200) {
        window.location.replace(result.body.redirect || '/');
        return;
      }
      button.disabled = false;
      if (result.status === 429) {
        var minutes = Math.max(1, Math.ceil((result.body.retryAfterMs || 60000) / 60000));
        say(s.locked.replace('{minutes}', minutes), 'error');
      } else {
        say(result.body.message || s.bad, 'error');
        document.getElementById('password').value = '';
        document.getElementById('password').focus();
      }
    }).catch(function () {
      clearTimeout(slow);
      button.disabled = false;
      say(s.offline, 'error');
    });
  });
})();
</script>
</body>
</html>`;
}
