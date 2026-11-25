/**
 * The TanStack router plugin moves a route's page component into its own lazily loaded chunk,
 * but anything else the route file exports has to stay in the main bundle (the generated route
 * tree imports every route file), and a component used by both ends up in both chunks. The
 * profile, onboarding and calendar routes exported their forms and week grid for the tests, so
 * that code was shipped twice. Components the tests render live in src/components instead.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The names a module's top-level `export` statements declare. */
function exportedNames(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("export")) continue;
    const declared = line.match(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/,
    );
    names.push(declared ? declared[1] : line.trim());
  }
  return names;
}

const routeSource = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../src/routes/${file}`, import.meta.url)), "utf8");

describe("route files of the app shell export only their route", () => {
  it.each([
    "__root.tsx",
    "index.tsx",
    "login.tsx",
    "app.tsx",
    "app.profile.tsx",
    "app.calendar.tsx",
  ])("%s", (file) => {
    expect(exportedNames(routeSource(file))).toEqual(["Route"]);
  });

  it("onboarding.profile.tsx, apart from the step indicator the connectors step shares", () => {
    // Stepper was exported before these changes; onboarding.connectors.tsx imports it.
    expect(exportedNames(routeSource("onboarding.profile.tsx"))).toEqual(["Route", "Stepper"]);
  });

  it("reads export statements the way the check above needs", () => {
    expect(
      exportedNames(
        [
          "export const Route = x;",
          "export function ProfileForm() {}",
          "export interface Ev {}",
          "export { a } from './b';",
          "const notExported = 1;",
        ].join("\n"),
      ),
    ).toEqual(["Route", "ProfileForm", "Ev", "export { a } from './b';"]);
  });
});
