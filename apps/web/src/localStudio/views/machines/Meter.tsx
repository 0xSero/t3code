import { cn } from "../../../lib/utils";

export function Meter({
  pct,
  tone = "default",
  label,
}: {
  readonly pct: number | null;
  readonly tone?: "default" | "warning";
  readonly label: string;
}) {
  const value = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === null ? undefined : Math.round(value)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500 ease-out",
          pct === null ? "bg-transparent" : tone === "warning" ? "bg-warning" : "bg-foreground/70",
        )}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}
