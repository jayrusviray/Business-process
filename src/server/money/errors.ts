/** A business-rule violation whose message is safe to show to staff. */
export class MoneyRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyRuleError";
  }
}

/** Map DB/rule errors to a message suitable for the UI. Never leaks SQL. */
export function friendlyError(e: unknown): string {
  if (e instanceof MoneyRuleError) return e.message;
  const msg = e instanceof Error ? `${e.message} ${(e as { cause?: Error }).cause?.message ?? ""}` : String(e);
  if (/row-level security|permission denied|insufficient_privilege/.test(msg)) return "You are not allowed to do that.";
  if (/assignments_no_vehicle_overlap/.test(msg)) return "That vehicle is already assigned to someone on those dates.";
  if (/assignments_no_driver_overlap/.test(msg)) return "That driver already has a vehicle on those dates.";
  if (/boundary_plans_no_overlap/.test(msg)) return "That driver already has a boundary plan covering those dates.";
  if (/vehicles_plate_uq/.test(msg)) return "A vehicle with that plate number already exists.";
  if (/payments_reference_required/.test(msg)) return "A reference number is required for non-cash payments.";
  if (/charges are already posted/.test(msg)) return "Charges are already posted past that date. Reverse them first.";
  if (/versioned/.test(msg)) return "Plans can't be edited. End this plan and start a new one.";
  if (/append-only/.test(msg)) return "Financial records can't be changed. Post a reversal or adjustment instead.";
  if (/duplicate key/.test(msg)) return "That record already exists.";
  console.error(e);
  return "Something went wrong. Nothing was saved.";
}
