import { markedOrphans, RUN_MARKER, runMarker } from "@runtime/orphans";
import { expect, it } from "vitest";

it("picks only orphans that carry this project's marker", () => {
  const marker = runMarker("/data/projects/a/worker-home");
  expect(marker).not.toBe(runMarker("/data/projects/b/worker-home"));
  const listing = [
    `  101     1 /usr/libexec/swiftpm-testing-helper --test-bundle-path /p HOME=/x ${RUN_MARKER}=${marker} TMPDIR=/t`,
    `  102   500 /usr/bin/swift-test ${RUN_MARKER}=${marker}`,
    `  103     1 /usr/bin/sleep 30 ${RUN_MARKER}=${runMarker("/other")}`,
    `  104     1 /usr/bin/sleep 30 ${RUN_MARKER}=${marker}0`,
    `  105     1 /usr/bin/sleep 30 ${RUN_MARKER}=${marker}`,
  ].join("\n");
  expect(markedOrphans(marker, listing)).toEqual([101, 105]);
});
