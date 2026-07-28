import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["my-agents.dev.skywt"],
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
