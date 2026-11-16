import { base64url, utf8 } from "@palm/auth";
import { describe, expect, it } from "vitest";
import { createAccount, MASTODON, worker } from "./helpers.ts";

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function registerApp(redirect = "ivory://oauth") {
  const res = await worker.fetch(`${MASTODON}/api/v1/apps`, form({ client_name: "Test App", redirect_uris: redirect, scopes: "read write follow" }));
  expect(res.status).toBe(200);
  return res.json<{ client_id: string; client_secret: string }>();
}

/** Runs the browser half of the OAuth flow: sign in on palm's page, get a code. */
async function authorize(clientId: string, username: string, password: string, extra: Record<string, string> = {}) {
  return worker.fetch(
    `${MASTODON}/oauth/authorize`,
    { ...form({ response_type: "code", client_id: clientId, redirect_uri: "ivory://oauth", scope: "read write follow", state: "xyz", username, password, ...extra }), redirect: "manual" },
  );
}

describe("Mastodon API", () => {
  it("serves instance info with the federation domain", async () => {
    const v2 = await (await worker.fetch(`${MASTODON}/api/v2/instance`)).json<{ domain: string; version: string }>();
    expect(v2.domain).toBe("palm.test");
    expect(v2.version).toMatch(/^4\.3\.0 \(compatible; palm /);
    const v1 = await (await worker.fetch(`${MASTODON}/api/v1/instance`)).json<{ uri: string }>();
    expect(v1.uri).toBe("palm.test");
  });

  it("shows the sign-in page for a registered app", async () => {
    const app = await registerApp();
    const res = await worker.fetch(`${MASTODON}/oauth/authorize?response_type=code&client_id=${app.client_id}&redirect_uri=ivory://oauth&scope=read`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test App");
    expect(html).toContain('name="client_id"');
  });

  it("runs the whole sign-in: app, authorize, token, verify_credentials", async () => {
    await createAccount("dee", "s3cret-pass", "admin");
    const app = await registerApp();

    const redirect = await authorize(app.client_id, "dee", "s3cret-pass");
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.protocol).toBe("ivory:");
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code")!;

    const tokenRes = await worker.fetch(
      `${MASTODON}/oauth/token`,
      form({ grant_type: "authorization_code", code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: "ivory://oauth" }),
    );
    expect(tokenRes.status).toBe(200);
    const { access_token } = await tokenRes.json<{ access_token: string }>();

    const me = await (await worker.fetch(`${MASTODON}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${access_token}` } })).json<{
      username: string;
      acct: string;
      url: string;
      source: unknown;
    }>();
    expect(me).toMatchObject({ username: "dee", acct: "dee", url: "https://mastodon.palm.test/@dee", uri: "https://palm.test/users/dee" });
    expect(me.source).toBeDefined();

    // A code works once.
    const again = await worker.fetch(
      `${MASTODON}/oauth/token`,
      form({ grant_type: "authorization_code", code, client_id: app.client_id, client_secret: app.client_secret }),
    );
    expect(again.status).toBe(400);
  });

  it("supports PKCE instead of the client secret", async () => {
    await createAccount("eli", "pkce-password");
    const app = await registerApp();
    const verifier = "a-long-random-verifier-string-for-the-test-1234567890";
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
    const redirect = await authorize(app.client_id, "eli", "pkce-password", { code_challenge: challenge, code_challenge_method: "S256" });
    const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;

    const wrong = await worker.fetch(`${MASTODON}/oauth/token`, form({ grant_type: "authorization_code", code, client_id: app.client_id, code_verifier: "nope" }));
    expect(wrong.status).toBe(400);

    const redirect2 = await authorize(app.client_id, "eli", "pkce-password", { code_challenge: challenge, code_challenge_method: "S256" });
    const code2 = new URL(redirect2.headers.get("location")!).searchParams.get("code")!;
    const right = await worker.fetch(`${MASTODON}/oauth/token`, form({ grant_type: "authorization_code", code: code2, client_id: app.client_id, code_verifier: verifier }));
    expect(right.status).toBe(200);
  });

  it("re-shows the page on a wrong password", async () => {
    await createAccount("fay", "the-password");
    const app = await registerApp();
    const res = await authorize(app.client_id, "fay", "not-the-password");
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("don't match");
  });

  it("refuses a redirect the app didn't register", async () => {
    const app = await registerApp("ivory://oauth");
    const res = await worker.fetch(`${MASTODON}/oauth/authorize?client_id=${app.client_id}&redirect_uri=https://evil.example/cb`);
    expect(res.status).toBe(400);
  });

  it("rejects API calls without a valid token", async () => {
    expect((await worker.fetch(`${MASTODON}/api/v1/accounts/verify_credentials`)).status).toBe(401);
    expect(
      (await worker.fetch(`${MASTODON}/api/v1/accounts/verify_credentials`, { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
  });

  it("needs a signed-in account for the home timeline", async () => {
    expect((await worker.fetch(`${MASTODON}/api/v1/timelines/home`)).status).toBe(401);
  });
});
