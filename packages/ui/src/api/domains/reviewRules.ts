import { request } from "../transport.js";
import type {
  ReviewRule,
  ReviewRuleCreateInput,
  ReviewRuleUpdateInput,
} from "../../types/index.js";

export const reviewRulesApi = {
  list: (habitatId: string) =>
    request<{ reviewRules: ReviewRule[] }>(`/habitats/${habitatId}/review-rules`),
  create: (habitatId: string, body: ReviewRuleCreateInput) =>
    request<{ reviewRule: ReviewRule }>(`/habitats/${habitatId}/review-rules`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  update: (ruleId: string, body: ReviewRuleUpdateInput) =>
    request<{ reviewRule: ReviewRule }>(`/review-rules/${ruleId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  // Optional CAS expectation for empty-body clients; omitted = legacy LWW.
  delete: (ruleId: string, expectedVersion?: number) =>
    request<void>(
      `/review-rules/${ruleId}${expectedVersion !== undefined ? `?expectedVersion=${expectedVersion}` : ""}`,
      { method: "DELETE" },
    ),
};
