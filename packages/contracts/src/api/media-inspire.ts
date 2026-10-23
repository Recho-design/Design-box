/**
 * 「灵感拓展」（media inspire）的数据契约。
 *
 * 这一层只描述 HTTP 边界上的形状与素材库本身：web 的灵感拓展面板与
 * `od media inspire` CLI 消费同一份常量与类型，daemon 的
 * `routes/media.ts` + `media/inspire.ts` 负责生产响应。纯 TS，不碰
 * Node / Express —— 凭据解析与 LLM 调用属于 daemon。
 *
 * 素材库条目（id / label / hint）从上游备份仓库原样搬运：id 供前后端
 * 传递，label 是笔记原文短句（前端 Chip 文案），hint 是给文本 LLM 的
 * 具象化锚点。组名与顺序即前端展示顺序。
 */

/** 单条灵感思路：id 用于前后端传递，label 为面向用户的中文短句，hint 是给文本 LLM 的具象化锚点 */
export interface InspireIdea {
  id: string;
  label: string;
  hint: string;
}

/** 一组同源思路，group 即前端 Chip 分组标题 */
export interface InspireIdeaGroup {
  group: string;
  ideas: InspireIdea[];
}

/** [id, label, hint] 三元组，一行一条便于与素材出处逐条对照 */
type InspireIdeaRow = [string, string, string];

/**
 * 六组思路的原始清单（组名与顺序即前端展示顺序）。
 *
 * 出处：豆瓣笔记《平面设计中的 194 种创意拓展思路》筛出视觉可操作的子集，
 * 共 6 组 77 条。改条目时保持一行一条，便于与原文逐条校对。
 */
