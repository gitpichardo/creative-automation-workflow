import type { RedisClientType } from 'redis';

/**
 * Minimal in-memory stand-in for the subset of the `redis` v6 client API
 * `src/lib/state.ts` actually uses (`get`, `set` with `NX`/`EX`, `lPush`,
 * `lTrim`, `lRange`, `quit`). This project's dev/CI sandbox has no Redis
 * server available, so this is what makes `state.ts` unit-testable at all
 * -- see `__setClientForTests`. TTLs (`EX`) are tracked but not actually
 * expired in the background; tests that care about expiry check
 * presence/absence directly rather than waiting out a real TTL.
 */
export function createFakeRedisClient() {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();

  const fake = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(
      key: string,
      value: string,
      opts?: { NX?: boolean; EX?: number },
    ): Promise<'OK' | null> {
      if (opts?.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async lPush(key: string, value: string): Promise<number> {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    },
    async lTrim(key: string, start: number, stop: number): Promise<'OK'> {
      const list = lists.get(key) ?? [];
      lists.set(key, list.slice(start, stop + 1));
      return 'OK';
    },
    async lRange(key: string, start: number, stop: number): Promise<string[]> {
      const list = lists.get(key) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    },
    async quit(): Promise<void> {
      store.clear();
      lists.clear();
    },
    // Exposed for assertions/debugging in tests.
    __store: store,
    __lists: lists,
  };

  return fake as unknown as RedisClientType;
}
