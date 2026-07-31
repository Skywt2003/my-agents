import { resizeTerminal } from "@/lib/terminal/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = (await request.json()) as { cols?: number; rows?: number };
  if (!Number.isFinite(body.cols) || !Number.isFinite(body.rows)) {
    return Response.json({ error: "Terminal dimensions are required." }, { status: 400 });
  }
  try {
    const { id } = await params;
    resizeTerminal(id, body.cols!, body.rows!);
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not resize terminal." },
      { status: 400 },
    );
  }
}
