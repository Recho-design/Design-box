# Media Playground（直接生成工作台 v2）设计

- 日期：2026-10-05（评审修订版 r3）
- 状态：已实施并全链路验收通过（2026-10-05；实测修订：files 端点 `sendFile` 需 `dotfiles:'allow'`——默认数据根 `.od` 含点号段；GenerateView 样式对齐 tokens.css 真实 token）
- 前置：`apps/web/src/components/ImageWorkbench.tsx`（v1 弹窗工作台，本次度黜）、
  `apps/daemon/src/routes/media.ts`（generate 端点与批次逻辑）
- 评审记录：第一轮 DeepSeek（4 阻塞/12 建议/4 可选）；第二轮 Codex（6 阻塞/
  4 建议）——两轮意见全部吸收进本版，取舍记录见 §11

## 1. 背景与目标

v1「直接生图」是 Design Files 面板里的右侧弹窗（`ImageWorkbench`），有两个问题：

1. **绑项目**：想测一张图必须先有项目；生成、参考图、产物全部落在项目目录。
2. **交互割裂**：弹窗与左侧对话区在心理模型上割裂，参考项目
   [gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) 的
   「底部输入条 + 任务卡片流」体验更连贯：输入即出图、结果卡片即历史、
   「输出转参考图」形成迭代闭环。

v2 = **全局「生成」视图（Media Playground）**取代弹窗，支持临时（scratch）与
项目两种落盘目标。

## 2. 决策记录（已与用户确认）

| # | 决策 | 选择 |
|---|---|---|
| D1 | 入口形态 | 全局生图 Playground，不进项目内 chat composer |
| D2 | 临时组织方式 | 单一 scratch 收件箱（单会话），不做多会话管理 |
| D3 | v1 弹窗处置 | 删除 `ImageWorkbench`，入口统一到 Playground |
| D4 | 项目内进入的落盘默认 | 默认当前项目；全局进入默认 scratch，可手动切换目标 |
| D5 | 渠道 | 复用媒体生成提供商管道（`generateMedia` 分发器），不另写生成实现 |
| D6 | 模型语义 | `model` = image 目录 id，**可省略**（缺省/空串由 daemon 解析默认，见 §7）；模型名由 `modelOverride` 自由指定（接缝见下；两轮修订见注记） |

> **2026-10-12 修订（D6 放开）**：`model` 已放开为任意 **image 目录 id**
> （`findMediaModel` + `modelsForSurface('image')` 校验），错误文案改为
> `model must be an image model id from /api/media/models`（并附可用 id
> 列表，见 §5.3）；缺省/空串不再是错误——由 daemon 解析默认（见 §7）。
> `modelOverride` 的语义（「Caller-supplied provider
> model name; wins over provider config + alias」）在全部 image renderer
> （openai 非 Azure 分支 / grok / nanobanana）统一为最高优先；
> 能力分支（尺寸、dall-e-3 的 response_format/quality、gpt-image 的
> quality）仍按目录 id 走。源切换 UI（生图源下拉 + model-options 自动拉取）
> 落在 GenerateView（web 侧）。

> **2026-10-12 修订二（GPT 参数补全 + custom-image 移除）**：
>
> - `PlaygroundGenerateRequest` / `PlaygroundGenerationParams` 新增可选字段
>   `resolution`（'auto'|'1K'|'2K'|'4K'）、`moderation`（'auto'|'low'）、
>   `transparent`（boolean）。参数模型（比例 8 档表、质量词表、`gptImageSizeFor`
>   尺寸计算、模型能力分档）共享在
>   `packages/contracts/src/api/media-gpt-image.ts`，web 与 daemon 同源消费。
> - **wire 语义**：openai 源下 aspect 与 resolution **都具体**才发具体 `size`；
>   任一 'auto' → 不发 size（模型自定）。`resolution: undefined`（agent 旧路径 /
>   CLI 不带 `--resolution`）与显式 `'auto'`（工作台）在 daemon
>   `buildOpenAIImageBody` 里是两条路：前者逐字节保持旧行为（固定 size 映射 +
>   quality 缺省 `high`），后者不发 size 不补 quality。
> - 质量词表收口双侧双保险（web `submitQualityFor` / daemon `gptImageQualityFor`）：
>   表外值（旧卡 `'standard'`）与低版本族上的 `xhigh`/`max` 一律不发字段。
> - **openai 渲染器合并了原 custom-image 的参考图路径**（有参考图 →
>   `/v1/images/edits` + JSON `images:[{image_url}]`，该 JSON 形态是官方
>   OpenAPI 规格支持的，依据见 `media/index.ts` 内注释）。openai 源从此支持参考图。
> - **custom-image provider 整体移除**（与 openai 源重复——openai provider 本就
>   支持自定义 baseUrl/model/key；原用户迁移姿势 = 在 OpenAI 提供商配置里填
>   baseUrl + model，工作台模型下拉选 wire 名）。keyless 模型拉取语义随之迁到
>   openai 槽位（`model-fetch.ts`）。聊天 GenerateSurface 的 `GENERATE_MODEL_ID`
>   从 `'custom-image'` 改为 `'gpt-image-2'`，比例生效靠恒发 `resolution: '1K'`
>   （面板无分辨率控件，钉最低成本档）。
> - 能力分档（尺寸档位 / xhigh·max / gpt 判定）**统一按目录 id**（PR #1309 约定），
>   唯一例外：`gptImageSizeFor` 的分档判据看请求真正要发的模型名（effectiveModel）。

