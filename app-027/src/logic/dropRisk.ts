import type { Contour, MaterialPreset, Shape } from './types'
import type { ComputedShape } from './pipeline'
import { planBridges, type BridgePlan } from './bridges'
import type { NestingResult } from './nesting'
import { boundsOf, polylineLength } from './geometry'

/**
 * 掉落风险试算：连刀点留多宽不能只凭经验。
 * 对每条闭合轮廓，按面积、细长程度、所在层、当前缺口规划（宽度/个数/是否削窄/均匀度）
 * 与切割顺序位置，估出该片段在切割与取件时被拽掉的可能性（0~100），并分 4 档：
 * 低 / 中 / 高 / 危险。对高风险给出建议缺口宽度区间与个数，并判断该「加宽缺口」
 * 还是「并入相邻轮廓（去掉该镂空）」更划算。
 *
 * 启发式模型（所有常数集中在 MODEL），非物理仿真，只是把老师傅的经验显式化、可复算。
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export type RiskLevelInfo = {
  level: RiskLevel
  /** 0~100 掉落可能性评分 */
  score: number
  label: string
  color: string
  /** 一句话结论文案 */
  verdict: string
}

/** 单项因子（用于逐片展开说明，每一项都可向用户解释） */
export type RiskFactor = {
  key: string
  label: string
  /** 该因子贡献的分值（0~ 上限） */
  points: number
  /** 该因子的实测值文案 */
  value: string
  /** 推高（+）/ 压低（−）风险 */
  dir: 'up' | 'down'
}

export type RiskSuggestion = {
  /** 建议缺口宽度区间（mm） */
  widthLo: number
  widthHi: number
  /** 建议缺口个数 */
  count: number
  /** 更划算的处置方式 */
  strategy: 'widen' | 'merge' | 'either' | 'none'
  strategyText: string
  /** 决策依据 */
  reason: string
  /** 并入相邻轮廓的候选父轮廓 id（去掉这片镂空时，镂空区域并入该片） */
  mergeParentId: string | null
}

export type ContourRisk = {
  contourId: string
  shapeId: string
  shapeName: string
  depth: number
  layer: number
  areaMm2: number
  lengthMm: number
  /** 细长程度：周长² /（4π·面积），圆 = 1，越大越细长 */
  slenderness: number
  isFragment: boolean
  /** 当前规划的缺口个数 */
  gapCount: number
  /** 当前实际缺口宽度（被削窄时小于设定值） */
  appliedWidthMm: number
  /** 缺口是否被削窄（轮廓太短放不下设定宽度） */
  degraded: boolean
  /** 缺口均匀度 0~1（越均匀越稳） */
  gapEvenness: number
  /** 缺口总宽占周长比例 */
  holdRatio: number
  /** 切割顺序中的序号位置（1 起，0 = 未排入，如未闭合） */
  cutSeq: number
  level: RiskLevelInfo
  factors: RiskFactor[]
  suggestion: RiskSuggestion
  /** 轮廓代表点（列表定位/跳转用，取质心） */
  anchor: { x: number; y: number }
}

export type RiskReport = {
  items: ContourRisk[]
  /** 预计会掉几片（高 + 危险） */
  dropCount: number
  highCount: number
  criticalCount: number
  /** 最危险的一片 */
  worst: ContourRisk | null
  /** 整幅总结论文案 */
  summary: string
  /** 评估所用的参数指纹（用于两版对照） */
  fingerprint: string
}

/** 模型常数（集中管理，便于说明与调参） */
const MODEL = {
  /** 面积分档参考（mm²）：越小越容易被刀尖/镊子带走 */
  areaTiny: 2,
  areaSmall: 8,
  areaMedium: 30,
  /** 细长程度分档（圆=1） */
  slenderHigh: 4,
  slenderMid: 2,
  /**
   * 缺口总宽占周长的安全比例（碎片的「粘接面积」代理量）。
   * 周长越长，保持比例天然越低（大片本身自重稳，不需要高比例），
   * 因此按面积分两档：小碎片要 14%，大片 7% 即够。
   */
  holdSafeFragment: 0.14,
  holdLowFragment: 0.06,
  holdSafeLarge: 0.07,
  holdLowLarge: 0.03,
  /** 单个缺口在常见纸张上的可靠宽度区间（mm） */
  reliableW: 0.45,
  strongW: 0.8,
  maxW: 1.2,
  /** 细长片建议并入的阈值：面积小于该值且细长比大于该值，加宽不如并入 */
  mergeArea: 1.5,
  mergeSlenderness: 5,
  /** 并入后父轮廓会留下的缺口宽度阈值（mm）：缺口太宽影响外观则不推荐并入 */
  mergeMaxSpan: 8,
  /** 评分分档线 */
  cutLow: 25,
  cutMedium: 45,
  cutHigh: 70,
}

