/**
 * 多图批次助手：一次「出 N 张」的请求拆成 N 次独立的 provider 调用。
 *
 * 这里不是一次 `n: N`：OpenAI 兼容端点按张计费、按张失败，一次失败不能连坐
 * 已经落盘的那几张。用 allSettled 保留每个槽位的结果，调用方才能标出失败项而
 * 不掩盖其余产出。
 *
 * 位置说明：它本就是 media 域逻辑，从 `routes/media.ts` 提升到此处导出，
 * Playground 路由与 agent 旧路由因此共用同一份批次语义（旧路由改 import，
 * 行为零变化）。
 */

/** 多图批次里的一个槽位，字段就是调用方看到的那一份。 */
export interface MediaBatchFileResult {
  name: string;
  size?: number;
  mime?: string;
  /** 仅当该槽位的 provider 调用失败时出现。 */
  error?: string;
}

/** 把任意异常值压成一行可读文本（批次槽位的 `error` 就是它）。 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 为每个槽位并行渲染一个文件，并逐个槽位回报结果。
 *
 * `outputNames` 由调用方派生并保证唯一——两个并行槽位各自走自动命名会在同一
 * 毫秒算出同一个路径而互相覆盖，命名权因此不属于这里。
 */
export async function generateMediaBatch(
  baseArgs: Record<string, unknown>,
  outputNames: string[],
  generate: (args: any) => Promise<any>,
): Promise<{ files: MediaBatchFileResult[]; metas: any[] }> {
  const settled = await Promise.allSettled(
    outputNames.map((name) => generate({ ...baseArgs, output: name })),
  );
  const files: MediaBatchFileResult[] = [];
  const metas: any[] = [];
  settled.forEach((result, index) => {
    const requested = outputNames[index]!;
    if (result.status === 'fulfilled') {
      const meta = result.value ?? {};
      const name = typeof meta.name === 'string' && meta.name ? meta.name : requested;
      metas.push(meta);
      files.push({ name, size: meta.size, mime: meta.mime });
      return;
    }
    files.push({ name: requested, error: errorText(result.reason) });
  });
  return { files, metas };
}
