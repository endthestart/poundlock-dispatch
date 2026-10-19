import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverProjectVerification } from "@core/project-verification";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

it("does not invent framework-specific checks from a project entry script", async () => {
  const root = await tempDir("dispatch-checks-");
  await writeFile(join(root, "manage.py"), "#!/usr/bin/env python3\n");
  await mkdir(join(root, ".venv", "bin"), { recursive: true });
  await writeFile(join(root, ".venv", "bin", "python"), "");
  expect(await discoverProjectVerification(root)).toEqual([]);
});

it("discovers Django checks when the project declares Django and has manage.py", async () => {
  const root = await tempDir("dispatch-checks-");
  await writeFile(join(root, "manage.py"), "#!/usr/bin/env python3\n");
  await writeFile(
    join(root, "pyproject.toml"),
    '[project]\nname = "tasks"\ndependencies = [\n    "django>=5.2",\n]\n',
  );
  await mkdir(join(root, ".venv", "bin"), { recursive: true });
  await writeFile(join(root, ".venv", "bin", "python"), "");
  expect(await discoverProjectVerification(root)).toEqual([
    ".venv/bin/python manage.py check",
    ".venv/bin/python manage.py test",
  ]);
  const plain = await tempDir("dispatch-checks-");
  await writeFile(join(plain, "manage.py"), "");
  await writeFile(join(plain, "requirements.txt"), "Django==5.2\n");
  expect(await discoverProjectVerification(plain)).toEqual([
    "python3 manage.py check",
    "python3 manage.py test",
  ]);
});

it("discovers Django checks from Django installed in the project environment", async () => {
  const root = await tempDir("dispatch-checks-");
  await writeFile(join(root, "manage.py"), "");
  await mkdir(join(root, ".venv", "bin"), { recursive: true });
  await writeFile(join(root, ".venv", "bin", "python"), "");
  await mkdir(join(root, ".venv", "lib", "python3.14", "site-packages", "django"), {
    recursive: true,
  });
  expect(await discoverProjectVerification(root)).toEqual([
    ".venv/bin/python manage.py check",
    ".venv/bin/python manage.py test",
  ]);
});

it("discovers pytest from project metadata and a local interpreter", async () => {
  const root = await tempDir("dispatch-checks-");
  await writeFile(join(root, "pytest.ini"), "[pytest]\n");
  await mkdir(join(root, ".venv", "bin"), { recursive: true });
  await writeFile(join(root, ".venv", "bin", "python"), "");
  expect(await discoverProjectVerification(root)).toEqual([".venv/bin/python -m pytest"]);
});

it("checks a Swift package, alone or beside a Rust core", async () => {
  const root = await tempDir("dispatch-checks-");
  await writeFile(join(root, "Package.swift"), "// swift-tools-version:5.9\n");
  expect(await discoverProjectVerification(root)).toEqual(["swift build", "swift test"]);
  await writeFile(join(root, "Cargo.toml"), "[workspace]\n");
  expect(await discoverProjectVerification(root)).toEqual([
    "cargo test",
    "cargo check",
    "swift build",
    "swift test",
  ]);
});

it("discovers unittest from a conventional tests directory", async () => {
  const root = await tempDir("dispatch-checks-");
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests", "test_app.py"), "def test_ok():\n    assert True\n");
  expect(await discoverProjectVerification(root)).toEqual(["python3 -m unittest"]);
});

it("uses commands declared by package scripts", async () => {
  const root = await tempDir("dispatch-checks-");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest", lint: "biome check", release: "no" } }),
  );
  expect(await discoverProjectVerification(root)).toEqual(["npm test", "npm run lint"]);
});

it("ignores a partially written package manifest", async () => {
  const root = await tempDir("dispatch-checks-");
  await writeFile(join(root, "package.json"), "{");
  await expect(discoverProjectVerification(root)).resolves.toEqual([]);
});
