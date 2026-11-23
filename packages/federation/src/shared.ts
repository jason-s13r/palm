import {
  createFederationBuilder,
  type Context,
  type Federation,
  type FederationBuilder,
  type SendActivityOptions,
  type SenderKeyPair,
} from "@fedify/fedify";
import type { Activity, Recipient } from "@fedify/fedify/vocab";
import { PERMANENT_FAILURE_STATUS_CODES, RETRY_DELAYS_SECONDS, type RequestContext } from "@palm/core";
import { Temporal } from "temporal-polyfill";
import { communityKeys, type Account, type Community } from "@palm/db";
import { D1KvStore } from "./kv.ts";
import { importJwkCached } from "./keys.ts";
import { signRefusedFetches } from "./signed-fetch.ts";
import { CloudflareMessageQueue, type FederationName } from "./queue.ts";

/**
 * palm runs two Fedify federations over the same database. Fedify gives each
 * federation one actor path, and Lemmy's communities live at /c/{name} while
 * people live at /users/{name}:
 *
 *   people       /users/{name} (Person), /inbox, /objects/{id}, nodeinfo
 *   communities  /c/{name} (Group), its followers, outbox and inbox
 *
 * Both share the inbox listeners in inbox.ts.
 */
export const peopleBuilder: FederationBuilder<RequestContext> = createFederationBuilder<RequestContext>();
export const communitiesBuilder: FederationBuilder<RequestContext> = createFederationBuilder<RequestContext>();

export interface Federations {
  people: Federation<RequestContext>;
  communities: Federation<RequestContext>;
}

// One pair per database per isolate: building them is the costly part. The
// built pair is kept, not a pending promise, which is tied to its request.
const built = new WeakMap<D1Database, Federations>();
const builtTrusted = new WeakMap<D1Database, Federations>();

const outboxRetryPolicy = ({ attempts }: { attempts: number }) => {
  const seconds = RETRY_DELAYS_SECONDS[attempts - 1];
  return seconds === undefined ? null : Temporal.Duration.from({ seconds });
};

/**
 * The two federations for a database. `trusted` builds a pair that skips
 * signature checks, for deliveries palm has already authenticated itself
 * (see trustedDelivery in inbox-auth.ts); nothing else may use it.
 */
export async function federationsFor(bindings: RequestContext["bindings"], trusted = false): Promise<Federations> {
  const cache = trusted ? builtTrusted : built;
  const known = cache.get(bindings.DB);
  if (known) return known;
  const options = (name: FederationName) => ({
    kv: new D1KvStore(bindings.DB),
    ...(trusted ? { skipSignatureVerification: true } : {}),
    // With a queue, outgoing deliveries become queue jobs, which the
    // Worker's queue handler runs (see processQueueMessage). Received
    // activities are handled in the request: a busy Lemmy community sends
    // over a thousand an hour, and each queued one costs three of the free
    // plan's 10,000 daily queue operations.
    ...(bindings.QUEUE
      ? (() => {
          const queue = new CloudflareMessageQueue(bindings.QUEUE, name);
          return { queue: { outbox: queue, fanout: queue }, manuallyStartQueue: true };
        })()
      : {}),
    outboxRetryPolicy,
    permanentFailureStatusCodes: PERMANENT_FAILURE_STATUS_CODES,
    // A server that keeps failing has its deliveries held rather than
    // retried one by one. Each hold puts the delivery back on the queue, so
    // holds are checked every two hours and given up after a day, not
    // Fedify's 30 minutes and a week (about 336 queue messages each).
    circuitBreaker: { recoveryDelay: { hours: 2 }, heldActivityTtl: { hours: 24 } },
  });
  const [people, communities] = await Promise.all([peopleBuilder.build(options("people")), communitiesBuilder.build(options("communities"))]);
  signRefusedFetches(people);
  signRefusedFetches(communities);
  // Two requests arriving together may both build; the first one kept wins.
  const found = cache.get(bindings.DB) ?? { people, communities };
  cache.set(bindings.DB, found);
  return found;
}

/** Fedify contexts for both federations, for code that sends or looks things up. */
export async function contextsFor(ctx: RequestContext): Promise<{ people: Context<RequestContext>; communities: Context<RequestContext> }> {
  const { people, communities } = await federationsFor(ctx.bindings);
  const base = new URL(`https://${ctx.domain.domain}`);
  return { people: people.createContext(base, ctx), communities: communities.createContext(base, ctx) };
}

