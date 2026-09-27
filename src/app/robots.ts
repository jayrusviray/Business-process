import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/school", "/privacy", "/apply"], disallow: ["/app", "/portal", "/api", "/login", "/home"] },
    sitemap: new URL("/sitemap.xml", siteUrl()).toString(),
  };
}
