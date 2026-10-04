import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'vitest';

import { createAgyStreamHandler } from '../../src/runtimes/agy-stream.js';

/**
 * agy ≥ 1.2.13 `--output-format stream-json` 的 NDJSON 事件流解析。
 * 样本取自主代理实测的真实 stdout（见任务规格），不许改动。
 */

function collect(chunks: (string | Buffer)[]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const handler = createAgyStreamHandler((event) => events.push(event));
  for (const chunk of chunks) handler.feed(chunk);
  handler.flush();
  return events;
}

const INIT_LINE = JSON.stringify({
  event: 'init',
  conversation_id: 'conv-123',
  init: { cwd: '/tmp/x', tools: ['view_file'], permission_mode: 'always-proceed' },
});
const TEXT_LINES = [
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 3,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'po',
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 3,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'ng',
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 3,
      state: 'DONE',
      step_type: 'agent_response',
      usage: { input_tokens: 10, output_tokens: 2 },
      duration: 1.2,
    },
  }),
];
const TOOL_LINES = [
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: { path: 'a.ts' },
    },
  }),
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-123',
      step_index: 1,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: { path: 'a.ts' },
    },
  }),
];
const RESULT_LINE = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-123',
    status: 'SUCCEEDED',
    response: 'pong',
    duration_seconds: 4.5,
    usage: { input_tokens: 11, output_tokens: 3 },
  },
});
const ERROR_RESULT_LINE = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-123',
    status: 'ERROR',
    response: '',
    error: 'quota exceeded (RESOURCE_EXHAUSTED)',
  },
});

describe('agy stream 解析器', () => {
  test('init → text_delta → tool → usage 的完整序列（真实样本）', () => {
    const events = collect([`${INIT_LINE}\n${TEXT_LINES.join('\n')}\n${TOOL_LINES.join('\n')}\n${RESULT_LINE}\n`]);
    const kinds = events.map((e) => e.type);
    assert.deepEqual(kinds, ['status', 'text_delta', 'text_delta', 'tool_use', 'tool_result', 'usage']);
    const [status, delta1, delta2, toolUse, toolResult, usageEvent] = events as Array<Record<string, unknown>>;
    assert.ok(status && delta1 && delta2 && toolUse && toolResult && usageEvent);
    assert.deepEqual(delta1.delta, 'po');
    assert.deepEqual(delta2.delta, 'ng');
    assert.equal(toolUse.name, 'view_file');
    assert.equal(toolResult.toolUseId, toolUse.id);
    assert.equal(toolResult.isError, false);
    assert.deepEqual(usageEvent.usage, { input_tokens: 11, output_tokens: 3 });
    assert.equal(usageEvent.isError, false);
    assert.equal(usageEvent.durationMs, 4500);
    assert.equal(usageEvent.stopReason, 'SUCCEEDED');
  });

  test('init 帧透会透传 status 且带会话 id', () => {
    const events = collect([`${INIT_LINE}\n`]);
    assert.deepEqual(events, [{ type: 'status', label: 'initializing', sessionId: 'conv-123' }]);
  });

  test('ERROR result 带 error 文本且 isError', () => {
    const events = collect([`${ERROR_RESULT_LINE}\n`]);
    const usage = events.find((e) => e.type === 'usage') as { isError: boolean };
    assert.equal(usage.isError, true);
    const error = events.find((e) => e.type === 'error') as { message: string };
    assert.equal(error.message, 'quota exceeded (RESOURCE_EXHAUSTED)');
  });

  test('没有 agent_response 增量时 result.response 补成 text_delta', () => {
    const events = collect([`${RESULT_LINE}\n`]);
    const texts = events.filter((e) => e.type === 'text_delta').map((e) => e.delta);
    assert.deepEqual(texts, ['pong']);
  });

  test('工具 ERROR 回报 isError=true 的 tool_result', () => {
    const toolError = JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'view_file',
      },
    });
    const events = collect([`${INIT_LINE}\n${TOOL_LINES[0]}\n${toolError}\n`]);
    const result = events.find((e) => e.type === 'tool_result') as { isError: boolean };
    assert.equal(result.isError, true);
  });

  test('非 JSON 行变成 bounded raw 事件', () => {
    const events = collect(['not json\n']);
    assert.equal(events.length, 1);
    assert.equal((events[0] as { type: string }).type, 'raw');
  });

  test('未知 step_type 走 raw 通道不崩', () => {
    const line = JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 0, state: 'ACTIVE', step_type: 'unknown_kind' },
    });
    const events = collect([`${line}\n`]);
    assert.equal((events[0] as { type: string }).type, 'raw');
  });

  test('多字节字符跨分片不丢字', () => {
    const line = `${JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-123',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: '桌面渲染服务当前不可用',
      },
    })}\n`;
    const full = Buffer.from(line, 'utf8');
    for (let at = 1; at < full.length - 1; at += 7) {
      const events = collect([full.subarray(0, at), full.subarray(at)]);
      const texts = events.filter((e) => e.type === 'text_delta').map((e) => e.delta);
      assert.deepEqual(texts, ['桌面渲染服务当前不可用'], `切在第 ${at} 字节后被破坏`);
    }
  });

  test('step_update tool 帧空白行被忽略', () => {
    const events = collect([`\n\n${TEXT_LINES[0]}\n\n`]);
    assert.deepEqual(events.map((e) => e.type), ['text_delta']);
  });
});
