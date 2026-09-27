import { z } from "zod";
import { isIsoDate, type IsoDate } from "./dates";
import { parsePeso, type Centavos } from "./money";

/** Zod field: peso text input → bigint centavos. */
export const zPeso = z
  .string()
  .trim()
  .transform((s, ctx): Centavos => {
    try {
      return parsePeso(s);
    } catch {
      ctx.addIssue({ code: "custom", message: `"${s}" is not a valid peso amount` });
      return z.NEVER;
    }
  });

/** Optional peso input: blank → 0. */
export const zPesoOrZero = z
  .string()
  .trim()
  .transform((s, ctx): Centavos => {
    if (s === "") return BigInt(0);
    try {
      return parsePeso(s);
    } catch {
      ctx.addIssue({ code: "custom", message: `"${s}" is not a valid peso amount` });
      return z.NEVER;
    }
  });

export const zIsoDate = z
  .string()
  .refine(isIsoDate, "Use a valid date (YYYY-MM-DD)")
  .transform((s) => s as IsoDate);

export const zOptionalText = z
  .string()
  .trim()
  .transform((s) => (s === "" ? null : s))
  .nullable()
  .optional();

/** Philippine mobile number, normalised to 09XXXXXXXXX. */
export const zPhMobile = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ""))
  .transform((s) => (s.startsWith("+63") ? `0${s.slice(3)}` : s.startsWith("63") && s.length === 12 ? `0${s.slice(2)}` : s))
  .refine((s) => /^09\d{9}$/.test(s), "Use a PH mobile number like 0917 123 4567");