/** The domains this deployment serves. */
export const localDomains = (ctx: RequestContext) => ctx.config.domains.map((d) => d.domain);

/** Whether a URL is one of this deployment's. */
export const isLocalUrl = (ctx: RequestContext, url: URL | string) =>
  localDomains(ctx).includes(new URL(url).host.toLowerCase());

/** A local account's actor identifier: its username, lowercased like urls.user. */
export const identifierOf = (account: Pick<Account, "username">) => account.username.toLowerCase();
export const communityIdentifierOf = (community: Pick<Community, "name">) => community.name.toLowerCase();

const isRsa = (key: CryptoKey) => key.algorithm.name === "RSASSA-PKCS1-v1_5";

/**
 * The keys to sign deliveries with: RSA only. That signs the HTTP request,
 * which is what Mastodon and Lemmy check, and the Linked Data signature.
 * Leaving out the Ed25519 key skips the Object Integrity Proof, which costs
 * several times the rest of signing and nothing palm talks to requires yet.
 */
export async function personKeys(people: Context<RequestContext>, account: Account): Promise<SenderKeyPair[]> {
  const pairs = await people.getActorKeyPairs(identifierOf(account));
  return pairs.filter((p) => isRsa(p.privateKey)).map(({ keyId, privateKey }) => ({ keyId, privateKey }));
}

export async function communitySenderKeys(communities: Context<RequestContext>, community: Community): Promise<SenderKeyPair[]> {
  const pairs = await communities.getActorKeyPairs(communityIdentifierOf(community));
  return pairs.filter((p) => isRsa(p.privateKey)).map(({ keyId, privateKey }) => ({ keyId, privateKey }));
}

/** A community's key pairs, RSA first, for its actor and for signing. */
export async function communityKeyPairs(db: D1Database, communityId: number): Promise<CryptoKeyPair[]> {
  const stored = await communityKeys(db, communityId);
  stored.sort((a, b) => (a.algorithm === b.algorithm ? 0 : a.algorithm === "RSASSA-PKCS1-v1_5" ? -1 : 1));
  return Promise.all(
    stored.map(async (k) => ({ publicKey: await importJwkCached(k.publicJwk, "public"), privateKey: await importJwkCached(k.privateJwk, "private") })),
  );
}

/** A follower row as a Fedify recipient. */
export const recipient = (f: { actorId: string; inbox: string; sharedInbox: string | null }): Recipient => ({
  id: new URL(f.actorId),
  inboxId: new URL(f.inbox),
  endpoints: f.sharedInbox ? { sharedInbox: new URL(f.sharedInbox) } : null,
});

/** A remote account or community as a recipient, if palm knows its inbox. */
export const recipientOf = (actor: { apId: string | null; inbox: string | null; sharedInbox: string | null }): Recipient | null =>
  actor.apId && actor.inbox ? recipient({ actorId: actor.apId, inbox: actor.inbox, sharedInbox: actor.sharedInbox }) : null;

/** Logs a problem with federation without failing the request or job around it. */
/**
 * Sends an activity, through the queue when it can and straight away when it
 * can't. One recipient (accepting a follow, a reply's author) is sent at once:
 * it's a single cheap request, and waiting on the queue only delays it. More
 * go through the queue, and if the queue refuses (the free plan's daily
 * operations used up), they're sent now instead of lost.
 */
export async function send(
  ctx: Context<RequestContext>,
  keys: SenderKeyPair[],
  recipients: Recipient | Recipient[],
  activity: Activity,
  options: SendActivityOptions = {},
): Promise<void> {
  const many = Array.isArray(recipients) && recipients.length > 1;
  if (!many || options.immediate) {
    await ctx.sendActivity(keys, recipients, activity, { ...options, immediate: true });
    return;
  }
  try {
    await ctx.sendActivity(keys, recipients, activity, options);
  } catch (error) {
    // With a queue, sending only enqueues, so a failure here is the queue's.
    logProblem("queue_refused_sending_now", { activity: activity.id?.href ?? null, recipients: Array.isArray(recipients) ? recipients.length : 1, error: String(error) });
    await ctx.sendActivity(keys, recipients, activity, { ...options, immediate: true });
  }
}

export function logProblem(event: string, details: Record<string, unknown>): void {
  console.warn(JSON.stringify({ palm: event, ...details }));
}
