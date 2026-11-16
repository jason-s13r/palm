import { describe, expect, it } from "vitest";
import { createAccount, json, LEMMY, worker } from "./helpers.ts";

async function login(username: string, password: string) {
  return worker.fetch(`${LEMMY}/api/v3/user/login`, json({ username_or_email: username, password }));
}

describe("Lemmy API", () => {
  it("serves the site without a login", async () => {
    const res = await worker.fetch(`${LEMMY}/api/v3/site`);
    expect(res.status).toBe(200);
    const body = await res.json<{ version: string; my_user?: unknown; site_view: { site: { name: string } } }>();
    expect(body.version).toMatch(/^0\.19\./);
    expect(body.site_view.site.name).toBe("palm staging");
    expect(body.my_user).toBeUndefined();
  });

  it("identifies itself as Lemmy in nodeinfo", async () => {
    const links = await (await worker.fetch(`${LEMMY}/.well-known/nodeinfo`)).json<{ links: { href: string }[] }>();
    const info = await (await worker.fetch(links.links[0]!.href)).json<{ software: { name: string; version: string } }>();
    expect(info.software.name).toBe("lemmy");
    expect(info.software.version).toMatch(/^0\.19\.9\+palm\./);
  });

  it("logs in, shows the account in the site, and logs out", async () => {
    await createAccount("ana", "hunter2-hunter2", "admin");

    const res = await login("Ana", "hunter2-hunter2");
    expect(res.status).toBe(200);
    const { jwt } = await res.json<{ jwt: string }>();
    expect(jwt.split(".")).toHaveLength(3);
    // Voyager reads iss to find the server; it must be the API host.
    const claims = JSON.parse(atob(jwt.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
    expect(claims.iss).toBe("lemmy.palm.test");

    const auth = { headers: { authorization: `Bearer ${jwt}` } };
    const site = await (await worker.fetch(`${LEMMY}/api/v3/site`, auth)).json<{
      my_user: { local_user_view: { person: { name: string; actor_id: string }; local_user: { admin: boolean } } };
      admins: { person: { name: string } }[];
    }>();
    expect(site.my_user.local_user_view.person.name).toBe("ana");
    expect(site.my_user.local_user_view.person.actor_id).toBe("https://palm.test/users/ana");
    expect(site.my_user.local_user_view.local_user.admin).toBe(true);
    expect(site.admins.map((a) => a.person.name)).toContain("ana");

    expect((await worker.fetch(`${LEMMY}/api/v3/user/validate_auth`, auth)).status).toBe(200);
    await worker.fetch(`${LEMMY}/api/v3/user/logout`, { method: "POST", ...auth });
    expect((await worker.fetch(`${LEMMY}/api/v3/user/validate_auth`, auth)).status).toBe(401);
  });

  it("accepts the handle forms people type", async () => {
    await createAccount("bo", "correct-password");
    for (const name of ["bo", "@bo", "bo@palm.test", "BO"]) {
      expect((await login(name, "correct-password")).status, name).toBe(200);
    }
  });

  it("refuses a wrong password the way Lemmy does", async () => {
    await createAccount("cy", "right-password");
    const res = await login("cy", "wrong-password");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "incorrect_login" });
    expect((await login("nobody", "x")).status).toBe(400);
  });

  it("answers the feeds apps load at startup with empty lists", async () => {
    expect(await (await worker.fetch(`${LEMMY}/api/v3/post/list`)).json()).toEqual({ posts: [] });
    // The inbox needs a login, as Lemmy's does.
    expect((await worker.fetch(`${LEMMY}/api/v3/user/unread_count`)).status).toBe(401);
  });

  it("returns a Lemmy-style 404 for endpoints it doesn't have yet", async () => {
    const res = await worker.fetch(`${LEMMY}/api/v3/modlog`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_endpoint" });
  });
});
