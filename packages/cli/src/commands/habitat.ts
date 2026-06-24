import { api } from "../client.js";
import { withErrorHandling } from "../error-handler.js";

/** Registers the `orcy habitat` subcommands (list, find, settings, summary, metrics) on the given {@link Command}. */
export function registerHabitatCommands(program: any) {
  const habitat = program.command("habitat").description("Habitat-level operations");

  habitat
    .command("list")
    .description("List all available habitats")
    .action(
      withErrorHandling(async () => {
        const result = await api.get<any>("/api/boards");
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  habitat
    .command("find")
    .description("Find a habitat by name")
    .argument("<name>", "Habitat name to search for")
    .action(
      withErrorHandling(async (name: string) => {
        const result = await api.get<any>(`/api/boards?name=${encodeURIComponent(name)}`);
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  habitat
    .command("get-settings")
    .description("Get habitat settings and metadata")
    .argument("<habitatId>", "Habitat UUID")
    .action(
      withErrorHandling(async (habitatId: string) => {
        const result = await api.get<any>(`/api/boards/${habitatId}`);
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  habitat
    .command("update-settings")
    .description("Update habitat name, description, and/or automation execution")
    .argument("<habitatId>", "Habitat UUID")
    .option("--name <name>", "New habitat name")
    .option("--description <desc>", "New habitat description")
    .option("--automation-execution <on|off>", "Enable or disable automation action execution")
    .action(
      withErrorHandling(
        async (
          habitatId: string,
          options: {
            name?: string;
            description?: string;
            automationExecution?: string;
          },
        ) => {
          const body: Record<string, unknown> = {};
          if (options.name) body.name = options.name;
          if (options.description) body.description = options.description;
          if (options.automationExecution) {
            const enabled = options.automationExecution === "on";
            body.automationSettings = { executeActions: enabled };
          }
          const result = await api.patch<any>(`/api/boards/${habitatId}`, body);
          console.log(JSON.stringify(result, null, 2));
        },
      ),
    );

  habitat
    .command("summary")
    .description("Get habitat activity summary")
    .argument("<habitatId>", "Habitat UUID")
    .option("--since <range>", "Time range: 24h, 7d, 30d, all", "7d")
    .option("--max-tasks <n>", "Max task narratives", "20")
    .option("--no-digest", "Exclude markdown digest")
    .action(
      withErrorHandling(
        async (
          habitatId: string,
          options: { since: string; maxTasks: string; digest: boolean },
        ) => {
          const params = new URLSearchParams({ since: options.since, maxTasks: options.maxTasks });
          if (!options.digest) params.set("includeDigest", "false");
          const result = await api.get<any>(`/api/boards/${habitatId}/summary?${params}`);
          console.log(JSON.stringify(result, null, 2));
        },
      ),
    );

  habitat
    .command("metrics")
    .description("Get habitat performance metrics")
    .argument("<habitatId>", "Habitat UUID")
    .action(
      withErrorHandling(async (habitatId: string) => {
        const result = await api.get<any>(`/api/boards/${habitatId}/metrics`);
        console.log(JSON.stringify(result, null, 2));
      }),
    );
}
