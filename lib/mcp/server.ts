/**
 * Coast MCP server factory — builds a per-request McpServer bound to one
 * authenticated viewer. Stateless: a fresh server + transport per request.
 */
import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOLS, type Viewer } from "./tools";

export const MCP_SERVER_NAME = "coast";
export const MCP_SERVER_VERSION = "0.1.0";

export const MCP_INSTRUCTIONS =
  "Coast is a read-only connector. All tools return the signed-in user's own " +
  "financial data for informational and educational purposes only — never " +
  "financial advice, and never a recommendation to buy, sell, or move money. " +
  "No tool can change anything in the user's account.";

export function createMcpServer(viewer: Viewer): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS }
  );
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
      },
      async () => tool.run(viewer)
    );
  }
  return server;
}
