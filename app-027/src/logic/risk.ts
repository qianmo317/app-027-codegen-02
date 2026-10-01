/**
 * 掉落风险试算（经验模型，纯函数）
 *
 * 背景：连刀点（缺口）留多宽过去全凭经验——留窄了小碎片在切割/取件时被拽掉，
 * 留宽了成品上能看见明显缺口。这里把风险拆成五个可解释的因子：
 *
 *   1. 面积因子  areaFactor     越小越容易掉（惯性小、与垫板粘附弱）
 *   2. 细长因子  slenderFactor  细长条容易被刀尖挑起、撕断
 *   3. 层深因子  depthFactor    嵌套越深、图层越靠后，越孤立、越难取
 *   4. 保持因子  holdFactor     缺口（连刀点）个数 / 宽度 / 分布提供的约束
 *   5. 偏置因子  lopsidedFactor 连刀点全挤在一侧时，对侧是一长段自由弧，取件时先脱落
 *
 * 每个因子归一到 0~1，加权得 0~100 的风险分，映射为四档与经验掉落概率。
 * 概率不是精确物理量，只是给师傅一个「大概几片会掉」的参照。
 */
import type { Pt } from './types'
import { dist, polygonArea, polylineLength } from './geometry'
import type { BridgeGap } from './bridges'

export type RiskGrade = 'safe' | 'watch' | 'high' | 'critical'

/** 奇数层深 = 保留下来的「岛」（成品的一部分）；偶数层深 = 镂空废料 */
export type PieceRole = 'kept' | 'waste'

export type RiskAdviceKind = 'none' | 'widen' | 'merge'

/** 轮廓的相邻（父）轮廓信息——「并入相邻轮廓」建议的目标 */
export type RiskNeighbor = {
  id: string
  areaMm2: number
}

export type RiskInput = {
  id: string
  points: Pt[]
  /** 净面积 mm² */
  area: number
  /** 周长 mm */
  length: number
  /** 嵌套层深（1 = 最外层；3、5… 为保留岛；2、4… 为镂空废料） */
  depth: number
  /** 所在图层序号（0 起，多色纸分层切割，越靠后切越孤立） */
  layer: number
  /** 当前规划出来的缺口（弧长起点 + 挖掉的弧长） */
  gaps: BridgeGap[]
  /** 当前实际生效的单个缺口宽度（被削窄时小于设定值，mm） */
  appliedWidthMm: number
  /** 碎片面积阈值 mm²（小于它的被强制连刀） */
  areaThresholdMm2: number
  /** 父轮廓（直接外层）；根轮廓为 null */
  parent: RiskNeighbor | null
  /** 因轮廓过短缺口被削窄/合并（降级） */
  degraded: boolean
}

export type RiskFactors = {
  areaFactor: number
  slenderFactor: number
  depthFactor: number
  holdFactor: number
  lopsidedFactor: number
  /** 经验需要的最少缺口个数（约束住这片） */
  requiredCount: number
  /** 缺口宽度是否达到该片几何尺度的最低要求 */
  widthAdequate: number
  /** 相邻缺口间最长自由弧占周长的比例（0~1，越大越偏） */
  maxFreeRatio: number
  /** 长宽比（L² / 4πA，圆 = 1，越大越细长） */
  slenderness: number
  /** 特征平均宽度 ≈ 2A / L（mm）：细条的物理宽度量级 */
  featureWidthMm: number
}

export type RiskSuggestion = {
  /** 主要建议：加宽缺口 / 并入相邻轮廓 / 维持现状 */
  kind: RiskAdviceKind
  /** 建议的单个缺口宽度区间（mm） */
  widthRangeMm: [number, number] | null
  /** 建议的缺口个数 */
  bridgeCount: number | null
  /** 并入目标轮廓 id（kind = merge 时） */
  mergeTargetId: string | null
  /** 加宽方案的几何可行性（受最长直线段限制） */
  widenFeasible: boolean
  /** 加宽的观感代价：总缺口弧长占周长比例（%） */
  widenCostPct: number
  /** 并入的观感代价：被并入/丢失的面积 mm² */
  mergeCostAreaMm2: number
  /** 给师傅看的结论文案（含「加宽好还是并入好」的判断理由） */
  reason: string
}

