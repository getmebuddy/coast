/** Streamable-HTTP MCP endpoint. Bearer token required; see lib/mcp/handler.ts. */
import { handleMcpRequest } from "@/lib/mcp/handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return handleMcpRequest(req);
}

export async function POST(req: Request) {
  return handleMcpRequest(req);
}

export async function DELETE(req: Request) {
  return handleMcpRequest(req);
}
