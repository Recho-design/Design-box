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
  /**
   * 画笔局部重绘的 mask：**黑底白笔迹 PNG** 的目标基目录相对路径，白 = 待编辑
   * 区域。前端把画布导出成 PNG 后经 `POST /api/media/playground/uploads` 上传，
   * 拿到相对路径再传进来（与 `images` 同一套引用语义）。
   *
   * 三条硬约束（daemon 逐条判定，缺一不可）：
   * - 必须是 PNG，且与 `images[0]`（mask 作用的底图）**同像素尺寸**——不缩放，
   *   不一致直接 400 `mask_invalid`，「缩放了却改错区域」比明确失败更难排查；
   * - 至少带一张 `images`：mask 编辑的第一张参考图是底图；
   * - 只有 **OpenAI 系**支持原生 mask（`/images/edits` 的 multipart `mask` 字段，
   *   目录模型上的 `inpaintMask` 能力位，目前是 gpt-image 族）。其他 provider
   *   （nanobanana、grok 等）没有这条通路，daemon 返回 400 `mask_unsupported`
   *   而不是静默忽略 mask 出一张「没按涂抹区域改」的图。
   */
  maskImage?: string;
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

/**
 * `POST /api/media/playground/generations/batch-delete` 的请求体。
 *
 * 一次请求删多条历史（卡片流的多选删除、`od media playground delete <id>...`）。
 * `ids` 必须是非空字符串数组；daemon 侧去重后逐条处理，去重后超过 100 条则整个
 * 请求 400 —— 而不是静默只删前 100 条（调用方会以为剩下的也删了）。
 */
export interface PlaygroundBatchDeleteRequest {
  ids: string[];
}

/**
 * `POST /api/media/playground/generations/batch-delete` 的响应。
 *
 * 三个桶互斥，并集 = 请求里**去重后**的全部 id，各自保持 id 首次出现的顺序。
 * 逐条复用单删语义，所以：
 *
 * - `deleted`：行已删。scratch 行的产物文件连同行删除（best-effort：文件删不掉
 *   不回滚行删除）；项目行只删历史行，项目工作区里的素材文件不动。
 * - `skippedRunning`：`running` 行拒绝删除，与单删的 409 同义（行还在被写，
 *   删掉会让 settle 的更新落空）。批删把它降级成"这一条没删"，而不是让整批失败。
 * - `notFound`：id 不存在（含已被删过的）。同样不算整批失败：调用方通常在表达
 *   "清掉我选的这些"，重复调用即可收敛。
 *
 * 因此整批永远是 200 —— 部分失败是**结果**，不是错误信封。调用方按桶决定后续
 * （CLI 有跳过项时 exit 1，同时把逐条结果打出来）。
 */
export interface PlaygroundBatchDeleteResponse {
  deleted: string[];
  skippedRunning: string[];
  notFound: string[];
}
