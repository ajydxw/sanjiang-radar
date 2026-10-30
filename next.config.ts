import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  ...(process.env.RADAR_IDENTITY_BUILD === "1" ? { distDir: ".sites-runtime/identity-web/out" } : {}),
};

export default nextConfig;
