import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "./file-access.js";

async function pythonInterpreter(root: string): Promise<string> {
  const local = ".venv/bin/python";
  return (await exists(join(root, local))) ? local : "python3";
}

async function venvHasPackage(root: string, name: string): Promise<boolean> {
  const lib = join(root, ".venv", "lib");
  const versions = await readdir(lib).catch(() => [] as string[]);
  for (const version of versions) {
    const site = await readdir(join(lib, version, "site-packages")).catch(() => [] as string[]);
    if (
      site.some(
        (entry) => entry.toLowerCase() === name || entry.toLowerCase().startsWith(`${name}-`),
      )
    )
      return true;
  }
  return false;
}

/**
 * Discover commands declared by the repository after setup. This is a bounded,
 * deterministic fallback when a project has no saved verification defaults.
 * Commands come from project metadata and conventional test entry points, not
 * from framework-specific product rules.
 */
async function discoverPythonVerification(root: string): Promise<string[] | undefined> {
  const python = await pythonInterpreter(root);
  const pyproject = await readFile(join(root, "pyproject.toml"), "utf8").catch(() => "");
  const requirements = await readFile(join(root, "requirements.txt"), "utf8").catch(() => "");
  const hasPytestConfig =
    (await exists(join(root, "pytest.ini"))) || /\[tool\.pytest/.test(pyproject);
  const hasPytestDependency =
    /(?:^|\n)\s*pytest[\s=<>]/.test(requirements) || /(?:^|\n)pytest\s*=/.test(pyproject);
  if (hasPytestConfig || hasPytestDependency) return [`${python} -m pytest`];

  // Django keeps tests inside each app and runs them through manage.py, so a
  // fresh project has no top-level tests directory. Require Django to be
  // declared or installed in the project's own environment: an entry script
  // alone is not evidence.
  const declaresDjango =
    /(?:^|\n)\s*django[\s=<>~!\[]/i.test(requirements) ||
    /["']django(?:[\s=<>~!\[][^"']*)?["']/i.test(pyproject);
  if (
    (declaresDjango || (await venvHasPackage(root, "django"))) &&
    (await exists(join(root, "manage.py")))
  )
    return [`${python} manage.py check`, `${python} manage.py test`];

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const hasUnittestTree = entries.some(
    (entry) =>
      (entry.isDirectory() && (entry.name === "tests" || entry.name === "test")) ||
      (entry.isFile() && /^test_.*\.py$/.test(entry.name)),
  );
  if (hasUnittestTree) return [`${python} -m unittest`];
  return undefined;
}

export async function discoverProjectVerification(root: string): Promise<string[]> {
  const packageFile = join(root, "package.json");
  if (await exists(packageFile)) {
    try {
      const packageJson = JSON.parse(await readFile(packageFile, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = packageJson.scripts ?? {};
      return ["test", "typecheck", "lint", "build"]
        .filter((name) => typeof scripts[name] === "string" && scripts[name].trim())
        .map((name) => (name === "test" ? "npm test" : `npm run ${name}`));
    } catch {
      // A partially written manifest is not an instruction and should not stop review.
    }
  }
  // A Swift package beside a Rust core, as a native macOS shell over it, is checked too.
  const swift = (await exists(join(root, "Package.swift"))) ? ["swift build", "swift test"] : [];
  if (await exists(join(root, "Cargo.toml"))) return ["cargo test", "cargo check", ...swift];
  if (swift.length) return swift;
  if (await exists(join(root, "go.mod"))) return ["go test ./...", "go vet ./..."];
  if (await exists(join(root, "Makefile"))) {
    const makefile = await readFile(join(root, "Makefile"), "utf8");
    return ["test", "check", "build"]
      .filter((target) => new RegExp(`^${target}:`, "m").test(makefile))
      .map((target) => `make ${target}`);
  }
  return (await discoverPythonVerification(root)) ?? [];
}