const SOURCE_GROUPS: Array<{ group: string; rows: InspireIdeaRow[] }> = [
  {
    group: '形态',
    rows: [
      ['upside-down', '把它颠倒过来', '主体上下倒置或视角翻转，制造反常识的构图'],
      ['enlarge', '使它更大', '主体放大到撑满画面，成为带压迫感的局部特写'],
      ['make-round', '把它变为圆形', '外形归纳为圆，用弧线与球体替换原有硬边轮廓'],
      ['bend', '使它弯曲', '主体弯折成弧线或 S 形，把直线结构柔化'],
      ['slice', '把它切成片状', '沿同一方向切成等高薄片，露出整齐的剖面'],
      ['repeat', '使它重复', '同一主体等距重复成阵列，形成视觉节奏'],
      ['divide', '把它分割开', '切成数块并留出缝隙错位，块面之间清楚分离'],
      ['pair', '使它成对', '成对出现，左右或上下互相呼应成为一组'],
      ['lengthen', '使它更长', '纵向拉长比例，朝一个方向延伸出修长形态'],
      ['shorten', '使它更短', '压缩比例，形成矮胖敦实的短粗形态'],
      ['make-3d', '使它变成立体', '增加体积与厚度，给出明确的高光、暗部与投影'],
      ['make-flat', '使它变成平面', '去掉体积与透视，只用扁平色块与清晰轮廓线'],
      ['tilt', '使它倾斜', '整体倾斜一个角度，产生动势与不稳定感'],
      ['rotate-sideways', '把它向旁边转', '侧转约九十度，改以侧面视角呈现主体'],
      ['inside-out', '把它由里外翻转', '内外翻转，把原本藏起来的内部结构翻到表面'],
      ['widen', '使它更宽广', '横向铺开成全景式开阔构图，视野向两侧展开'],
      ['narrow', '使它更狭窄', '压成窄条或细长画幅，制造纵向挤压感'],
      ['pleat', '把它褶曲', '表面起规律的折痕，形成明暗交替的折面'],
    ],
  },
  {
    group: '材质',
    rows: [
      ['transparent', '使它透明', '材质转为半透明，能看见背后的轮廓与透过的光'],
      ['hollow', '把它弄成空的', '内部掏空只剩外壳，露出空腔与内壁'],
      ['fill', '把它填满', '内部被密集物质填满，不留一丝空隙'],
      ['opaque', '使它不透明', '完全不透光的实心表面，厚重且拒光'],
      ['powder', '使它变为粉状', '表面松散呈颗粒粉末，边缘有细微飞散'],
      ['gel', '使成凝胶状', '半凝固的胶质，湿润反光并带轻微颤动感'],
      ['solidify', '使它凝固起来', '由流动状态定形成坚硬块体，表面留下流动纹理'],
      ['melt', '使它溶化', '边缘软化下淌，表面出现液态流淌痕迹'],
      ['soften', '使它软化', '松软下垂，失去原本的硬挺支撑'],
      ['harden', '使它硬化', '坚硬如石或金属，边缘锐利且没有弹性'],
      ['evaporate', '使蒸发变为汽化', '形体弥散成雾与蒸汽，边界变得模糊'],
      ['freeze', '把它冻起来', '表面结霜覆冰，透出冷调与冰晶质感'],
      ['wrap', '把它缠起来', '被布条或线绳层层缠绕，留下缠绕的纹理'],
      ['fold', '使它可以折叠', '出现明显折痕与折叠结构，像纸张一样可收拢'],
      ['miniaturize', '小型化', '缩小到极小，与周围巨大环境形成尺度对比'],
    ],
  },
  {
    group: '光色',
    rows: [
      ['color-shift', '把颜色变换一下', '整体换一套配色，改变色相与饱和度的关系'],
      ['fluorescent', '使它发萤光', '荧光色的自发光边缘，在暗处尤其醒目'],
      ['glow', '使它发光', '主体自身发出柔和光晕，向四周扩散'],
      ['spark', '使它发出火花', '迸出火花与碎光点，带瞬间爆发的能量'],
      ['cool-tone', '使它更冷', '整体转冷调，蓝青灰主导并压低暖色比例'],
      ['darken', '使它更暗', '压暗整体亮度，只保留局部微弱光源'],
      ['sharpen', '使它锐利', '提高对比与边缘锐度，明暗交界干脆利落'],
      ['lower-key', '降低调子', '压低明度基调，让画面整体沉下来'],
      ['high-key', '提高调子', '抬高明度基调，画面通透轻快'],
      ['flicker', '使它闪动', '明暗交替闪动，出现类似频闪的层次'],
      ['symmetric', '使它对称', '镜像对称构图，左右或上下严格呼应'],
      ['asymmetric', '使它不对称', '打破平衡，重心明显偏移形成张力'],
    ],
  },
  {
    group: '时间动态',
    rows: [
      ['speed-up', '使它的速度加快', '出现高速运动的拖影与速度线'],
      ['slow-down', '使它缓慢下来', '形态缓慢流动，细节清晰可辨'],
      ['animate', '使它活动', '赋予明确动作与姿态，像正在被使用'],
      ['fly', '使它飞行', '主体腾空飞起，脱离地面并带起气流'],
      ['float', '使它浮起', '轻轻浮在表面或空中，下方投出柔和阴影'],
      ['suspend', '使它悬浮半空中', '静止悬停于半空，四周留出空间'],
      ['roll', '使它滚转', '翻滚旋转并带出运动残影'],
      ['shake', '摇动它', '高频晃动，边缘出现重影与震动模糊'],
      ['burn', '使它燃烧', '表面燃烧，火焰与焦痕向外蔓延'],
    ],
  },
  {
    group: '情绪风格',
    rows: [
      ['romantic', '使它罗曼蒂克', '柔和暖光、朦胧虚化与轻盈飘落的氛围'],
      ['nostalgic', '增添怀旧的诉求', '胶片颗粒、褪色色调与年代感道具'],
      ['futuristic', '使它看起来像未来派', '冷光、流线造型与科技感的光带界面'],
      ['realistic', '它是写实派', '真实物理材质与自然光影，像纪实摄影'],
      ['anthropomorphic', '使拟人化', '赋予五官与肢体动作，像有性格的角色'],
      ['comical', '使它更滑稽', '夸张变形与谐趣表情，带喜剧节奏'],
      ['satirical', '使它成为被讽刺的', '反讽的对比与荒诞并置，带批判意味'],
      ['pop', '使它看起来流行', '高饱和撞色、波普式重复与潮流质感'],
      ['youthful', '使它成为年轻型的', '明快色彩与活泼动势，街头年轻气息'],
      ['simplify', '使它单纯化', '只留必要元素，大面积留白与极简色块'],
      ['exaggerated', '夸张地说', '把特征放大到荒诞程度，比例刻意失衡'],
    ],
  },
  {
    group: '表现手法',
    rows: [
      ['symbolic', '运用象征', '用一个具体物象指代抽象含义，给画面留下解读空间'],
      ['diagram', '变换为图解方式', '用箭头、标注与分解图式呈现信息结构'],
      ['photographic', '变为摄影技巧', '长焦虚化、逆光轮廓、微距等摄影语言'],
      ['different-background', '用不同背景', '换一个背景环境，重新定义主体的语境'],
      ['different-environment', '用不同环境', '把主体放进陌生场景，制造尺度与氛围反差'],
      ['mask-off', '把它遮蔽起来', '大部分遮挡只露出局部，引起好奇'],
      ['frame-it', '把它框起来', '用画框、窗口或几何框景限定视线'],
      ['visual-effect', '使用视觉效果', '加入光效、粒子与扭曲等后期视觉处理'],
      ['new-art-form', '运用新艺术形式', '借用拼贴、装置或数字生成艺术的语言'],
      ['alternate-material', '使用另外的物料', '换成另一种材料，如混凝土、织物或金属'],
      ['change-packaging', '变换包装', '重新设计外包装与容器形态'],
      ['condense', '使它凝缩', '把信息压缩进一个高度凝练的符号或瞬间'],
    ],
  },
];

