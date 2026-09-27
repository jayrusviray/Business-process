import { z } from "zod";
import { CONTACT_METHODS, SERVICE_LINES } from "./crm";
import { zPhMobile } from "./validation";

/** Website inquiry form (public). Consent to the privacy notice is required (RA 10173). */
export const InquiryInput = z.object({
  name: z.string().trim().min(2, "Please enter your name.").max(120),
  mobile: zPhMobile,
  email: z.union([z.literal(""), z.email("Please enter a valid email or leave it blank.")]).transform((s) => s || null),
  location: z.string().trim().max(120).default(""),
  interest: z.enum(SERVICE_LINES, { error: "Choose a service." }),
  preferredContact: z.enum(CONTACT_METHODS, { error: "Choose how we should contact you." }),
  message: z.string().trim().max(1000, "Please keep your message under 1,000 characters.").default(""),
  consent: z.literal("on", { error: "Please agree to the privacy notice so we can contact you." }),
});
export type InquiryInput = z.infer<typeof InquiryInput>;
