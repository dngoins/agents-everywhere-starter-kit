import { api } from "../../../../../server/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ productId: string }> }) {
  return api().uploadProduct(request, (await context.params).productId);
}
