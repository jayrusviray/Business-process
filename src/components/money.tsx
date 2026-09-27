import { formatPeso } from "@/lib/money";
import { cn } from "@/lib/utils";

/** Renders centavos (bigint or DB bigint string) as ₱ with tabular digits. */
export function Money({ value, className, signed = false }: { value: bigint | string | null | undefined; className?: string; signed?: boolean }) {
  const v = value == null ? BigInt(0) : typeof value === "bigint" ? value : BigInt(value);
  return (
    <span className={cn("money", signed && v > BigInt(0) && "text-destructive", signed && v < BigInt(0) && "text-success", className)}>
      {formatPeso(v)}
    </span>
  );
}
