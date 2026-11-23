/**
 * Responses that won't change on a retry: the server read the delivery and
 * refused it (a bad digest, a signature it rejects, an object it won't take).
 * Each retry is a queue message, three of the free plan's daily operations,
 * so these are dropped at once. 429 and 5xx are retried.
 */
export const PERMANENT_FAILURE_STATUS_CODES: readonly number[] = [400, 401, 403, 404, 405, 410, 413, 415, 422];

/**
 * When a failed delivery is tried again: spread over about 17 hours, so an
 * instance that's down for an upgrade or an outage of a few hours still gets
 * it, and every retry stays inside the queue's 24-hour retention.
 */
export const RETRY_DELAYS_SECONDS: readonly number[] = [60, 10 * 60, 60 * 60, 4 * 60 * 60, 12 * 60 * 60];
