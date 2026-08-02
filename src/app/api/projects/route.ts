import { NextResponse } from "next/server";

import { validateWorkingDirectory } from "@/lib/acp/runtime";
import { createProject, listProjects } from "@/lib/persistence/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ projects: listProjects() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { name?: string; path?: string };
    const path = body.path?.trim() ?? "";
    await validateWorkingDirectory(path);
    const project = createProject({ name: body.name ?? "", path });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not add project." },
      { status: 400 },
    );
  }
}
