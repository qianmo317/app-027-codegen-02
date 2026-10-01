import { PATTERN_LIBRARY, fetchPatternText } from '@/data/patterns'
import { defaultMaterials } from '@/data/materials'
import { DEFAULT_CUT_SETTINGS, type CutSettings, type MaterialPreset, type Pt, type Shape } from './types'
import { cleanupContours } from './cleanup'
import { importSvgText } from './importer'
import { computeShape } from './pipeline'
import { buildJob } from './job'
import { buildA4Sheet, computePlacement, exportGcode, exportPlt, type ExportMeta } from './exporters'
import { polygonArea, polylineLength } from './geometry'
import { aggregateRisk, evaluateContourRisk, type RiskInput } from './risk'
import type { BridgeGap } from './bridges'

export type CheckResult = {
  id: string
  title: string
  pass: boolean
  detail: string
}

export type ImportedSummary = {
  file: string
  name: string
  kept: number
  notClosed: number
  selfIntersect: number
  duplicates: number
  maxDepth: number
  bridges: number
  fragments: number
  ms: number
}

export type SelfTestReport = {
  checks: CheckResult[]
  summaries: ImportedSummary[]
  totalMs: number
}

type Item = {
  file: string
  name: string
  shape: Shape
  contours: number
  notClosed: number
  si: number
  dup: number
  maxDepth: number
  bridges: number
  fragments: number
  ms: number
}

function ok(id: string, title: string, pass: boolean, detail: string): CheckResult {
  return { id, title, pass, detail }
}

/** 造一个 5000 点的波浪圆轮廓 */
function wavyCircle(cx: number, cy: number, r: number, n: number, amp: number, lobes: number): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const rr = r + amp * Math.sin(lobes * a)
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) })
  }
  return pts
}

