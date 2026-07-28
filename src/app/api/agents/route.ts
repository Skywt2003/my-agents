import { NextResponse } from "next/server";

import {
  addCustomAgent,
  listInstalledAgents,
  removeAgent,
} from "@/lib/acp/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ agents: listInstalledAgents() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      id?: string;
      name?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    };
    addCustomAgent({
      id: body.id,
      name: body.name ?? "",
      command: body.command ?? "",
      args: body.args,
      env: body.env,
    });
    return NextResponse.json({ agents: listInstalledAgents() }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not add agent." },
      { status: 400 },
    );
  }
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
