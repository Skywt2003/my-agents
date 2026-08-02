import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.MYAGENTS_NEXT_DIST_DIR ?? ".next",
  allowedDevOrigins: ["my-agents.dev.skywt"],
  images: {
    remotePatterns: [
      new URL("https://cdn.agentclientprotocol.com/registry/v1/latest/*.svg"),
    ],
  },
  serverExternalPackages: ["better-sqlite3", "node-pty"],
};

export default nextConfig;
