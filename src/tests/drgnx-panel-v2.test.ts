/**
 * The `_drgnx/panel` extension on an ACP v2 connection: the capability moves to
 * `capabilities._meta` of the v2 `initialize` response (and is read from the
 * client's role-agnostic `capabilities._meta`), the context breakdown goes out
 * after a turn's result, and `_drgnx/before_tool` is asked from the PreToolUse
 * hook. Claude Code is a double; the client is the SDK's v2 client app.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DRGNX_PANEL_KEY } from "../drgnx-panel.js";
import { acpProtocolRouter } from "../serve.js";
import type { AgentHandle } from "../v2/agent.js";

type Fake = {
  options: Options;
  prompt(index: number): Promise<SDKUserMessage>;
  send(message: Record<string, unknown>): void;
};

const sdk = vi.hoisted(() => ({ processes: [] as unknown[] }));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const queue: Array<IteratorResult<Record<string, unknown>>> = [];
      let wake = () => {};
      const prompts: SDKUserMessage[] = [];
      let promptArrived = () => {};
      void (async () => {
        for await (const message of prompt) {
          prompts.push(message);
          promptArrived();
        }
      })();
      const fake = {
        options,
        prompts,
        prompt: async (index: number) => {
          while (prompts.length <= index) {
            await new Promise<void>((resolve) => (promptArrived = resolve));
          }
          return prompts[index];
        },
        send: (message: Record<string, unknown>) => {
          queue.push({ value: message, done: false });
          wake();
        },
      };
      sdk.processes.push(fake);
      const messages: AsyncGenerator<Record<string, unknown>> = {
        async next() {
          while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          return queue.shift()!;
        },
        async return() {
          return { value: undefined, done: true };
        },
        async throw(error) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        async [Symbol.asyncDispose]() {},
      };
      return Object.assign(messages, {
        initializationResult: async () => ({
          models: [{ value: "default", displayName: "Default", description: "Recommended" }],
        }),
        supportedCommands: async () => [],
        interrupt: async () => undefined,
        setPermissionMode: async () => {},
        setModel: async () => {},
        stopTask: async () => {},
        close: () => {
          queue.push({ value: undefined, done: true });
          wake();
        },
        applyFlagSettings: async () => {},
        mcpServerStatus: async () => [],
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        getContextUsage: async () => ({
          totalTokens: 60000,
          maxTokens: 160000,
          rawMaxTokens: 200000,
          categories: [
            { id: "system_prompt", name: "s", tokens: 4000, color: "x", kind: "used" },
            { id: "messages", name: "m", tokens: 56000, color: "x", kind: "used" },
          ],
        }),
      });
    },
    getSessionMessages: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
  };
});

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  execFile: vi.fn((...invocation: unknown[]) => {
    const callback = invocation.at(-1) as (...args: unknown[]) => void;
    callback(null, { stdout: JSON.stringify({ loggedIn: false }), stderr: "" });
  }),
}));

const agents: AgentHandle[] = [];
let tempDir: string;
let cwd: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "drgnx-panel-v2-"));
  cwd = await mkdtemp(path.join(tempDir, "project-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempDir, "claude"));
  sdk.processes = [];
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
});

/** A v2 client that records `_drgnx/context` and answers `_drgnx/before_tool` with `answer`. */
function panelClient(answer: () => unknown = () => ({ outcome: "allow" })) {
  const contexts: unknown[] = [];
  const beforeTool: unknown[] = [];
  const app = v2
    .client({ name: "v2-test-client" })
    .onNotification(
      "_drgnx/context",
      (params: unknown) => params,
      ({ params }) => {
        contexts.push(params);
      },
    )
    .onRequest(
      "_drgnx/before_tool",
      (params: unknown) => params,
      ({ params }) => {
        beforeTool.push(params);
        return answer();
      },
    );
  const toAgent = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
  const toClient = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
  acpProtocolRouter(undefined, () => {}, "v2", {
    onV2Agent: (agent) => agents.push(agent),
  }).connect({ readable: toAgent.readable, writable: toClient.writable });
  return {
    contexts,
    beforeTool,
    connect: <T>(run: (agent: v2.ClientContext) => Promise<T>) =>
      app.connectWith({ readable: toClient.readable, writable: toAgent.writable }, run),
  };
}

