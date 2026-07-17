import type { Profile } from "./bridge";

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
      try {
        const profiles = await lookup(missing);
        for (const profile of profiles) known.set(profile.id, profile.display_name);
        // Ids the server didn't return (deleted users) stay unknown but stop
        // being re-requested this session.
        for (const id of missing) {
          if (!known.has(id)) known.set(id, "");
        }
        return profiles.length > 0;
      } catch {
        return false; // leave ids retryable on the next ensure
      } finally {
        for (const id of missing) inflight.delete(id);
      }
    },
  };
}

// displayName falls back to a short id stub for unknown or deleted users.
export function displayName(cache: NameCache, userID: string): string {
  const name = cache.get(userID);
  if (name) return name;
  return userID ? userID.slice(0, 6) : "未知用户";
}