export type ContourRisk = {
  id: string
  grade: RiskGrade
  /** 0~100，越高越危险 */
  score: number
  /** 经验掉落概率 %（0~100） */
  probabilityPct: number
  role: PieceRole
  factors: RiskFactors
  suggestion: RiskSuggestion
}

export type RiskSummary = {
  /** 参与试算的闭合轮廓数 */
  total: number
  /** 预计会掉几片（保留岛按概率求和，四舍五入；废料只单列不计入） */
  expectedDrops: number
  /** 期望掉片数（不取整，对照用） */
  expectedDropsRaw: number
  /** 高 / 危险档的保留岛数量（成品损失片数） */
  highKept: number
  /** 高 / 危险档总片数（含镂空废料；废料掉落会卡刀/粘连） */
  highAll: number
  critical: number
  high: number
  watch: number
  safe: number
  /** 最危险的一片 */
  worst: { id: string; score: number; grade: RiskGrade } | null
  /** 整张纹样的加权平均分（按面积加权） */
  avgScore: number
}

export const RISK_GRADE_LABEL: Record<RiskGrade, string> = {
  safe: '安全',
  watch: '注意',
  high: '高危',
  critical: '危险',
}

export const RISK_GRADE_COLOR: Record<RiskGrade, string> = {
  safe: '#47c07a',
  watch: '#ffc857',
  high: '#ff8f3c',
  critical: '#ff5252',
}

/** 权重：面积 0.30 / 细长 0.15 / 层深 0.12 / 保持 0.33 / 偏置 0.10 */
const W_AREA = 0.3
const W_SLENDER = 0.15
const W_DEPTH = 0.12
const W_HOLD = 0.33
const W_LOP = 0.1

/** 0~1 平滑夹紧 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** 长宽比：圆=1，正方形≈1.27，越细长越大（带最小面积保护，避免数值爆炸） */
export function slendernessOf(area: number, length: number): number {
  if (area <= 1e-9) return 8
  return Math.min(8, Math.max(1, (length * length) / (4 * Math.PI * area)))
}

/** 特征平均宽度 ≈ 2A / L（mm）；无量级时退回一个很小的数 */
function featureWidthOf(area: number, length: number): number {
  if (length <= 1e-9) return 0
  return Math.max(0, (2 * area) / length)
}

/** 相邻缺口间的最长自由弧长（无缺口时返回整圈周长，单个缺口时为周长-缺口宽） */
function maxFreeArc(L: number, gaps: BridgeGap[]): number {
  if (gaps.length === 0) return L
  const sorted = gaps.slice().sort((a, b) => a.s - b.s)
  let max = 0
  for (let i = 0; i < sorted.length; i++) {
    const curEnd = sorted[i].s + sorted[i].widthMm
    const nextStart = i + 1 < sorted.length ? sorted[i + 1].s : sorted[0].s + L
    max = Math.max(max, Math.max(0, nextStart - curEnd))
  }
  return max
}

/** 多边形最长单条直线段长度（缺口只能开在一条直线段内，宽度受它限制） */
export function longestEdgeMm(pts: Pt[]): number {
  let m = 0
  const n = pts.length
  if (n < 2) return 0
  for (let i = 0; i < n; i++) m = Math.max(m, dist(pts[i], pts[(i + 1) % n]))
  return m
}

function gradeOf(score: number): RiskGrade {
  if (score >= 70) return 'critical'
  if (score >= 48) return 'high'
  if (score >= 26) return 'watch'
  return 'safe'
}

/** 风险分 → 经验掉落概率：分段线性，便于向师傅解释 */
function probabilityOf(score: number): number {
  const pts: Array<[number, number]> = [
    [0, 0],
    [26, 4],
    [48, 18],
    [70, 45],
    [100, 85],
  ]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    if (score <= x1) {
      const t = (score - x0) / (x1 - x0)
      return Math.round((y0 + (y1 - y0) * t) * 10) / 10
    }
  }
  return 85
}

