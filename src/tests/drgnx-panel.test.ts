/**
 * The `_drgnx/panel` extension: what the agent advertises, the context
 * breakdown it pushes, and `_drgnx/before_tool`. The client is a double that
 * records what the agent sends; no Claude Code and no network are involved.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as agentSdk from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import {
  DRGNX_PANEL_KEY,
  beforeToolHook,
  contextFromUsage,
  panelCapability,
  pushContext,
} from "../drgnx-panel.js";
import { initializeClient, makeMockQuery } from "./helpers.js";

// A plain object, so `vi.spyOn(agentSdk, "query")` can replace the export.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: vi.fn(),
}));

const PANEL_CLIENT = { _meta: { [DRGNX_PANEL_KEY]: { version: 1 } } };

function usage(overrides: Record<string, unknown> = {}) {
  return {
    totalTokens: 60000,
    maxTokens: 160000,
    rawMaxTokens: 200000,
    categories: [
      { id: "system_prompt", name: "System prompt", tokens: 4000, color: "x", kind: "used" },
      { id: "system_tools", name: "System tools", tokens: 12000, color: "x", kind: "used" },
      { id: "mcp_tools", name: "MCP tools", tokens: 3000, color: "x", kind: "used" },
      { id: "memory_files", name: "Memory files", tokens: 1000, color: "x", kind: "used" },
      { id: "skills", name: "Skills", tokens: 500, color: "x", kind: "used" },
      { id: "messages", name: "Messages", tokens: 39500, color: "x", kind: "used" },
      { id: "mcp_tools_deferred", name: "Deferred", tokens: 9000, color: "x", kind: "deferred" },
      { id: "autocompact_buffer", name: "Buffer", tokens: 40000, color: "x", kind: "buffer" },
      { id: "free_space", name: "Free", tokens: 100000, color: "x", kind: "free" },
    ],
    messageBreakdown: { toolResultTokens: 25000 },
    ...overrides,
  };
}

describe("_drgnx/panel capability", () => {
  it("is offered only to a client that sent _drgnx/panel version 1", () => {
    expect(panelCapability(PANEL_CLIENT)).toEqual({
      version: 1,
      features: ["context", "before-tool"],
    });
    expect(panelCapability({})).toBeUndefined();
    expect(panelCapability(undefined)).toBeUndefined();
    expect(panelCapability({ _meta: { [DRGNX_PANEL_KEY]: { version: 2 } } })).toBeUndefined();
  });

  it("never advertises what the SDK cannot serve", () => {
    const features = panelCapability(PANEL_CLIENT)?.features ?? [];
    for (const f of ["drop", "pin", "compact-preview"]) expect(features).not.toContain(f);
  });

  it("rides agentCapabilities._meta of initialize, next to the adapter's own keys", async () => {
    const agent = new ClaudeAcpAgent({} as unknown as AcpClient, {
      log: () => {},
      error: () => {},
    });
    const asked = await agent.initialize({ protocolVersion: 1, clientCapabilities: PANEL_CLIENT });
    expect(asked.agentCapabilities?._meta?.[DRGNX_PANEL_KEY]).toEqual({
      version: 1,
      features: ["context", "before-tool"],
    });
    expect(asked.agentCapabilities?._meta?.claudeCode).toEqual({ promptQueueing: true });
    const plain = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(plain.agentCapabilities?._meta).not.toHaveProperty(DRGNX_PANEL_KEY);
  });
});

describe("contextFromUsage", () => {
  it("maps the used rows to the hub's parts and leaves out free, buffer and deferred rows", () => {
    const ctx = contextFromUsage(usage() as never);
    expect(ctx).toEqual({
      used: 60000,
      size: 200000,
      parts: [
        { kind: "system", tokens: 4500 },
        { kind: "tools", tokens: 15000 },
        { kind: "files", tokens: 1000 },
        { kind: "tool-output", tokens: 25000 },
        { kind: "conversation", tokens: 14500 },
      ],
    });
  });

  it("keeps the whole messages row as conversation when Claude Code gave no breakdown", () => {
    const ctx = contextFromUsage(usage({ messageBreakdown: undefined }) as never);
    expect(ctx.parts.find((p) => p.kind === "conversation")?.tokens).toBe(39500);
    expect(ctx.parts.some((p) => p.kind === "tool-output")).toBe(false);
  });

  it("falls back to maxTokens when the raw window is unknown, and drops empty parts", () => {
    const ctx = contextFromUsage(
      usage({
        rawMaxTokens: 0,
        categories: [{ id: "messages", name: "m", tokens: 0, color: "x", kind: "used" }],
      }) as never,
    );
    expect(ctx.size).toBe(160000);
    expect(ctx.parts).toEqual([]);
  });
});

describe("pushContext", () => {
  it("sends _drgnx/context with the session id, from the cheap summary read", async () => {
    const getContextUsage = vi.fn(async () => usage());
    const extNotification = vi.fn(async () => {});
    await pushContext({
      sessionId: "s1",
      query: { getContextUsage } as never,
      client: { extNotification } as never,
      logger: { log: () => {}, error: () => {} },
    });
    expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
    expect(extNotification).toHaveBeenCalledWith(
      "_drgnx/context",
      expect.objectContaining({ sessionId: "s1", used: 60000, size: 200000 }),
    );
  });

  it("logs a failed read and never throws", async () => {
    const error = vi.fn();
    await expect(
      pushContext({
        sessionId: "s1",
        query: { getContextUsage: async () => Promise.reject(new Error("older CLI")) } as never,
        client: { extNotification: async () => {} } as never,
        logger: { log: () => {}, error },
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});

describe("_drgnx/before_tool", () => {
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  } as never;
  const options = { signal: new AbortController().signal };

  function hook(answer: () => Promise<unknown>) {
    const extRequest = vi.fn(answer);
    const run: HookCallback = beforeToolHook({ sessionId: "s1", client: { extRequest } as never });
    return { extRequest, run };
  }

  it("sends the tool call and lets it run on allow, without deciding the permission itself", async () => {
    const { extRequest, run } = hook(async () => ({ outcome: "allow" }));
    const out = await run(input, "toolu_1", options);
    expect(extRequest).toHaveBeenCalledWith(
      "_drgnx/before_tool",
      {
        sessionId: "s1",
        toolCall: {
          toolCallId: "toolu_1",
          title: "Bash",
          rawInput: { command: "ls" },
          _meta: { claudeCode: { toolName: "Bash" } },
        },
      },
      options.signal,
    );
    expect(out).toEqual({ continue: true });
  });

  it("denies the tool with the hub's reason", async () => {
    const { run } = hook(async () => ({ outcome: "deny", reason: "no rm here" }));
    expect(await run(input, "toolu_1", options)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no rm here",
      },
    });
  });

  it.each([
    ["the request fails", () => Promise.reject(new Error("link lost"))],
    ["the answer has no outcome", async () => ({})],
    ["the outcome is unknown", async () => ({ outcome: "maybe" })],
  ])("fails closed when %s", async (_why, answer) => {
    const { run } = hook(answer);
    const out = (await run(input, "toolu_1", options)) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/drgnx/);
  });

  it("ignores other hook events", async () => {
    const { extRequest, run } = hook(async () => ({ outcome: "deny" }));
    expect(await run({ hook_event_name: "PostToolUse" } as never, "toolu_1", options)).toEqual({
      continue: true,
    });
    expect(extRequest).not.toHaveBeenCalled();
  });
});

describe("the session's PreToolUse hooks", () => {
  let cwd: string;
  let agent: ClaudeAcpAgent;
  let querySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "drgnx-panel-"));
    agent = new ClaudeAcpAgent(
      { sessionUpdate: async () => {}, extNotification: async () => {} } as unknown as AcpClient,
      {
        log: () => {},
        error: () => {},
      },
    );
    querySpy = vi
      .spyOn(agentSdk, "query")
      .mockImplementation(() => makeMockQuery() as unknown as agentSdk.Query);
  });

  afterEach(async () => {
    for (const sessionId of Object.keys(agent.sessions)) await agent.closeSession({ sessionId });
    querySpy.mockRestore();
    await rm(cwd, { recursive: true, force: true });
  });

  async function preToolUseHooks(clientCapabilities: Record<string, unknown>) {
    await initializeClient(agent, clientCapabilities);
    await agent.newSession({ cwd, mcpServers: [] });
    const options = (
      querySpy.mock.calls.at(-1)?.[0] as { options: { hooks?: Record<string, unknown[]> } }
    ).options;
    return options.hooks?.PreToolUse ?? [];
  }

  it("carries the before-tool hook for a client that sent _drgnx/panel", async () => {
    const asked = new ClaudeAcpAgent(
      {
        extRequest: async () => ({ outcome: "deny", reason: "r" }),
        sessionUpdate: async () => {},
        extNotification: async () => {},
      } as unknown as AcpClient,
      { log: () => {}, error: () => {} },
    );
    agent = asked;
    const hooks = (await preToolUseHooks(PANEL_CLIENT)) as { hooks: HookCallback[] }[];
    expect(hooks.length).toBeGreaterThan(0);
    const out = await hooks
      .at(-1)!
      .hooks[0](
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} } as never,
        "toolu_9",
        { signal: new AbortController().signal },
      );
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("adds none for any other client", async () => {
    expect(await preToolUseHooks({})).toEqual([]);
  });
});
