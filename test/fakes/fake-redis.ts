import { WatchError, type RedisClientType } from 'redis';

/**
 * Minimal in-memory stand-in for the subset of the `redis` v6 client API
 * `src/lib/state.ts` actually uses (`get`, `set` with `NX`/`EX`, `lPush`,
 * `lTrim`, `lRange`, `quit`, and -- for `updateCampaign`'s optimistic-lock
 * loop -- `duplicate`, `watch`, `unwatch`, `multi().set().exec()`). This
 * project's dev/CI sandbox has no Redis server available, so this is what
 * makes `state.ts` unit-testable at all -- see `__setClientForTests`. TTLs
 * (`EX`) are tracked but not actually expired in the background; tests that
 * care about expiry check presence/absence directly rather than waiting out
 * a real TTL.
 *
 * `duplicate()` returns a *separate* client instance backed by the same
 * shared `store`/`version` maps (mirroring how real `duplicate()`d
 * connections all talk to the same Redis server), each tracking its own
 * WATCHed keys -- so tests can actually exercise the WATCH/MULTI/EXEC
 * optimistic-lock race in `updateCampaign`, not just its happy path. Every
 * `set()` bumps a per-key version counter; `multi().exec()` aborts by
 * throwing a `WatchError` (matching real node-redis v6, confirmed against
 * an actual conflict rather than assumed from v4-era docs) if any key this
 * connection WATCHed has a newer version than when it was watched.
 */
export function createFakeRedisClient() {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const versions = new Map<string, number>();

  function bumpVersion(key: string): void {
    versions.set(key, (versions.get(key) ?? 0) + 1);
  }

  function makeClient(): RedisClientType {
    const watched = new Map<string, number>();

    const fake = {
      async connect(): Promise<void> {},
      // A no-op here, deliberately: real `quit()` just closes *this*
      // connection, it doesn't flush the server's data -- and `updateCampaign`
      // duplicates + quits an isolated connection on every single call, so a
      // fake that cleared shared state here would wipe all campaign data
      // after the very first update. Each test gets fresh `store`/`lists`
      // maps anyway via a new `createFakeRedisClient()` in `beforeEach`.
      async quit(): Promise<void> {},
      duplicate(): RedisClientType {
        return makeClient();
      },
      async watch(key: string): Promise<void> {
        watched.set(key, versions.get(key) ?? 0);
      },
      async unwatch(): Promise<void> {
        watched.clear();
      },
      multi() {
        const queued: Array<{ key: string; value: string; opts?: { EX?: number } }> = [];
        const builder = {
          set(key: string, value: string, opts?: { EX?: number }) {
            queued.push({ key, value, opts });
            return builder;
          },
          async exec(): Promise<unknown[]> {
            const dirty = [...watched.entries()].some(([key, seenVersion]) => (versions.get(key) ?? 0) !== seenVersion);
            watched.clear();
            if (dirty) throw new WatchError();
            for (const { key, value } of queued) {
              store.set(key, value);
              bumpVersion(key);
            }
            return queued.map(() => 'OK');
          },
        };
        return builder;
      },
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
        bumpVersion(key);
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
      // Exposed for assertions/debugging in tests.
      __store: store,
      __lists: lists,
    };

    return fake as unknown as RedisClientType;
  }

  return makeClient();
}
