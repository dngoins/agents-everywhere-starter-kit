import { api } from "../../../../server/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ assetId: string }> };
export async function GET(request: Request, context: Context) { return api().getAsset(request, (await context.params).assetId); }
export async function HEAD(request: Request, context: Context) { return api().getAsset(request, (await context.params).assetId); }
