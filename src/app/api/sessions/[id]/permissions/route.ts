import { NextResponse } from "next/server";

import { resolvePermission } from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      permissionId?: string;
      optionId?: string;
    };
    if (!body.permissionId) throw new Error("Permission ID is required.");
    resolvePermission(id, body.permissionId, body.optionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not resolve permission." },
      { status: 400 },
    );
  }
}

