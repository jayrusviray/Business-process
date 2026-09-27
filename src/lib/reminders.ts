import { addDays, dayOfWeek, daysBetween, formatBusinessDate, type IsoDate } from "./dates";
import { formatPeso, type Centavos } from "./money";

export type Trigger =
  | "balance_weekly"
  | "missed_boundary"
  | "amortization_upcoming"
  | "amortization_missed"
  | "rto_milestone"
  | "license_expiry";

export const TRIGGER_LABEL: Record<Trigger | "manual", string> = {
  balance_weekly: "Weekly balance",
  missed_boundary: "Missed boundary",
  amortization_upcoming: "RTO amortization due soon",
  amortization_missed: "RTO amortization missed",
  rto_milestone: "RTO milestone",
  license_expiry: "License expiry",
  manual: "Manual message",
};

/** SMS-safe peso: "P1,250.00" (₱ is outside GSM-7 and would cut each SMS to 70 chars). */
export function smsPeso(v: Centavos): string {
  return formatPeso(v, { symbol: false }).replace(/^(-?)/, "$1P");
}

/** Replace {{var}} placeholders. Unknown/missing variables are an error, never sent as-is. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`Template uses {{${k}}}, which isn't available for this message`);
    return vars[k];
  });
}

export const TEMPLATE_VARIABLES: Record<Trigger | "manual", string[]> = {
  balance_weekly: ["name", "balance"],
  missed_boundary: ["name", "amount", "date", "balance"],
  amortization_upcoming: ["name", "amount", "due_date", "contract_no"],
  amortization_missed: ["name", "amount", "due_date", "missed", "contract_no"],
  rto_milestone: ["name", "percent", "contract_no"],
  license_expiry: ["name", "due_date", "days"],
  manual: ["name", "balance"],
};

export type RuleConfig = { trigger: Trigger; active: boolean; weekday: number | null; offsetDays: number | null; minAmount: Centavos };

/** Everything the generator needs to know about one driver today. */
export type DriverFacts = {
  driverId: string;
  firstName: string;
  phone: string;
  totalBalance: Centavos;
  /** Boundary charges by due date with outstanding amounts (only recent days are needed). */
  boundaryDays: { dueDate: IsoDate; amount: Centavos; outstanding: Centavos }[];
  licenseExpiry: IsoDate | null;
  rto: null | {
    contractNo: string;
    percentPaid: number;
    installments: { seq: number; dueDate: IsoDate; amount: Centavos; outstanding: Centavos | null }[];
    missed: number;
  };
};

export type PlannedMessage = { trigger: Trigger; dedupeKey: string; vars: Record<string, string> };

const MILESTONES = [25, 50, 75, 100];

/** Pure: which reminders a driver should get today under the given rules. */
export function planReminders(rules: RuleConfig[], f: DriverFacts, today: IsoDate): PlannedMessage[] {
  const out: PlannedMessage[] = [];
  const base = { name: f.firstName, balance: smsPeso(f.totalBalance) };
  for (const r of rules) {
    if (!r.active) continue;
    switch (r.trigger) {
      case "balance_weekly":
        if (r.weekday === dayOfWeek(today) && f.totalBalance >= r.minAmount && f.totalBalance > BigInt(0)) {
          out.push({ trigger: r.trigger, dedupeKey: `balance_weekly:${f.driverId}:${today}`, vars: base });
        }
        break;
      case "missed_boundary": {
        const day = addDays(today, -(r.offsetDays ?? 1));
        const b = f.boundaryDays.find((x) => x.dueDate === day);
        if (b && b.outstanding > BigInt(0) && b.outstanding >= r.minAmount) {
          out.push({
            trigger: r.trigger,
            dedupeKey: `missed_boundary:${f.driverId}:${day}`,
            vars: { ...base, amount: smsPeso(b.amount), date: formatBusinessDate(day) },
          });
        }
        break;
      }
      case "amortization_upcoming": {
        const due = addDays(today, r.offsetDays ?? 3);
        for (const i of f.rto?.installments ?? []) {
          if (i.dueDate === due && (i.outstanding === null || i.outstanding > BigInt(0))) {
            out.push({
              trigger: r.trigger,
              dedupeKey: `amortization_upcoming:${f.driverId}:${i.dueDate}`,
              vars: { ...base, amount: smsPeso(i.outstanding ?? i.amount), due_date: formatBusinessDate(i.dueDate), contract_no: f.rto!.contractNo },
            });
          }
        }
        break;
      }
      case "amortization_missed": {
        const due = addDays(today, -(r.offsetDays ?? 1));
        for (const i of f.rto?.installments ?? []) {
          if (i.dueDate === due && i.outstanding !== null && i.outstanding > BigInt(0)) {
            out.push({
              trigger: r.trigger,
              dedupeKey: `amortization_missed:${f.driverId}:${i.dueDate}`,
              vars: {
                ...base,
                amount: smsPeso(i.outstanding),
                due_date: formatBusinessDate(i.dueDate),
                missed: String(f.rto!.missed),
                contract_no: f.rto!.contractNo,
              },
            });
          }
        }
        break;
      }
      case "rto_milestone": {
        // Highest milestone reached; the dedupe key makes each milestone fire once.
        const reached = MILESTONES.filter((m) => (f.rto?.percentPaid ?? 0) >= m).pop();
        if (f.rto && reached) {
          out.push({
            trigger: r.trigger,
            dedupeKey: `rto_milestone:${f.driverId}:${f.rto.contractNo}:${reached}`,
            vars: { ...base, percent: String(reached), contract_no: f.rto.contractNo },
          });
        }
        break;
      }
      case "license_expiry": {
        if (!f.licenseExpiry) break;
        const days = daysBetween(today, f.licenseExpiry);
        if (days >= 0 && days <= (r.offsetDays ?? 30)) {
          out.push({
            trigger: r.trigger,
            dedupeKey: `license_expiry:${f.driverId}:${f.licenseExpiry}`,
            vars: { ...base, due_date: formatBusinessDate(f.licenseExpiry), days: String(days) },
          });
        }
        break;
      }
    }
  }
  return out;
}

/** sms: link that opens the phone's messaging app with the text filled in. */
export function smsHref(phone: string, body: string): string {
  return `sms:${phone.replace(/[^\d+]/g, "")}?body=${encodeURIComponent(body)}`;
}

/** GSM-7 SMS segments (160 chars, or 153 per part when split). Informational only. */
export function smsSegments(body: string): number {
  return body.length <= 160 ? 1 : Math.ceil(body.length / 153);
}
