/// <reference path="./async-hooks.d.ts" />
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "./context.ts";

/**
 * The request (or queue job, or cron run) being served, for code deep in
 * the database layer that needs it: the hooks that send push notifications
 * and stream events run after a notification or post is written, wherever
 * that happens, and need the deployment's bindings to do it.
 *
 * workerd has `run` but not `enterWith`, so each entry point opens a scope
 * holding a box, and the context is put in the box once it's built.
 */
const store = new AsyncLocalStorage<{ ctx?: RequestContext }>();

/** Runs `fn` in a fresh scope for `enterContext` to fill. */
export function contextScope<T>(fn: () => T): T {
  return store.run({}, fn);
}

/** Makes `ctx` the current context for the rest of this scope's work. */
export function enterContext(ctx: RequestContext): void {
  const box = store.getStore();
  if (box) box.ctx = ctx;
}

export function currentContext(): RequestContext | undefined {
  return store.getStore()?.ctx;
}
