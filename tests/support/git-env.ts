/**
 * Git's repository-location variables, as `git rev-parse --local-env-vars`
 * lists them. A test run from a git hook or `git rebase --exec` inherits them,
 * and then a test's `git init` or `git config` in a temp folder writes to the
 * enclosing repository instead: it once set `core.bare` and a test identity in
 * a developer's real `.git/config`.
 */
export const GIT_LOCATION_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

/** Removes them in place, with the `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs `GIT_CONFIG_COUNT` names. */
export function dropGitLocation(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (
      (GIT_LOCATION_VARIABLES as readonly string[]).includes(name) ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)
    )
      delete env[name];
  }
}
