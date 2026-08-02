import { NextResponse } from "next/server";

import {
  createSession,
  listSessions,
} from "@/lib/acp/runtime";
import { getProject, listProjects } from "@/lib/persistence/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sync = new URL(request.url).searchParams.get("sync") === "1";
  const result = await listSessions(sync);
  return NextResponse.json({
    ...result,
    projects: listProjects(),
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      projectId?: string;
      agentId?: string;
    };
    const project = body.projectId ? getProject(body.projectId) : null;
    if (!project) throw new Error("Choose a project before starting a session.");
    const session = await createSession(project, body.agentId ?? "codex");
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create session." },
      { status: 400 },
    );
  }
}
