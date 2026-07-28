import { prepareSession, promptSession, subscribe } from "@/lib/acp/runtime";
import type { SessionStreamEvent } from "@/lib/myagents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await request.json()) as { message?: string };
  const message = body.message?.trim();
  if (!message) return Response.json({ error: "Message is required." }, { status: 400 });

  try {
    await prepareSession(id);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not load session." },
      { status: 400 },
    );
  }

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: SessionStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      cleanup = subscribe(id, send);

      void promptSession(id, message)
        .catch((error) => {
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Prompt failed.",
          });
        })
        .finally(() => {
          cleanup();
          controller.close();
        });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
