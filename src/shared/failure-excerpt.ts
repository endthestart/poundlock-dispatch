const FAILURE_LINE =
  /\bFAILED\b|\bFAIL\b|panicked at|^error(\[|:)|^\s*---- .* ----$|AssertionError|assert(ion)? .*failed|^\s*(left|right):|^E\s|Traceback|✗|×|failed to compile|could not compile/i;

/**
 * The lines that say what failed: test names, panics, assertion values and
 * compiler errors, from anywhere in the output. The first 300 characters of a
 * cargo run are compile progress, so reviews could not name the failing test.
 */
export function failureExcerpt(output: string, limit = 1_200): string {
  const lines = output.split("\n");
  const picked = lines.filter((line) => FAILURE_LINE.test(line)).slice(0, 16);
  const tail = lines.filter((line) => line.trim()).slice(-2);
  const excerpt = [...new Set([...picked, ...tail])].join("\n");
  return excerpt.length > limit ? `${excerpt.slice(0, limit)}…` : excerpt;
}

/** A runner saying it ran nothing. */
const ZERO_TESTS =
  /Test run with 0 tests|Executed 0 tests|\bno tests ran\b|collected 0 items|No tests found|^Ran 0 tests|^# tests 0$|^running 0 tests$/m;
/** A runner saying it ran something. */
const SOME_TESTS =
  /Test run with [1-9]|Executed [1-9]|collected [1-9]|^Ran [1-9]|^# tests [1-9]|^running [1-9]\d* tests?$|\b[1-9]\d* passed\b/m;

/**
 * True when a passing check ran no tests. A Swift shell's smoke tests were
 * static methods that `swift test` never found, so the check passed with
 * nothing run (13 Oct).
 */
export function ranNoTests(output: string): boolean {
  return ZERO_TESTS.test(output) && !SOME_TESTS.test(output);
}