/** 建议缺口个数：碎片 ≥ 2 且按周长上限封顶；细长条需要更多约束 */
function suggestCount(area: number, L: number, sl: number, threshold: number): number {
  let n: number
  if (area < threshold) {
    // 强制连刀的碎片：基础 2 个，细长则沿长度方向增加
    n = sl >= 3 ? 3 : 2
  } else {
    // 大轮廓按周长每 10~12mm 一个，细长条加密
    n = Math.max(2, Math.ceil(L / (sl >= 3 ? 9 : 12)))
  }
  // 缺口不能重叠：n 个缺口总宽（取最小建议宽 0.3mm）不超过 60% 周长
  const capByLength = Math.max(1, Math.floor((0.6 * L) / 0.3))
  n = Math.min(n, capByLength)
  return Math.max(1, n)
}

/**
 * 试算单片闭合轮廓的掉落风险。
 */
export function evaluateContourRisk(input: RiskInput): ContourRisk {
  const { area, length: L, depth, layer, gaps, appliedWidthMm, areaThresholdMm2 } = input
  const role: PieceRole = depth % 2 === 1 ? 'kept' : 'waste'

  const sl = slendernessOf(area, L)
  const featureW = featureWidthOf(area, L)

  // 1) 面积因子：阈值处 ≈ 0.7，面积到 50 倍阈值衰减到 0
  const tScale = Math.max(areaThresholdMm2, 1e-6)
  const areaFactor = clamp01(1 - Math.log10(Math.max(area, 1e-6) / tScale + 1) / Math.log10(51))

  // 2) 细长因子：sl=1 → 0，sl=8 → 1
  const slenderFactor = clamp01((sl - 1) / 7)

  // 3) 层深因子：depth1=0，depth2=0.25，depth3=0.45，再深每层 +0.1；后置图层 +0.08
  const depthBase = depth <= 1 ? 0 : depth === 2 ? 0.25 : 0.45 + (depth - 3) * 0.1
  const depthFactor = clamp01(depthBase + layer * 0.08)

  // 4) 保持因子
  //    经验最少缺口数：碎片 2 个（细长 3 个）；大轮廓按周长
  const required = area < tScale ? (sl >= 3 ? 3 : 2) : Math.max(0, Math.ceil(L / 12))
  const n = gaps.length
  let countDeficit = 0
  if (required > 0) countDeficit = clamp01((required - n) / required)
  // 缺口都被削窄合并（降级）→ 保持力再打折扣
  if (input.degraded && n > 0 && n < required) countDeficit = Math.max(countDeficit, 0.7)

  // 宽度是否够：以特征宽度为尺度，0.2mm 以下几乎必然撕断，0.8mm 以上绰绰有余
  const widthAdequate =
    n === 0
      ? 0
      : clamp01((appliedWidthMm - 0.2) / 0.6) *
        // 特征宽度极小时，宽缺口也救不住整片：按 0.3mm 特征宽为及格线打折
        clamp01(0.4 + featureW / 0.6)

  // 5) 偏置因子：最长自由弧占周长比例；圆上 2 个对置缺口 → 0.5
  const maxFree = maxFreeArc(L, gaps)
  const maxFreeRatio = L > 0 ? clamp01(maxFree / L) : 1
  // 0.5 以下（缺口分布均匀）不扣分，0.5→1 映射到 0→1
  const lopsidedFactor = n >= 2 ? clamp01((maxFreeRatio - 0.5) / 0.5) : n === 1 ? clamp01((maxFreeRatio - 0.6) / 0.4) : 0.5

  const holdFactor = clamp01(
    0.62 * countDeficit + 0.38 * (1 - widthAdequate),
  )

  const score = Math.round(
    (W_AREA * areaFactor + W_SLENDER * slenderFactor + W_DEPTH * depthFactor + W_HOLD * holdFactor + W_LOP * lopsidedFactor) *
      100,
  )
  const grade = gradeOf(score)
  const probabilityPct = probabilityOf(score)

  const factors: RiskFactors = {
    areaFactor,
    slenderFactor,
    depthFactor,
    holdFactor,
    lopsidedFactor,
    requiredCount: required,
    widthAdequate,
    maxFreeRatio,
    slenderness: sl,
    featureWidthMm: featureW,
  }

  const suggestion = buildSuggestion(input, factors, grade, n)

  return { id: input.id, grade, score, probabilityPct, role, factors, suggestion }
}

