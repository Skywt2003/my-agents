import { subscribeTerminal } from "@/lib/terminal/runtime";
import type { TerminalStreamEvent } from "@/lib/myagents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let cleanup = () => {};
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (event: TerminalStreamEvent) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          if (event.type === "exit") {
            closed = true;
            cleanup();
            controller.close();
          }
        };
        const subscription = subscribeTerminal(id, send);
        cleanup = subscription.unsubscribe;
        if (subscription.history) {
          send({ type: "output", data: subscription.history });
        }
        if (subscription.info.status === "exited") {
          send({ type: "exit", exitCode: subscription.info.exitCode ?? 0 });
        }
        request.signal.addEventListener("abort", cleanup, { once: true });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    cleanup();
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not open terminal stream." },
      { status: 404 },
    );
  }
}
