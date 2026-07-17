/**
 * Compact causal context connecting a publication or event to its origin chain.
 *
 * `root` is the originating action (human request, scheduled occurrence, import,
 * plugin run, workflow recovery run, automation rule run). `parent` is the
 * immediate predecessor when a deeper chain exists. `hops` preserve each
 * appended Rule/Run hop for chain-membership inspection (cycle + depth-limit
 * detection).
 *
 * Server-constructed — untrusted callers cannot assert privileged run or actor
 * identities via this shape. See Task-Creation Technical Plan § "Provenance
 * and Automation Cycle Safety".
 */

/** Compact causal context connecting a publication or event to its origin chain. */
export interface CausalContext {
  root: CausalRef;
  parent?: CausalRef;
  hops?: CausalHop[];
}

/** One typed reference inside a {@link CausalContext} (root/parent/hop). */
export interface CausalRef {
  type: string;
  id: string;
}

/** One appended rule/run hop inside a {@link CausalContext}. */
export interface CausalHop {
  type: string;
  id: string;
  label?: string;
}