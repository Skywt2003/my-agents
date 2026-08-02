import { setSessionConfigOption } from "@/lib/acp/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      configId?: string;
      value?: string | boolean;
    };
    if (!body.configId || body.value === undefined) {
      throw new Error("A configuration option and value are required.");
    }
    const session = await setSessionConfigOption(id, body.configId, body.value);
    return Response.json({ session });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Could not update session configuration.",
      },
      { status: 400 },
    );
  }
}