export async function runSelfTest(settings: CutSettings = DEFAULT_CUT_SETTINGS, material?: MaterialPreset): Promise<SelfTestReport> {
  const t0 = performance.now()
  const checks: CheckResult[] = []
  const summaries: ImportedSummary[] = []
  const mat = material ?? defaultMaterials()[0]

  // ---------- 1. 导入 10 个真实窗花 SVG ----------
  const imported: Item[] = []
  for (const p of PATTERN_LIBRARY) {
    try {
      const text = await fetchPatternText(p.file)
      const t1 = performance.now()
      const res = importSvgText(text, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
      const shape: Shape = { id: `st_${p.slug}`, name: p.name, contours: res.contours, layer: 0 }
      const comp = computeShape(shape, settings, mat)
      const ms = performance.now() - t1
      imported.push({
        file: p.file,
        name: p.name,
        shape,
        contours: res.contours.length,
        notClosed: res.cleanup.notClosed,
        si: res.cleanup.selfIntersect,
        dup: res.cleanup.duplicates,
        maxDepth: comp.stats.maxDepth,
        bridges: comp.stats.bridgeCount,
        fragments: comp.stats.fragmentCount,
        ms,
      })
      summaries.push({
        file: p.file,
        name: p.name,
        kept: res.contours.length,
        notClosed: res.cleanup.notClosed,
        selfIntersect: res.cleanup.selfIntersect,
        duplicates: res.cleanup.duplicates,
        maxDepth: comp.stats.maxDepth,
        bridges: comp.stats.bridgeCount,
        fragments: comp.stats.fragmentCount,
        ms,
      })
    } catch (e) {
      checks.push(ok(`import-${p.file}`, `导入 ${p.name}`, false, (e as Error).message))
    }
  }

  checks.push(
    ok(
      'import-10',
      '导入 10 个真实窗花 SVG（本地纹样库，含嵌套 3 层 / 自交 / 未闭合 / 重复用例）',
      imported.length === 10 && imported.every((x) => x.contours > 0),
      imported.map((x) => `${x.file.replace('.svg', '')}:${x.contours}轮廓`).join('｜'),
    ),
  )

  const byFile = new Map(imported.map((x) => [x.file, x]))

  const conc = byFile.get('concentric-three.svg')
  checks.push(
    ok(
      'nesting-3',
      '包含关系树嵌套 3 层正确（同心三层窗花）',
      !!conc && conc.maxDepth >= 3,
      conc ? `同心三层窗花 maxDepth = ${conc.maxDepth}（外圆 depth1 → 内圆 depth2 → 花瓣 depth3）` : '未导入',
    ),
  )

  const selfCross = byFile.get('self-cross-flower.svg')
  checks.push(
    ok(
      'self-intersect',
      '自交检测：缠枝自交花标出全部自交路径',
      !!selfCross && selfCross.si >= 2,
      selfCross ? `自交轮廓 ${selfCross.si} 条（八角星 {8/3} 星形 + 蝴蝶结对角线交叉）` : '未导入',
    ),
  )

  const openSpiral = byFile.get('open-spiral.svg')
  checks.push(
    ok(
      'not-closed',
      '闭合检查：盘长未闭合纹标出未闭合路径',
      !!openSpiral && openSpiral.notClosed >= 1,
      openSpiral ? `未闭合 ${openSpiral.notClosed} 条（首尾距离 > 容差 ${settings.closeToleranceMm}mm，可一键闭合）` : '未导入',
    ),
  )

  const scatter = byFile.get('petal-scatter.svg')
  checks.push(
    ok(
      'duplicate',
      '重复路径合并：雪花散点中完全重叠 / 反向重叠的路径被合并',
      !!scatter && scatter.dup >= 2,
      scatter ? `合并重复路径 ${scatter.dup} 条（同一图形画了 2 遍，其中一条点序反向）` : '未导入',
    ),
  )

  const clean = byFile.get('window-flower-classic.svg')
  checks.push(
    ok(
      'clean-file',
      '干净文件不误报：经典八角窗花 0 未闭合 / 0 自交 / 0 重复',
      !!clean && clean.notClosed === 0 && clean.si === 0 && clean.dup === 0,
      clean ? `未闭合 ${clean.notClosed}｜自交 ${clean.si}｜重复 ${clean.dup}` : '未导入',
    ),
  )

  // ---------- 2. 连刀点：宽度 / 偏差 / 碎片 / 长度规则 ----------
  let widthMaxErr = 0
  let devLarge = 0
  let devAll = 0
  let maxAreaDelta = 0
  let maxLengthDelta = 0
  let fragTotal = 0
  let fragWithBridges = 0
  let bridgeTotal = 0
  let degraded = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, { ...settings, bridgeRule: 'by_area' }, mat)
    for (const c of item.shape.contours) {
      const m = comp.byId.get(c.id)
      if (!m) continue
      bridgeTotal += m.bridgeMetrics.count
      if (m.bridgeMetrics.degraded) degraded += 1
      if (c.closed && c.area < settings.areaThresholdMm2) {
        fragTotal += 1
        if (m.bridgeMetrics.count >= 2) fragWithBridges += 1
      }
      if (!m.bridgeMetrics.degraded) {
        for (const w of m.bridgeMetrics.widths) widthMaxErr = Math.max(widthMaxErr, Math.abs(w - settings.bridgeWidthMm))
      }
      devAll = Math.max(devAll, m.bridgeMetrics.geometryDeviationMm)
      if (c.length >= 20) devLarge = Math.max(devLarge, m.bridgeMetrics.geometryDeviationMm)
      maxAreaDelta = Math.max(maxAreaDelta, Math.abs(m.bridgeMetrics.areaBefore - m.bridgeMetrics.areaAfter))
      maxLengthDelta = Math.max(maxLengthDelta, Math.abs(m.bridgeMetrics.lengthBefore - m.bridgeMetrics.lengthAfter))
    }
  }

  checks.push(
    ok(
      'bridge-width',
      `连刀点缺口宽度与设定一致（${settings.bridgeWidthMm}mm ± 0.05mm）`,
      widthMaxErr <= 0.05,
      `共 ${bridgeTotal} 个连刀点，最大偏差 ${widthMaxErr.toFixed(4)}mm${degraded ? `（${degraded} 个碎片因过短被削窄，单独计为降级告警）` : ''}`,
    ),
  )

  checks.push(
    ok(
      'bridge-deviation',
      '轮廓几何偏差 ≤ 0.1mm（挖缺口后重算面积/周长并记录偏差）',
      devLarge <= 0.1,
      `缺口吸附在单条直线段内（不跨折角）：最大几何偏差 ${devAll.toFixed(5)}mm（长度 ≥20mm 轮廓 ${devLarge.toFixed(5)}mm）｜` +
        `被挖掉的最大面积 ${maxAreaDelta.toFixed(4)}mm²、最大周长 ${maxLengthDelta.toFixed(3)}mm（已重算并记录）`,
    ),
  )

  checks.push(
    ok(
      'bridge-fragment',
      `小碎片（面积 < ${settings.areaThresholdMm2}mm²）100% 生成连刀点（每片 ≥ 2 个）`,
      fragTotal === 0 || fragWithBridges === fragTotal,
      `碎片 ${fragTotal} 个，已连刀 ${fragWithBridges} 个，覆盖 ${fragTotal ? ((fragWithBridges / fragTotal) * 100).toFixed(0) : 100}%`,
    ),
  )

  let lengthRuleOk = true
  const lengthRuleDetail: string[] = []
  let lengthRuleCount = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, { ...settings, bridgeRule: 'by_length' }, mat)
    for (const c of item.shape.contours) {
      const m = comp.byId.get(c.id)
      if (!m || !c.closed) continue
      if (c.area < settings.areaThresholdMm2) continue
      const expect = Math.floor(c.length / settings.bridgeEveryMm)
      if (expect !== m.bridgeMetrics.count) {
        lengthRuleOk = false
        if (lengthRuleDetail.length < 5) lengthRuleDetail.push(`${item.file}: 周长 ${c.length.toFixed(1)}mm 期望 ${expect} 实得 ${m.bridgeMetrics.count}`)
      }
      lengthRuleCount += 1
    }
  }
  checks.push(
    ok(
      'bridge-by-length',
      '大轮廓按长度规则数量正确（n = ⌊周长 / 每段长度⌋）',
      lengthRuleOk,
      lengthRuleOk ? `每 ${settings.bridgeEveryMm}mm 一个连刀点，校验 ${lengthRuleCount} 条大轮廓全部吻合` : lengthRuleDetail.join('；'),
    ),
  )

  // ---------- 3. 切割顺序：先内后外 ----------
  let orderOk = true
  const orderDetail: string[] = []
  let orderPairs = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, settings, mat)
    const idx = new Map<string, number>()
    comp.order.steps.forEach((s, i) => {
      if (!idx.has(s.contourId)) idx.set(s.contourId, i)
    })
    for (const c of item.shape.contours) {
      const pi = idx.get(c.id)
      if (pi === undefined) continue
      for (const hid of c.holes) {
        const ci = idx.get(hid)
        if (ci === undefined) continue
        orderPairs += 1
        if (ci > pi) {
          orderOk = false
          if (orderDetail.length < 3) orderDetail.push(`${item.file}: 内层排在外层之后`)
        }
      }
    }
  }
  checks.push(
    ok(
      'order-inner-first',
      '切割顺序为先内后外（后序遍历包含关系树）',
      orderOk && orderPairs > 0,
      orderOk ? `校验 ${orderPairs} 组父子关系，内层轮廓全部排在外层之前` : orderDetail.join('；'),
    ),
  )

  // ---------- 4. 跳刀优化 ≥ 15% ----------
  let improvement = 0
  let nnImprovement = 0
  let travelDetail = '未导入'
  if (scatter) {
    const comp2 = computeShape(scatter.shape, { ...settings, travelOptimize: 'nearest_2opt' }, mat)
    const compNn = computeShape(scatter.shape, { ...settings, travelOptimize: 'nearest' }, mat)
    improvement = comp2.stats.improvementPct
    nnImprovement = compNn.stats.improvementPct
    travelDetail =
      `雪花散点（24 个碎片）：朴素顺序 ${comp2.stats.naiveTravelMm.toFixed(1)}mm → 仅最近邻 ${compNn.stats.travelMm.toFixed(1)}mm（−${nnImprovement.toFixed(1)}%）→ ` +
      `最近邻+2-opt ${comp2.stats.travelMm.toFixed(1)}mm（−${comp2.stats.improvementPct.toFixed(1)}%）`
  }
  checks.push(ok('travel-2opt', '跳刀优化：2-opt 后总跳刀长度比朴素顺序短 ≥ 15%', improvement >= 15, travelDetail))

  // ---------- 5. 导出 PLT / G-code ----------
  const exportShape = clean?.shape ?? imported[0]?.shape
  if (exportShape) {
    const comp = computeShape(exportShape, settings, mat)
    const sheet = { widthMm: 210, heightMm: 297, name: 'A4 纵向' }
    const job = buildJob([exportShape], new Map([[exportShape.id, comp]]), [0], { sharedEdge: false, start: { x: 0, y: 0 } })
    const pl = computePlacement(job.steps, sheet, 1)
    const meta: ExportMeta = {
      projectName: '自检',
      formName: exportShape.name,
      material: mat,
      bridgeWidthMm: settings.bridgeWidthMm,
      passes: mat.passes,
      sheet,
      cutLengthMm: job.cutLengthMm,
      travelMm: job.travelMm,
    }
    const plt = exportPlt(
      job.steps,
      { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 },
      sheet,
      meta,
      pl,
    )

    let maxInternalY = -Infinity
    let exportYOfMax = 0
    for (const st of job.steps) {
      for (const p of st.points) {
        const y = p.y + pl.offsetY
        if (y > maxInternalY) {
          maxInternalY = y
          exportYOfMax = Math.round((sheet.heightMm - y) / 0.025)
        }
      }
    }
    const inSheet = plt.minX >= 0 && plt.minY >= 0 && plt.maxX <= plt.sheetMaxX && plt.maxY <= plt.sheetMaxY
    const flipOk = Math.abs(plt.minY - exportYOfMax) <= 1
    checks.push(
      ok(
        'export-plt',
        '导出 PLT：坐标全部落在纸幅内、原点在左下（y′ = 纸幅高 − y）',
        inSheet && flipOk,
        `X ${plt.minX}~${plt.maxX}｜Y ${plt.minY}~${plt.maxY}（0.025mm/单位，纸幅上限 ${plt.sheetMaxX}×${plt.sheetMaxY}）｜` +
          `内部最大 y = ${maxInternalY.toFixed(2)}mm → 导出最小 y = ${exportYOfMax}（左下原点）`,
      ),
    )

    const gcode = exportGcode(job.steps, { format: 'gcode', unit: 'mm', origin: 'bottom_left', yFlip: true, scale: 1 }, sheet, meta, pl)
    const hasG21 = gcode.text.includes('G21')
    const feed = Math.round(mat.speedMmS * 60)
    const hasFeed = gcode.text.includes(`F${feed}`)
    const passSegments = (gcode.text.match(/; ---- pass \d+\/\d+/g) ?? []).length
    checks.push(
      ok(
        'export-gcode',
        '导出 G-code：单位 mm、进给与重复次数正确',
        hasG21 && hasFeed && passSegments === mat.passes,
        `G21(mm)=${hasG21}｜F${feed}（${mat.speedMmS}mm/s × 60）=${hasFeed}｜pass 段 ${passSegments}/${mat.passes}`,
      ),
    )

    // ---------- 6. A4 检查图 1:1 ----------
    const a4 = buildA4Sheet(job.steps, sheet, meta, pl, { showNumbers: true, showTravel: true, title: '自检' })
    const rulerMatch = /<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)" y2="[\d.]+" stroke="#000" stroke-width="0.3"\/>/.exec(a4)
    const rulerLen = rulerMatch ? Math.abs(Number(rulerMatch[2]) - Number(rulerMatch[1])) : 0
    const isMm1to1 =
      a4.includes(`width="${sheet.widthMm}mm"`) &&
      a4.includes(`height="${sheet.heightMm}mm"`) &&
      a4.includes(`viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}"`)
    checks.push(
      ok(
        'a4-ruler',
        'A4 检查图 1:1：100mm 校验尺几何长度误差 ≤ 1mm',
        Math.abs(rulerLen - 100) <= 1 && isMm1to1,
        `校验尺 ${rulerLen.toFixed(3)}mm（误差 ${Math.abs(rulerLen - 100).toFixed(3)}mm）｜SVG 物理尺寸 ${sheet.widthMm}mm×${sheet.heightMm}mm，浏览器 CSS mm 打印为 1:1`,
      ),
    )
  } else {
    checks.push(ok('export-plt', '导出 PLT 用例', false, '没有可用的纹样'))
  }

  // ---------- 10. 掉落风险试算 ----------
  const gap = (s: number, w = 0.5): BridgeGap => ({ s, widthMm: w, atIndex: 0 })
  const riskInput = (
    id: string,
    pts: Pt[],
    opts: { depth: number; layer?: number; gaps: BridgeGap[]; appliedWidth?: number; parent?: { id: string; areaMm2: number }; degraded?: boolean; threshold?: number },
  ): RiskInput => ({
    id,
    points: pts,
    area: polygonArea(pts),
    length: polylineLength(pts, true),
    depth: opts.depth,
    layer: opts.layer ?? 0,
    gaps: opts.gaps,
    appliedWidthMm: opts.appliedWidth ?? 0.5,
    areaThresholdMm2: opts.threshold ?? settings.areaThresholdMm2,
    parent: opts.parent ?? null,
    degraded: opts.degraded ?? false,
  })

  // 10a. 深层极小孤岛、无缺口 → 危险档
  const tiny = ellipsePts(60, 60, 0.9, 0.9, 18)
  const tinyRisk = evaluateContourRisk(
    riskInput('risk_tiny', tiny, { depth: 3, gaps: [], parent: { id: 'outer', areaMm2: 400 } }),
  )
  // 10b. 同一片、两个均匀缺口、宽度足够 → 明显降档
  const tinyBridged = evaluateContourRisk(
    riskInput('risk_tiny_b', tiny, {
      depth: 3,
      gaps: [gap(polylineLength(tiny, true) * 0.25, 0.7), gap(polylineLength(tiny, true) * 0.75, 0.7)],
      appliedWidth: 0.7,
      parent: { id: 'outer', areaMm2: 400 },
    }),
  )
  const tinyGap = tinyRisk.score - tinyBridged.score
  checks.push(
    ok(
      'risk-tiny',
      '掉落风险：深层极小孤岛无连刀点判为危险；补上均匀缺口后显著降档',
      tinyRisk.grade === 'critical' && tinyGap >= 12,
      `半径 0.9mm 孤岛（面积 ${polygonArea(tiny).toFixed(2)}mm²，depth3）：无缺口 ${tinyRisk.score} 分（${tinyRisk.grade}）→ 2 个 0.7mm 缺口 ${tinyBridged.score} 分（${tinyBridged.grade}），下降 ${tinyGap} 分`,
    ),
  )

  // 10c. 细长条 vs 等面积近圆片：细长条风险明显更高
  const strip = rectPts(0, 0, 14, 0.5)
  const blob = ellipsePts(0, 0, 1.6, 1.4, 24) // ≈7mm²，与细条接近
  const stripRisk = evaluateContourRisk(
    riskInput('risk_strip', strip, { depth: 3, gaps: [gap(3), gap(11)], parent: { id: 'o', areaMm2: 400 } }),
  )
  const blobRisk = evaluateContourRisk(
    riskInput('risk_blob', blob, { depth: 3, gaps: [gap(polylineLength(blob, true) * 0.25), gap(polylineLength(blob, true) * 0.75)], parent: { id: 'o', areaMm2: 400 } }),
  )
  checks.push(
    ok(
      'risk-slender',
      '掉落风险：同面积量级下细长条比近圆片更危险（长宽比因子生效）',
      stripRisk.factors.slenderness > 5 && stripRisk.score > blobRisk.score + 8,
      `14×0.5mm 细条（长宽比 ${stripRisk.factors.slenderness.toFixed(1)}）${stripRisk.score} 分 vs 近圆片（${blobRisk.factors.slenderness.toFixed(1)}）${blobRisk.score} 分`,
    ),
  )

  // 10d. 过短轮廓加宽不可行且有父轮廓 → 建议并入相邻轮廓
  const micro = rectPts(0, 0, 1.0, 1.0)
  const microRisk = evaluateContourRisk(
    riskInput('risk_micro', micro, { depth: 3, gaps: [gap(0.2, 0.2)], appliedWidth: 0.2, degraded: true, parent: { id: 'o', areaMm2: 400 } }),
  )
  checks.push(
    ok(
      'risk-merge',
      '掉落风险：周长过短无处加宽时建议「并入相邻轮廓」而非硬加宽',
      microRisk.grade !== 'safe' && microRisk.suggestion.kind === 'merge' && microRisk.suggestion.mergeTargetId === 'o',
      `1×1mm 小岛 ${microRisk.score} 分（${microRisk.grade}）：${microRisk.suggestion.kind}｜${microRisk.suggestion.reason.slice(0, 60)}…`,
    ),
  )

  // 10e. 汇总函数：预计掉片数与「最危险一片」
  const summary = aggregateRisk([
    { shapeId: 's', area: 10000, risk: evaluateContourRisk(riskInput('big', rectPts(0, 0, 100, 100), { depth: 1, gaps: [gap(50), gap(150), gap(250), gap(350)] })) },
    { shapeId: 's', area: polygonArea(tiny), risk: tinyRisk },
    { shapeId: 's', area: polygonArea(strip), risk: stripRisk },
  ])
  checks.push(
    ok(
      'risk-summary',
      '掉落风险：总体结论给出预计掉片数与最危险轮廓（最外层大块不计入掉片）',
      summary.total === 3 &&
        summary.expectedDrops >= 1 &&
        summary.worst?.id === 'risk_tiny' &&
        summary.critical >= 1,
      `共 ${summary.total} 片｜预计掉 ${summary.expectedDrops} 片（≈${summary.expectedDropsRaw}）｜危险 ${summary.critical} / 高危 ${summary.high}｜最危险 = ${summary.worst?.id}（${summary.worst?.score} 分）`,
    ),
  )

  // 10f. 与管线联动：改缺口宽度后风险结果随之变化（缓存签名失效）
  //      用带长边的方形小岛（采样椭圆的边太短，缺口会被几何削窄，测不出宽度差异）
  const probePts = rectPts(29, 29, 2.2, 1.4)
  const probeShape: Shape = {
    id: 'risk_probe',
    name: '风险用例',
    layer: 0,
    contours: [
      { id: 'rp_outer', points: rectPts(0, 0, 60, 60), closed: true, area: 3600, length: 240, holes: [], bridges: [], warnings: [] },
      { id: 'rp_island', points: probePts, closed: true, area: 2.2 * 1.4, length: 2 * (2.2 + 1.4), holes: [], bridges: [], warnings: [] },
    ],
  }
  const compNarrow = computeShape(probeShape, { ...settings, bridgeWidthMm: 0.3 }, mat)
  const compWide = computeShape(probeShape, { ...settings, bridgeWidthMm: 1.0 }, mat)
  const islandNarrow = compNarrow.byId.get('rp_island')?.risk
  const islandWide = compWide.byId.get('rp_island')?.risk
  const appliedN = compNarrow.byId.get('rp_island')?.bridgeMetrics.appliedWidthMm
  const appliedW = compWide.byId.get('rp_island')?.bridgeMetrics.appliedWidthMm
  checks.push(
    ok(
      'risk-reactive',
      '掉落风险：缺口宽度/面积阈值/层级变化后立即重算（管线签名失效、风险分随宽度下降）',
      !!islandNarrow && !!islandWide && (appliedW ?? 0) > (appliedN ?? 0) && islandWide.score < islandNarrow.score,
      `2.2×1.4mm 小岛：缺口设定 0.3mm（生效 ${appliedN}mm）→ ${islandNarrow?.score} 分；设定 1.0mm（生效 ${appliedW}mm）→ ${islandWide?.score} 分`,
    ),
  )

  // ---------- 7. 性能 ----------
  const bigPts = wavyCircle(80, 80, 62, 5000, 2.5, 11)
  const rawBig: Array<{ points: Pt[]; closed: boolean }> = [{ points: bigPts, closed: true }]
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2
    rawBig.push({ points: wavyCircle(80 + 50 * Math.cos(a), 80 + 50 * Math.sin(a), 1.1, 20, 0, 3), closed: true })
  }
  const t2 = performance.now()
  const cleaned = cleanupContours(rawBig, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
  const bigShape: Shape = { id: 'st_perf', name: '性能用例', contours: cleaned.contours, layer: 0 }
  const bigComp = computeShape(bigShape, settings, mat)
  const perfMs = performance.now() - t2
  checks.push(
    ok(
      'perf-5000',
      '5000 点轮廓全流程（清理 + 连刀 + 排序）< 300ms',
      perfMs < 300,
      `主轮廓 ${bigPts.length} 点 + 40 个碎片｜清理保留 ${cleaned.contours.length} 条｜连刀 ${bigComp.stats.bridgeCount} 个｜耗时 ${perfMs.toFixed(1)}ms`,
    ),
  )

  // ---------- 8. 缓存签名（参数变化才失效） ----------
  const sigA = computeShape(bigShape, settings, mat).signature
  const sigB = computeShape(bigShape, { ...settings, bridgeWidthMm: settings.bridgeWidthMm + 0.1 }, mat).signature
  checks.push(
    ok('cache-signature', '参数变化使缓存签名失效（避免每次渲染都重算）', sigA !== sigB, `签名一致 = ${sigA === sigB}（应为 false，参数已变化）`),
  )

  // ---------- 9. 刀补：凹角自交裁剪 + 明确告警 ----------
  const starShape: Shape = {
    id: 'st_offset',
    name: '刀补用例',
    layer: 0,
    contours: [makeStar(80, 80, 40, 20, 5, 0.3)],
  }
  const noOffset = computeShape(starShape, { ...settings, useBladeOffset: false }, mat)
  const withOffset = computeShape(starShape, { ...settings, useBladeOffset: true }, mat)
  const starId = starShape.contours[0].id
  const offEntry = withOffset.byId.get(starId)
  const noEntry = noOffset.byId.get(starId)
  const offsetMsg = offEntry?.offsetMessage ?? ''
  const geometryChanged = JSON.stringify(offEntry?.runs) !== JSON.stringify(noEntry?.runs)
  checks.push(
    ok(
      'blade-offset',
      '刀补：闭合轮廓按 bladeOffset 偏置，凹角自交自动裁剪',
      geometryChanged && (offEntry?.offsetOk ?? false),
      `五角星（外 R40 / 内 R20，10 个凹角）刀补 ${mat.bladeOffsetMm}mm：${offsetMsg}｜几何已改变 = ${geometryChanged}`,
    ),
  )
  // 刀补失败用例：外层大方框内的细长条（depth=2 → 向内偏置），0.25mm 偏置必然让 0.3mm 细条塌陷
  const thinInner = rectContour('st_thin', 30, 39.85, 20, 0.3)
  const outerSquare = rectContour('st_outer', 0, 0, 80, 80)
  const tinyShape: Shape = { id: 'st_offset_tiny', name: '刀补失败用例', layer: 0, contours: [outerSquare, thinInner] }
  const tinyOffset = computeShape(tinyShape, { ...settings, useBladeOffset: true }, mat)
  const tinyEntry = tinyOffset.byId.get(thinInner.id)
  const tinyOk = tinyEntry?.offsetOk ?? true
  const tinyMsg = tinyEntry?.offsetMessage ?? ''
  const tinyRuns = tinyEntry?.runs.length ?? 0
  checks.push(
    ok(
      'blade-offset-fail',
      '刀补超出轮廓尺度时明确警告并保留原路径（不输出坏路径）',
      !tinyOk && tinyMsg.includes('原路径') && tinyRuns > 0,
      `0.3mm 细长条（内层，向内侧偏置 ${mat.bladeOffsetMm}mm）：${tinyMsg}｜仍输出 ${tinyRuns} 段原路径`,
    ),
  )

  const totalMs = performance.now() - t0
  return { checks, summaries, totalMs }
}

