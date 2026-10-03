/**
 * Focused pure-time matrix for the effective-grant-time decision primitive.
 *
 * The contract's worked examples state instants as bare numbers (E=100,
 * now=110). They are rendered here through {@link at} into the exact
 * provisioning-grammar ISO form a persisted row actually holds, so the
 * assertions exercise the real grammar rather than a loosened stand-in.
 *
 * Every case asserts the exact `state` AND the exact computed window, because
 * the window is where the timestamp-precedence rules are observable: a start
 * that drifted to the sweep stamp, or to a later revocation, changes these
 * numbers and fails here.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateGrantTime,
  isEffectivelyActive,
  isEffectivelyUsable,
  GRACE_WINDOW_MS_PER_HOUR,
  type EffectiveGrantState,
  type GrantTimeInput,
} from "../services/remoteGrantTime.js";

const HOUR = GRACE_WINDOW_MS_PER_HOUR;
const DEFAULT_WINDOW_MS = 24 * HOUR;

const at = (ms: number): string => new Date(ms).toISOString();

function grant(over: Partial<GrantTimeInput> = {}): GrantTimeInput {
  return {
    status: "active",
    expiresAt: null,
    expiredAt: null,
    revokedAt: null,
    graceWindowHours: 24,
    ...over,
  };
}

const GRACE_STATUSES = ["expired", "grace"] as const;

describe("evaluateGrantTime — per-status field table", () => {
  it("hard_revoked, frozen and unknown statuses are blocked with no timestamp or window able to restore authority", () => {
    const fullyStamped = {
      expiresAt: at(100),
      expiredAt: at(100),
      revokedAt: at(100),
      graceWindowHours: 720,
    };
    for (const status of ["hard_revoked", "frozen", "pending", "", "grace_period"]) {
      const evaluated = evaluateGrantTime(grant({ ...fullyStamped, status }), 110);
      expect(evaluated.state, status).toBe("blocked");
      expect(evaluated.graceStartMs, status).toBeNull();
      expect(evaluated.graceEndMs, status).toBeNull();
    }
  });

  it("active with a null expiry is active and non-expiring", () => {
    const evaluated = evaluateGrantTime(grant({ expiresAt: null }), 1_000_000_000_000);
    expect(evaluated.state).toBe("active");
    expect(evaluated.graceStartMs).toBeNull();
  });

  it("active before its deadline is active; at the deadline it is no longer active", () => {
    expect(evaluateGrantTime(grant({ expiresAt: at(200) }), 199).state).toBe("active");
    expect(evaluateGrantTime(grant({ expiresAt: at(200) }), 200).state).toBe("grace");
  });

  it("active with a malformed expiry is blocked", () => {
    expect(evaluateGrantTime(grant({ expiresAt: "not-a-date" }), 100).state).toBe("blocked");
    // A date-only or numeric string is NOT accepted through Date.parse coercion.
    expect(evaluateGrantTime(grant({ expiresAt: "2026-10-03" }), 100).state).toBe("blocked");
    expect(evaluateGrantTime(grant({ expiresAt: "100" }), 100).state).toBe("blocked");
  });
});

describe("evaluateGrantTime — the contract's concrete mixed-state rows", () => {
  // Each entry: [label, grant, now, expected state, expected graceStartMs]
  const rows: Array<[string, GrantTimeInput, number, EffectiveGrantState, number | null]> = [
    [
      "E=100 X=50 now=110 → start 100, X ignored",
      grant({ expiresAt: at(100), expiredAt: at(50) }),
      110,
      "grace",
      100,
    ],
    [
      "E=100 X=150 (future) now=110 → start 100, X ignored",
      grant({ expiresAt: at(100), expiredAt: at(150) }),
      110,
      "grace",
      100,
    ],
    [
      "E=100 X malformed now=110 → start 100, X ignored",
      grant({ expiresAt: at(100), expiredAt: "not-a-date" }),
      110,
      "grace",
      100,
    ],
    [
      "E=200 (future) X=50 now=100 → blocked, X cannot rescue",
      grant({ expiresAt: at(200), expiredAt: at(50) }),
      100,
      "blocked",
      null,
    ],
    [
      "E=100 R=50 now=110 → start 50, earlier revocation shortens",
      grant({ expiresAt: at(100), revokedAt: at(50) }),
      110,
      "grace",
      50,
    ],
    [
      "E=100 R=200 (future) now=110 → blocked, R inconsistent",
      grant({ expiresAt: at(100), revokedAt: at(200) }),
      110,
      "blocked",
      null,
    ],
    [
      "E=100 R malformed now=110 → blocked, R invalid",
      grant({ expiresAt: at(100), revokedAt: "not-a-date" }),
      110,
      "blocked",
      null,
    ],
    [
      "E=null X=null R=50 now=100 → blocked, required legacy start missing",
      grant({ expiresAt: null, expiredAt: null, revokedAt: at(50) }),
      100,
      "blocked",
      null,
    ],
    [
      "E=null X=50 now=110 → bounded grace from the legacy start",
      grant({ expiresAt: null, expiredAt: at(50) }),
      110,
      "grace",
      50,
    ],
    [
      "E=null X=200 (future) now=110 → blocked, legacy start in the future",
      grant({ expiresAt: null, expiredAt: at(200) }),
      110,
      "blocked",
      null,
    ],
    [
      "E=null X malformed now=110 → blocked, legacy start invalid",
      grant({ expiresAt: null, expiredAt: "not-a-date" }),
      110,
      "blocked",
      null,
    ],
  ];

  for (const status of GRACE_STATUSES) {
    for (const [label, base, now, expectedState, expectedStart] of rows) {
      it(`${status}: ${label}`, () => {
        const evaluated = evaluateGrantTime({ ...base, status }, now);
        expect(evaluated.state).toBe(expectedState);
        expect(evaluated.graceStartMs).toBe(expectedStart);
        if (expectedStart !== null && evaluated.state === "grace") {
          expect(evaluated.graceEndMs).toBe(expectedStart + DEFAULT_WINDOW_MS);
        }
      });
    }
  }

  const softRevokedRows: Array<
    [string, GrantTimeInput, number, EffectiveGrantState, number | null]
  > = [
    [
      "R=50 E=200 (valid future) X malformed now=100 → start 50, X ignored",
      grant({ expiresAt: at(200), expiredAt: "not-a-date", revokedAt: at(50) }),
      100,
      "grace",
      50,
    ],
    [
      "R=100 E=50 X=150 now=110 → start 50, later revoke + X cannot restart",
      grant({ expiresAt: at(50), expiredAt: at(150), revokedAt: at(100) }),
      110,
      "grace",
      50,
    ],
    [
      "R=100 E=null X=50 now=110 → start 50 via legacy fallback",
      grant({ expiresAt: null, expiredAt: at(50), revokedAt: at(100) }),
      110,
      "grace",
      50,
    ],
    [
      "R=100 E=null X=200 (future) now=110 → blocked",
      grant({ expiresAt: null, expiredAt: at(200), revokedAt: at(100) }),
      110,
      "blocked",
      null,
    ],
    [
      "R=100 E=null X malformed now=110 → blocked",
      grant({ expiresAt: null, expiredAt: "not-a-date", revokedAt: at(100) }),
      110,
      "blocked",
      null,
    ],
    [
      "R missing now=110 → blocked, revocation stamp required",
      grant({ expiresAt: at(50), revokedAt: null }),
      110,
      "blocked",
      null,
    ],
    [
      "R=200 (future) now=110 → blocked, revocation in the future",
      grant({ expiresAt: at(50), revokedAt: at(200) }),
      110,
      "blocked",
      null,
    ],
    [
      "R malformed now=110 → blocked",
      grant({ expiresAt: at(50), revokedAt: "not-a-date" }),
      110,
      "blocked",
      null,
    ],
  ];

  for (const [label, base, now, expectedState, expectedStart] of softRevokedRows) {
    it(`soft_revoked: ${label}`, () => {
      const evaluated = evaluateGrantTime({ ...base, status: "soft_revoked" }, now);
      expect(evaluated.state).toBe(expectedState);
      expect(evaluated.graceStartMs).toBe(expectedStart);
    });
  }

  it("active: ignored history is inert even when malformed or future-dated", () => {
    for (const history of [
      { expiredAt: "not-a-date", revokedAt: "not-a-date" },
      { expiredAt: at(9_999_999), revokedAt: at(9_999_999) },
      { expiredAt: null, revokedAt: null },
    ]) {
      const evaluated = evaluateGrantTime(grant({ expiresAt: null, ...history }), 100);
      expect(evaluated.state).toBe("active");
      expect(evaluated.graceStartMs).toBeNull();
    }
  });
});

describe("evaluateGrantTime — half-open boundaries", () => {
  it("one millisecond before the deadline still authorizes; the exact deadline does not", () => {
    const row = grant({ expiresAt: at(1_000_000) });
    expect(isEffectivelyActive(row, 999_999)).toBe(true);
    expect(isEffectivelyActive(row, 1_000_000)).toBe(false);
    // Usable stays true at the exact deadline — grace has begun.
    expect(isEffectivelyUsable(row, 1_000_000)).toBe(true);
  });

  it("one millisecond past the deadline is inside grace, not active", () => {
    const row = grant({ expiresAt: at(1_000_000) });
    const evaluated = evaluateGrantTime(row, 1_000_001);
    expect(evaluated.state).toBe("grace");
    expect(evaluated.graceStartMs).toBe(1_000_000);
  });

  it("the exact grace end is blocked and the window is half-open", () => {
    const row = grant({ expiresAt: at(100), graceWindowHours: 2 });
    const end = 100 + 2 * HOUR;
    expect(evaluateGrantTime(row, end - 1).state).toBe("grace");
    expect(evaluateGrantTime(row, end).state).toBe("blocked");
    expect(evaluateGrantTime(row, end).reason).toBe("grace_window_elapsed");
  });

  it("a zero-hour window provides no grace at all", () => {
    const row = grant({ expiresAt: at(100), graceWindowHours: 0 });
    expect(evaluateGrantTime(row, 100).state).toBe("blocked");
    expect(evaluateGrantTime(row, 101).state).toBe("blocked");
  });

  it("a 720-hour window is accepted (the provisionable maximum)", () => {
    const row = grant({ expiresAt: at(100), graceWindowHours: 720 });
    expect(evaluateGrantTime(row, 100 + 720 * HOUR - 1).state).toBe("grace");
    expect(evaluateGrantTime(row, 100 + 720 * HOUR).state).toBe("blocked");
  });

  it("a delayed sweep stamp never extends the expiry-based grace deadline", () => {
    // Status already flipped to `expired` long ago, but the sweep only just
    // stamped expiredAt. The deadline is still the configured expiresAt.
    const row = grant({ status: "expired", expiresAt: at(100), expiredAt: at(1_000_000) });
    const evaluated = evaluateGrantTime(row, 1_000_000);
    expect(evaluated.state).toBe("grace");
    expect(evaluated.graceStartMs).toBe(100);
    // Far past the expiry-based deadline, the freshly stamped sweep cannot revive it.
    expect(evaluateGrantTime(row, 100 + DEFAULT_WINDOW_MS).state).toBe("blocked");
  });
});

describe("evaluateGrantTime — window validation is deferred until grace", () => {
  const invalidWindows = [
    1.5,
    -1,
    721,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ];

  it("an invalid window never removes active authority before expiry", () => {
    for (const graceWindowHours of invalidWindows) {
      const row = grant({ expiresAt: at(200), graceWindowHours });
      const evaluated = evaluateGrantTime(row, 100);
      expect(evaluated.state, String(graceWindowHours)).toBe("active");
      expect(evaluated.graceEndMs, String(graceWindowHours)).toBeNull();
    }
  });

  it("an invalid window blocks grace once the deadline is reached", () => {
    for (const graceWindowHours of invalidWindows) {
      const row = grant({ expiresAt: at(100), graceWindowHours });
      const evaluated = evaluateGrantTime(row, 100);
      expect(evaluated.state, String(graceWindowHours)).toBe("blocked");
      expect(evaluated.reason, String(graceWindowHours)).toBe("grace_window_invalid");
      // The start is still reported so server-side logs can explain the denial.
      expect(evaluated.graceStartMs, String(graceWindowHours)).toBe(100);
    }
  });
});

describe("evaluateGrantTime — fail-closed inputs", () => {
  it("a non-finite now cannot authorize anything", () => {
    const row = grant({ expiresAt: at(100) });
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(evaluateGrantTime(row, now).state, String(now)).toBe("blocked");
      expect(evaluateGrantTime(row, now).reason, String(now)).toBe("now_not_finite");
    }
  });

  it("an empty string is invalid, not absent", () => {
    // A legacy row whose only possible start is an empty string must NOT be
    // treated as "no stamp recorded" and handed a fabricated grace window.
    expect(
      evaluateGrantTime(grant({ status: "expired", expiresAt: null, expiredAt: "" }), 110).state,
    ).toBe("blocked");
    expect(
      evaluateGrantTime(grant({ status: "soft_revoked", expiresAt: null, revokedAt: "" }), 110)
        .state,
    ).toBe("blocked");
  });

  it("a malformed evaluated field blocks only that grant, not its siblings", () => {
    const broken = grant({ status: "expired", expiresAt: "not-a-date" });
    const healthy = grant({ status: "expired", expiresAt: at(100) });
    expect(evaluateGrantTime(broken, 110).state).toBe("blocked");
    expect(evaluateGrantTime(healthy, 110).state).toBe("grace");
  });

  it("never mutates the row it is handed", () => {
    const row = grant({
      status: "soft_revoked",
      expiresAt: at(200),
      expiredAt: at(300),
      revokedAt: at(50),
    });
    const before = { ...row };
    evaluateGrantTime(row, 100);
    expect(row).toEqual(before);
  });
});
