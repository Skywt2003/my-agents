import { writeTerminal } from "@/lib/terminal/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = (await request.json()) as { data?: string };
  if (typeof body.data !== "string") {
    return Response.json({ error: "Terminal input is required." }, { status: 400 });
  }
  try {
    const { id } = await params;
    writeTerminal(id, body.data);
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not write to terminal." },
      { status: 400 },
    );
  }
}
