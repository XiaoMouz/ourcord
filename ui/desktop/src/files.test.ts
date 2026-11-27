import { describe, expect, it } from "vitest";
import type { FileRecord } from "./bridge";
import { indexMissingFiles } from "./files";

function file(id: string): FileRecord {
  return { id, room_id: "room", uploader_id: "user", filename: `${id}.txt`, size_bytes: 12, mime_type: "text/plain", created_at: 1 };
}

describe("indexMissingFiles", () => {
  it("does not trigger another metadata effect when an attachment is absent from an empty response", () => {
    const current = {};
    expect(indexMissingFiles(current, [])).toBe(current);
  });

  it("settles when the server repeatedly returns unrelated files but the requested attachment is missing", () => {
    const first = indexMissingFiles({}, [file("unrelated")]);
    expect(indexMissingFiles(first, [file("unrelated")])).toBe(first);
  });

  it("resolves an attachment when it becomes available on a later poll without mutating the previous index", () => {
    const known = file("known");
    const current = { known };
    const recovered = file("recovered");
    const next = indexMissingFiles(current, [file("known"), recovered, recovered]);
    expect(next).not.toBe(current);
    expect(next.known).toBe(known);
    expect(next.recovered).toBe(recovered);
    expect(current).toEqual({ known });
    expect(indexMissingFiles(next, [file("known"), file("recovered")])).toBe(next);
  });
});
