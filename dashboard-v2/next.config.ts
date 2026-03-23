import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/dashboard',
  // API e dashboard no mesmo domínio — URLs relativas funcionam
};

export default nextConfig;
