import { api } from "../../../../../../../server/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ jobId: string; assetId: string }> }) {
  const { jobId, assetId } = await context.params;
  return api().decideFrame(request, jobId, assetId);
}
