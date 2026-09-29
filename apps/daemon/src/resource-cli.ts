/**
 * 阶段2 摘除 Vela 体系后，od resource 命令提示已下线。
 */
export async function runResource(_args: string[]): Promise<void> {
  console.error('`od resource` command is no longer available as Vela cloud integrations have been removed.');
  process.exitCode = 1;
}
