// The one Node API palm uses in the Worker (with nodejs_compat), declared
// here rather than pulling in all of @types/node.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