/**
 * 给出「加宽缺口」还是「并入相邻轮廓」的建议。
 *
 * - 缺口只能开在单条直线段内，加宽上限受最长边约束；上限低于最低有效宽度 → 加宽不可行。
 * - 并入 = 删掉这片小岛（不切它的边界），它留在父轮廓上成为底纸的一部分；
 *   对保留岛（奇层深）= 丢失镂空细节，对镂空废料（偶层深）= 这个洞被填平。
 */
function buildSuggestion(input: RiskInput, f: RiskFactors, grade: RiskGrade, n: number): RiskSuggestion {
  const none: RiskSuggestion = {
    kind: 'none',
    widthRangeMm: null,
    bridgeCount: null,
    mergeTargetId: null,
    widenFeasible: true,
    widenCostPct: 0,
    mergeCostAreaMm2: 0,
    reason: '当前缺口配置的保持力足够，维持现状即可。',
  }
  if (grade === 'safe' || grade === 'watch') return none

  const L = input.length
  const maxEdge = longestEdgeMm(input.points)
  const nTarget = suggestCount(input.area, L, f.slenderness, input.areaThresholdMm2)

  // 最低有效宽度：0.45mm 起步，细长/深层再上调
  const wMin = Math.round(Math.min(1.2, 0.45 + (f.slenderness >= 3 ? 0.15 : 0) + (input.depth >= 3 ? 0.1 : 0)) * 100) / 100
  // 建议上限：不超过最长边的 50%，且 nTarget 个总宽 ≤ 55% 周长
  const wGeom = Math.max(0, Math.min(maxEdge * 0.5, (0.55 * L) / Math.max(1, nTarget)))
  const wMax = Math.round(Math.max(wMin, Math.min(1.2, Math.max(wGeom, 0.6))) * 100) / 100
  const widenFeasible = wGeom + 1e-9 >= wMin
  const widthRange: [number, number] = [wMin, Math.max(wMin, Math.round(Math.min(wMax, Math.max(wGeom, wMin)) * 100) / 100)]

  const widenCostPct = Math.round(((widthRange[0] * nTarget) / Math.max(L, 1e-6)) * 1000) / 10
  const mergeCost = Math.round(input.area * 100) / 100

  const roleText = input.depth % 2 === 1 ? '保留岛（成品的一部分）' : '镂空废料'
  const countText = n < nTarget ? `（现仅 ${n} 个，建议补到 ${nTarget} 个）` : `（${nTarget} 个，均匀分布）`

  if (!widenFeasible) {
    if (input.parent) {
      return {
        kind: 'merge',
        widthRangeMm: widthRange,
        bridgeCount: nTarget,
        mergeTargetId: input.parent.id,
        widenFeasible: false,
        widenCostPct,
        mergeCostAreaMm2: mergeCost,
        reason:
          `这片${roleText}周长仅 ${L.toFixed(1)}mm、最长直线段 ${maxEdge.toFixed(1)}mm，` +
          `缺口加宽到最低有效宽度 ${wMin}mm 也无处可放（会跨折角/互相重叠），加宽不可行；` +
          `建议直接并进相邻轮廓（取消这圈刀路，约 ${mergeCost}mm² 留在底纸上），比硬留缺口更划算。`,
      }
    }
    return {
      kind: 'widen',
      widthRangeMm: widthRange,
      bridgeCount: nTarget,
      mergeTargetId: null,
      widenFeasible: false,
      widenCostPct,
      mergeCostAreaMm2: mergeCost,
      reason:
        `轮廓过小，缺口无法加宽到 ${wMin}mm，且它没有可并入的相邻外轮廓；` +
        `只能在最长边 ${maxEdge.toFixed(1)}mm 内取尽量宽的缺口 ${countText}，或改纹样把这片放大。`,
    }
  }

  // 加宽可行：用观感代价与并面积损失权衡
  // - 极小岛（面积 < 阈值 的一半）+ 深层保留岛：加宽也容易掉且缺口占比难看 → 并入更划算
  const tinyKept = input.depth % 2 === 1 && input.area < input.areaThresholdMm2 * 0.75 && input.depth >= 3
  if (tinyKept && input.parent) {
    return {
      kind: 'merge',
      widthRangeMm: widthRange,
      bridgeCount: nTarget,
      mergeTargetId: input.parent.id,
      widenFeasible: true,
      widenCostPct,
      mergeCostAreaMm2: mergeCost,
      reason:
        `这片${roleText}只有 ${input.area.toFixed(2)}mm²，即使缺口加宽到 ${widthRange[0]}~${widthRange[1]}mm，` +
        `总缺口也要占周长 ${widenCostPct}%（成品上是一串明显豁口），照样容易掉；` +
        `并进相邻轮廓只损失 ${mergeCost}mm² 一小块镂空细节，观感与良率都更划算${countText}。`,
    }
  }

  const why =
    f.holdFactor >= 0.5
      ? '主要问题是缺口个数/宽度的保持力不足'
      : f.lopsidedFactor >= 0.6
        ? '缺口挤在一侧，对侧自由弧过长'
        : '面积小且偏细长，刀尖容易挑起'
  return {
    kind: 'widen',
    widthRangeMm: widthRange,
    bridgeCount: nTarget,
    mergeTargetId: null,
    widenFeasible: true,
    widenCostPct,
    mergeCostAreaMm2: mergeCost,
    reason:
      `${why}：建议把缺口加宽到 ${widthRange[0]}~${widthRange[1]}mm、放 ${nTarget} 个并均匀分布` +
      `${input.parent ? '；加宽代价仅占周长 ' + widenCostPct + '%，比并进相邻轮廓（损失 ' + mergeCost + 'mm²）更划算' : ''}。`,
  }
}

