import { NextResponse } from "next/server";

import {
  listInstalledAgents,
  removeAgent,
} from "@/lib/acp/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ agents: listInstalledAgents() });
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) throw new Error("Agent ID is required.");
    await removeAgent(id);
    return NextResponse.json({ agents: listInstalledAgents() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove agent." },
      { status: 400 },
    );
  }
}
