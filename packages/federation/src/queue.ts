import type { MessageQueue, MessageQueueEnqueueOptions } from "@fedify/fedify";
import type { FederationTask } from "@palm/core";

/**
 * Everything palm puts on its Cloudflare Queue. One queue carries both:
 * Fedify's own work (sending to each inbox, handling received activities),
 * tagged with the federation it belongs to, and palm's tasks, which do the
 * part of a client request that would otherwise blow the CPU budget.
 */
export type QueueBody =
  | { palm: "fedify"; federation: FederationName; message: unknown }
  | { palm: "task"; domain: string; task: FederationTask }
  /** A delivery to an inbox, accepted at once and verified in the queue. */
  | { palm: "inbox"; url: string; headers: [string, string][]; body: string; receivedAt: number };

/** palm runs two Fedify federations: one for people, one for communities. */
export type FederationName = "people" | "communities";

/** Queues are capped at 24 hours of delay; Fedify's backoff stays well inside it. */
const MAX_DELAY_SECONDS = 24 * 60 * 60;

function delaySeconds(options?: MessageQueueEnqueueOptions): number | undefined {
  const seconds = options?.delay?.total({ unit: "seconds" });
  return seconds && seconds > 0 ? Math.min(Math.ceil(seconds), MAX_DELAY_SECONDS) : undefined;
}

/**
 * Fedify's MessageQueue on a Cloudflare Queue. Sending is all Fedify needs
 * from it: the Worker's queue handler passes messages back in, rather than
 * Fedify listening for them.
 */
export class CloudflareMessageQueue implements MessageQueue {
  readonly nativeRetrial = false;

  constructor(
    private readonly queue: Queue<QueueBody>,
    private readonly federation: FederationName,
  ) {}

  async enqueue(message: unknown, options?: MessageQueueEnqueueOptions): Promise<void> {
    const delay = delaySeconds(options);
    await this.queue.send({ palm: "fedify", federation: this.federation, message }, delay ? { delaySeconds: delay } : {});
  }

  async enqueueMany(messages: readonly unknown[], options?: MessageQueueEnqueueOptions): Promise<void> {
    const delay = delaySeconds(options);
    // sendBatch takes up to 100 messages.
    for (let i = 0; i < messages.length; i += 100) {
      await this.queue.sendBatch(
        messages.slice(i, i + 100).map((message) => ({
          body: { palm: "fedify", federation: this.federation, message } as QueueBody,
          ...(delay ? { delaySeconds: delay } : {}),
        })),
      );
    }
  }

  listen(): Promise<void> {
    // The Worker's queue handler delivers messages; nothing listens here.
    return Promise.resolve();
  }
}
