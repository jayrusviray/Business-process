import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Phone photos of receipts and payment proofs (uploadDocument allows up to 8 MB) + multipart overhead.
      bodySizeLimit: "9mb",
    },
  },
};

export default nextConfig;