/** 全部灵感思路，按六个分组组织（6 组 77 条）。 */
export const INSPIRE_IDEA_GROUPS: readonly InspireIdeaGroup[] = SOURCE_GROUPS.map(
  ({ group, rows }) => ({
    group,
    ideas: rows.map(([id, label, hint]) => ({ id, label, hint })),
  }),
);

/** 素材库总条数（77），供校验与展示使用。 */
export const INSPIRE_IDEA_COUNT: number = INSPIRE_IDEA_GROUPS.reduce(
  (sum, groupItem) => sum + groupItem.ideas.length,
  0,
);

/** id → 思路 的索引，供 daemon 按 ideaIds 取回 label 与 hint。 */
const IDEA_INDEX: ReadonlyMap<string, InspireIdea> = new Map<string, InspireIdea>(
  INSPIRE_IDEA_GROUPS.flatMap((groupItem) => groupItem.ideas).map((idea) => [idea.id, idea]),
);

/** 按 id 查单条思路，未命中返回 undefined。 */
export function getInspireIdeaById(id: string): InspireIdea | undefined {
  return IDEA_INDEX.get(id);
}

/**
 * `POST /api/media/inspire` 的请求体。
 *
 * prompt 可为空，但此时必须 `hasImage: true`（基于参考图与思路直接扩展）；
 * 两者同时为空是 400。ideaIds 至少 1 条且全部须存在于素材库，未知 id 在
 * 响应里逐个报出。
 */
export interface InspireTranslateRequest {
  /** 基础描述：要保留主体、动作与场景的一段文字，可为空（见上方约束）。 */
  prompt?: string;
  /** 选中的思路 id 列表，至少 1 条。 */
  ideaIds: string[];
  /** 是否已有参考图：true 时转译侧重风格与氛围，不重复描述参考图构图。 */
  hasImage?: boolean;
}

/**
 * `POST /api/media/inspire` 的响应。
 *
 * 单一 fusion 模式：多条思路融合为一张图的统一方案，返回一条可直接用于
 * 图像生成的中文提示词，不出图。
 */
export interface InspireTranslateResponse {
  prompt: string;
}
