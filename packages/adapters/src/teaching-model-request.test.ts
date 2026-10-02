import { describe, expect, it } from "vitest";
import type { AgentRunRequest } from "@cortexai-agent-hub/adapter-kit";
import { buildPlaybookFromRecording } from "@cortexai-agent-hub/core";
import type { TeachRecordingEvent } from "@cortexai-agent-hub/core";
import { startModelEmulator } from "./model-emulator.js";

describe("AC2: model request body never contains secret values from taught skills", () => {
  it("sends {{secret:password}} placeholder to model, not the actual password", async () => {
    const passwordEvents: TeachRecordingEvent[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "S", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "e", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "c", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:03.000Z", kind: "key", key: "r", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:04.000Z", kind: "key", key: "e", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:05.000Z", kind: "key", key: "t", fieldType: "password", fieldLabel: "password" },
      { at: "2026-01-01T00:00:06.000Z", kind: "key", key: "Enter" },
    ];

    const playbook = buildPlaybookFromRecording("Sign in", passwordEvents);

    // Capture the model request body
    let capturedRequest: { messages: Array<{ role: string; content?: unknown }> } | null = null;
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            capturedRequest = request;
          },
          response: { type: "text", text: "I need your password." },
        },
      ],
    });

    // Simulate a user invoking the skill by creating a request that includes the playbook
    const runRequest: AgentRunRequest = {
      model: server.model,
      authorization: { id: "fixture-bot-id", botId: "fixture-bot", type: "bot", hashedSigningKey: "fixture-hash" },
      prompt: `Sign in to dashboard\n\nRun taught skill: Sign in\nSteps:\n${playbook.steps.join("\n")}`,
      tools: [],
    };

    // Run the request through the model emulator (which simulates Pi runtime)
    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({
        model: server.model.id,
        stream: true,
        messages: [{ role: "user", content: runRequest.prompt }],
      }),
    });

    expect(response.status).toBe(200);
    server.assertComplete();

    // AC2 assertions: the model request must contain {{secret:password}}, not "Secret"
    expect(capturedRequest).not.toBeNull();
    const requestBody = JSON.stringify(capturedRequest);
    expect(requestBody).toContain("{{secret:password}}");
    expect(requestBody).not.toContain("Secret");
    expect(requestBody.toLowerCase()).not.toContain("secret");

    await server.close();
  });

  it("sends [redacted input] placeholder to model for Protected input", async () => {
    const protectedEvents: TeachRecordingEvent[] = [
      { at: "2026-01-01T00:00:00.000Z", kind: "key", key: "P", sensitive: true },
      { at: "2026-01-01T00:00:01.000Z", kind: "key", key: "I", sensitive: true },
      { at: "2026-01-01T00:00:02.000Z", kind: "key", key: "N", sensitive: true },
    ];

    const playbook = buildPlaybookFromRecording("Enter PIN", protectedEvents);

    let capturedRequest: { messages: Array<{ role: string; content?: unknown }> } | null = null;
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            capturedRequest = request;
          },
          response: { type: "text", text: "I need your PIN." },
        },
      ],
    });

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer local", "content-type": "application/json" },
      body: JSON.stringify({
        model: server.model.id,
        stream: true,
        messages: [{ role: "user", content: `Enter PIN\n\nRun taught skill: Enter PIN\nSteps:\n${playbook.steps.join("\n")}` }],
      }),
    });

    expect(response.status).toBe(200);
    server.assertComplete();

    // AC2 assertions: the model request must contain [redacted input], not "PIN"
    expect(capturedRequest).not.toBeNull();
    const requestBody = JSON.stringify(capturedRequest);
    expect(requestBody).toContain("[redacted input]");
    expect(requestBody).not.toContain("PIN");

    await server.close();
  });
});
