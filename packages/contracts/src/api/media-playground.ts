/**
 * Media Playground（直接生成工作台 v2）的数据契约。
 *
 * 这一层只描述 HTTP 边界上的形状：web 的卡片流与 `od media playground` CLI
 * 消费同一份类型，daemon 的 `routes/media-playground.ts` 负责生产它。纯 TS，
 * 不碰 Node / Express / SQLite —— 表结构与落盘布局属于 daemon。
 *
 * 命名与语义的一个要点：**所有路径都是「目标基目录下的相对路径」**。scratch
 * 目标下它是根级 basename（`<genId>-1.png`）或 `uploads/x.png`；项目目标下它
 * 是实际项目根（导入型项目为 `metadata.baseDir`）下的相对路径。客户端不需要、
 * 也无法区分这两者之外的差别。唯一的例外是 generate 响应上的 `outputDir`：
 * 它是那个基目录本身的绝对路径，只给机器消费面（CLI / MCP）定位字节用。
 */

/**
 * Playground 支撑的产物面。
 *
 * v1 恒为 `'image'`：数据库的 `surface` 列刻意**不加 CHECK 约束**，DTO 同理，
 * 将来放开视频时不需要迁移即可扩展这个联合类型。
 */
export type PlaygroundSurface = 'image';

/** 一行历史里的一张产物；批次部分失败时失败槽位带 `error`。 */
export interface PlaygroundGenerationFile {
  /** 目标基目录下的相对路径（scratch：根级 basename 或 `uploads/x.png`）。 */
  name: string;
  size?: number;
  mime?: string;
  /** 仅当该槽位的 provider 调用失败时出现；成功槽位不受连坐。 */
  error?: string;
}

/** 一次生成的参数留痕（`params_json`）。 */
export interface PlaygroundGenerationParams {
  aspect?: string;
  quality?: string;
  /** 分辨率档：'auto' | '1K' | '2K' | '4K'。与 aspect 都具体时才计算具体 size。 */
  resolution?: string;
  /** 内容审核档：'auto' | 'low'（仅 gpt-image 族）。 */
  moderation?: string;
  /** 透明背景：true → API body.background = 'transparent'（仅 gpt-image 族）。 */
  transparent?: boolean;
  count?: number;
  /** 已执行的转存记录：projectId + 实际落地名（幂等依据，UI 渲染转存态）。 */
  transfers?: Array<{ projectId: string; files: string[] }>;
}

/** 一张卡片 = 一次生成（含批次）。 */
export interface PlaygroundGeneration {
  id: string;
  /** null = scratch（不属于任何项目）。 */
  targetProjectId: string | null;
  surface: PlaygroundSurface;
  /** image 目录模型 id（目录 id，不是 wire 模型名）。 */
  model: string;
  /** 实际 wire 模型名（优先于 provider 配置与目录别名）。 */
  modelOverride?: string | null;
  prompt: string;
  params: PlaygroundGenerationParams;
  status: 'running' | 'done' | 'failed';
  files: PlaygroundGenerationFile[];
  /**
   * 目标基目录的**绝对路径**——机器消费面（CLI / MCP 外部代理）据此定位产物
   * 字节：相对 `files[].name` 拼在它下面就是磁盘上的真实文件。
   *
   * 仅 generate 响应携带；列表 / 转存 / 删除响应不填（那些调用方拿到的相对
   * 路径已经够用，而绝对路径只在"刚刚生成完、要把字节搬走"这一刻才有意义）。
   * web 不消费它。
   */
  outputDir?: string;
  error?: string | null;
  createdAt: number;
}

/** `POST /api/media/playground/generate` 的请求体。 */
export interface PlaygroundGenerateRequest {
  /** 缺省 = scratch。 */
  targetProjectId?: string;
  surface: PlaygroundSurface;
  /**
   * 目录模型 id（见 GET /api/media/models），如 `gpt-image-2`、`dall-e-3`。
   *
   * **缺省 = daemon 解析默认**：`offeredModelsForSurface('image')` 目录序中首个
   * provider 已配置的模型。空串视同缺省。外部 CLI / MCP 代理因此不必先知道目录
   * id 就能出图。
   */
  model?: string;
  modelOverride?: string;
  prompt: string;
  aspect?: string;
  quality?: string;
  /** 分辨率档：'auto' | '1K' | '2K' | '4K'。与 aspect 都具体时才计算具体 size。 */
  resolution?: string;
  /** 内容审核档：'auto' | 'low'（仅 gpt-image 族）。 */
  moderation?: string;
  /** 透明背景：true → API body.background = 'transparent'（仅 gpt-image 族）。 */
  transparent?: boolean;
  count?: number;
  /** 目标基目录相对路径（scratch：`uploads/x.png` 或产物 basename）。 */
  images?: string[];
}

/** `GET /api/media/playground/generations` 的响应。 */
export interface PlaygroundGenerationListResponse {
  generations: PlaygroundGeneration[];
  /** `'<createdAt>:<id>'` 复合游标；null = 没有更早的一页。 */
  nextBefore: string | null;
}

/** `POST /api/media/playground/uploads` 的响应：可直接放进 `images` 的引用名。 */
export interface PlaygroundUploadResponse {
  name: string;
}

/** `POST /api/media/playground/generations/:id/transfer` 的响应。 */
export interface PlaygroundTransferResponse {
  generation: PlaygroundGeneration;
  /** 本次实际落地名（幂等命中时为既有记录）；原 scratch 文件保留。 */
  transferredFiles: string[];
}

/** `DELETE /api/media/playground/generations/:id` 的响应。 */
export interface PlaygroundDeleteResponse {
  ok: true;
}
