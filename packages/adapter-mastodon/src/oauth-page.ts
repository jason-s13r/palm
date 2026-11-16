import { escapeHtml } from "./views.ts";

/**
 * The one browser page Mastodon apps need: sign in and approve the app. The
 * app opens it in a browser sheet at /oauth/authorize; on success palm
 * redirects back to the app with a code.
 */
export interface AuthorizePage {
  instanceName: string;
  appName: string;
  /** The query parameters to carry through the form post. */
  params: Record<string, string>;
  error?: string;
  username?: string;
}

export function authorizePage(page: AuthorizePage): string {
  const hidden = Object.entries(page.params)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Sign in to ${escapeHtml(page.instanceName)}</title>
  <style>
    :root { color-scheme: light dark; --accent: #2e7d5a; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
      font: 16px/1.5 system-ui, -apple-system, sans-serif; background: Canvas; color: CanvasText; }
    main { width: 100%; max-width: 360px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    p { margin: 0 0 20px; opacity: .75; }
    label { display: block; font-size: 14px; margin: 14px 0 6px; }
    input[type=text], input[type=password] { width: 100%; padding: 12px; font: inherit; border-radius: 10px;
      border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Field; color: FieldText; }
    button { width: 100%; margin-top: 22px; padding: 13px; font: inherit; font-weight: 600; border: 0;
      border-radius: 10px; background: var(--accent); color: white; }
    .error { margin: 16px 0 0; padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, #c62828 15%, Canvas); }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(page.instanceName)}</h1>
    <p>Sign in to let <strong>${escapeHtml(page.appName)}</strong> use your account.</p>
    ${page.error ? `<div class="error" role="alert">${escapeHtml(page.error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none"
        autocorrect="off" spellcheck="false" required value="${escapeHtml(page.username ?? "")}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in and approve</button>
    </form>
  </main>
</body>
</html>`;
}

export function codePage(instanceName: string, code: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(instanceName)}</title></head>
<body style="font:16px/1.5 system-ui;padding:24px;max-width:480px;margin:auto">
<h1>Approved</h1><p>Copy this code into the app:</p>
<p><code style="font-size:18px;word-break:break-all">${escapeHtml(code)}</code></p>
</body></html>`;
}
