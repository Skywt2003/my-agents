import { NextResponse } from "next/server";

import {
  installRegistryAgent,
  listInstalledAgents,
} from "@/lib/acp/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { registryId?: string };
    if (!body.registryId) throw new Error("Registry agent ID is required.");
    await installRegistryAgent(body.registryId);
    return NextResponse.json({ agents: listInstalledAgents() }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not install agent.",
      },
      { status: 400 },
    );
  }
}
