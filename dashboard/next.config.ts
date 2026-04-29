import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Trim React dev artefacts from production bundles.
  reactStrictMode: true,
  // Helps OpenNext / Wrangler bundle resolve the project root unambiguously.
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;

// Recommended by @opennextjs/cloudflare so `next dev` integrates with the
// OpenNext adapter and Cloudflare bindings are available in local dev.
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
initOpenNextCloudflareForDev();