export const RISK_COLORS: Record<RiskLevel, string> = {
  low: '#47c07a',
  medium: '#ffc857',
  high: '#ff8f3c',
  critical: '#ff4d4d',
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '危险',
}

const r2 = (v: number): number => Math.round(v * 100) / 100
const r3 = (v: number): number => Math.round(v * 1000) / 1000

/** 试算输入（当前版或假设版共用） */
export type RiskInput = {
  areaThresholdMm2: number
  bridgeWidthMm: number
  bridgeEveryMm: number
  bridgeRule: 'by_area' | 'by_length' | 'manual'
  material: MaterialPreset | null
}

type ShapeCtx = {
  shape: Shape
  tree: NestingResult
  computed: ComputedShape
  seqOf: Map<string, number>
}

/** 在给定假设参数下重跑连刀规划（不改原数据），返回每个闭合轮廓的假设规划 */
function planUnder(shape: Shape, input: RiskInput): Map<string, BridgePlan> {
  const out = new Map<string, BridgePlan>()
  for (const c of shape.contours) {
    if (!c.closed || c.points.length < 3) continue
    out.set(
      c.id,
      planBridges(
        c.points,
        c.closed,
        c.area,
        c.length,
        {
          rule: input.bridgeRule,
          areaThresholdMm2: input.areaThresholdMm2,
          bridgeWidthMm: input.bridgeWidthMm,
          bridgeEveryMm: input.bridgeEveryMm,
        },
        c.bridges.map((b) => b.atIndex),
      ),
    )
  }
  return out
}

/** 缺口沿周长的分布均匀度：1 = 完全等距，越小越扎堆 */
function gapEvenness(gaps: Array<{ s: number; widthMm: number }>, L: number): number {
  const n = gaps.length
  if (n <= 1) return n === 1 ? 0.55 : 1
  const sorted = gaps.map((g) => g.s).sort((a, b) => a - b)
  const gapsBetween: number[] = []
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? sorted[i + 1] : sorted[0] + L
    gapsBetween.push(next - sorted[i] - (gaps[i]?.widthMm ?? 0))
  }
  const mean = gapsBetween.reduce((a, b) => a + b, 0) / n
  if (mean <= 1e-9) return 0
  const variance = gapsBetween.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const cv = Math.sqrt(variance) / mean
  return r3(Math.max(0, Math.min(1, 1 - cv)))
}

function centroidOf(c: Contour): { x: number; y: number } {
  const pts = c.points
  const n = pts.length
  if (n === 0) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (const p of pts) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / n, y: sy / n }
}

/**
 * 对一个形状内的全部闭合轮廓做掉落风险试算。
 * plans 可为「假设参数」下的规划；不传则用当前派生结果。
 */
export function assessShape(shape: Shape, computed: ComputedShape, input: RiskInput, plans?: Map<string, BridgePlan>): ContourRisk[] {
  const tree = computed.tree
  const seqOf = new Map<string, number>()
  computed.order.steps.forEach((st, i) => {
    if (!seqOf.has(st.contourId)) seqOf.set(st.contourId, i + 1)
  })
  const ctx: ShapeCtx = { shape, tree, computed, seqOf }
  const planMap = plans ?? planUnder(shape, input)

  const items: ContourRisk[] = []
  for (const c of shape.contours) {
    if (!c.closed || c.points.length < 3) continue
    items.push(assessContour(c, ctx, input, planMap.get(c.id)))
  }
  return items
}

