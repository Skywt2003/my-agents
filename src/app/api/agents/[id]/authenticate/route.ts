import { NextResponse } from "next/server";

import { authenticateAgent } from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { methodId?: string; cwd?: string };
    if (!body.methodId) throw new Error("Authentication method is required.");
    await authenticateAgent(id, body.methodId, body.cwd);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not authenticate agent.",
      },
      { status: 400 },
    );
  }
}
