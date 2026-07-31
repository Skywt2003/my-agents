import { createTerminal } from "@/lib/terminal/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    cwd?: string;
    cols?: number;
    rows?: number;
  };
  try {
    const terminal = await createTerminal(
      body.cwd?.trim() ?? "",
      body.cols,
      body.rows,
    );
    return Response.json({ terminal }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not create terminal." },
      { status: 400 },
    );
  }
}