function assessContour(c: Contour, ctx: ShapeCtx, input: RiskInput, plan?: BridgePlan): ContourRisk {
  const { tree } = ctx
  const depth = tree.depthOf.get(c.id) ?? 1
  const A = c.area
  const L = c.length || polylineLength(c.points, true)
  const slenderness = A > 1e-9 ? (L * L) / (4 * Math.PI * A) : 99
  const isFragment = A < input.areaThresholdMm2

  const gaps = plan?.gaps ?? []
  const gapCount = gaps.length
  const appliedWidthMm = plan?.metrics.appliedWidthMm ?? input.bridgeWidthMm
  const degraded = plan?.metrics.degraded ?? false
  const evenness = gapEvenness(gaps, L)
  const totalHold = gaps.reduce((a, g) => a + g.widthMm, 0)
  const holdRatio = L > 0 ? totalHold / L : 0
  const cutSeq = ctx.seqOf.get(c.id) ?? 0

  // ---------- 因子打分（上限合计 100） ----------
  const factors: RiskFactor[] = []

  // 1) 面积（0~34）
  let areaPts = 0
  if (A < MODEL.areaTiny) areaPts = 34
  else if (A < MODEL.areaSmall) areaPts = 24
  else if (A < MODEL.areaMedium) areaPts = 12
  else areaPts = 3
  factors.push({
    key: 'area',
    label: '面积',
    points: areaPts,
    value: `${r2(A)}mm²${A < input.areaThresholdMm2 ? `（< 阈值 ${input.areaThresholdMm2}mm²，属碎片）` : ''}`,
    dir: areaPts >= 12 ? 'up' : 'down',
  })

  // 2) 细长程度（0~20）
  let slenderPts = 0
  if (slenderness >= MODEL.slenderHigh) slenderPts = 20
  else if (slenderness >= MODEL.slenderMid) slenderPts = 11
  else if (slenderness >= 1.5) slenderPts = 5
  factors.push({
    key: 'slender',
    label: '细长程度',
    points: slenderPts,
    value: `细长比 ${r2(slenderness)}（圆=1）`,
    dir: slenderPts >= 11 ? 'up' : 'down',
  })

  // 3) 层（0~12）：内层岛屿先切，之后还要在它周围/外侧走刀，被拖拽时间长
  let depthPts: number
  let depthNote: string
  if (depth >= 4) {
    depthPts = 12
    depthNote = `第 ${depth} 层（深嵌岛屿，取件时最易被带落）`
  } else if (depth === 3) {
    depthPts = 7
    depthNote = `第 3 层（内嵌岛屿）`
  } else if (depth === 2) {
    depthPts = 4
    depthNote = `第 2 层（镂空内片）`
  } else {
    depthPts = 0
    depthNote = `第 1 层（外轮廓，整片不掉）`
  }
  factors.push({ key: 'depth', label: '所在层', points: depthPts, value: depthNote, dir: depthPts >= 7 ? 'up' : 'down' })

  // 4) 缺口保持（0~22）：无缺口必掉；保持比例按面积分档，再叠加单个宽度/削窄
  // 大片自身有重量与刚度，保持比例天然低也不掉；小碎片才苛求高比例。
  const holdSafe = isFragment ? MODEL.holdSafeFragment : MODEL.holdSafeLarge
  const holdLow = isFragment ? MODEL.holdLowFragment : MODEL.holdLowLarge
  let holdPts = 0
  let holdNote: string
  if (gapCount === 0) {
    holdPts = isFragment ? 22 : 6
    holdNote = isFragment ? '没有任何连刀点，切完即脱落' : '无连刀点（大片一般可自行成片）'
  } else {
    if (holdRatio < holdLow) holdPts += isFragment ? 11 : 7
    else if (holdRatio < holdSafe) holdPts += isFragment ? 6 : 2
    if (degraded) holdPts += 7
    else if (appliedWidthMm < MODEL.reliableW) holdPts += 5
    else if (appliedWidthMm >= MODEL.strongW) holdPts += 0
    else holdPts += 2
    holdNote =
      `${gapCount} 个缺口 × ${r2(appliedWidthMm)}mm，保持比例 ${(holdRatio * 100).toFixed(1)}%（${isFragment ? '碎片' : '大片'}安全线 ${(holdSafe * 100).toFixed(0)}%）` +
      (degraded ? '（轮廓太短，缺口被削窄）' : '')
  }
  factors.push({ key: 'hold', label: '缺口保持', points: holdPts, value: holdNote, dir: holdPts >= 6 ? 'up' : 'down' })

  // 5) 缺口个数与均匀度（0~6）
  let layoutPts = 0
  if (gapCount === 1) layoutPts += isFragment ? 4 : 2
  if (gapCount > 0 && evenness < 0.45) layoutPts += 2
  factors.push({
    key: 'layout',
    label: '缺口分布',
    points: layoutPts,
    value: gapCount === 0 ? '—' : `${gapCount} 个，均匀度 ${(evenness * 100).toFixed(0)}%${gapCount === 1 ? '（单点悬挂，取件一转就掉）' : ''}`,
    dir: layoutPts >= 3 ? 'up' : 'down',
  })

  // 6) 切割/取件拖拽（0~10）：切割顺序靠后 + 材料刀压遍数 + 外轮廓切割时的牵连
  const seqRatio = cutSeq > 0 && ctx.computed.order.steps.length > 0 ? cutSeq / ctx.computed.order.steps.length : 0.5
  let dragPts = Math.round(4 * seqRatio)
  // 多遍切割 = 每遍都要把片再掀一次
  const passes = input.material?.passes ?? 1
  if (passes >= 2) dragPts += 3
  // 外层在它切完之后才切 → 取件/走刀拖拽
  const parentId = tree.nodeById.get(c.id)?.parentId ?? null
  if (parentId && cutSeq > 0) {
    const parentSeq = ctx.seqOf.get(parentId)
    if (parentSeq && parentSeq > cutSeq) dragPts += 3
  }
  factors.push({
    key: 'drag',
    label: '切割拖拽',
    points: Math.min(10, dragPts),
    value: `切割序号 ${cutSeq || '—'}/${ctx.computed.order.steps.length}${passes >= 2 ? `，材料需切 ${passes} 遍` : ''}`,
    dir: dragPts >= 5 ? 'up' : 'down',
  })

  // 7) 缓解项（至多 −12）：缺口又宽又均匀、片也不算小时回加分
  let relief = 0
  if (gapCount >= 2 && appliedWidthMm >= MODEL.reliableW && holdRatio >= holdSafe && evenness >= 0.6) relief = A >= MODEL.areaSmall ? -12 : -7
  else if (gapCount >= 2 && appliedWidthMm >= MODEL.reliableW && holdRatio >= holdLow) relief = A >= MODEL.areaMedium ? -6 : -3
  if (relief < 0) {
    factors.push({
      key: 'relief',
      label: '连刀缓冲',
      points: relief,
      value: '缺口数量/宽度/均匀度均充足，可抵消部分拖拽',
      dir: 'down',
    })
  }

  const raw = factors.reduce((a, f) => a + f.points, 0)
  const score = Math.max(0, Math.min(100, Math.round(raw)))
  const level: RiskLevel = score >= MODEL.cutHigh ? 'critical' : score >= MODEL.cutMedium ? 'high' : score >= MODEL.cutLow ? 'medium' : 'low'

  const suggestion = suggest(c, ctx, input, { depth, A, L, slenderness, isFragment, gapCount, appliedWidthMm, holdRatio, evenness, level })
  const verdict = verdictText(level, isFragment, gapCount, suggestion)

  const info: RiskLevelInfo = {
    level,
    score,
    label: RISK_LABELS[level],
    color: RISK_COLORS[level],
    verdict,
  }

  return {
    contourId: c.id,
    shapeId: ctx.shape.id,
    shapeName: ctx.shape.name,
    depth,
    layer: ctx.shape.layer,
    areaMm2: A,
    lengthMm: L,
    slenderness,
    isFragment,
    gapCount,
    appliedWidthMm,
    degraded,
    gapEvenness: evenness,
    holdRatio,
    cutSeq,
    level: info,
    factors,
    suggestion,
    anchor: centroidOf(c),
  }
}

