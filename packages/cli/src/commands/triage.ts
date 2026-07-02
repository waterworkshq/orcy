import { api } from "../client.js";
import { withErrorHandling } from "../error-handler.js";
import { RELEASE_TYPES } from "@orcy/shared";

/** Registers the `orcy triage` subcommands on the given {@link Command}. */
export function registerTriageCommands(program: any) {
  const triage = program.command("triage").description("Triage and release operations");

  triage
    .command("release-trigger")
    .description("Record a detected release and (when activation ships) trigger auto-promotion")
    .argument("<habitat-id>", "Habitat UUID")
    .requiredOption("--version <version>", "Released version (e.g. v0.24.0 or 0.24.0)")
    .option(
      "--type <type>",
      `Release type override / first-release declaration: ${RELEASE_TYPES.join(", ")}`,
    )
    .option("--notes <notes>", "Release notes")
    .action(
      withErrorHandling(
        async (habitatId: string, options: { version: string; type?: string; notes?: string }) => {
          const body: Record<string, unknown> = {
            habitatId,
            version: options.version,
            detectedBy: "cli",
          };
          if (options.type) {
            if (!RELEASE_TYPES.includes(options.type as (typeof RELEASE_TYPES)[number])) {
              throw new Error(
                `Invalid release type '${options.type}'. Must be one of: ${RELEASE_TYPES.join(", ")}`,
              );
            }
            body.releaseType = options.type;
          }
          if (options.notes) body.releaseNotes = options.notes;

          const result = await api.post<Record<string, unknown>>(
            "/api/triage/release-trigger",
            body,
          );
          console.log(JSON.stringify(result, null, 2));
        },
      ),
    );
}
