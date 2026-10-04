export type ExecutionProfile = 'filesystem' | 'text_artifact';

export function executionProfileFromStreamFormat(
  streamFormat: string | null | undefined,
): ExecutionProfile {
  // 'agy-stream-json' 是 antigravity 从 'plain' 迁移到 stream-json stdin
  // 后的流格式（ENAMETOOLONG 修复）：agy 依旧不接收 OD 转发的 MCP/工具，
  // 模型把产物以文本形式吐回，传输层换了、执行语义没换，所以继续走
  // 'text_artifact'，提示词侧保持字节级不变。
  return streamFormat === 'plain' || streamFormat === 'agy-stream-json'
    ? 'text_artifact'
    : 'filesystem';
}
