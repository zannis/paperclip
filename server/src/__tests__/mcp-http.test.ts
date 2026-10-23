import { describe, expect, it } from "vitest";
import {
  incompleteMcpResult,
  initializeMcpHttpSession,
  MCP_HTTP_ACCEPT,
  MCP_PROTOCOL_VERSION,
  mcpHttpRequestHeaders,
  MCP_STATELESS_PROTOCOL_VERSION,
  parseMcpHttpResponseBody,
  statelessMcpHeaders,
  statelessMcpRequest,
  usesStatelessMcpProtocol,
} from "../services/mcp-http.js";

describe("mcpHttpRequestHeaders", () => {
  it("advertises both JSON and SSE on every request", () => {
    expect(mcpHttpRequestHeaders()).toMatchObject({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    expect(MCP_HTTP_ACCEPT).toBe("application/json, text/event-stream");
  });

  it("preserves caller-supplied headers while keeping the required Accept value", () => {
    expect(mcpHttpRequestHeaders({ Authorization: "Bearer x", accept: "application/json" })).toMatchObject({
      accept: "application/json, text/event-stream",
      Authorization: "Bearer x",
    });
  });
});

describe("initializeMcpHttpSession", () => {
  it("returns the negotiated protocol and ephemeral session headers", async () => {
    const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
    const sessionHeaders = await initializeMcpHttpSession({
      requestId: "test-request",
      headers: { Authorization: "Bearer token" },
      send: async (init) => {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ headers: new Headers(init.headers), payload });
        if (payload.method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "stateful-test", version: "1" },
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-123" },
          });
        }
        return new Response(null, { status: 202 });
      },
    });

    expect(requests.map(({ payload }) => payload.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer token");
    expect(requests[1]!.headers.get("mcp-session-id")).toBe("session-123");
    expect(requests[1]!.headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
    expect(sessionHeaders).toMatchObject({
      Authorization: "Bearer token",
      "Mcp-Session-Id": "session-123",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
  });
});

describe("parseMcpHttpResponseBody", () => {
  it("parses a plain application/json body", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [] } };
    expect(parseMcpHttpResponseBody(JSON.stringify(payload), "application/json")).toEqual(payload);
  });

  it("parses an SSE-framed body, extracting the JSON-RPC message", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [{ name: "kv_get" }] } };
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream; charset=utf-8")).toEqual(payload);
  });

  it("skips non-JSON-RPC SSE events and returns the response message", () => {
    const ping = "event: ping\ndata: {\"type\":\"ping\"}";
    const message = { jsonrpc: "2.0", id: "1", result: { ok: true } };
    const body = `${ping}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(message);
  });

  it("handles multi-line SSE data fields", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { note: "line" } };
    const json = JSON.stringify(payload, null, 2);
    const body = `data: ${json.split("\n").join("\ndata: ")}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(payload);
  });

  it("throws when an SSE stream carries no data events", () => {
    expect(() => parseMcpHttpResponseBody("event: ping\n\n", "text/event-stream")).toThrow();
  });
});

describe("statelessMcpRequest", () => {
  it("sends the 2026-07-28 envelope: version header, method header and per-request metadata", () => {
    const { headers, body } = statelessMcpRequest({
      id: "list-1",
      method: "tools/list",
      params: { cursor: "next" },
      headers: { Authorization: "Bearer token" },
    });
    expect(MCP_STATELESS_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(headers).toMatchObject({
      Authorization: "Bearer token",
      accept: MCP_HTTP_ACCEPT,
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    });
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("mcp-name");
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list",
      params: {
        cursor: "next",
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "paperclip", version: "1" },
        },
      },
    });
  });

  it("names the tool on tools/call, base64-wrapping names that are not visible ASCII", () => {
    const plain = statelessMcpRequest({ id: 1, method: "tools/call", params: { name: "find_Account", arguments: {} } });
    expect(plain.headers["Mcp-Name"]).toBe("find_Account");
    const wide = statelessMcpRequest({ id: 2, method: "tools/call", params: { name: "créer contact", arguments: {} } });
    expect(wide.headers["Mcp-Name"]).toBe(`=?base64?${Buffer.from("créer contact", "utf8").toString("base64")}?=`);
  });

  it("drops caller-supplied session and protocol headers but keeps credentials", () => {
    const { headers } = statelessMcpRequest({
      id: 3,
      method: "tools/list",
      headers: {
        "X-Api-Key": "secret",
        "mcp-session-id": "stale",
        "mcp-protocol-version": "2025-06-18",
        "MCP-METHOD": "initialize",
        "mcp-name": "other",
      },
    });
    expect(headers["X-Api-Key"]).toBe("secret");
    const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    expect(lower["mcp-session-id"]).toBeUndefined();
    expect(lower["mcp-name"]).toBeUndefined();
    expect(lower["mcp-protocol-version"]).toBe("2026-07-28");
    expect(lower["mcp-method"]).toBe("tools/list");
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "mcp-protocol-version")).toHaveLength(1);
  });

  it("gives a JSON-RPC response only the version header", () => {
    const headers = statelessMcpHeaders({ "X-Api-Key": "secret", "Mcp-Session-Id": "stale" });
    expect(headers).toMatchObject({ "X-Api-Key": "secret", "MCP-Protocol-Version": "2026-07-28", accept: MCP_HTTP_ACCEPT });
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toEqual(expect.arrayContaining(["mcp-method", "mcp-session-id"]));
  });
});

describe("usesStatelessMcpProtocol", () => {
  it("is true only for a connection that learned 2026-07-28", () => {
    expect(usesStatelessMcpProtocol({ mcpProtocolVersion: "2026-07-28" })).toBe(true);
    expect(usesStatelessMcpProtocol({ mcpProtocolVersion: "2025-06-18" })).toBe(false);
    expect(usesStatelessMcpProtocol({ mcpSessionRequired: true })).toBe(false);
    expect(usesStatelessMcpProtocol(null)).toBe(false);
  });
});

describe("incompleteMcpResult", () => {
  it("passes complete results and results from servers that send no resultType", () => {
    expect(incompleteMcpResult({ content: [] })).toBeNull();
    expect(incompleteMcpResult({ resultType: "complete", content: [] })).toBeNull();
    expect(incompleteMcpResult(null)).toBeNull();
    // Only input_required means "not done"; anything else is a result to read.
    expect(incompleteMcpResult({ resultType: "task", content: [] })).toBeNull();
    expect(incompleteMcpResult({ resultType: null, content: [] })).toBeNull();
  });

  it("explains an input_required result, including the server's question and links", () => {
    const outcome = incompleteMcpResult({
      resultType: "input_required",
      content: [{ type: "resource_link", uri: "https://crm.example/#Account/view/abc", name: "Acme" }],
      inputRequests: {
        confirmDuplicate: { method: "elicitation/create", params: { message: "The record might be a duplicate. Proceed anyway?" } },
      },
    });
    expect(outcome?.message).toContain("The record might be a duplicate. Proceed anyway?");
    expect(outcome?.message).toContain("nothing was changed");
    expect(outcome?.message).toContain("https://crm.example/#Account/view/abc");
  });

  it("falls back to a generic question when the server gives none", () => {
    expect(incompleteMcpResult({ resultType: "input_required", content: [] })?.message)
      .toContain("needs more input");
  });
});
