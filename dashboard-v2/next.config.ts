import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  // Sem basePath — Nginx serve static files direto do root
};

export default nextConfig;
