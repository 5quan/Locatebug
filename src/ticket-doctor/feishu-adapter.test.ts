import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, DiagnosisReport, TicketTask } from "./contracts.ts";
import {
  eventToTicket,
  FeishuTicketBridge,
  type FeishuMessenger,
  type FeishuReceiveMessageEvent,
  type TicketRuntimePort,
} from "./feishu-adapter.ts";

function message(overrides: Partial<NonNullable<FeishuReceiveMessageEvent["message"]>> = {}): FeishuReceiveMessageEvent {
  return {
    message: {
      message_id: "om_test_001",
      create_time: "1788660120000",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({
        text: "@_user_1 下单接口批量 500，服务：checkout-service，commit: 58ed2ba",
      }),
      mentions: [{ key: "@_user_1", name: "ticket-doctor" }],
      ...overrides,
    },
  };
}

const REPORT: DiagnosisReport = {
  status: "complete",
  hypotheses: [
    {
      cause: "库存服务调用超时",
      confidence: "medium",
      evidence: [{ source: "test", excerpt: "timeout after 3000ms" }],
    },
  ],
  suggestedNextSteps: ["检查库存服务"],
};

class RuntimeStub implements TicketRuntimePort {
  submissions: TicketTask[] = [];
  duplicate = false;

  async submit(task: TicketTask) {
    this.submissions.push(task);
    return { runId: `run_${task.ticketId}`, accepted: !this.duplicate };
  }

  async waitUntilDone(): Promise<void> {}

  async getEvents(runId: string): Promise<AgentEvent[]> {
    return [
      { type: "run_started", runId, sequence: 1, timestamp: 1 },
      { type: "run_completed", runId, sequence: 2, timestamp: 2, status: "complete", result: REPORT },
    ];
  }
}

class MessengerStub implements FeishuMessenger {
  replies: Array<{ messageId: string; text: string }> = [];

  async replyText(messageId: string, text: string): Promise<void> {
    this.replies.push({ messageId, text });
  }
}

test("自由文本事件映射为 TicketTask，并清理 @、提取服务和 commit", () => {
  const task = eventToTicket(message());
  assert.ok(task);
  assert.match(task.ticketId, /^feishu_om_test_001_/);
  assert.equal(task.description, "下单接口批量 500，服务：checkout-service，commit: 58ed2ba");
  assert.equal(task.service, "checkout-service");
  assert.equal(task.commit, "58ed2ba");
  assert.equal(task.occurredAt, 1788660120000);
});

test("忽略私聊、非文本和未 @ 机器人消息", () => {
  assert.equal(eventToTicket(message({ chat_type: "p2p" })), undefined);
  assert.equal(eventToTicket(message({ message_type: "image" })), undefined);
  assert.equal(eventToTicket(message({ mentions: [] })), undefined);
  assert.equal(eventToTicket({ ...message(), sender: { sender_type: "app" } }), undefined);
});

test("保留自由文本中的日志换行", () => {
  const event = message({
    content: JSON.stringify({ text: "@_user_1 接口报错\nERROR timeout\ntraceId=abc" }),
  });
  assert.equal(eventToTicket(event)?.description, "接口报错\nERROR timeout\ntraceId=abc");
});

test("受理后异步回复确认与最终报告", async () => {
  const runtime = new RuntimeStub();
  const messenger = new MessengerStub();
  const bridge = new FeishuTicketBridge(runtime, messenger);
  const result = await bridge.handle(message());
  assert.equal(result.kind, "accepted");
  await bridge.waitForDelivery("om_test_001");
  assert.equal(runtime.submissions.length, 1);
  assert.equal(messenger.replies.length, 2);
  assert.match(messenger.replies[0].text, /已受理/);
  assert.match(messenger.replies[1].text, /库存服务调用超时/);
});

test("飞书重投同一消息时依赖 Runtime 原子幂等，不重复回复", async () => {
  const runtime = new RuntimeStub();
  runtime.duplicate = true;
  const messenger = new MessengerStub();
  const bridge = new FeishuTicketBridge(runtime, messenger);
  const result = await bridge.handle(message());
  assert.equal(result.kind, "duplicate");
  assert.equal(messenger.replies.length, 0);
});
