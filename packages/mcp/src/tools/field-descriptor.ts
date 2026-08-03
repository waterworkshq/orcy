import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KanbanApiClient } from "../api.js";
import {
  createDispatchTool,
  createDispatchHandler,
  type Handler,
  type ToolHandler,
} from "./dispatch-utils.js";

/** A field marker carries the JSON-schema wire fragment + optionality for one shared parameter. */
export interface FieldMarker<T = unknown> {
  readonly isOptional: boolean;
  readonly wire: Record<string, unknown>;
  optional(): FieldMarker<T>;
  readonly __type?: T;
}

type WireOpts = { description?: string } & Record<string, unknown>;

function make<T>(wire: Record<string, unknown>, isOptional = false): FieldMarker<T> {
  return { isOptional, wire, optional: () => make<T>(wire, true) } as FieldMarker<T>;
}

/** Field markers; each factory's `wire` is the JSON-schema fragment. */
export const field = {
  string: (w: WireOpts = {}): FieldMarker<string> => make<string>({ type: "string", ...w }),
  number: (w: WireOpts = {}): FieldMarker<number> => make<number>({ type: "number", ...w }),
  boolean: (w: WireOpts = {}): FieldMarker<boolean> => make<boolean>({ type: "boolean", ...w }),
  array: <T = unknown>(items: Record<string, unknown>, w: WireOpts = {}): FieldMarker<T[]> =>
    make<T[]>({ type: "array", items, ...w }),
  enum: (values: string[], w: WireOpts = {}): FieldMarker<string> =>
    make<string>({ type: "string", enum: values, ...w }),
};

/** Descriptor record → TS args shape (every field mapped to its TS type). */
export type ArgsOf<D extends Record<string, FieldMarker>> = {
  [K in keyof D]: D[K] extends FieldMarker<infer T> ? T : never;
};

/** Descriptor record → required list (non-optional keys, insertion order). */
export function requiredFrom(args: Record<string, FieldMarker>): string[] {
  return Object.keys(args).filter((k) => !args[k].isOptional);
}

/** Field registry → flat `properties` object, in registry-key order. Unique keys give structural conflict-detection. */
export function wirePropertiesFrom(registry: Record<string, FieldMarker>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, marker] of Object.entries(registry)) props[name] = marker.wire;
  return props;
}

/** One action: its args + handler. `enumLast` appends it to the descriptor action-enum. `execute` is declared as a method so its parameters are checked bivariantly (under `strictFunctionTypes`, methods keep the bivariant carve-out): existing handlers that already type their own `args` therefore assign cleanly without per-entry signature edits, while the per-entry `args` record still types each handler's `args` via {@link ArgsOf} (catching typos where `args` is inferred from the descriptor — e.g. the batch inline arrows). */
export interface ActionEntry<A extends Record<string, FieldMarker> = Record<string, FieldMarker>> {
  readonly args: A;
  execute(client: KanbanApiClient, args: ArgsOf<A>): unknown | Promise<unknown>;
  readonly enumLast?: boolean;
}

/** Builds the action enum, shared `properties`, per-action required map, and handler map from one declaration, then calls {@link createDispatchTool} + {@link createDispatchHandler}. Handler-map key order = `actions` insertion order (drives "Valid actions:"); `enumLast` entries append to the descriptor enum. */
export function defineActions<A extends Record<string, Record<string, FieldMarker>>>(config: {
  name: string;
  description: string;
  fields: Record<string, FieldMarker>;
  actions: { [K in keyof A]: ActionEntry<A[K]> };
}): { tool: Tool; handler: ToolHandler; actions: Record<string, Handler> } {
  const keys = Object.keys(config.actions);
  const handlerMap: Record<string, Handler> = {};
  const requiredFor: Record<string, string[]> = {};
  for (const k of keys) {
    handlerMap[k] = config.actions[k].execute;
    requiredFor[k] = requiredFrom(config.actions[k].args);
  }
  const enumOrder = [
    ...keys.filter((k) => !config.actions[k].enumLast),
    ...keys.filter((k) => config.actions[k].enumLast),
  ];
  return {
    tool: createDispatchTool({
      name: config.name,
      description: config.description,
      actions: enumOrder,
      sharedParams: wirePropertiesFrom(config.fields),
    }),
    handler: createDispatchHandler(handlerMap, requiredFor),
    actions: handlerMap,
  };
}
