import type { Profile } from "./bridge";

// control/src/profile.ts bounds each lookup below D1's parameter limit.
const PROFILE_LOOKUP_BATCH_SIZE = 90;

export type NameCache = {
  get(userID: string): string | undefined;
  // ensure resolves any unknown ids via the batched lookup; returns true when
  // new names were learned (callers use it to trigger a re-render).
  ensure(userIDs: string[]): Promise<boolean>;
};

export function createNameCache(lookup: (ids: string[]) => Promise<Profile[]>): NameCache {
  const known = new Map<string, string>();
  const inflight = new Set<string>();
  return {
    get(userID) {
      return known.get(userID);
    },
    async ensure(userIDs) {
      const missing = [...new Set(userIDs)].filter((id) => id && !known.has(id) && !inflight.has(id));
      if (missing.length === 0) return false;
      for (const id of missing) inflight.add(id);
      let learned = false;
      try {
        for (let offset = 0; offset < missing.length; offset += PROFILE_LOOKUP_BATCH_SIZE) {
          const batch = missing.slice(offset, offset + PROFILE_LOOKUP_BATCH_SIZE);
          const profiles = await lookup(batch);
          for (const profile of profiles) known.set(profile.id, profile.display_name);
          // Only a successful batch can establish that a user was deleted.
          for (const id of batch) {
            if (!known.has(id)) known.set(id, "");
          }
          learned = learned || profiles.length > 0;
        }
      } catch {
        // Stop on service failure; retain completed batches and leave the
        // failed/unattempted ids retryable on the next ensure.
      } finally {
        for (const id of missing) inflight.delete(id);
      }
      return learned;
    },
  };
}

// displayName falls back to a short id stub for unknown or deleted users.
export function displayName(cache: NameCache, userID: string): string {
  const name = cache.get(userID);
  if (name) return name;
  return userID ? userID.slice(0, 6) : "未知用户";
}
