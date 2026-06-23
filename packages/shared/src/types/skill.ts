/** Exhaustive readonly list of habitat skill categories, including the v0.20.1 `anti_patterns` addition for `sidetracked` experience signals. */
export const SKILL_CATEGORIES = [
  "convention",
  "pattern",
  "pitfall",
  "domain_knowledge",
  "agent_insight",
  "anti_patterns",
] as const;

/** Union of the members of {@link SKILL_CATEGORIES}, representing a classified habitat skill signal. */
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];
