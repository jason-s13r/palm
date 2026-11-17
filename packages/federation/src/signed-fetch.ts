import { importJwk, type Federation } from "@fedify/fedify";
import { currentContext, urls } from "@palm/core";
import { actorKeys, admins } from "@palm/db";

type Loader = (url: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
type Factory = (options?: unknown) => Loader;
type AuthFactory = (identity: { keyId: URL; privateKey: CryptoKey }, options?: unknown) => Loader;
interface Factories {
  documentLoaderFactory: Factory;
  authenticatedDocumentLoaderFactory: AuthFactory;
}

const signers = new WeakMap<D1Database, Map<string, Promise<{ keyId: URL; privateKey: CryptoKey } | null>>>();

/** The deployment's first admin signs fetches for servers that want them signed. */
function signerFor(db: D1Database, domain: string) {
  let byDomain = signers.get(db);
  if (!byDomain) signers.set(db, (byDomain = new Map()));
  let found = byDomain.get(domain);
  if (!found) {
    found = (async () => {
      for (const admin of await admins(db, domain)) {
        const rsa = (await actorKeys(db, admin.id)).find((k) => k.algorithm === "RSASSA-PKCS1-v1_5");
        if (rsa) return { keyId: new URL(`${urls.user(domain, admin.username)}#main-key`), privateKey: await importJwk(rsa.privateJwk, "private") };
      }
      // None yet: look again next time rather than caching the miss.
      byDomain!.delete(domain);
      return null;
    })();
    byDomain.set(domain, found);
  }
  return found;
}

const refused = (error: unknown) => {
  const status = (error as { response?: Response } | null)?.response?.status;
  return status === 401 || status === 403;
};

/**
 * Fetches unsigned, as most servers allow, and signs a retry when a server
 * refuses (Mastodon's authorized fetch, GoToSocial). Signing every fetch
 * would cost an RSA signature each, a large part of the CPU budget.
 */
export function signRefusedFetches(federation: Federation<unknown>, signer: typeof signerFor = signerFor): void {
  const f = federation as unknown as Factories;
  const plain = f.documentLoaderFactory;
  f.documentLoaderFactory = (options) => {
    const load = plain(options);
    return async (url, opts) => {
      try {
        return await load(url, opts);
      } catch (error) {
        const ctx = currentContext();
        if (!refused(error) || !ctx) throw error;
        const identity = await signer(ctx.bindings.DB, ctx.domain.domain);
        if (!identity) throw error;
        return f.authenticatedDocumentLoaderFactory(identity, options)(url, opts);
      }
    };
  };
}
