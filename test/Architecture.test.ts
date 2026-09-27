import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Three packages: a shared core and two independent flavours. These rules keep
 * them apart, so each flavour ships and installs on its own:
 *   core          → imports nothing from the other packages
 *   unit-of-work  → imports @chronicle/core, never @chronicle/event-log
 *   event-log     → imports @chronicle/core, never @chronicle/unit-of-work
 * and no package reaches into another's files with a relative path.
 */
const root = path.resolve(__dirname, "..");
const packages = ["core", "unit-of-work", "event-log"] as const;
type Pkg = (typeof packages)[number];

const allowedPackages: Record<Pkg, string[]> = {
  "core": [],
  "unit-of-work": ["@chronicle/core"],
  "event-log": ["@chronicle/core"],
};

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return [...text.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

/** A violation, or undefined if `specifier` is allowed from `file` in package `pkg`. */
function check(pkg: Pkg, file: string, specifier: string): string | undefined {
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(file), specifier);
    const own = path.join(root, "packages", pkg, "src");
    return target.startsWith(own + path.sep) ? undefined : `relative import leaves the package: ${specifier}`;
  }
  if (specifier.startsWith("@chronicle/")) {
    return allowedPackages[pkg].includes(specifier) ? undefined : `imports ${specifier}`;
  }
  return undefined; // third-party / node built-ins
}

const sourcesOf = (pkg: Pkg) => fs.readdirSync(path.join(root, "packages", pkg, "src")).filter((f) => f.endsWith(".ts"));

describe("architecture: core, unit-of-work and event-log stay separate", () => {
  for (const pkg of packages) {
    it(`${pkg} imports only ${allowedPackages[pkg].join(", ") || "itself"}`, () => {
      const files = sourcesOf(pkg);
      expect(files.length).toBeGreaterThan(0);
      const violations: string[] = [];
      for (const f of files) {
        const file = path.join(root, "packages", pkg, "src", f);
        for (const spec of importsOf(file)) {
          const problem = check(pkg, file, spec);
          if (problem) violations.push(`${pkg}/${f}: ${problem}`);
        }
      }
      expect(violations).toEqual([]);
    });

    it(`${pkg} declares @chronicle dependencies only as peers`, () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "packages", pkg, "package.json"), "utf8"));
      expect(Object.keys(manifest.dependencies ?? {}).filter((d) => d.startsWith("@chronicle/"))).toEqual([]);
      expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(allowedPackages[pkg]);
    });
  }

  it("the three packages are released together, at the same version", () => {
    const versions = packages.map((pkg) => JSON.parse(fs.readFileSync(path.join(root, "packages", pkg, "package.json"), "utf8")).version);
    expect(new Set(versions).size).toBe(1);
  });

  it("the rule itself catches violations", () => {
    const file = path.join(root, "packages", "unit-of-work", "src", "Probe.ts");
    expect(check("unit-of-work", file, "@chronicle/event-log")).toBe("imports @chronicle/event-log");
    expect(check("unit-of-work", file, "../../core/src/Tracker")).toMatch(/leaves the package/);
    expect(check("unit-of-work", file, "./Entity")).toBeUndefined();
    expect(check("unit-of-work", file, "@chronicle/core")).toBeUndefined();
    expect(check("core", file, "typescript")).toBeUndefined();
  });
});
