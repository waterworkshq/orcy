import { api } from "../client.js";

export function registerSkillCommands(program: any) {
  // Note: CLI uses "habitatId" for user-facing clarity.
  // MCP/API layers use "boardId" for the same field — they map to the same UUID.
  const skill = program.command("skill").description("Habitat dynamic skill operations");

  skill
    .command("get")
    .description("Get the current skill document for a habitat")
    .argument("<habitatId>", "Habitat UUID")
    .action(async (habitatId: string) => {
      try {
        const result = await api.get<any>(`/api/habitats/${habitatId}/skill`);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Failed to get skill: ${err.message}`);
        process.exit(1);
      }
    });

  skill
    .command("refresh")
    .description("Regenerate the skill document for a habitat from accumulated signals")
    .argument("<habitatId>", "Habitat UUID")
    .action(async (habitatId: string) => {
      try {
        const result = await api.post<any>(`/api/habitats/${habitatId}/skill/refresh`, {});
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Failed to refresh skill: ${err.message}`);
        process.exit(1);
      }
    });

  skill
    .command("contribute")
    .description("Manually contribute an insight to a habitat skill")
    .argument("<habitatId>", "Habitat UUID")
    .requiredOption("--insight <text>", "The insight text to contribute")
    .option("--category <category>", "Category for the insight")
    .choices("category", ["convention", "pattern", "pitfall", "domain_knowledge", "agent_insight"])
    .action(async (habitatId: string, options: any) => {
      const body: Record<string, any> = { insight: options.insight };
      if (options.category) body.skillCategory = options.category;

      try {
        const result = await api.post<any>(`/api/habitats/${habitatId}/skill/contribute`, body);
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Failed to contribute insight: ${err.message}`);
        process.exit(1);
      }
    });

  skill
    .command("signals")
    .description("List signals accumulated for a habitat skill")
    .argument("<habitatId>", "Habitat UUID")
    .option("--limit <n>", "Max signals", "20")
    .action(async (habitatId: string, options: any) => {
      const params = new URLSearchParams();
      if (options.limit) params.set("limit", options.limit);
      const query = params.toString();

      try {
        const result = await api.get<any>(
          `/api/habitats/${habitatId}/skill/signals${query ? `?${query}` : ""}`,
        );
        console.log(JSON.stringify(result, null, 2));
      } catch (err: any) {
        console.error(`Failed to list signals: ${err.message}`);
        process.exit(1);
      }
    });
}
