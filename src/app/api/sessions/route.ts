import { NextResponse } from "next/server";

import {
  createSession,
  defaultWorkingDirectory,
  listSessions,
} from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sync = new URL(request.url).searchParams.get("sync") === "1";
  const result = await listSessions(sync);
  return NextResponse.json({
    ...result,
    defaultCwd: defaultWorkingDirectory(),
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      cwd?: string;
      agentId?: string;
    };
    const cwd = body.cwd?.trim() || defaultWorkingDirectory();
    const session = await createSession(cwd, body.agentId ?? "codex");
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create session." },
      { status: 400 },
    );
  }
}
