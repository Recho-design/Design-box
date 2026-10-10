/** @module agent-protocol
 * ACP and DeepSeek Harness profile subprocess protocol adapters.
 * External daemon code imports only from this barrel.
 */
export { createJsonLineStream } from './core/index.js';
export {
  type AcpMcpServerInput,
  type ModelOption,
  buildAcpSessionNewParams,
  normalizeModels,
  detectAcpModels,
  attachAcpSession,
} from './acp/index.js';
export * from './dsh-profile/index.js';
