import { describe, expect, it } from "vitest";
import { createAccount, giveKeys, MASTODON, mastodonToken, worker } from "./helpers.ts";

const AP = { accept: "application/activity+json" };

describe("Public document cache", () => {
  it("serves actors from cache until the profile changes", async () => {
    const id = await createAccount("pc_amy", "pw");
    await giveKeys(id);
    const actor = () => worker.fetch("https://palm.test/users/pc_amy", { headers: AP });

    const first = await actor();
    expect(first.headers.get("x-palm-cache")).toBeNull();
    await first.text();
    // The copy is stored after the response; give it a moment.
    await new Promise((r) => setTimeout(r, 50));
    const second = await actor();
    expect(second.headers.get("x-palm-cache")).toBe("hit");
    await second.text();

    await worker.fetch(`${MASTODON}/api/v1/accounts/update_credentials`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${await mastodonToken(id)}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Amy Changed" }),
    });
    const third = await actor();
    expect(third.headers.get("x-palm-cache")).toBeNull();
    expect((await third.json<{ name: string }>()).name).toBe("Amy Changed");

    const finger = () => worker.fetch("https://palm.test/.well-known/webfinger?resource=acct:pc_amy@palm.test");
    await (await finger()).text();
    await new Promise((r) => setTimeout(r, 50));
    expect((await finger()).headers.get("x-palm-cache")).toBe("hit");

    // Browsers get the web page, which isn't cached.
    const page = await worker.fetch("https://palm.test/users/pc_amy", { headers: { accept: "text/html" } });
    expect(page.headers.get("x-palm-cache")).toBeNull();
  });
});