未来接缝（本次不建，但结构预留）：
- **视频**：`media_playground_generations.surface` 列已存在但 **v1 不加
  CHECK 约束**，就是为 surface 扩展免迁移；DTO 的 `surface` 同理。
- **注册表模型**：放开 `model` 到任意目录 id 时，只需 UI 下拉接
  `/api/media/models` + DTO 放宽，管道零改动。
- **节点画布**：回合的 `images` 保留可寻址引用（指向基目录内文件），是
  将来图视图的连线原语。

## 3. 关键现状事实（设计的约束来源）

- `generateMedia` 内 `projectId` 只用于两处：参数校验
  （`media/index.ts:415`）与 `ensureProject(projectsRoot, projectId)`
  （`:510`）；`onBytesWritten` / 202 任务 / 快照关联 / 埋点全部在
  `routes/media.ts` 一侧。media 层加 `outputDir` 不影响任何既有调用方。
- `generateMedia` 的单一 `dir` **同时是产物落盘根与参考图解析根**
  （`resolveProjectImage` 强制目标在 `dir` 内）；`sanitizeName` 把
  `/`、`\` 换成 `_`，**产物无法写进子目录**。⇒ scratch 目录必须扁平布局
  （B1）。
- `media_tasks` 表 `project_id NOT NULL` + FK，且终态任务 1 小时 GC——它是
  轮询通道，不是历史存储；scratch 没有项目行插不进去 ⇒ 需要独立历史表。
- `POST /api/media/generate` 批次路径（count>1）同步返回全部 per-slot 结果
  ⇒ Playground 卡片免轮询。
- 路由侧的 `RUNTIME_DATA_DIR` 来自注入的 `ctx.paths`（`routes/media.ts:299`）；
  `server.ts` 的同名常量是模块私有，路由拿不到（B3）。
- 既有花钱端点带 `isLocalSameOrigin(req, getResolvedPort())` 同源守卫
  （`routes/media.ts:1203`），无全局中间件，逐端点 opt-in（B2）。
- Web router 是 path-only：`Route` 只有结构化字段，`commitNavigation` 用
  pathname 判同路径（B4）⇒ 项目上下文必须编码进 path，不能用 query。
- SQLite `foreign_keys = ON`（`db.ts:76`），CASCADE 真生效；迁移注册点在
  `db.ts:610`（`migrateMediaTasks(db)` 调用处）。
- `autoOutputName` 用 `Date.now().toString(36)`：同毫秒两个单图请求会算出
  同名文件互相覆盖（S8）⇒ Playground 输出名必须从 generation id 派生。
- 导入型项目的真实工作区是 `metadata.baseDir`；`ensureProject` 不读
  metadata，产物落 `PROJECTS_DIR/<id>`；Design Files 列的是 `baseDir`
  （S4）⇒ **Playground 的项目目标（生成与转存）一律用
  `resolveProjectDir(PROJECTS_DIR, id, metadata)` 取实际项目根**。agent
  旧路径维持 `ensureProject` 现状不动（已知行为，不在本 spec 范围内改）。
- v1 的参考图上传/文件刷新依赖 `useProjectCollabContext()` 的
  `workspaceContext`；全局入口层没有该 provider（缺省
  `workspaceContext: null`）（S9）⇒ D7。
- `sniffImageExt` 对未知字节**默认返回 `.png`**（`media/index.ts:1847`）⇒
  上传校验必须「未知魔数 → 拒绝」，不能直接复用该函数的默认分支（C4）。
- 参考图读取有 16MB 上限（`media/index.ts` `resolveProjectImage`）⇒
  Playground 上传限额对齐 16MB，否则「传得上来、用不进去」（C4）。

## 4. 总体架构

```
Web: GenerateView（卡片流 + 底部 InputBar）
      │  target = scratch | 当前项目（path 段编码）
      ▼
HTTP: /api/media/playground/*（新，同源守卫，契约进 packages/contracts）
      ▼
daemon: routes/media-playground.ts（新 route 文件）
      │   └─► 批次助手（自 routes/media.ts 提升到 src/media/ 导出）
      │        └─► generateMedia（渠道不变，outputDir 解耦）
      │              ├─ scratch 目标 → PLAYGROUND_DIR（registrar 派生）
      │              └─ 项目目标   → resolveProjectDir(...)（实际项目根）
      ▼
SQLite: media_playground_generations（新表，卡片历史）
```

agent 侧 `POST /api/media/generate` 与 `media-contract` 提示词契约**完全不动**；
Playground 是新增的平行走廊，不共用 agent 的任务存储。

## 5. daemon 设计

### 5.1 输出目录解耦（generateMedia 最小改造）

`generateMedia`（`apps/daemon/src/media/index.ts`）新增可选参数：

```ts
/**
 * 显式输出目录：提供时【目录派生】以它为准——跳过 ensureProject，
 * projectsRoot 不再使用，projectId 退化为纯错误上下文（不参与路径，
 * 与其同传不构成冲突）。
 */
