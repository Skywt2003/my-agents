import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["my-agents.dev.skywt"],
  images: {
    remotePatterns: [
      new URL("https://cdn.agentclientprotocol.com/registry/v1/latest/*.svg"),
    ],
  },
  serverExternalPackages: ["better-sqlite3", "node-pty"],
};

export default nextConfig;