/** 汇总一张纹样（可跨多个形状）的总体结论 */
export function aggregateRisk(rows: Array<{ shapeId: string; risk: ContourRisk; area: number }>): RiskSummary {
  let expectedRaw = 0
  let highKept = 0
  let highAll = 0
  let critical = 0
  let high = 0
  let watch = 0
  let safe = 0
  let weighted = 0
  let weightSum = 0
  let worst: RiskSummary['worst'] = null

  for (const r of rows) {
    const g = r.risk.grade
    if (g === 'critical') critical += 1
    if (g === 'high') high += 1
    if (g === 'watch') watch += 1
    if (g === 'safe') safe += 1
    if (g === 'high' || g === 'critical') {
      highAll += 1
      // 成品掉片只计保留岛（奇层深）；最外层大块本就不会掉
      if (r.risk.role === 'kept' && r.risk.factors.depthFactor > 0.05) highKept += 1
    }
    // 期望掉片：只计保留岛；最外层（depth1，depthFactor≈0）不参与
    if (r.risk.role === 'kept' && r.risk.factors.depthFactor > 0.05) {
      expectedRaw += r.risk.probabilityPct / 100
    }
    const w = Math.max(r.area, 0.01)
    weighted += r.risk.score * w
    weightSum += w
    if (!worst || r.risk.score > worst.score) {
      worst = { id: r.risk.id, score: r.risk.score, grade: g }
    }
  }

  return {
    total: rows.length,
    expectedDrops: Math.round(expectedRaw),
    expectedDropsRaw: Math.round(expectedRaw * 10) / 10,
    highKept,
    highAll,
    critical,
    high,
    watch,
    safe,
    worst,
    avgScore: weightSum > 0 ? Math.round((weighted / weightSum) * 10) / 10 : 0,
  }
}

/** 供测试 / 其他模块直接构造一片简单多边形的面积周长（与 cleanup 派生口径一致） */
export function measurePolygon(pts: Pt[]): { area: number; length: number } {
  return { area: polygonArea(pts), length: polylineLength(pts, true) }
}