outputDir?: string;
```

- 未传时行为逐字节不变（agent / CLI / 既有 60+ 测试调用点零影响）。
- **参数契约（C1 修订，消除 r2 的自相矛盾）**：互斥的是**目录选择行为**，
  不是参数本身——`outputDir` 存在 → 目录完全由它决定，`projectId` 仅用于
  错误信息与日志（Playground 传 generation id）。类型上 `projectId` 保持
  必填（不弱化既有调用方的编译期约束，O1）。
- `resolveProjectImage` 的两条报错文案中性化：「resolves outside the
  project directory」→「resolves outside the allowed directory」，
  「`--image` not found」保持（scratch 下同样成立）（O2）。

**Playground 两种目标都走 `outputDir`（C2 修订）**：

```
scratch 目标：outputDir = PLAYGROUND_DIR
项目目标：  outputDir = resolveProjectDir(PROJECTS_DIR, id, metadata)
```

项目目标与 transfer 用同一个解析器（导入型项目落 `baseDir`，产物直接
进 Design Files）；`ensureProject` 分支只有 agent 旧路径继续使用。
项目目录已存在（项目创建时建立），Playground 不创建目录，只往里写。

**PLAYGROUND_DIR 布局（扁平，B1 修订）**：产物与 `uploads/` 平级——

```
<RUNTIME_DATA_DIR>/media-playground/
  <genId>-1.png ... <genId>-N.png     # 产物，名从 generation id 派生（S8）
  uploads/<sanitized-unique>.png       # 参考图上传
