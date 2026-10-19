import assert from "node:assert/strict";
import test from "node:test";
import { words } from "../src/words.js";

test("words splits on any run of spaces", () => {
  assert.deepEqual(words("  one two\tthree "), ["one", "two", "three"]);
});
