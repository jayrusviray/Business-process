import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content Security Policy without nonces: Next.js inlines its bootstrap scripts,
 * so script-src needs 'unsafe-inline' (nonces would force every page to render
 * dynamically). Everything is served from our own origin; the browser never talks
 * to Supabase directly (sign-in and storage go through the server). Documents open
 * via a redirect to a signed URL, which is a navigation and not restricted here.
 * Verified with Playwright (e2e/public.spec.ts checks for CSP violations).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Browsers ignore HSTS over plain http (localhost), so this is safe in development.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Receipt photos use <input type="file" capture>, which opens the camera app and needs no permission here.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // Phone photos of receipts and payment proofs (uploadDocument allows up to 8 MB) + multipart overhead.
      bodySizeLimit: "9mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
