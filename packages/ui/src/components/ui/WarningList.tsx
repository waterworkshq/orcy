import type { AnalyticsWarning } from "../../types/index.js";

export function WarningList({
  warnings,
  variant = "note",
}: {
  warnings: AnalyticsWarning[];
  variant?: "note" | "plain";
}) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-1" role="note" aria-label="Analytics caveats">
      {warnings.map((warning) => (
        <p
          key={`${warning.code}:${warning.message}`}
          className={
            variant === "plain"
              ? "text-[11px] text-muted-foreground"
              : "text-xs text-on-surface-variant"
          }
        >
          {variant === "plain"
            ? warning.message
            : `${warning.severity === "critical" ? "Critical" : "Note"}: ${warning.message}`}
        </p>
      ))}
    </div>
  );
}