/** 高风险片的处置建议：加宽缺口 vs 并入相邻轮廓 */
function suggest(
  c: Contour,
  ctx: ShapeCtx,
  input: RiskInput,
  m: {
    depth: number
    A: number
    L: number
    slenderness: number
    isFragment: boolean
    gapCount: number
    appliedWidthMm: number
    holdRatio: number
    evenness: number
    level: RiskLevel
  },
): RiskSuggestion {
  const none: RiskSuggestion = {
    widthLo: r2(input.bridgeWidthMm),
    widthHi: r2(input.bridgeWidthMm),
    count: Math.max(m.gapCount, 0),
    strategy: 'none',
    strategyText: '保持当前缺口即可',
    reason: '掉落可能性低，无需调整。',
    mergeParentId: null,
  }
  if (m.level === 'low' && m.gapCount > 0) return none

  // 需要的保持比例：高风险按 14% 补，危险按 18% 补（碎片安全线之上留余量）
  const targetHold = m.level === 'critical' ? 0.18 : MODEL.holdSafeFragment
  // 建议个数：至少 2 个（碎片）；周长每 10mm 再加一个，上限 6
  let count = Math.max(m.isFragment ? 2 : 2, Math.min(6, Math.ceil(m.L / 10)))
  if (m.gapCount === 1) count = Math.max(count, 2)
  // 反推单个缺口宽度
  let wNeed = (targetHold * m.L) / count
  // 细长片窄口易撕裂，宽度下限抬高
  const wLo = Math.max(MODEL.reliableW, m.slenderness >= MODEL.slenderHigh ? 0.6 : 0.45)
  const wHi = Math.min(MODEL.maxW, Math.max(wLo + 0.2, wNeed + 0.15))
  const widthLo = r2(Math.min(wLo, wHi))
  const widthHi = r2(wHi)

  // 放不下：n 个缺口 × 下限宽度 已超过周长 60%（与 planBridges 的 MAX_GAP_RATIO 一致）
  const fit = count * widthLo <= 0.6 * m.L
  // 特征宽度（细长形的平均「丝宽」≈ 2A/L）：缺口宽度接近丝宽时，加宽会把细丝切豁，外观不可接受
  const featureWidth = m.L > 0 ? (2 * m.A) / m.L : Infinity
  const gapEatsFeature = featureWidth <= widthLo * 1.5

  // ---------- 并入相邻轮廓的可行性 ----------
  // 并入 = 去掉这片镂空：把该轮廓与其直接父轮廓之间的「岛屿」抹平（视觉上镂空消失）。
  const parentId = ctx.tree.nodeById.get(c.id)?.parentId ?? null
  const parent = parentId ? ctx.shape.contours.find((x) => x.id === parentId) ?? null : null
  const b = boundsOf(c.points)
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY)
  const mergeFeasible =
    !!parent &&
    m.depth >= 2 && // 外轮廓本身无法并入
    span <= MODEL.mergeMaxSpan &&
    parent.area > m.A * 1.5

  // 决策：
  // - 又小又细，或缺口放不下，或缺口宽度已接近「丝宽」（加宽会把细丝切豁）→ 并入更划算
  // - 缺口放得下、片不算特别小 → 加宽（保留镂空设计）
  const mergeWorthy = m.A < MODEL.mergeArea && m.slenderness >= MODEL.mergeSlenderness
  let strategy: RiskSuggestion['strategy']
  let strategyText: string
  let reason: string
  if (!fit || mergeWorthy || gapEatsFeature) {
    if (mergeFeasible) {
      strategy = 'merge'
      strategyText = '并入相邻轮廓更划算'
      if (!fit) {
        reason = `周长仅 ${r2(m.L)}mm，${count} 个可靠缺口放不下（会被削窄）；并入父轮廓比一排窄缺口更稳、更好看。`
      } else if (gapEatsFeature) {
        reason = `这片最窄处只有约 ${r2(featureWidth)}mm，而可靠缺口要 ${widthLo}mm——加宽等于把细丝切豁；建议并入父轮廓（抹掉这段镂空），不掉片也不难看。`
      } else {
        reason = `该片仅 ${r2(m.A)}mm²、细长比 ${r2(m.slenderness)}，加宽缺口会在成品上留下明显缺口；建议并入父轮廓（抹掉这段镂空），不掉片也不难看。`
      }
    } else {
      strategy = 'widen'
      strategyText = '只能加宽缺口（无可并入的相邻轮廓）'
      reason = fit
        ? '该片没有可并入的父轮廓，按建议宽度/个数加宽缺口。'
        : `周长仅 ${r2(m.L)}mm，缺口放不下；又没有可并入的相邻轮廓，建议减到 ${Math.max(2, Math.floor((0.6 * m.L) / widthLo))} 个、单个取 ${widthLo}~${widthHi}mm，并接受外观缺口。`
      count = Math.max(2, Math.min(count, Math.floor((0.6 * m.L) / Math.max(widthLo, 0.01))))
    }
  } else if (mergeFeasible && m.A < MODEL.mergeArea && m.slenderness >= MODEL.slenderMid && m.level === 'critical') {
    strategy = 'either'
    strategyText = '并入相邻轮廓更省，加宽亦可'
    reason = `小片 ${r2(m.A)}mm² 且偏细长：并入父轮廓最省事；若要保留镂空，按 ${widthLo}~${widthHi}mm × ${count} 个加宽。`
  } else {
    strategy = 'widen'
    strategyText = '加宽缺口即可（保留镂空）'
    reason = `周长 ${r2(m.L)}mm 放得下 ${count} 个缺口；按 ${widthLo}~${widthHi}mm 加宽后保持比例可达 ${(targetHold * 100).toFixed(0)}%，无需牺牲镂空。`
  }

  return { widthLo, widthHi, count, strategy, strategyText, reason, mergeParentId: mergeFeasible ? parentId : null }
}

