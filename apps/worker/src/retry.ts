import { PERMANENT_FAILURE_STATUS_CODES, RETRY_DELAYS_SECONDS } from "@palm/core";
import type { QueueBody } from "@palm/federation";

/**
 * Whether a failed queue message is worth another go, and when. Every retry
 * is another read of the free plan's daily queue operations, so:
 * - a delivery the other server refused (a 4xx other than 429) is dropped;
 * - a received activity is tried once more, since what fails twice is
 *   usually palm's own bug, which a retry doesn't fix;
 * - anything else is retried on the same spread-out schedule as Fedify's
 *   deliveries, up to the queue's max_retries.
 */
export function retryDelay(body: QueueBody, attempts: number, error: unknown): number | null {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if ((error as Error | null)?.name === "SendActivityError" && typeof status === "number" && PERMANENT_FAILURE_STATUS_CODES.includes(status)) return null;
  if (body.palm === "inbox" && attempts >= 2) return null;
  return RETRY_DELAYS_SECONDS[attempts - 1] ?? null;
}
