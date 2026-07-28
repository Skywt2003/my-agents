import { NextResponse } from "next/server";

import { fetchAgentRegistry, listInstalledAgents } from "@/lib/acp/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [registry, installed] = await Promise.all([
      fetchAgentRegistry(),
      Promise.resolve(listInstalledAgents()),
    ]);
    const installedRegistryIds = new Set(
      installed.flatMap(({ registryId }) => (registryId ? [registryId] : [])),
    );
    return NextResponse.json({
      agents: registry.map((agent) => ({
        ...agent,
        installed: installedRegistryIds.has(agent.id),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not load ACP Registry.",
      },
      { status: 502 },
    );
  }
}
