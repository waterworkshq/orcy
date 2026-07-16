/**
 * Failure-injection `DbClient` wrapper for the task-publication primitives (T1
 * Phase 3).
 *
 * Wraps a REAL-DB drizzle client (sql.js in tests, not a full mock — so SQLite
 * semantics such as UNIQUE constraints, RETURNING, ON CONFLICT DO NOTHING all
 * behave identically to production). Proxies the chainable-return shape so the
 * 9 `*WithClient` primitives cannot tell they are talking to a wrapper.
 *
 * Wraps `.insert()`, `.update()`, `.delete()` so each terminal `.run()` /
 * `.returning().all()` is counted as a write. `.select()` is passed through
 * (reads never fail). On the Nth write boundary (configurable via
 * `failAtWriteN`), the wrapper throws a deterministic error — the caller's
 * `db.transaction` then rolls back, proving the primitives are tx-aware and
 * never escape to `getDb()`.
 *
 * Does NOT expose `.transaction()` itself — the load-bearing invariant is that
 * the `*WithClient` primitives NEVER open their own transactions, so the
 * absence is intentional. A primitive that tried to start a nested tx would
 * fail loudly in tests.
 */
import type { TaskPublicationDbClient } from "../../repositories/taskPublication.js";

export type WriteKind = "insert" | "update" | "delete";

/** Record of a single write boundary that reached the wrapper. */
export interface WriteRecord {
  /** 1-based index of this write across the wrapper's lifetime. */
  index: number;
  /** Kind of write boundary (insert / update / delete). */
  kind: WriteKind;
  /** The table passed to the originating `.insert() / .update() / .delete()`. */
  table: unknown;
}

export interface FailureInjectorOptions {
  /**
   * The 1-based write boundary at which to throw. `null` = never throw
   * (wrapper still counts writes — useful for asserting writeCount after a
   * sequence).
   */
  failAtWriteN: number | null;
  /**
   * Optional factory for the injected error. Receives the {@link WriteRecord}
   * so tests can include context (table, kind, index) in the failure message.
   */
  errorFactory?: (record: WriteRecord) => Error;
}

/**
 * A deterministic-failure-injecting DbClient. Pass it to any `*WithClient`
 * primitive in place of `tx`. The primitive cannot tell the difference — the
 * wrapper preserves the chainable-return shape and proxies every method
 * through to the inner drizzle client.
 */
export class FailingDbClient {
  /** Number of write boundaries reached on this wrapper (1-based). */
  writeCount = 0;
  /** Append-only log of every write boundary reached. */
  writes: WriteRecord[] = [];
  /**
   * Number of SELECT chains initiated on this wrapper. Pass-through, never
   * fails. Useful for asserting that the `SELECT(max)→INSERT` order-allocation
   * sequence in `createTaskWithClient` BOTH happen on the passed client — a
   * leak to `getDb()` would under-count this.
   */
  readCount = 0;
  /** Current failure point. `null` = no failure injection. */
  failAtWriteN: number | null;
  /** Factory used to mint the injected error. */
  errorFactory: (record: WriteRecord) => Error;

  constructor(
    /** The real drizzle client the wrapper proxies. Tests can read this to verify state post-rollback. */
    public readonly inner: TaskPublicationDbClient,
    options: FailureInjectorOptions,
  ) {
    this.failAtWriteN = options.failAtWriteN;
    this.errorFactory =
      options.errorFactory ??
      ((record) =>
        new Error(
          `Injected failure at write #${record.index} (${record.kind}) for Phase 3 test`,
        ));
  }

  // ---------------------------------------------------------------------------
  // Public API — preserves the BaseSQLiteDatabase shape used by primitives.
  // ---------------------------------------------------------------------------

  /** Read chains are passed through to the inner client — reads never fail. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select(...args: any[]): any {
    this.readCount += 1;
    return (this.inner as unknown as { select: (...a: unknown[]) => unknown }).select(
      ...args,
    );
  }

  /** Wraps the insert builder so terminal `.run()` / `.all()` count as writes. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: unknown): any {
    const innerBuilder = (
      this.inner as unknown as { insert: (t: unknown) => unknown }
    ).insert(table);
    return this.wrapChain(innerBuilder, "insert", table);
  }

  /** Wraps the update builder so terminal `.run()` / `.all()` count as writes. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(table: unknown): any {
    const innerBuilder = (
      this.inner as unknown as { update: (t: unknown) => unknown }
    ).update(table);
    return this.wrapChain(innerBuilder, "update", table);
  }

  /** Wraps the delete builder so terminal `.run()` / `.all()` count as writes. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(table: unknown): any {
    const innerBuilder = (
      this.inner as unknown as { delete: (t: unknown) => unknown }
    ).delete(table);
    return this.wrapChain(innerBuilder, "delete", table);
  }

  /**
   * INTENTIONALLY OMITTED: `.transaction()`. The load-bearing invariant is
   * that the `*WithClient` primitives NEVER open their own transactions.
   * Exposing `.transaction()` here would mask a regression in that invariant.
   */

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** Resets counters. Use between successive tx within one test. */
  reset(): void {
    this.writeCount = 0;
    this.readCount = 0;
    this.writes = [];
  }

  /** Reconfigure the failure point (e.g. between successive calls). */
  setFailAt(n: number | null): void {
    this.failAtWriteN = n;
  }

  /**
   * Convenience: returns the kind+table of the write that reached the Nth
   * boundary (or `undefined` if fewer writes happened). Useful for
   * "what got injected at the boundary" assertions.
   */
  writeAt(n: number): WriteRecord | undefined {
    return this.writes[n - 1];
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Wraps a drizzle builder (insert/update/delete) so the terminal write
   * boundaries (`.run()` and `.all()`) are intercepted, counted, and
   * optionally thrown. Chaining methods are re-bound to the real builder and
   * re-wrapped so the kind/table context propagates through the chain.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wrapChain(builder: unknown, kind: WriteKind, table: unknown): any {
    return new Proxy(builder as object, {
      get: (target, prop, receiver) => {
        // Write boundaries — intercept, count, and (maybe) throw.
        if (prop === "run") {
          return () => {
            this.recordWrite(kind, table);
            return (target as { run: () => unknown }).run();
          };
        }
        if (prop === "all") {
          return () => {
            this.recordWrite(kind, table);
            return (target as { all: () => unknown }).all();
          };
        }
        // `.get()` on an insert/update/delete chain is a read terminal
        // (e.g. drizzle uses `.get()` for single-row RETURNING on some
        // builders). Pass through without counting as a write — it is the
        // INSERT/UPDATE that committed, not the read.
        if (prop === "get") {
          return () => (target as { get: () => unknown }).get();
        }
        // Chaining methods (values, set, where, from, returning,
        // onConflictDoNothing, onConflictDoUpdate, limit, offset, orderBy, …).
        // Re-bind on the real builder, then re-wrap so subsequent chain calls
        // keep the same kind/table context.
        const value = Reflect.get(target as object, prop, receiver);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, args);
            return this.wrapChain(result, kind, table);
          };
        }
        return value;
      },
    });
  }

  private recordWrite(kind: WriteKind, table: unknown): void {
    this.writeCount += 1;
    const record: WriteRecord = { index: this.writeCount, kind, table };
    this.writes.push(record);
    if (this.failAtWriteN !== null && this.writeCount === this.failAtWriteN) {
      throw this.errorFactory(record);
    }
  }
}