/** 矩形轮廓 */
function rectPts(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

/** 椭圆折线（供风险试算测试构造近圆片） */
function ellipsePts(cx: number, cy: number, rx: number, ry: number, n: number): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push({ x: Math.round((cx + rx * Math.cos(a)) * 1000) / 1000, y: Math.round((cy + ry * Math.sin(a)) * 1000) / 1000 })
  }
  return pts
}

/** 矩形轮廓（带 id，用于管线类用例） */
function rectContour(id: string, x: number, y: number, w: number, h: number): Shape['contours'][number] {
  const pts = rectPts(x, y, w, h)
  return { id, points: pts, closed: true, area: w * h, length: 2 * (w + h), holes: [], bridges: [], warnings: [] }
}

/** 星形多边形（含凹角，用于刀补自交裁剪测试） */
function makeStar(cx: number, cy: number, rOuter: number, rInner: number, points: number, wobble: number): Shape['contours'][number] {
  const pts: Pt[] = []
  const n = points * 2
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    const r = (i % 2 === 0 ? rOuter : rInner) * (1 + (i % 3 === 0 ? wobble : 0))
    pts.push({ x: Math.round((cx + r * Math.cos(a)) * 1000) / 1000, y: Math.round((cy + r * Math.sin(a)) * 1000) / 1000 })
  }
  return {
    id: 'st_star',
    points: pts,
    closed: true,
    area: polygonArea(pts),
    length: polylineLength(pts, true),
    holes: [],
    bridges: [],
    warnings: [],
  }
}