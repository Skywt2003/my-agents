import { NextResponse } from "next/server";

import {
  createSession,
  defaultWorkingDirectory,
  listSessions,
} from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await listSessions();
  return NextResponse.json({
    ...result,
    defaultCwd: defaultWorkingDirectory(),
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      cwd?: string;
      agentId?: "codex" | "opencode";
    };
    const cwd = body.cwd?.trim() || defaultWorkingDirectory();
    if (body.agentId && body.agentId !== "codex" && body.agentId !== "opencode") {
      throw new Error("Unknown ACP agent.");
    }
    const session = await createSession(cwd, body.agentId ?? "codex");
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create session." },
      { status: 400 },
    );
  }
}