const PANEL = { _meta: { [DRGNX_PANEL_KEY]: { version: 1 } } } as v2.ClientCapabilities;

async function initialize(agent: v2.ClientContext, capabilities: v2.ClientCapabilities) {
  return agent.request(v2.methods.agent.initialize, {
    protocolVersion: v2.PROTOCOL_VERSION,
    info: { name: "v2-test-client", version: "1.0.0" },
    capabilities,
  });
}

async function openSession(agent: v2.ClientContext, capabilities: v2.ClientCapabilities) {
  await initialize(agent, capabilities);
  const response = await agent.request(v2.methods.agent.session.new, { cwd });
  return { response, claude: sdk.processes.at(-1) as unknown as Fake };
}

const preToolHooks = (claude: Fake) =>
  (claude.options.hooks?.PreToolUse ?? []).flatMap((matcher) => matcher.hooks);

async function askBeforeTool(claude: Fake) {
  const hooks = preToolHooks(claude);
  const outputs = [];
  for (const hook of hooks) {
    outputs.push(
      await hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          tool_use_id: "toolu_1",
        } as never,
        "toolu_1",
        { signal: new AbortController().signal },
      ),
    );
  }
  return outputs;
}

describe("_drgnx/panel on ACP v2", () => {
  it("is advertised in capabilities._meta to a client that asked, and only to it", async () => {
    await panelClient().connect(async (agent) => {
      const response = await initialize(agent, PANEL);
      expect(response.capabilities?._meta?.[DRGNX_PANEL_KEY]).toEqual({
        version: 1,
        features: ["context", "before-tool"],
      });
      expect(response.capabilities?._meta?.claudeCode).toEqual({ promptQueueing: true });
    });
    await panelClient().connect(async (agent) => {
      const response = await initialize(agent, {});
      expect(response.capabilities?._meta).not.toHaveProperty(DRGNX_PANEL_KEY);
    });
  });

  it("asks _drgnx/before_tool before a tool runs, and honours allow and deny", async () => {
    let answer: unknown = { outcome: "allow" };
    const client = panelClient(() => answer);
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent, PANEL);
      expect(await askBeforeTool(claude)).toContainEqual({ continue: true });
      expect(client.beforeTool).toEqual([
        {
          sessionId: expect.any(String),
          toolCall: {
            toolCallId: "toolu_1",
            title: "Bash",
            rawInput: { command: "ls" },
            _meta: { claudeCode: { toolName: "Bash" } },
          },
        },
      ]);
      answer = { outcome: "deny", reason: "no" };
      const denied = await askBeforeTool(claude);
      expect(JSON.stringify(denied)).toContain('"permissionDecision":"deny"');
    });
  });

  it("installs no before_tool hook for a client that did not ask", async () => {
    const client = panelClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent, {});
      await askBeforeTool(claude);
      expect(client.beforeTool).toEqual([]);
    });
  });

  it("pushes _drgnx/context after a turn's result", async () => {
    const client = panelClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent, PANEL);
      void agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: [{ type: "text", text: "Hi" }],
      });
      const prompt = await claude.prompt(0);
      claude.send({
        type: "command_lifecycle",
        command_uuid: prompt.uuid,
        state: "started",
        uuid: randomUUID(),
      });
      claude.send({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "",
        errors: [],
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0,
        modelUsage: {},
        uuid: randomUUID(),
      });
      await vi.waitFor(() => expect(client.contexts).toHaveLength(1));
      expect(client.contexts[0]).toMatchObject({
        sessionId: response.sessionId,
        used: 60000,
        size: 200000,
      });
    });
  });
});