```

产物在根、参考图在 `uploads/` 子目录：参考图是「目标基目录相对路径」
（`uploads/x.png`），产物名是根级 basename——`outputDir = PLAYGROUND_DIR`
一个值同时满足两个角色，无矛盾。**产物输出名固定
`${generationId}-${slot}.png`**（扩展名由 renderer `suggestedExt` 决定），
从构造上消除同毫秒碰撞，也让 `files_json` 的文件名天然唯一可追溯。

**目录来源（B3 修订）**：`PLAYGROUND_DIR` **不是模块级常量**。在
`routes/media-playground.ts` 的 route registrar 内从
`ctx.paths.RUNTIME_DATA_DIR` 派生，作为参数传给 handler / store / 文件
操作。参考图上传不新造 multer 实例，沿用既有上传处理方式但落盘点由该
派生目录参数化。禁止 `process.env.OD_DATA_DIR` 直读与 cwd 兜底
（根 AGENTS.md 数据目录契约）。

### 5.2 历史持久化：`media_playground_generations` 新表

```sql
CREATE TABLE IF NOT EXISTS media_playground_generations (
  id TEXT PRIMARY KEY,
  target_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = scratch
  surface TEXT NOT NULL,                    -- v1 恒 'image'，无 CHECK（D6 接缝）
  model TEXT NOT NULL,                      -- image 目录 id（请求缺省时落解析出的默认）
  model_override TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',   -- aspect/quality/count/transfers[]
  status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  files_json TEXT NOT NULL DEFAULT '[]',    -- [{name, size?, mime?, error?}]
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_playground_cursor
  ON media_playground_generations(created_at DESC, id);
```

- 一行 = 一张卡片 = 一次生成（含批次）。批次部分失败以 per-slot `error`
  记在 `files_json`，与批次响应同构。
- `files_json` 只存 **basename**（产物永远在目标根目录，无层级）；
  `target_project_id` 非空的行，basename 即**实际项目根**（导入型项目为
  `baseDir`）下的相对路径。`images` 引用同理：scratch 传 `uploads/x.png`
  或产物 basename；项目目标传实际项目根相对路径。**一个语义：目标基目录
  下的相对路径**（B1/C2 的统一）。
- **行插入时机（S8 修订）**：dispatch 前插 `running` 行，settle 后更新为
  `done`/`failed`——API 花费在历史里有痕迹。route registrar 启动时把遗留
  `running` 行清扫为 `failed`（daemon 重启即中断，不产生永久 running）。
- **孤儿治理（S8 修订）**：`DELETE /generations/:id` **一律删除 scratch
  产物文件**（无论是否转存过；转存副本在项目里不受影响）——不留任何
  「不在行里也无入口可删」的永久孤儿。
- **删除竞态（C5 修订）**：`running` 行**不可删除**（DELETE 返回 409
  `GENERATION_RUNNING`）——同步批次在 HTTP 请求内 settle，运行窗口就是
  请求窗口；禁止删除避免「删行后 settle 更新落空 + 渲染器照常写出孤儿
  文件」。
- **游标分页（S2/C 建议 2 修订）**：排序键 `(created_at DESC, id DESC)`
  （id 为 TEXT，字典序）；`before` 谓词 = 行的 `(created_at, id)` 二元组
  字典序**严格小于**游标值，格式 `"<created_at>:<id>"`。索引
  `(created_at DESC, id)` 与该谓词匹配，同毫秒插入不漏不重。
- 迁移函数放 `apps/daemon/src/media/playground-store.ts`（行级 CRUD 一并
  在此），**在 `db.ts` 的 `migrateMediaTasks(db)` 旁同点注册**（S2）。

### 5.3 HTTP API（新前缀 `/api/media/playground`）

**安全基线（B2 修订）**：六个端点**全部**加
`isLocalSameOrigin(req, getResolvedPort())`——包括读路径（`generations`、
`files`）：本机 UI/CLI 专属，读路径泄露生成历史与图片同样不可接受。

| 方法/路径 | 语义 |
|---|---|
| `POST /generate` | 生成。body：`{targetProjectId?, surface:'image', model?, modelOverride?, prompt, aspect?, quality?, count?, images?: string[]}`。**`model` 可选**：缺省/空串时 daemon 解析默认——`offeredModelsForSurface('image')` 目录序中首个 **`configured === true`** 的 provider 的模型（env key / 存储 key / 借用凭据；**baseUrl-only 不算可用**，见 §7）；无任何已配置 provider → 400 并附可用模型 id 列表；显式非法 id 的 400 消息同样附该列表。同步响应（批次语义，count 钳 1–10）。`images` 为目标基目录相对路径（scratch：`uploads/x.png` 或产物 basename；项目：实际项目根相对路径）。响应 = 完整 generation 行（含 per-slot 失败）+ `outputDir`（目标基目录绝对路径，见 §7）。 |
| `POST /uploads` | 参考图上传（multipart）。**可选 `targetProjectId`（C3 修订）**：缺省落 scratch `uploads/`；传项目 id 则落**该项目的实际项目根**（`resolveProjectDir`，导入型为 baseDir）——参考图永远落在「生成时会解析的目录」，两个目标下上传即可用。`sanitizeName` + 唯一化命名（`uniqueUploadFileName` 规则）；大小上限 **16MB**（对齐参考图读取上限）；魔数校验**未知格式拒绝**（不得走 `sniffImageExt` 的默认 `.png` 分支，C4）。返回 `{name}` = 目标基目录相对路径，可直接放 `images`。 |
| `GET /generations?limit=50&before=&target=` | 倒序卡片历史；`target=scratch` 或项目 id 过滤。响应含 `nextBefore`。 |
| `GET /files/:id/:slot` | 只读返回 **scratch 产物**字节（S6 修订）：① 行必须 `target_project_id IS NULL`；② `slot` 为非负整数且 < `files_json` 长度、该槽无 `error`；③ 拼出的绝对路径做 containment 复核；④ 响应头 `Content-Type: mime`、`Cache-Control: private, max-age=31536000, immutable`（文件名含唯一 genId，内容不可变）、inline `Content-Disposition`。项目产物走既有项目文件服务（`projectFileUrl`）。 |
| `POST /generations/:id/transfer` | scratch → 项目转存：body `{projectId}`。**落盘用 `resolveProjectDir(PROJECTS_DIR, projectId, metadata)`**（导入型项目落 baseDir，否则 Design Files 不可见，S4）；目标重名走 `uniqueUploadFileName` 规则去重，不静默覆盖；**幂等与留痕（C 建议 3 修订）**：行 `params_json.transfers` 记 `[{projectId, files: [实际落地名]}]`，重复 transfer 同一项目 → 直接 200 返回既有记录，不再复制（不产生 `-1` 副本）；响应含本次实际落盘名列表。原 scratch 文件保留。 |
| `DELETE /generations/:id` | 删行 + **一律删 scratch 产物文件**（见 §5.2）；**`running` 行返回 409**（C5）。 |

**错误信封（S12 修订）**：新端点**统一嵌套信封**
`sendApiError(res, status, code, message)`；路由 catch 分支也包成嵌套
（不再产生 `{error: string}` 平形状）。CLI 的
`exitWithMediaHttpFailure` 依赖嵌套形状拿 `code`/`nextStep`。

**媒体策略与观测（S7 修订）**：
- Playground 无 Run，**显式**按 `defaultMediaExecutionPolicy()` 放行（不
  沉默绕过 run 级策略）。
- 复用 `mediaAnalyticsContext` 的无 Run standalone 身份回退，上报
  `captureMediaGenerationResult`（`media_generation_result`），不新开观测
  盲区。

### 5.4 与既有 generate 端点的关系

- `POST /api/media/generate`（agent + 202 任务轮询）**不动**。
- Playground 是独立 handler（新文件 `apps/daemon/src/routes/media-playground.ts`，
  注册进 route-context-contract 的 deps，S1）：不建 media_tasks、不挂
  `onBytesWritten` 快照、不做 late-file 关联（无 Run 无消息）。
- 批次助手 `generateMediaBatch` 从 `routes/media.ts` **提升到
  `apps/daemon/src/media/` 并导出**（它本就是 media 域逻辑；旧路由改 import，
  行为零变化），Playground 与旧路由共用同一份批次语义（S1）。

### 5.5 CLI 双轨（UI/CLI 双轨契约）

```bash
od media playground generate [--project <id>] [--model <image-model-id>] \
    [--model-override <name>] [--count n] [--aspect 16:9] [--quality high] \
    [--image <ref> ...] --prompt-file <path|->   # 无 --project 即 scratch；无 --model 即 daemon 默认
od media playground upload <file>... [--project <id>]  # → 输出目标相对引用名（S11/C3）
od media playground list [--json] [--limit n] [--target scratch|<pid>]
od media playground download <generationId> [--slot n] [--out <path>]  # C6
od media playground transfer <generationId> --project <id>
od media playground delete <generationId>
od media models [--json] [--daemon-url <url>]  # image 模型 id+provider / providers / aspects
```

- `upload` 补齐双轨（S11）：CLI 把本地文件送进目标目录，输出 `{name}`
  供 `--image` 引用——图生图不做成 UI 独有能力。
- `download` 补齐双轨（C6）：scratch 行从 `PLAYGROUND_DIR`、项目行从实际
  项目根读字节；`--out` 缺省落当前目录（用产物 basename），`--json` 输出
  `{path}`——UI 的预览/下载能力 CLI 同形可达。
- `runMedia` 的子命令扩展点在 `cli.ts` 的 `media` 分发处（现认
  `generate|wait|scaffold|models`），新增 `playground` 一级子命令。
- `models` 补齐双轨：`od media models` 只读列目录（image 模型 id + provider、
  providers、aspects；`--json` 打原始 `GET /api/media/models` 载荷）——给代理
  一条「我到底能写哪个 id」的回答路径，但**不是必经之路**：
  `playground generate` 省略 `--model` 也能出图（默认解析见 §7）。失败沿用
  media 惯例（连不上 exit 3，daemon 拒绝 exit 4）。
- `--json` 行形状与 HTTP 响应一致；`transfer`/`delete` 失败退出码沿用
  既有惯例（2/3/4 + 嵌套 `{error:{code,message,nextStep}}`）。

## 6. Web 设计

### 6.1 路由与入口（B4 修订）

- `EntryHomeView` 增加 `'generate'`；**Route 结构化字段编码项目上下文，
  不用 query**：
  ```ts
  { kind: 'home'; view: 'generate'; generateProjectId?: string }
  ```
  `parseRoute` 认 `/generate`（无目标）与 `/generate/<projectId>`（预选
  项目目标）——与 `brandId` 的既有先例同构，深链/刷新/回退语义完整；
  `buildPath` 侧对称编码（C 建议 1）。
- EntryNavRail 加「生成」项（icon + label，与既有 rail 项同构）。
- Design Files 的「直接生图」按钮（`DesignFilesPanel.tsx:1376`，
  `design-files-image-workbench-trigger` testid 一并迁移）改为
  `navigate` 到 `/generate/<projectId>`（D4）。
- **视图内目标切换是组件 state，不重写 URL**（避免每次切换 push 历史）；
  但**路径变化必须同步重置 state**（C 建议 1）：`generateProjectId` 是
  受控源——浏览器前进/后退或 rail 跳转使 pathname 变化时，GenerateView
  以 `useEffect` 把 route 字段单向同步进目标 state（route → state，
  永不反向），已挂载视图不会保留旧目标。

**D7（评审 S9 新增决策）**：v1 项目目标**仅支持个人/本地项目**——目标
选择器不列团队 Workspace 项目（全局入口层没有
`useProjectCollabContext`，拿不到 workspace 授权身份；只读项目也不该显示
写操作）。团队项目支持留待后续把生成视图挂进项目上下文时再做。

**2026-10-05 修订（入口迁移）**：项目级「直接生图」入口从 Design Files
工具栏**迁到聊天框 composer 附件行**（`composer-generate-trigger`，viewer/
sendDisabled 时隐藏）。点击**不再 navigate 到 `/generate`**，而是在聊天
面板内展开内嵌生图 surface（`components/chat/GenerateSurface.tsx`，纯逻辑
在 `runtime/chat/generate-surface.ts`）——与工作台三点刻意差异：目标恒为
当前项目（无 scratch 档/转存）；历史只覆盖本次会话（全量历史仍在导航栏
「生成」）；不注入聊天消息管线。全局 `/generate` 视图与 rail 入口不变。
失败卡重试语义为**就地替换**（不追加新卡）。

### 6.2 视图布局（对齐 gpt_image_playground）

```
┌ GenerateView ─────────────────────────────────┐
│ 顶栏：目标选择器（临时/个人项目）│ 历史数量   │
│ ──────────────────────────────────────────── │
│ 卡片流（滚动区，最新在上）                    │
│   GenerationCard ×N：图片格 + 参数徽标 + 状态 │
│   动作：预览 / 复用 / 转参考图 / 下载 /       │
│         转存到项目(仅scratch) / 删除          │
│ ──────────────────────────────────────────── │
│ InputBar（吸底）：                            │
│   参考图 chips（上传/粘贴/拖拽）              │
│   prompt 多行输入                             │
│   参数快选：模型名(带建议列表) / 比例5档 /    │
│             质量 / 张数1-10                   │
│   [生成] 按钮                                 │
└──────────────────────────────────────────────┘
```

- 生成中卡片为本地乐观态；请求 settle 后用响应行刷新（行已在服务端
  `running → done`，乐观卡只是即时反馈层）。
- 「复用」：把该卡 prompt+参数填回 InputBar；「转参考图」：把产物 basename
  加进参考图 chips（指向其所在目标基目录）。
- **模型建议列表来自 `/api/media/models`**（daemon 目录），不用 web 侧
  `IMAGE_MODELS` 副本继续漂移（O3）；输入仍自由（`modelOverride` 语义）。
  **列表仅作可编辑示例**（C 建议 4）：datalist 形态、placeholder 说明
  「示例值，实际模型名以你的端点为准」——不暗示这些 id 由端点直接支持：
  目录 id 由 `model` 承载，这里的自由文本填的是上游 wire 名
  （`modelOverride`）。
- **2026-10-12 修订**：上面这条原本写死 `model:'custom-image'` 的约束已
  随 D6 放开失效——`model` 现在接受任意 image 目录 id（见 §2 D6 修订
  注记），源切换下拉落在 GenerateView，`modelOverride` 在所有 image
  renderer 中优先于 provider 配置。
- **2026-10-12 修订（模型下拉只列可拉取模型）**：模型下拉**不再列目录
  内置 id**（`IMAGE_MODELS` 常量只是 daemon 目录，不代表该 provider 可
  调度），选项 = 默认档（provider 配置的模型名；未配置显示
  `generate.modelDefaultUnset`）+ `/model-options` 拉回的 id。提交语义
  不变：默认档仍派发目录默认 id（`resolveDispatchModel` 的 fallback），
  所选名作为 `modelOverride` 传 daemon。注册表里未标
  `supportsModelFetch` 的源只有默认档一档（其模型名本就来自用户配置）。
- 图片预览复用既有 Lightbox/预览模式；样式走 `GenerateView.module.css`
  （组件旁，不进 `styles/` 全局，O4），遵守动画哲学（enter 200ms
  ease-out、exit 140ms；卡片从 `scale(0.9)+opacity:0` 进入）。
- 组件复用 `@open-design/components` 原语，不新增 raw class。
- **转存/项目目标生成后**：调用既有 `invalidateProjectFilesCache`（+
  在项目视图时触发文件刷新），保证 Design Files 立即可见（S9）。

### 6.3 v1 弹窗度黜（S9 修订）

- 删除 `ImageWorkbench.tsx` / `ImageWorkbench.module.css`；
  `DesignFilesPanel.tsx` 中的入口按钮（`:1376`）、挂载点（`:1976`）、
  `workbenchOpen` state 与 `onRefreshFiles` 回调链一并清理。
- i18n：**删除**旧 `imageWorkbench.*` 全部 24 个 key（`types.ts:3619-3642`
  ×19 locale），新增 `generate.*` key 组（目标选择器、转存、删除确认、
  空态、历史计数、上传失败、跨目标引用提示等；`types.ts` 先行，19 locale
  全量，typecheck 强制）。

### 6.4 Settings → Media 提供商面板约定（2026-10-08 补）

- 该面板表单是**自动保存**（400ms 防抖，SettingsDialog autosave loop），
  没有保存按钮。禁止再出现"保存前不会生效"类误导文案
  （`settings.mediaProviderSaveHint` 已因此删除，勿回填）。
- 面板内**新增控件一律复用 `@open-design/components` 原语**
  （如拉取模型按钮用 `Button`），不新增 raw class 按钮；既有旧按钮的
  迁移另立任务，不顺手混入。
- **拉取模型**：`supportsModelFetch` 的提供商（openai/grok/imagerouter/
  openrouter/aihubmix）在 model 字段旁有"拉取模型"按钮，
  走 `GET /api/media/providers/:id/model-options`（路径刻意不带 `/models`
  后缀：更早注册的 aihubmix 公开目录路由
  `/api/media/providers/aihubmix/models` 会遮蔽同形路径；daemon 侧读已保存
  配置代拉上游 OpenAI 兼容 `/models`，同 elevenlabs voices / aihubmix
  catalogue 模式；错误信封单形状 `{error}`）。该能力位需要 web 与 daemon
  两份 `MEDIA_PROVIDERS` 注册表（`apps/web/src/media/models.ts` 与
  `apps/daemon/src/media/models.ts`）同步维护——review 时两边对账。
- 拉取模型是设置表单辅助动作（同 elevenlabs voices），不做 CLI 双轨。
- **已知限制（裁定不修）**：拉取读的是 daemon 已保存配置——屏上 key
  改动若未过 400ms 防抖落盘就点拉取，仍用旧 key（旧 key 有效则静默
  成功，无效则报错后重点即可）。修它需动自动保存与拉取的时序，
  风险大于收益。

## 7. 数据契约（packages/contracts）

`packages/contracts/src/api/media-playground.ts`（纯 TS，无 Node API）：

```ts
export type PlaygroundSurface = 'image';                 // D6 接缝：将来并 'video'
export type PlaygroundGenerationFile = {
  name: string;                 // 目标基目录下的相对路径（scratch: 根级 basename 或 uploads/x.png）
  size?: number; mime?: string;
  error?: string;               // per-slot 失败（批次部分失败）
};
export type PlaygroundGenerationParams = {
  aspect?: string; quality?: string; count?: number;
  /** 已执行的转存记录：projectId + 实际落地名（幂等依据，UI 渲染转存态） */
  transfers?: Array<{ projectId: string; files: string[] }>;
};
export type PlaygroundGeneration = {
  id: string;
  targetProjectId: string | null;   // null = scratch
  surface: PlaygroundSurface;
  model: string;                    // image 目录 id（请求缺省时落解析出的默认）
  modelOverride?: string | null;    // 实际 wire 模型名；缺省 = provider 别名 > 目录 id
  prompt: string;
  params: PlaygroundGenerationParams;
  status: 'running' | 'done' | 'failed';
  files: PlaygroundGenerationFile[];
  /**
   * 目标基目录的**绝对路径**（`files[].name` 拼在它下面即磁盘上的真实文件）。
   * 仅 generate 响应携带——列表/转存/删除响应不填；web 不消费，给外部
   * CLI/MCP 代理定位产物字节用（见 §5.3）。
   */
  outputDir?: string;
  error?: string | null;
  createdAt: number;
};
export type PlaygroundGenerateRequest = {
  targetProjectId?: string;         // 缺省 = scratch
  surface: PlaygroundSurface;
  /**
   * **可选**——缺省/空串时 daemon 解析默认：`offeredModelsForSurface('image')`
   * 目录序中首个 **`configured === true`** 的 provider 的模型（env key /
   * 存储 key / 借用凭据）；**baseUrl-only 不算可用**——openai/grok/nanobanana
   * 三个 image renderer 无 key 必抛错，把这种配置当默认只会产出失败卡片，还会
   * 按目录序遮蔽后面真正配了 key 的 provider；
   * 无任何已配置 provider → 400 并附可用模型 id 列表；显式非法 id 的 400
   * 消息同样附该列表（外部代理不必先读目录即可出图）。
   */
  model?: string;
  modelOverride?: string;
  prompt: string;
  aspect?: string; quality?: string; count?: number;
  images?: string[];                // 目标基目录相对路径
};
export type PlaygroundGenerationListResponse = {
  generations: PlaygroundGeneration[];
  nextBefore: string | null;        // 'createdAt:id' 复合游标
};
export type PlaygroundUploadResponse = { name: string };
export type PlaygroundTransferResponse = {
  generation: PlaygroundGeneration;
  transferredFiles: string[];      // 本次实际落地名（幂等命中时为既有记录）
};
export type PlaygroundDeleteResponse = { ok: true };
```

外部编码代理（MCP `generate_image` / `list_media_models` 工具）接入见
`docs/external-media-orchestration.md` 的 External Coding Agents 节。

## 8. 错误与边界

- 批次部分失败：per-slot `error` 徽标 + 成功槽位正常渲染（沿用批次语义）。
- `model` 缺省/空串 → daemon 解析默认（目录序首个 `configured === true` 的
  provider 的模型；baseUrl-only 不算可用，见 §7）；
  无任何已配置 provider → 400 并附可用模型 id 列表；显式非法 id 的 400 消息
  同样附该列表（§5.3）。
- `modelOverride` 空白串按无 override；三个 image renderer 的 wire 名都有
  落点（provider 配置模型 / 别名 / 目录 id，nanobanana 另有内置默认），
  「明确报错」只发生在缺省解析时**一个 provider 都没配**（上一条）。
- **wire 模型名规则（2026-10-13 补）**：请求级 `modelOverride` 最优先；
  否则当请求的目录 id 是该 provider 的**目录默认模型**（`modelDef.default`，
  openai = `gpt-image-2`、grok = `grok-imagine-image`）且 Settings → Media
  里配了默认模型时，**配置的模型名**作 wire 名发出（自建网关/中转常只服务
  用户配置的那一个名字）；显式选到的非默认目录模型（`dall-e-3` 等）是明确
  选择，原样发送，不做静默改道。id 与端点真实模型不符时上游回 422，
  `mediaFailureNextStep` 把 `invalid_model_error` / `model not found` 归为
  `switch-model`（此前落 `contact-support`），代理据此换模型自愈。
- `count` 钳 1–10（复用 `clampMediaGenerateCount`）。
- 同源守卫全端点（§5.3）；uploads 净化 + 16MB 限额 + 未知魔数拒绝（§5.3）；
  `files/:id/:slot` 四条防护（§5.3）。
- `running` 行不可 DELETE（409）；重复 transfer 同一项目幂等返回（§5.2/§5.3）。
- 项目不存在/已删除：generate/uploads 400、transfer 404；项目删除级联清其
  历史行（scratch 行不受影响）。
- daemon 重启：清扫遗留 `running` → `failed`（§5.2）。
- scratch 磁盘治理：v1 不做自动清理；`uploads/` 的孤儿参考图随产物删除
  规则治理外的残留，量级可控，记为已知边界。

## 9. 测试与验证（S10 修订：全部落 apps/daemon/tests/ 路由级 Vitest）

- 路由级测试（`startServer`，daemon HTTP 边界，最便宜层）：
  - scratch 生成：产物落 `PLAYGROUND_DIR` 根、`genId-N` 命名、行
    running→done、同步响应形状
  - 项目目标生成：**导入型项目（baseDir）落点正确**（C2）、行带
    targetProjectId
  - **批次 per-slot 部分失败**：一槽 500 一槽成功 → 行与响应各按各（§8 核心）
  - **同毫秒并发两次单图生成**：文件名不互踩（S8 回归锚）
  - `images` 引用上一轮产物（转参考图链路）+ `uploads/x.png` 解析 +
    **项目目标下的上传落点与引用**（C3）
  - uploads：未知魔数拒绝、超 16MB 拒绝、文件名净化（C4）
  - transfer：导入型项目落点正确、重名去重、**重复 transfer 同一项目
    幂等（不产生副本）**（C 建议 3）、transfers 记录
  - list 倒序 / target 过滤 / 复合游标（同毫秒 tie-break，谓词见 §5.2）
  - delete：行+scratch 文件俱删（含已转存行）；**running 行 409**（C5）
  - `files/:id/:slot`：slot 越界 / 项目行 / 穿越复核 全拒
  - 同源守卫：非本源请求 403
- 单元级：`playground-store.ts` CRUD + 启动清扫；`generateMediaBatch`
  提升后的等价性（旧路由测试继续绿）。
- 契约：`pnpm --filter @open-design/contracts typecheck`；web/daemon
  typecheck；`pnpm guard`。
- i18n：19 locale 由 `types.ts` 类型强制。
- 浏览器实测：mock OpenAI 兼容端点 + 真实 UI 全流程（生成 → 卡片 →
  转参考图迭代 → 转存个人项目 → Design Files 可见）。

## 10. 明确不做（YAGNI）

多会话、收藏夹、遮罩编辑器、多 API 配置切换（已有 Settings → Media）、
瀑布流虚拟化、scratch 自动清理、视频 surface（留接缝）、注册表模型放开
（留接缝）、节点画布（留可寻址引用接缝）、团队 Workspace 项目目标（D7，
待项目上下文内挂载）、agent 提示词契约变更。

## 11. 评审意见取舍记录

**第一轮（DeepSeek）**：
- **采纳**：B1（扁平布局+basename 语义统一）、B2（全端点同源）、B3
  （registrar 内派生，禁模块常量）、B4（path 段编码项目）、S1–S12 全部、
  O1（projectId 保持必填+运行期互斥）、O2（报错文案中性化）、O3（模型
  建议接 daemon 目录）。
- **部分采纳**：O4 无需改动（确认合规）。
- **YAGNI 判定引用**：评审确认「不建 media_tasks、不做多会话/清理/虚拟化、
  `images` 不上更强引用模型」均为正确克制。

**第二轮（Codex，针对 r2）**：
- **采纳**：C1（参数契约改为「目录派生互斥」，projectId 退化错误上下文）、
  C2（项目目标生成也走 `resolveProjectDir`，两种目标统一走 `outputDir`）、
  C3（uploads 支持项目目标落点，返回目标相对引用）、C4（上传 16MB 对齐
  读取上限；未知魔数拒绝）、C5（running 行 DELETE 409）、C6（CLI 补
  `download`）、建议 1（buildPath 对称编码 + 路径变化单向同步 state）、
  建议 2（游标排序与谓词写死）、建议 3（transfers 幂等留痕）、建议 4
  （模型建议列表标注「仅示例」语义）。
- 无不采纳项。

## 12. 实施教训（2026-10-05/06 UI 落地与三轮灰底修复）

工作台视觉落地 + 入口迁移 + 三轮「输入区灰底」修复过程中沉淀，改本视图
或新增同类面板前先过一遍：

**视觉问题的工作方法**
- 视觉 bug **必须先在真实浏览器取证再动手改**。本项目两轮「盲改 CSS」
  （容器底色 → 控件填充）都没打中真凶，第三轮浏览器取证一次定位。
- 浏览器 eval 取证时，rect 与 computed style 必须取自**同一元素链**——
  本项目曾把父容器 `.generateView` 的 800px rect 拼到 `footer.inputBar`
  的背景色上，误导了整个修复方向。
- 实机对账方法（可复用）：flex 子项高度求和 = 父高逐位对账，可排除
  「容器被拉伸」类猜测；把旧样式作为内联样式注回/清除做 A/B 复现，
  可一击证实因果。

**「盒级涂料 + 内部卡片不占满盒」灰带模式**
- 容器上有 `background`/`backdrop-filter` 这类**盒级**涂料、内部又有
  `max-width` 或 padding 圈时，露出的一圈就是「意味不明的灰色色块」
  （`.inputBar` 案例：玻璃灰刷满整条 footer，白色 console 卡只占中间）。
- 修法：容器的视觉责任交还内部卡片（卡自带 border + shadow），容器
  保持透明；不要用涂料去「衬」一张已经完整的卡。

**共享表单组件（@open-design/components）迁移清单**
- 共享皮肤 `.control` 的盒模型是「padding 撑高度、不设固定高」——本视图
  要压缩高度时**必须同步收 padding 并把 line-height 对齐内容盒**
  （height − 2px 边框），否则文字下沉截断。
- 跨 CSS Module 覆盖共享类必须用**后代选择器**（如
  `.composerToolbar .paramSelect`，特异性 0,2,0）压过 `.control`；
  单类对单类时胜负取决于不可控的级联顺序。
- 改 CSS Module 后核对 `styles.X` 引用与 css 定义**双向一致性**——
  悬空引用不报错、静默丢样式。

**错误信封**
- playground 端点的错误信封有 `{error:{message}}` 与 `{error:string}`
  两种形状真实共存（sendApiError vs 路由 catch）；前端读错误信息的
  helper 两种都要认（GenerateView `apiErrorMessage` 与
  `runtime/chat/generate-surface.ts` `generateErrorMessage` 同款）。
