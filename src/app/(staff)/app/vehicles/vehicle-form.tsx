import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { toDecimalString } from "@/lib/money";
import type { ActionState } from "@/server/action";

type Vehicle = Partial<{
  id: string;
  plateNo: string;
  make: string;
  model: string;
  year: number | null;
  color: string;
  powertrain: string;
  conductionSticker: string;
  orcrExpiresOn: string | null;
  insuranceExpiresOn: string | null;
  region: string;
  platforms: string[];
  acquisitionCostCentavos: bigint | null;
  acquiredOn: string | null;
  fundingSource: string;
  status: string;
  notes: string;
}>;

export function VehicleForm({ action, vehicle = {}, submitLabel }: { action: (s: ActionState, f: FormData) => Promise<ActionState>; vehicle?: Vehicle; submitLabel: string }) {
  return (
    <ActionForm action={action} className="grid gap-4 sm:grid-cols-3">
      {vehicle.id ? <input type="hidden" name="id" value={vehicle.id} /> : null}
      <Field label="Plate number" htmlFor="plateNo">
        <Input id="plateNo" name="plateNo" defaultValue={vehicle.plateNo} required className="uppercase" />
      </Field>
      <Field label="Make" htmlFor="make">
        <Input id="make" name="make" defaultValue={vehicle.make} required />
      </Field>
      <Field label="Model" htmlFor="model">
        <Input id="model" name="model" defaultValue={vehicle.model} required />
      </Field>
      <Field label="Year" htmlFor="year">
        <Input id="year" name="year" inputMode="numeric" defaultValue={vehicle.year ?? ""} />
      </Field>
      <Field label="Color" htmlFor="color">
        <Input id="color" name="color" defaultValue={vehicle.color} />
      </Field>
      <Field label="Region" htmlFor="region">
        <Input id="region" name="region" defaultValue={vehicle.region} />
      </Field>
      <Field label="Platforms (comma-separated)" htmlFor="platforms">
        <Input id="platforms" name="platforms" placeholder="inDrive" defaultValue={(vehicle.platforms ?? []).join(", ")} />
      </Field>
      <Field label="Acquisition cost" htmlFor="acquisitionCost">
        <Input id="acquisitionCost" name="acquisitionCost" inputMode="decimal"
          defaultValue={vehicle.acquisitionCostCentavos ? toDecimalString(vehicle.acquisitionCostCentavos) : ""} />
      </Field>
      <Field label="Acquired on" htmlFor="acquiredOn">
        <Input id="acquiredOn" name="acquiredOn" type="date" defaultValue={vehicle.acquiredOn ?? ""} />
      </Field>
      <Field label="Funding source" htmlFor="fundingSource">
        <Select id="fundingSource" name="fundingSource" defaultValue={vehicle.fundingSource ?? "company"}>
          <option value="company">Company</option>
          <option value="investor">Investor / partner</option>
          <option value="financed">Bank / dealer financed</option>
        </Select>
      </Field>
      <Field label="Status" htmlFor="status">
        <Select id="status" name="status" defaultValue={vehicle.status ?? "available"}>
          {["available", "assigned", "maintenance", "transferred", "retired"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Type" htmlFor="powertrain">
        <Select id="powertrain" name="powertrain" defaultValue={vehicle.powertrain ?? "ice"}>
          <option value="ice">ICE (gasoline / diesel)</option>
          <option value="ev">EV (electric)</option>
          <option value="hybrid">Hybrid</option>
        </Select>
      </Field>
      <Field label="Conduction sticker" htmlFor="conductionSticker">
        <Input id="conductionSticker" name="conductionSticker" defaultValue={vehicle.conductionSticker} />
      </Field>
      <Field label="OR/CR expires" htmlFor="orcrExpiresOn">
        <Input id="orcrExpiresOn" name="orcrExpiresOn" type="date" defaultValue={vehicle.orcrExpiresOn ?? ""} />
      </Field>
      <Field label="Insurance expires" htmlFor="insuranceExpiresOn">
        <Input id="insuranceExpiresOn" name="insuranceExpiresOn" type="date" defaultValue={vehicle.insuranceExpiresOn ?? ""} />
      </Field>
      <Field label="Notes" htmlFor="notes" className="sm:col-span-3">
        <Textarea id="notes" name="notes" defaultValue={vehicle.notes} className="font-sans" />
      </Field>
      <div className="sm:col-span-3">
        <Button type="submit">{submitLabel}</Button>
      </div>
    </ActionForm>
  );
}
