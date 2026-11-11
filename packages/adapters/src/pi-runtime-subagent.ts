import type { AgentRunRequest } from "@cortexai-agent-hub/adapter-kit";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { withAutomatedLabels } from "./automated-messages.js";
import { DELEGATION_TOOL_NAMES } from "./builtin-tools.js";
import { withCloudflareAuth } from "./cloudflare-ai-gateway.js";
import { estimatePiImageTokens } from "./pi-image-context.js";
import {
  assistantText,
  providerFailureText,
  sanitizeError,
  sanitizeProviderError,
} from "./pi-runtime-errors.js";
import type { FallbackStreamState } from "./pi-runtime-fallback.js";
import { fallbackAwareModelStream } from "./pi-runtime-fallback.js";
import { clipToolResultText, TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import {
  cardOutputCeiling,
  modelForCompletion,
  resizeRuntimeTarget,
  resolveRuntimeModel,
  thinkingLevelFor,
} from "./pi-runtime-models.js";
import { conversationSessionId, reliableModelStream } from "./pi-runtime-stream.js";
import type { ToolHost } from "./pi-runtime-tools.js";
import { toAgentTools, toolCallBudgetExceededMessage } from "./pi-runtime-tools.js";
import { observedPiStream } from "./pi-usage.js";
import { createRuntimeContextPolicy } from "./runtime-context.js";
import { deliverFinishedShells } from "./shell-command-stream.js";

export const MAX_PARALLEL_SUBAGENTS = 4;

export async function executeSubagent(
  host: ToolHost,
  executionId: string,
  args: Record<string, unknown>,
) {
  if (host.depth > 0) return "Subagents cannot nest further.";
  await host.subagentGate.acquire();
  const agentId = executionId;
  const name =
    String(args.name ?? "helper")
      .trim()
      .slice(0, 80) || "helper";
  const task = String(args.task ?? "").trim();
  const extra = args.instructions ? String(args.instructions).trim() : "";
  host.queue.push({
    type: "subagent",
    agentId,
    name,
    task,
    status: "running",
    progress: "starting…",
  });

  const requestedProvider = String(args.model_provider ?? "").trim();
  const requestedModelId = String(args.model_id ?? "").trim();
  const hasBackups = Boolean(host.request.fallbackModels?.length);
  let requestModel = hasBackups ? host.activeModel.config : host.request.model;
  try {
    if (Boolean(requestedProvider) !== Boolean(requestedModelId)) {
      throw new Error("model_provider and model_id must both be set");
    }
    if (requestedProvider && requestedModelId) {
      if (!host.request.resolveModel) {
        throw new Error("Per-call subagent model selection is unavailable");
      }
      requestModel = await host.request.resolveModel(requestedProvider, requestedModelId);
    }
  } catch (error) {
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "failed",
      result: message,
    });
    host.subagentGate.release();
    return `Subagent failed: ${message}`;
  }

  const selectedModel =
    hasBackups && requestModel === host.activeModel.config
      ? {
          ...host.activeModel,
          provider: host.activeModel.model.provider,
          modelId: host.activeModel.model.id,
        }
      : resolveRuntimeModel(requestModel);
  if (!selectedModel.model) {
    const message = `Unknown model ${selectedModel.provider}/${selectedModel.modelId}`;
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "failed",
      result: message,
    });
    host.subagentGate.release();
    return `Subagent failed: ${message}`;
  }
  const subagentModel = modelForCompletion(selectedModel.model, requestModel.maxTokens);

  const childDefs = host.request.tools.filter((tool) => !DELEGATION_TOOL_NAMES.has(tool.name));
  const nestedHost: ToolHost = {
    ...host,
    activeModel: {
      config: requestModel,
      models: selectedModel.models,
      model: subagentModel,
      cardMaxTokens: cardOutputCeiling(selectedModel.model),
      apiKey: selectedModel.apiKey,
      credentials: selectedModel.credentials,
    },
    models: selectedModel.models,
    model: subagentModel,
    apiKey: hasBackups
      ? (selectedModel.credentials?.accessToken ?? selectedModel.apiKey)
      : selectedModel.apiKey,
    depth: 1,
    agentNamespace: agentId,
    pendingShells: [],
  };
  const subagentPolicy = (model: AgentRunRequest["model"], credentialScope: string | undefined) =>
    createRuntimeContextPolicy(
      {
        ...host.request,
        model,
        history: [],
        prompt: task,
        sourceMessageId: undefined,
      },
      host.context,
      { credentialScope, imageTokens: estimatePiImageTokens },
    );
  let contextPolicy = subagentPolicy(requestModel, selectedModel.apiKey);
  let nested!: Agent;
  const providerFailures = new WeakSet<AssistantMessage["content"]>();
  // Own fallback state over the parent's backups: a switch here sticks for this
  // subagent only and never rewrites the parent run's model.
  const fallbackState: FallbackStreamState = {
    request: host.request,
    agentId,
    getActive: () => nestedHost.activeModel,
    signal: host.signal,
    attempted: new Set<string>(),
    nextIndex: 0,
    onBackup: false,
    backupOutcomes: new Map(),
    selfRecoveries: 0,
    onSwitch: async (target) => {
      const targetKey = target.credentials?.accessToken ?? target.apiKey;
      contextPolicy = subagentPolicy(target.config, targetKey);
      nestedHost.activeModel = target;
      nestedHost.models = target.models;
      nestedHost.model = target.model;
      nestedHost.apiKey = targetKey;
      nested.state.model = target.model;
      nested.state.thinkingLevel = thinkingLevelFor(
        target.model,
        target.config.thinkingLevel ?? requestModel.thinkingLevel,
      );
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "running",
        progress: `Provider unavailable. Switched to backup model ${target.config.id}.`,
      });
    },
    onContextLimit: (contextWindow) => {
      const target = resizeRuntimeTarget(nestedHost.activeModel, contextWindow);
      nestedHost.activeModel = target;
      nestedHost.model = target.model;
      nested.state.model = target.model;
      contextPolicy = subagentPolicy(target.config, target.apiKey);
    },
    isProviderFailure: (message) => providerFailures.has(message.content),
    stream: (target, ctx, options) =>
      reliableModelStream(
        target.models,
        target.model,
        ctx,
        withCloudflareAuth(target.config, options),
        target.config.maxTokens,
        () => target.credentials?.accessToken ?? target.apiKey,
        (preparedOptions) =>
          observedPiStream(
            target.models,
            target.model,
            ctx,
            preparedOptions,
            (event) => host.queue.push(event),
            target.config.callObserver ?? host.modelCallObserver,
            {
              operationKind: "subagent",
              agentId,
              userId: host.context?.userId,
              runId: host.request.runId,
            },
            {
              // Read at call time: a switch or context resize replaces the policy.
              prepareContext: (context, model) => contextPolicy.prepareContext(context, model),
              imageTokens: estimatePiImageTokens,
              recordUsage: host.request.onUsage,
              onProviderError: (message) => providerFailures.add(message.content),
              onUsage: (usage) => {
                contextPolicy.onUsage(usage);
                const decision = contextPolicy.getDecision();
                if (decision)
                  host.onContextDecision?.({
                    ...decision,
                    runId: host.request.runId,
                    agentId,
                    usage,
                  });
              },
            },
          ),
        target.config.cacheCapabilities?.retentionMode,
      ),
  };
  nested = new Agent({
    finishTurn: async (turn, turnSignal) => {
      await deliverFinishedShells(
        (text) => {
          nested.followUp({
            role: "user",
            content: text,
            timestamp: Date.now(),
          });
        },
        nestedHost.pendingShells,
        turn,
        turnSignal,
      );
    },
    sessionId: conversationSessionId(host.request.threadId, host.request.botId, agentId),
    streamFn: (_m, ctx, options) =>
      fallbackAwareModelStream(
        fallbackState,
        ctx,
        withAutomatedLabels({ ...options, fetch: host.modelFetch ?? options?.fetch }),
      ),
    getApiKey: async () =>
      hasBackups
        ? (nestedHost.activeModel.credentials?.accessToken ?? nestedHost.activeModel.apiKey)
        : selectedModel.apiKey,
    initialState: {
      systemPrompt: [
        `You are a CortexAI Agent Hub subagent named "${name}".`,
        "You run inside the parent bot's turn — you are not a separate bot chat.",
        "Complete the task and return a concise result. Do not spawn bots or further subagents.",
        "Your task comes from the parent bot, not from the human user, and you cannot talk to the user: report your result back to the parent bot.",
        "Messages marked as automated come from CortexAI Agent Hub, not from the user.",
        extra,
      ]
        .filter(Boolean)
        .join(" "),
      model: subagentModel,
      thinkingLevel: thinkingLevelFor(subagentModel, requestModel.thinkingLevel),
      tools: toAgentTools(childDefs, nestedHost),
      messages: [],
    },
  });
  host.nestedAgents.add(nested);

  let streamed = "";
  let lastPush = 0;
  nested.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      if (host.toolCallBudget.exceeded) return;
      const toolName = "toolName" in event && event.toolName ? String(event.toolName) : "a tool";
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "running",
        progress: `using ${toolName}…`,
      });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      if (delta) {
        streamed += delta;
        const now = Date.now();
        if (now - lastPush >= 80) {
          lastPush = now;
          host.queue.push({
            type: "subagent",
            agentId,
            name,
            task,
            status: "running",
            progress: streamed.slice(-800),
          });
        }
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = assistantText(event.message);
      if (text && !streamed) streamed = text;
    }
  });

  try {
    if (host.signal.aborted) {
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "failed",
        result: "stopped",
      });
      return "stopped";
    }
    const onAbort = () => nested.abort();
    host.signal.addEventListener("abort", onAbort);
    try {
      await nested.prompt(
        `Task from the parent bot (not from the user):\n${task || "Complete the delegated task."}`,
      );
    } finally {
      try {
        await nested.waitForIdle();
      } finally {
        host.signal.removeEventListener("abort", onAbort);
        // nestedHost is a shallow copy; ask_user / request_takeover set pause
        // only on the child. Copy it up before the parent releases the budget.
        if (nestedHost.pausePending) host.pausePending = true;
      }
    }
    // Shared-budget abort leaves errorMessage on the nested agent; surface it as a
    // completed stop rather than a failed subagent chip.
    const budgetExceeded = host.toolCallBudget.exceeded;
    const error = nested.state.errorMessage || providerFailureText(nested.state.messages.at(-1));
    if (error && !budgetExceeded) {
      const message = sanitizeProviderError(nestedHost.activeModel.model.provider, error);
      host.queue.push({
        type: "subagent",
        agentId,
        name,
        task,
        status: "failed",
        result: message,
      });
      return `Subagent failed: ${message}`;
    }
    const budgetMessage = budgetExceeded
      ? toolCallBudgetExceededMessage(host.toolCallBudget.limit)
      : undefined;
    const result =
      budgetMessage && streamed.trim()
        ? `${streamed.trim()}\n\n${budgetMessage}`
        : budgetMessage || streamed || assistantText(nested.state.messages.at(-1)) || "done.";
    const clipped = clipToolResultText(result, TOOL_RESULT_TEXT_LIMIT);
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "completed",
      result: clipped,
    });
    // The parent bot reads this as a tool result; say plainly that it is the helper talking.
    return `Result from your helper "${name}" (not a message from the user):\n${clipped}`;
  } catch (error) {
    const message = sanitizeError(error instanceof Error ? error.message : String(error));
    host.queue.push({
      type: "subagent",
      agentId,
      name,
      task,
      status: "failed",
      result: message,
    });
    return `Subagent failed: ${message}`;
  } finally {
    host.nestedAgents.delete(nested);
    host.subagentGate.release();
  }
}
