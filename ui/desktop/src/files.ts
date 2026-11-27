import type { FileRecord } from "./bridge";

export function indexMissingFiles(current: Record<string, FileRecord>, incoming: FileRecord[]): Record<string, FileRecord> {
  let next = current;
  for (const file of incoming) {
    if (Object.hasOwn(next, file.id)) continue;
    if (next === current) next = { ...current };
    next[file.id] = file;
  }
  return next;
}
