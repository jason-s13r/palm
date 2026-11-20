/**
 * What an app's User-Agent says about it, for a post to show where it was
 * written ("via Ivory for iPhone"). Best effort: plenty of apps send a
 * webview's or an HTTP library's User-Agent that names neither.
 */
export interface UserAgentClient {
  /** The app's name, when its User-Agent leads with one ("Thunder/0.6"). */
  app: string | null;
  /** The kind of device: iPhone, iPad, Android, Mac, Windows, Linux. */
  device: string | null;
}

/** Leading product tokens that name a browser engine or HTTP library, not an app. */
const NOT_APPS = /^(mozilla|dart|okhttp|cfnetwork|darwin|dalvik|curl|wget|python|node|undici|axios|go-http-client|java|ktor|alamofire|reactnative|expo)$/i;

export function userAgentClient(userAgent: string | null | undefined): UserAgentClient {
  const ua = (userAgent ?? "").slice(0, 500);
  if (!ua) return { app: null, device: null };
  const product = /^([A-Za-z][\w .-]{0,40}?)\/\d/.exec(ua)?.[1]?.trim() ?? null;
  const app = product && !NOT_APPS.test(product) ? product : null;
  return { app, device: deviceOf(ua) };
}

function deviceOf(ua: string): string | null {
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone|\biOS\b/.test(ua)) return "iPhone";
  if (/Android|okhttp|Dalvik/i.test(ua)) return "Android";
  if (/Macintosh|Mac OS X|macOS/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux|X11/.test(ua)) return "Linux";
  // An iOS app's own networking stack names only CFNetwork and Darwin.
  if (/CFNetwork/.test(ua)) return "iPhone";
  return null;
}
