import { contextScope, enterContext, type RequestContext } from "@palm/core";
import { describe, expect, it } from "vitest";
import { signRefusedFetches } from "../src/signed-fetch.ts";

const refused = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: new Response("", { status }) });

function fakeFederation(status: number) {
  const calls: string[] = [];
  const federation = {
    documentLoaderFactory: () => async (url: string) => {
      calls.push(`plain ${url}`);
      if (status !== 200) throw refused(status);
      return { documentUrl: url, document: {} };
    },
    authenticatedDocumentLoaderFactory: (identity: { keyId: URL }) => async (url: string) => {
      calls.push(`signed ${url} ${identity.keyId.href}`);
      return { documentUrl: url, document: {} };
    },
  };
  return { federation, calls };
}

const ctx = { bindings: { DB: {} }, domain: { domain: "palm.test" } } as unknown as RequestContext;
const signer = async () => ({ keyId: new URL("https://palm.test/users/admin#main-key"), privateKey: {} as CryptoKey });

describe("signRefusedFetches", () => {
  it("retries signed when a server refuses", async () => {
    const { federation, calls } = fakeFederation(401);
    signRefusedFetches(federation as never, signer);
    await contextScope(async () => {
      enterContext(ctx);
      await federation.documentLoaderFactory()("https://locked.example/users/bob");
    });
    expect(calls).toEqual(["plain https://locked.example/users/bob", "signed https://locked.example/users/bob https://palm.test/users/admin#main-key"]);
  });

  it("leaves other failures and successes alone", async () => {
    const ok = fakeFederation(200);
    signRefusedFetches(ok.federation as never, signer);
    const missing = fakeFederation(404);
    signRefusedFetches(missing.federation as never, signer);
    await contextScope(async () => {
      enterContext(ctx);
      await ok.federation.documentLoaderFactory()("https://open.example/a");
      await expect(missing.federation.documentLoaderFactory()("https://open.example/b")).rejects.toThrow("HTTP 404");
    });
    expect([...ok.calls, ...missing.calls]).toEqual(["plain https://open.example/a", "plain https://open.example/b"]);
  });
});
