import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/v2',
  // API e dashboard no mesmo domínio — URLs relativas funcionam
};

export default nextConfig;