function verdictText(level: RiskLevel, isFragment: boolean, gapCount: number, s: RiskSuggestion): string {
  if (level === 'low') return gapCount === 0 && !isFragment ? '大片，切完成片，掉落可能性低' : '缺口保持充足，预计能挂住'
  if (level === 'medium') return '有可能松脱，建议取件时轻推检查'
  const head = isFragment ? '碎片' : '该片'
  if (level === 'high') return `${head}较可能被拽掉：${s.strategyText}`
  return `${head}几乎必掉：${s.strategyText}`
}

/** 对整张纹样（多形状）做试算；plansByShape 传假设参数下的规划即为「另一版」 */
export function assessProject(
  shapes: Shape[],
  computedByShape: Map<string, ComputedShape>,
  input: RiskInput,
  plansByShape?: Map<string, Map<string, BridgePlan>>,
): RiskReport {
  const items: ContourRisk[] = []
  for (const shape of shapes) {
    const comp = computedByShape.get(shape.id)
    if (!comp) continue
    items.push(...assessShape(shape, comp, input, plansByShape?.get(shape.id)))
  }
  items.sort((a, b) => b.level.score - a.level.score || a.areaMm2 - b.areaMm2 || a.shapeId.localeCompare(b.shapeId))

  const criticalCount = items.filter((i) => i.level.level === 'critical').length
  const highCount = items.filter((i) => i.level.level === 'high').length
  const dropCount = highCount + criticalCount
  const worst = items[0] ?? null

  const fragTotal = items.filter((i) => i.isFragment).length
  const mergeCount = items.filter((i) => i.suggestion.strategy === 'merge').length
  let summary: string
  if (items.length === 0) {
    summary = '当前没有可评估的闭合轮廓。'
  } else if (dropCount === 0) {
    summary = `照当前参数切完，${fragTotal} 个碎片预计都能挂住，不会掉片；最需要留意的是「${worst?.shapeName}」中的 ${r2(worst?.areaMm2 ?? 0)}mm² 小片（${worst?.level.label}风险）。`
  } else {
    summary =
      `照当前参数切完，预计会掉 ${dropCount} 片（危险 ${criticalCount}、高风险 ${highCount}）` +
      (mergeCount > 0 ? `，其中 ${mergeCount} 片建议直接并入相邻轮廓` : '') +
      `；最危险的是「${worst?.shapeName}」中 ${r2(worst?.areaMm2 ?? 0)}mm² 的${worst && worst.slenderness >= 2 ? '细长' : ''}片（评分 ${worst?.level.score}/100）：${worst?.suggestion.strategyText}。`
  }

  const fingerprint = [
    input.bridgeRule,
    input.areaThresholdMm2,
    r3(input.bridgeWidthMm),
    input.bridgeEveryMm,
    input.material?.id ?? '',
    shapes
      .map((s) => `${s.id}:${s.layer}:${s.contours.length}:${s.contours.reduce((a, c) => a + c.bridges.length, 0)}`)
      .join(','),
  ].join('|')

  return { items, dropCount, highCount, criticalCount, worst, summary, fingerprint }
}

/** 假设参数下的全部规划（用于「对照版」） */
export function plansForHypothetical(shapes: Shape[], input: RiskInput): Map<string, Map<string, BridgePlan>> {
  const out = new Map<string, Map<string, BridgePlan>>()
  for (const shape of shapes) out.set(shape.id, planUnder(shape, input))
  return out
}

/** 模型常数导出（供界面说明/自检使用） */
export const RISK_MODEL = MODEL
