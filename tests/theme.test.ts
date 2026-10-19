import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const themeCssPath = join(repoRoot, "src/renderer/theme.css");
const stylesCssPath = join(repoRoot, "src/renderer/styles.css");
const themeJsonPath = join(repoRoot, "src/shared/theme.json");

// Poundlock generates these; when it is checked out beside this worktree
// (which is itself a sibling checkout, so ../poundlock resolves the same way
// from here) the vendored copies must be byte-for-byte what it produced.
const ownerThemeCss = join(repoRoot, "../poundlock/web/theme.css");
const ownerThemeJson = join(repoRoot, "../poundlock/docs/design/theme.json");
const ownerFonts = join(repoRoot, "../poundlock/web/fonts");

describe("vendored theme drift", () => {
  it("matches the owner's theme.css when ../poundlock is checked out", () => {
    if (!existsSync(ownerThemeCss)) return;
    expect(readFileSync(themeCssPath, "utf8")).toBe(readFileSync(ownerThemeCss, "utf8"));
  });

  it("matches the owner's theme.json when ../poundlock is checked out", () => {
    if (!existsSync(ownerThemeJson)) return;
    expect(readFileSync(themeJsonPath, "utf8")).toBe(readFileSync(ownerThemeJson, "utf8"));
  });

  it("matches the owner's fonts when ../poundlock is checked out", () => {
    if (!existsSync(ownerFonts)) return;
    for (const name of ["inter.woff2", "jetbrains-mono.woff2"]) {
      expect(readFileSync(join(repoRoot, "src/renderer/fonts", name))).toEqual(
        readFileSync(join(ownerFonts, name)),
      );
    }
  });
});

const flavours = ["latte", "frappe", "macchiato", "mocha"] as const;

function parseThemeRoles(css: string): Record<(typeof flavours)[number], Record<string, string>> {
  const roles: Record<string, Record<string, string>> = {};
  for (const flavour of flavours) {
    const block = new RegExp(`:root\\[data-theme="${flavour}"\\]\\s*\\{([^}]+)\\}`).exec(css);
    if (!block) throw new Error(`theme.css is missing the ${flavour} block`);
    const vars: Record<string, string> = {};
    for (const match of block[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
      vars[match[1]] = match[2].trim();
    }
    roles[flavour] = vars;
  }
  return roles as Record<(typeof flavours)[number], Record<string, string>>;
}

const themeCss = readFileSync(themeCssPath, "utf8");
const stylesCss = readFileSync(stylesCssPath, "utf8");
const themeRoles = parseThemeRoles(themeCss);

function rootAliasBlock(css: string): string {
  const match = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!match) throw new Error("styles.css is missing its :root block");
  return match[1];
}

describe("styles.css theming discipline", () => {
  it("has no literal colours outside var()/color-mix()/transparent/currentColor", () => {
    // Strip comments first so example values in prose comments don't trip this up.
    const withoutComments = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders: string[] = [];
    for (const [lineNumber, line] of withoutComments.split("\n").entries()) {
      const withoutFunctionalColors = line.replace(/color-mix\([^)]*\)/g, "");
      const hit = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(withoutFunctionalColors);
      if (hit) offenders.push(`line ${lineNumber + 1}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it("defines every var(--x) used in styles.css, in theme.css or the alias block", () => {
    const alias = rootAliasBlock(stylesCss);
    const aliasNames = new Set([...alias.matchAll(/--([a-z0-9-]+):/g)].map((match) => match[1]));
    const themeNames = new Set(Object.keys(themeRoles.mocha));
    const used = new Set(
      [...stylesCss.matchAll(/var\(--([a-z0-9-]+)(?:,|\))/g)].map((match) => match[1]),
    );
    const undefinedNames = [...used].filter(
      (name) => !aliasNames.has(name) && !themeNames.has(name),
    );
    expect(undefinedNames).toEqual([]);
  });

  it("does not reference the removed --review-tint alias or the unused pulse keyframes", () => {
    expect(stylesCss).not.toMatch(/--review-tint/);
    expect(stylesCss).not.toMatch(/@keyframes pulse/);
  });
});

describe("theme.json contrast", () => {
  const themeJson = JSON.parse(readFileSync(themeJsonPath, "utf8")) as {
    flavours: Record<string, { roles: Record<string, string> }>;
  };

  function hexToLinear(channel: number): number {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  function relativeLuminance(hex: string): number {
    const value = hex.replace("#", "");
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    return 0.2126 * hexToLinear(r) + 0.7152 * hexToLinear(g) + 0.0722 * hexToLinear(b);
  }

  function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
    return (lighter + 0.05) / (darker + 0.05);
  }

  it("keeps --text on --s2 at 4.5:1 or better in every flavour", () => {
    for (const [name, flavour] of Object.entries(themeJson.flavours)) {
      const ratio = contrastRatio(flavour.roles.text, flavour.roles.s2);
      expect(ratio, `${name}: text on s2`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("theme font licences", () => {
  it("vendors the Inter and JetBrains Mono OFL licences alongside the font files", () => {
    const files = readdirSync(join(repoRoot, "src/renderer/fonts"));
    expect(files).toEqual(
      expect.arrayContaining([
        "inter.woff2",
        "jetbrains-mono.woff2",
        "INTER-LICENSE",
        "JETBRAINS-MONO-LICENSE",
      ]),
    );
  });
});
