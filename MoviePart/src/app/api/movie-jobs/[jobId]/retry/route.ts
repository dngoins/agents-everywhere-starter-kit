import { api } from "../../../../../server/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  return api().retryJob(request, (await context.params).jobId);
}
