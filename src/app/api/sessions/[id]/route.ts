import { NextResponse } from "next/server";

import {
  getSession,
  updateSessionTitlePreference,
} from "@/lib/acp/runtime";
import type { SessionTitleMode } from "@/lib/myagents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await getSession(id);
    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load session." },
      { status: 400 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      titleMode?: SessionTitleMode;
      customTitle?: string;
    };
    if (!body.titleMode) throw new Error("Session title mode is required.");
    const session = updateSessionTitlePreference(
      id,
      body.titleMode,
      body.customTitle,
    );
    return NextResponse.json({ session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update session." },
      { status: 400 },
    );
  }
}
