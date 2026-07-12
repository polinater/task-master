import { Redis } from "@upstash/redis";
import { env } from "./env";

/**
 * The record we persist per source item. This is the entire database — one
 * Redis hash whose fields are source keys ("linear:<id>" / "attio:<id>") and
 * whose values are these records. Nothing is stored in the Google task itself.
 */
export interface SyncRecord {
  /** The Google task id this source item maps to. */
  googleTaskId: string;
  /** The Google Tasks list id the task lives in (so we target the right list). */
  tasklistId: string;
  /** Whether we've already propagated completion to Google. */
  done: boolean;
  /** Hash of the last-synced title+notes+due, so we skip no-op updates. */
  hash: string;
  /** ISO timestamp of the last write, for debugging. */
  updatedAt: string;
}

const HASH_KEY = "sync:items";

export class SyncStore {
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis({ url: env.upstashUrl(), token: env.upstashToken() });
  }

  /** Load every mapping at once (one round-trip). */
  async all(): Promise<Map<string, SyncRecord>> {
    const data = await this.redis.hgetall<Record<string, SyncRecord>>(HASH_KEY);
    const map = new Map<string, SyncRecord>();
    if (data) {
      for (const [key, value] of Object.entries(data)) map.set(key, value);
    }
    return map;
  }

  async set(key: string, record: SyncRecord): Promise<void> {
    await this.redis.hset(HASH_KEY, { [key]: record });
  }

  async delete(key: string): Promise<void> {
    await this.redis.hdel(HASH_KEY, key);
  }
}
