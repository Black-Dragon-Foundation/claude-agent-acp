/**
 * The `_drgnx/panel` extension (drgnx's editor panel), version 1.
 *
 * The agent advertises `agentCapabilities._meta["_drgnx/panel"] = {version, features}`
 * to a client that sent `clientCapabilities._meta["_drgnx/panel"] = {version: 1}`,
 * and only with the features the Claude Agent SDK can serve:
 * - `context`: a `_drgnx/context` notification after each turn, from `getContextUsage`.
 * - `before-tool`: a `_drgnx/before_tool` request from the PreToolUse hook, honouring the answer.
 *
 * Not advertised, because the SDK has no call behind them: `drop` and `pin` (it cannot
 * edit the message list), `compact-preview` (a compaction is a model call; the SDK has no dry run).
 */
import type {
  HookCallback,
  HookJSONOutput,
  Query,
  SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import type { AcpClient, Logger } from "./acp-agent.js";

export const DRGNX_PANEL_KEY = "_drgnx/panel";
export const DRGNX_CONTEXT_METHOD = "_drgnx/context";
export const DRGNX_BEFORE_TOOL_METHOD = "_drgnx/before_tool";
const VERSION = 1;
const FEATURES = ["context", "before-tool"];

/** What the agent advertises, or nothing when the client did not send `_drgnx/panel` version 1. */
export function panelCapability(
  client?: Pick<ClientCapabilities, "_meta"> | null,
): { version: number; features: string[] } | undefined {
  const offered = (
    client?._meta as Record<string, { version?: unknown } | undefined> | undefined
  )?.[DRGNX_PANEL_KEY];
  if (offered?.version !== VERSION) return undefined;
  return { version: VERSION, features: [...FEATURES] };
}

type Kind = "system" | "tools" | "files" | "tool-output" | "conversation";
const KIND_OF_ROW: Record<string, Kind> = {
  system_prompt: "system",
  mcp_instructions: "system",
  custom_agents: "system",
  skills: "system",
  system_tools: "tools",
  mcp_tools: "tools",
  memory_files: "files",
  messages: "conversation",
};
const KIND_ORDER: Kind[] = ["system", "tools", "files", "tool-output", "conversation"];

export interface DrgnxContext {
  used: number;
  size: number;
  parts: { kind: Kind; tokens: number }[];
}

/**
 * The hub's breakdown of a `getContextUsage` answer: only rows that occupy the window
 * (`kind: "used"`), merged into the five parts. Tool results come out of the messages row
 * when Claude Code gives a message breakdown. Parts with no tokens are left out.
 */
export function contextFromUsage(usage: SDKControlGetContextUsageResponse): DrgnxContext {
  const tokens = new Map<Kind, number>();
  const add = (kind: Kind, n: number) => tokens.set(kind, (tokens.get(kind) ?? 0) + n);
  for (const row of usage.categories) {
    const kind = row.id ? KIND_OF_ROW[row.id] : undefined;
    if (row.kind === "used" && kind) add(kind, row.tokens);
  }
  const toolResults = Math.min(
    usage.messageBreakdown?.toolResultTokens ?? 0,
    tokens.get("conversation") ?? 0,
  );
  if (toolResults > 0) {
    add("conversation", -toolResults);
    add("tool-output", toolResults);
  }
  return {
    used: usage.totalTokens,
    size: usage.rawMaxTokens > 0 ? usage.rawMaxTokens : usage.maxTokens,
    parts: KIND_ORDER.flatMap((kind) => {
      const n = tokens.get(kind) ?? 0;
      return n > 0 ? [{ kind, tokens: n }] : [];
    }),
  };
}

/** Sends `_drgnx/context` for the session. Errors are logged, never thrown (older CLIs lack the call). */
export async function pushContext(args: {
  sessionId: string;
  query: Pick<Query, "getContextUsage">;
  client: Pick<AcpClient, "extNotification">;
  logger: Logger;
}): Promise<void> {
  try {
    const usage = await args.query.getContextUsage({ detail: "summary" });
    await args.client.extNotification(DRGNX_CONTEXT_METHOD, {
      sessionId: args.sessionId,
      ...contextFromUsage(usage),
    });
  } catch (error) {
    args.logger.error(`Session ${args.sessionId}: failed to send the context breakdown: ${error}`);
  }
}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

/**
 * The PreToolUse hook that asks the client `_drgnx/before_tool` before every tool runs.
 * `allow` returns `{continue: true}` only: the hub cannot grant a permission Claude Code's
 * own rules would ask for. `deny`, a failed request, or an answer that is neither fails closed.
 */
export function beforeToolHook(args: {
  sessionId: string;
  client: Pick<AcpClient, "extRequest">;
}): HookCallback {
  return async (input, toolUseID, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    try {
      const answer = (await args.client.extRequest(
        DRGNX_BEFORE_TOOL_METHOD,
        {
          sessionId: args.sessionId,
          toolCall: {
            toolCallId: toolUseID,
            title: input.tool_name,
            rawInput: input.tool_input,
            _meta: { claudeCode: { toolName: input.tool_name } },
          },
        },
        signal,
      )) as { outcome?: unknown; reason?: unknown } | undefined;
      if (answer?.outcome === "allow") return { continue: true };
      if (answer?.outcome === "deny") {
        return deny(
          typeof answer.reason === "string" ? answer.reason : "drgnx refused this tool call",
        );
      }
      return deny("drgnx gave no valid answer to _drgnx/before_tool");
    } catch (error) {
      return deny(`drgnx could not be asked before the tool ran: ${error}`);
    }
  };
}
