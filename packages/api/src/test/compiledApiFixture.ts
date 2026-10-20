import { beforeAll, afterAll } from "vitest";
import { createWorkspaceApiLayout, type CompiledApiLayout } from "./compiledApiLayout.js";

/**
 * Fixture façade over the compiled-artifact seam.
 *
 * The fixture used to compile the api package once per consuming test file —
 * eleven concurrent compilers in a default-parallelism run. It now arranges
 * the run's single shared compiled artifact into a private workspace layout.
 *
 * The seam contract holds: publishing lives in the artifact module, layout
 * lives in the layout module, and this façade never compiles anything.
 */
export function useCompiledApi(): { distDir: string; entrypoint: string } {
  const fixture = { distDir: "", entrypoint: "" };
  let layout: CompiledApiLayout | undefined;

  beforeAll(() => {
    layout = createWorkspaceApiLayout();
    fixture.distDir = layout.distDir;
    fixture.entrypoint = layout.entrypoint;
  }, 120_000);

  afterAll(() => {
    layout?.cleanup();
  });

  return fixture;
}
