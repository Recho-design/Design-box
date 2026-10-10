/**
 * Parses `agy --output-format stream-json` (antigravity ≥ 1.2.13) NDJSON
 * stdout into the small event set consumed by the chat UI. Structure mirrors
 * the other JSONL stream parsers (per-handler StringDecoder + line split +
 * bounded raw fallback); the wire shape differs, so keep it separate.
 *
 * Wire shape (real-world sample, agy 1.2.13):
 *   {"event":"init","conversation_id":"…","init":{...}}
 *   {"event":"step_update","step_update":{...,"step_type":"agent_response","text_delta":"pong"}}
 *   {"event":"step_update","step_update":{...,"step_type":"tool","tool_name":"view_file",...,"state":"ACTIVE"|"DONE"|"ERROR"}}
 *   {"event":"result","result":{"status":"SUCCEEDED"|"ERROR","response":"…","error":"…","usage":{...}}}
 */

import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

import { boundedRawAgentEvent } from './run-event-payload-budget.js';

type JsonRecord = Record<string, unknown>;
type AgyEventSink = (event: Record<string, unknown>) => void;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object';
}

/**
 * Decode one stdout chunk, given a decoder that carries state between chunks.
 * See `json-event-stream.ts` for why chunking makes naive `toString('utf8')` wrong.
 */
function stringifyContent(value: unknown, decoder: StringDecoder): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return decoder.write(value);
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textFromStepUpdate(step: unknown): string {
  if (!isRecord(step)) return '';
  return typeof step.text_delta === 'string' ? step.text_delta : '';
}

function isErrorResult(error: unknown): boolean {
  return typeof error === 'string' && error.trim().length > 0;
}

/**
 * 将完整 prompt 编码为 agy stream-json stdin 的单行 NDJSON user 帧。
 * server.ts（运行链）与 connectionTest.ts（连接测试）共用同一帧形——
 * 与 claude 的 encodeStreamJsonUserMessage 同理：帧形漂移 = 静默失败。
 */
export function encodeAgyUserMessage(prompt: string): string {
  return `${JSON.stringify({
    event: 'user',
    message: { role: 'user', content: prompt },
  })}\n`;
}

export function createAgyStreamHandler(onEvent: AgyEventSink) {
  let buffer = '';
  /*
   * Per-handler, never module-level: the decoder must own the trailing bytes
   * of the previous chunk alone, or two concurrent runs splice characters
   * (see the stream parsers' comments for the failure).
   */
  const decoder = new StringDecoder('utf8');
  let emittedAgentText = false;
  let lastToolUseId: string | null = null;
  let toolStepIndex = 0;

  /** step_update：agent_response 的 text_delta 与 tool 状态的最小映射。 */
  function handleStepUpdate(step: JsonRecord, obj: JsonRecord, rawLine: string) {
    if (step.step_type === 'agent_response') {
      const delta = textFromStepUpdate(step);
      if (delta.length > 0) {
        emittedAgentText = true;
        onEvent({ type: 'text_delta', delta });
      }
      return;
    }
    if (step.step_type !== 'tool') {
      onEvent(boundedRawAgentEvent(rawLine, obj));
      return;
    }
    const state = typeof step.state === 'string' ? step.state : '';
    const name = typeof step.tool_name === 'string' ? step.tool_name : 'tool';
    if (state === 'ACTIVE') {
      const id = `agy-tool-${(toolStepIndex += 1)}`;
      lastToolUseId = id;
      onEvent({ type: 'tool_use', id, name, input: {} });
    } else if (state === 'DONE' && lastToolUseId) {
      onEvent({ type: 'tool_result', toolUseId: lastToolUseId, content: '', isError: false });
    } else if (state === 'ERROR' && lastToolUseId) {
      onEvent({ type: 'tool_result', toolUseId: lastToolUseId, content: '', isError: true });
    }
  }

  /** result：终帧 —— usage/duration/stopReason，ERROR 时透传错误文本。 */
  function handleResult(result: JsonRecord, rawLine: string) {
    const isError = result.status === 'ERROR' || isErrorResult(result.error);
    // 短回复可能没有 agent_response 增量流、只落在 result.response 里；
    // 此时把 response 补成一条 text_delta，避免整个回复变成空输出。
    if (!emittedAgentText && typeof result.response === 'string' && result.response.length > 0) {
      onEvent({ type: 'text_delta', delta: result.response });
      emittedAgentText = true;
    }
    onEvent({
      type: 'usage',
      usage: isRecord(result.usage) ? result.usage : null,
      durationMs:
        typeof result.duration_seconds === 'number' ? result.duration_seconds * 1000 : null,
      stopReason: typeof result.status === 'string' ? result.status : null,
      isError,
    });
    if (!isError) return;
    onEvent({
      type: 'error',
      message: typeof result.error === 'string' && result.error.length > 0
        ? result.error
        : 'Antigravity run failed',
      raw: rawLine,
    });
  }

  function handleObject(obj: unknown, rawLine: string) {
    if (!isRecord(obj)) return;

    if (obj.event === 'init') {
      // First well-formed adapter output = CLI ready。会话 id 仅透传展示：
      // agy 不接入 OD 的 resume 存储（`resumesSessionViaCli` 为 false）。
      onEvent({
        type: 'status',
        label: 'initializing',
        sessionId: typeof obj.conversation_id === 'string' ? obj.conversation_id : undefined,
      });
      return;
    }

    if (obj.event === 'step_update' && isRecord(obj.step_update)) {
      handleStepUpdate(obj.step_update, obj, rawLine);
      return;
    }

    if (obj.event === 'result' && isRecord(obj.result)) {
      handleResult(obj.result, rawLine);
      return;
    }

    onEvent(boundedRawAgentEvent(rawLine, obj));
  }

  function handleLine(line: string) {
    try {
      handleObject(JSON.parse(line), line);
    } catch {
      onEvent(boundedRawAgentEvent(line));
    }
  }

  function feed(chunk: unknown) {
    buffer += stringifyContent(chunk, decoder);
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      handleLine(line);
    }
  }

  function flush() {
    const rem = (buffer + decoder.end()).trim();
    buffer = '';
    if (!rem) return;
    handleLine(rem);
  }

  return { feed, flush };
}
