import { describe, it, expectTypeOf } from 'vitest';
import type { FastifyTypeProvider } from 'fastify';
import { z } from 'zod';

/**
 * Compile-time smoke test: verify that a custom Zod v3-compatible type provider
 * correctly infers request.body / request.query / request.params types.
 *
 * This mirrors the setup in src/index.ts and the pilot routes in
 * src/routes/tasks/crud.ts and src/routes/features.ts.
 */

interface ZodV3TypeProvider extends FastifyTypeProvider {
  validator: this['schema'] extends z.ZodTypeAny ? z.infer<this['schema']> : unknown;
  serializer: this['schema'] extends z.ZodTypeAny ? z.infer<this['schema']> : unknown;
}

describe('ZodTypeProvider compile-time types', () => {
  it('infers body from Zod schema', () => {
    const bodySchema = z.object({ title: z.string(), priority: z.enum(['low', 'medium', 'high']) });
    type InferredBody = (ZodV3TypeProvider & { schema: typeof bodySchema })['validator'];
    expectTypeOf<InferredBody>().toEqualTypeOf<{ title: string; priority: 'low' | 'medium' | 'high' }>();
  });

  it('infers query from Zod schema', () => {
    const querySchema = z.object({ limit: z.number().optional(), offset: z.number().optional() });
    type InferredQuery = (ZodV3TypeProvider & { schema: typeof querySchema })['validator'];
    expectTypeOf<InferredQuery>().toEqualTypeOf<{ limit?: number; offset?: number }>();
  });

  it('infers params from Zod schema', () => {
    const paramsSchema = z.object({ id: z.string() });
    type InferredParams = (ZodV3TypeProvider & { schema: typeof paramsSchema })['validator'];
    expectTypeOf<InferredParams>().toEqualTypeOf<{ id: string }>();
  });

  it('falls back to unknown for non-Zod schemas', () => {
    type Inferred = (ZodV3TypeProvider & { schema: string })['validator'];
    expectTypeOf<Inferred>().toEqualTypeOf<unknown>();
  });
});
