import type { BudgetRefusedOutcome } from "../services/tasks/transitionBudget.js";

/**
 * Typed in-transaction budget refusal from the retry writer's recovery-lane
 * headroom check (`requireClaimHeadroom`): thrown INSIDE the writer's
 * immediate transaction so the reset rolls back untouched; the service layer
 * maps it to the `refused` retry outcome for the typed 409 wire.
 *
 * Deliberately a runtime-leaf module (the transitionBudget import is
 * type-only, erased at runtime): the retry writer throws it and the service
 * matches it with instanceof across mock boundaries without either layer
 * importing the other's graph.
 */
export class RetryTransitionBudgetRefusedError extends Error {
  constructor(public readonly refusal: BudgetRefusedOutcome) {
    super("retry_transition_budget_refused");
    this.name = "RetryTransitionBudgetRefusedError";
  }
}
