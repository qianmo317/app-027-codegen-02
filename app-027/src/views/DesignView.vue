<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PreviewCanvas from '@/components/PreviewCanvas.vue'
import { store, state } from '@/logic/store'
import { PATTERN_LIBRARY, fetchPatternText } from '@/data/patterns'
import type { Contour, ContourWarning, Pt, Shape } from '@/logic/types'
import type { ComputedShape } from '@/logic/pipeline'
import { makeContour } from '@/logic/cleanup'
import { dist, uid } from '@/logic/geometry'
import { arcToCubics, sampleCubicInto } from '@/logic/svg'
import {
  aggregateRisk,
  RISK_GRADE_COLOR,
  RISK_GRADE_LABEL,
  type ContourRisk,
  type RiskAdviceKind,
  type RiskGrade,
  type RiskSummary,
} from '@/logic/risk'

type Mode = 'outline' | 'toolpath' | 'bridge' | 'risk'
type Tool = 'select' | 'pan' | 'rect' | 'circle' | 'polygon' | 'bridge'
type SymOp = 'mirror_x' | 'mirror_y' | 'rotate_90' | 'rotate_180' | 'four_way'

const route = useRoute()
const router = useRouter()
const canvas = ref<InstanceType<typeof PreviewCanvas> | null>(null)

const projectId = computed(() => String(route.params.id))
const project = computed(() => store.getProject(projectId.value) ?? null)

const tool = ref<Tool>('select')
const mode = ref<Mode>('outline')
const selectedShapeId = ref<string>('')
const selectedContourId = ref<string | null>(null)
const cursorPt = ref<Pt>({ x: 0, y: 0 })
const busy = ref('')
const error = ref('')
const showProblems = ref(true)
const showRules = ref(true)
const showContour = ref(true)

watch(
  project,
  (p) => {
    if (p && p.shapes.length > 0 && !p.shapes.some((s) => s.id === selectedShapeId.value)) {
      selectedShapeId.value = p.shapes[0].id
    }
    if (p && !p.batchShapeId && p.shapes.length > 0) p.batchShapeId = p.shapes[0].id
  },
  { immediate: true },
)

const shapes = computed(() => project.value?.shapes ?? [])
const selectedShape = computed(() => shapes.value.find((s) => s.id === selectedShapeId.value) ?? null)
const selectedContour = computed<Contour | null>(() => {
  if (!selectedContourId.value) return null
  for (const s of shapes.value) {
    const c = s.contours.find((x) => x.id === selectedContourId.value)
    if (c) return c
  }
  return null
})

const computedOfSelected = computed(() => {
  if (!selectedShape.value) return null
  return store.computedOf(selectedShape.value.id)
})

const totalStats = computed(() => {
  let contours = 0
  let closed = 0
  let open = 0
  let bridges = 0
  let cutLen = 0
  let travel = 0
  let naive = 0
  let ms = 0
  let fragments = 0
  let maxDepth = 1
  let dev = 0
  for (const s of shapes.value) {
    const c = store.computedOf(s.id)
    if (!c) continue
    contours += c.stats.contourCount
    closed += c.stats.closedCount
    open += c.stats.openCount
    bridges += c.stats.bridgeCount
    fragments += c.stats.fragmentCount
    cutLen += c.stats.cutLengthMm
    travel += c.stats.travelMm
    naive += c.stats.naiveTravelMm
    ms += c.elapsedMs
    maxDepth = Math.max(maxDepth, c.stats.maxDepth)
    dev = Math.max(dev, c.stats.geometryDeviationMm)
  }
  return {
    contours,
    closed,
    open,
    bridges,
    fragments,
    cutLen,
    travel,
    naive,
    ms,
    maxDepth,
    dev,
    improve: naive > 1e-9 ? ((naive - travel) / naive) * 100 : 0,
  }
})

type Problem = { id: string; shapeId: string; contourId: string; kind: ContourWarning; text: string; level: 'err' | 'warn' | 'info' }

const problems = computed<Problem[]>(() => {
  const out: Problem[] = []
  for (const s of shapes.value) {
    const comp = store.computedOf(s.id)
    for (const c of s.contours) {
      for (const w of c.warnings) {
        if (w === 'not_closed') {
          const gap = c.points.length >= 2 ? dist(c.points[0], c.points[c.points.length - 1]) : 0
          out.push({
            id: `${c.id}-nc`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: `未闭合：首尾相距 ${gap.toFixed(2)}mm（容差 ${project.value?.settings.closeToleranceMm}mm），切不穿`,
            level: 'err',
          })
        } else if (w === 'self_intersect') {
          out.push({
            id: `${c.id}-si`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: `自交：路径与自身相交，交点处切不干净`,
            level: 'err',
          })
        } else if (w === 'duplicate') {
          out.push({ id: `${c.id}-dp`, shapeId: s.id, contourId: c.id, kind: w, text: '重复路径：存在完全重叠/反向重叠的路径，已合并只切一次', level: 'warn' })
        } else if (w === 'offset_failed') {
          out.push({ id: `${c.id}-of`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补偏置失败，已保留原路径', level: 'err' })
        } else if (w === 'offset_clipped') {
          out.push({ id: `${c.id}-oc`, shapeId: s.id, contourId: c.id, kind: w, text: comp?.byId.get(c.id)?.offsetMessage || '刀补在凹角产生自交，已裁剪', level: 'info' })
        } else if (w === 'bridge_degraded') {
          out.push({
            id: `${c.id}-bd`,
            shapeId: s.id,
            contourId: c.id,
            kind: w,
            text: comp?.byId.get(c.id)?.bridgeMetrics.reason || '轮廓过短，连刀点宽度已削窄',
            level: 'warn',
          })
        }
      }
    }
  }
  return out
})

function locate(p: Problem): void {
  selectedShapeId.value = p.shapeId
  selectedContourId.value = p.contourId
  canvas.value?.focusContour(p.contourId)
}

function onSelectContour(id: string, shapeId: string): void {
  selectedContourId.value = id
  selectedShapeId.value = shapeId
}

function mutate(fn: () => void): void {
  const p = project.value
  if (!p) return
  fn()
  store.recomputeProject(p, true)
  store.touch(p)
}

function drawingTargetShape(): Shape {
  const p = project.value as NonNullable<typeof project.value>
  const cur = selectedShape.value
  if (cur && cur.name.startsWith('绘图')) return cur
  const s: Shape = { id: uid('s'), name: `绘图 ${p.shapes.filter((x) => x.name.startsWith('绘图')).length + 1}`, contours: [], layer: cur?.layer ?? 0 }
  p.shapes.push(s)
  selectedShapeId.value = s.id
  return s
}

function onRect(r: { x: number; y: number; w: number; h: number }): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(
      makeContour(
        [
          { x: r.x, y: r.y },
          { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h },
          { x: r.x, y: r.y + r.h },
        ],
        true,
      ),
    )
  })
}

function circlePoints(cx: number, cy: number, r: number, tol = 0.1): Pt[] {
  const pts: Pt[] = []
  const cubics = [...arcToCubics(cx + r, cy, r, r, 0, true, true, cx - r, cy), ...arcToCubics(cx - r, cy, r, r, 0, true, true, cx + r, cy)]
  let cur: Pt = { x: cx + r, y: cy }
  for (const [c1, c2, end] of cubics) {
    sampleCubicInto(cur, c1, c2, end, tol, pts)
    cur = end
  }
  return pts
}

function onCircle(c: { cx: number; cy: number; r: number }): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(makeContour(circlePoints(c.cx, c.cy, c.r), true))
  })
}

function onPolygon(p: Pt[]): void {
  mutate(() => {
    const s = drawingTargetShape()
    s.contours.push(makeContour(p, true))
  })
}

function onManualBridge(b: { contourId: string; atIndex: number }): void {
  const p = project.value
  if (!p) return
  store.placeManualBridge(p, b.contourId, b.atIndex)
}

async function addPattern(slug: string): Promise<void> {
  const p = project.value
  if (!p || !slug) return
  const entry = PATTERN_LIBRARY.find((x) => x.slug === slug)
  if (!entry) return
  busy.value = slug
  error.value = ''
  try {
    const text = await fetchPatternText(entry.file)
    const { shape } = store.importSvgToShapes(text, entry.name, p.settings)
    shape.layer = selectedShape.value?.layer ?? 0
    store.addShape(p, shape)
    selectedShapeId.value = shape.id
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

function applySym(op: SymOp): void {
  const p = project.value
  if (!p || !selectedShape.value) return
  store.applySymmetry(p, selectedShape.value.id, op)
}

function closeAll(): void {
  const p = project.value
  if (!p) return
  const n = store.closeAllOpen(p)
  error.value = n === 0 ? '没有可闭合的轮廓' : ''
}

function closeOne(): void {
  const p = project.value
  if (!p || !selectedContour.value) return
  if (!store.closeContour(p, selectedContour.value.id)) error.value = '该轮廓已闭合或点数不足（≥3 点才能闭合）'
  else error.value = ''
}

function delContour(): void {
  const p = project.value
  if (!p || !selectedContour.value) return
  store.removeContour(p, selectedContour.value.id)
  selectedContourId.value = null
}

function delShape(): void {
  const p = project.value
  if (!p || !selectedShape.value) return
  if (!confirm(`删除形状「${selectedShape.value.name}」？`)) return
  store.removeShape(p, selectedShape.value.id)
  selectedContourId.value = null
}

function setName(v: string): void {
  const p = project.value
  if (!p) return
  if (selectedShape.value) {
    selectedShape.value.name = v
    store.touch(p)
  } else {
    p.name = v
    store.touch(p)
  }
}

function addLayer(): void {
  const p = project.value
  if (!p) return
  const max = Math.max(...p.shapes.map((s) => s.layer), 0)
  if (selectedShape.value) {
    selectedShape.value.layer = max + 1
    store.recomputeProject(p, true)
    store.touch(p)
  }
}

const rule = computed(() => project.value?.settings.bridgeRule ?? 'by_area')
const settings = computed(() => project.value?.settings)

function patch(mut: (s: NonNullable<typeof settings.value>) => void): void {
  const p = project.value
  if (!p) return
  mut(p.settings)
  store.updateSettings(p, {})
}

const selMetrics = computed(() => {
  const c = selectedContour.value
  if (!c) return null
  const comp = computedOfSelected.value
  const m = comp?.byId.get(c.id)
  return m ?? null
})

const computedMap = computed(() => {
  const m = new Map<string, ComputedShape>()
  for (const s of shapes.value) {
    const c = store.computedOf(s.id)
    if (c) m.set(s.id, c)
  }
  return m
})

// ---------------- 掉落风险试算 ----------------

type RiskRow = {
  shapeId: string
  shapeName: string
  contourId: string
  seq: number
  area: number
  length: number
  depth: number
  layer: number
  bridgeCount: number
  risk: ContourRisk
}

const showRisk = ref(true)
const riskGradeFilter = ref<'all' | RiskGrade>('all')

const riskRows = computed<RiskRow[]>(() => {
  const rows: RiskRow[] = []
  for (const s of shapes.value) {
    const comp = store.computedOf(s.id)
    if (!comp) continue
    let seq = 0
    for (const c of s.contours) {
      if (!c.closed) continue
      seq += 1
      const risk = comp.byId.get(c.id)?.risk
      if (!risk) continue
      rows.push({
        shapeId: s.id,
        shapeName: s.name,
        contourId: c.id,
        seq,
        area: c.area,
        length: c.length,
        depth: comp.tree.depthOf.get(c.id) ?? 1,
        layer: s.layer,
        bridgeCount: comp.byId.get(c.id)?.bridgeMetrics.count ?? 0,
        risk,
      })
    }
  }
  // 危险优先，同分按面积从小到大（越小越先掉）
  return rows.sort((a, b) => b.risk.score - a.risk.score || a.area - b.area)
})

const riskSummary = computed<RiskSummary>(() =>
  aggregateRisk(
    riskRows.value.map((r) => ({
      shapeId: r.shapeId,
      risk: r.risk,
      area: r.area,
    })),
  ),
)

const filteredRiskRows = computed(() =>
  riskGradeFilter.value === 'all' ? riskRows.value : riskRows.value.filter((r) => r.risk.grade === riskGradeFilter.value),
)

function contourLabelOf(row: RiskRow): string {
  const comp = store.computedOf(row.shapeId)
  const parentId = comp?.tree.nodeById.get(row.contourId)?.parentId ?? null
  const sameParent = parentId
    ? shapes.value
        .find((s) => s.id === row.shapeId)
        ?.contours.filter((c) => (comp?.tree.nodeById.get(c.id)?.parentId ?? null) === parentId)
        .sort((a, b) => a.area - b.area) ?? []
    : []
  const idx = sameParent.findIndex((c) => c.id === row.contourId)
  return `${row.shapeName} · 第${row.depth}层 ${row.risk.role === 'kept' ? '保留岛' : '镂空'}${idx >= 0 ? ` #${idx + 1}` : ''}`
}

function locateRisk(row: RiskRow): void {
  selectedShapeId.value = row.shapeId
  selectedContourId.value = row.contourId
  mode.value = 'risk'
  canvas.value?.focusContour(row.contourId)
}

function locateWorst(): void {
  const id = riskSummary.value.worst?.id
  if (!id) return
  const row = riskRows.value.find((r) => r.contourId === id)
  if (row) locateRisk(row)
}

/** 采用建议：把缺口宽度改到建议区间下限（立刻重算） */
function applyRiskWidth(row: RiskRow): void {
  const p = project.value
  const w = row.risk.suggestion.widthRangeMm?.[0]
  if (!p || !w) return
  p.settings.bridgeWidthMm = Math.round(w * 100) / 100
  store.updateSettings(p, {})
  selectedShapeId.value = row.shapeId
  selectedContourId.value = row.contourId
}

/** 并入相邻轮廓：取消这圈刀路（删除该闭合轮廓；废料洞被填平 / 小岛留作底纸） */
function mergeContour(row: RiskRow): void {
  const p = project.value
  if (!p) return
  if (!confirm(`把「${contourLabelOf(row)}」并入相邻轮廓？\n将删除这圈刀路（约 ${row.area.toFixed(2)}mm² 留在底纸上，不再镂空/保留）。`)) return
  store.removeContour(p, row.contourId)
  selectedContourId.value = null
}

// ---------------- 对照版（快照 A / B） ----------------

type RiskSnapshot = {
  at: number
  bridgeWidthMm: number
  areaThresholdMm2: number
  bridgeEveryMm: number
  rows: RiskRow[]
  summary: RiskSummary
}

const snapshotA = ref<RiskSnapshot | null>(null)
const snapshotB = ref<RiskSnapshot | null>(null)
const showCompare = ref(false)

function takeSnapshot(target: 'A' | 'B'): void {  const snap: RiskSnapshot = {
    at: Date.now(),
    bridgeWidthMm: project.value?.settings.bridgeWidthMm ?? 0,
    areaThresholdMm2: project.value?.settings.areaThresholdMm2 ?? 0,
    bridgeEveryMm: project.value?.settings.bridgeEveryMm ?? 0,
    rows: riskRows.value.map((r) => ({ ...r, risk: JSON.parse(JSON.stringify(r.risk)) as ContourRisk })),
    summary: JSON.parse(JSON.stringify(riskSummary.value)) as RiskSummary,
  }
  if (target === 'A') snapshotA.value = snap
  else snapshotB.value = snap
}

type CompareRow = {
  key: string
  label: string
  grade: RiskGrade
  scoreA: number | null
  scoreB: number | null
  delta: number | null
  probA: number | null
  probB: number | null
  adviceA: RiskAdviceKind
  adviceB: RiskAdviceKind
  row: RiskRow | null
}

const compareRows = computed<CompareRow[]>(() => {
  const a = snapshotA.value
  const b = snapshotB.value
  if (!a || !b) return []
  const map = new Map<string, CompareRow>()
  const labelFor = (snap: RiskSnapshot, cid: string): string => {
    const r = snap.rows.find((x) => x.contourId === cid)
    return r ? contourLabelOf(r) : '（已删除/已合并）'
  }
  for (const r of a.rows) {
    const other = b.rows.find((x) => x.contourId === r.contourId)
    map.set(r.contourId, {
      key: r.contourId,
      label: labelFor(a, r.contourId),
      grade: other ? other.risk.grade : r.risk.grade,
      scoreA: r.risk.score,
      scoreB: other ? other.risk.score : null,
      delta: other ? other.risk.score - r.risk.score : null,
      probA: r.risk.probabilityPct,
      probB: other ? other.risk.probabilityPct : null,
      adviceA: r.risk.suggestion.kind,
      adviceB: other ? other.risk.suggestion.kind : 'none',
      row: riskRows.value.find((x) => x.contourId === r.contourId) ?? null,
    })
  }
  for (const r of b.rows) {
    if (map.has(r.contourId)) continue
    map.set(r.contourId, {
      key: r.contourId,
      label: labelFor(b, r.contourId),
      grade: r.risk.grade,
      scoreA: null,
      scoreB: r.risk.score,
      delta: null,
      probA: null,
      probB: r.risk.probabilityPct,
      adviceA: 'none',
      adviceB: r.risk.suggestion.kind,
      row: riskRows.value.find((x) => x.contourId === r.contourId) ?? null,
    })
  }
  return Array.from(map.values()).sort(
    (x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0) || (y.scoreB ?? 0) - (x.scoreB ?? 0),
  )
})

function fmtTime(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function clearSnapshots(): void {
  snapshotA.value = null
  snapshotB.value = null
  showCompare.value = false
}

function scoreClass(score: number | null): string {
  if (score === null) return ''
  if (score >= 70) return 's-critical'
  if (score >= 48) return 's-high'
  if (score >= 26) return 's-watch'
  return 's-safe'
}

</script>

<template>
  <div v-if="!project" class="splash">项目不存在，请返回纹样库 <RouterLink to="/">返回</RouterLink></div>
  <div v-else class="workbench">
    <!-- 左：工具栏 -->
    <div class="panel">
      <div class="panel-head">工具</div>
      <div class="panel-body">
        <div class="tool-group">
          <button class="tool" :class="{ active: tool === 'select' }" @click="tool = 'select'"><span class="tool-icon">▶</span>选择 / 点选轮廓</button>
          <button class="tool" :class="{ active: tool === 'pan' }" @click="tool = 'pan'"><span class="tool-icon">✥</span>平移画布</button>
          <button class="tool" :class="{ active: tool === 'rect' }" @click="tool = 'rect'"><span class="tool-icon">▭</span>矩形</button>
          <button class="tool" :class="{ active: tool === 'circle' }" @click="tool = 'circle'"><span class="tool-icon">○</span>圆形</button>
          <button class="tool" :class="{ active: tool === 'polygon' }" @click="tool = 'polygon'"><span class="tool-icon">△</span>多边形</button>
          <button class="tool" :class="{ active: tool === 'bridge' }" @click="tool = 'bridge'"><span class="tool-icon">⌇</span>手工放连刀点</button>
        </div>
        <div class="hint">矩形/圆形：按住拖动绘制；多边形：逐点点击，回车或双击完成；手工连刀点：点击轮廓上的位置。</div>

        <div class="section">
          <div class="section-title">添加纹样</div>
          <select :value="''" @change="addPattern(($event.target as HTMLSelectElement).value)">
            <option value="">从内置纹样库添加…</option>
            <option v-for="p in PATTERN_LIBRARY" :key="p.slug" :value="p.slug">{{ p.category }}｜{{ p.name }}</option>
          </select>
          <div v-if="busy" class="hint">解析中…</div>
        </div>

        <div class="section">
          <div class="section-title">对称生成（选中形状）</div>
          <div class="btn-row">
            <button class="tiny" @click="applySym('mirror_x')">左右镜像</button>
            <button class="tiny" @click="applySym('mirror_y')">上下镜像</button>
            <button class="tiny" @click="applySym('rotate_90')">旋转 90°</button>
            <button class="tiny" @click="applySym('rotate_180')">旋转 180°</button>
            <button class="tiny" @click="applySym('four_way')">四方连续</button>
          </div>
        </div>

        <div class="section">
          <div class="section-title">图形列表</div>
          <div class="list">
            <div
              v-for="s in shapes"
              :key="s.id"
              class="list-item"
              :class="{ active: s.id === selectedShapeId }"
              @click="selectedShapeId = s.id"
            >
              <span class="grow">{{ s.name }}</span>
              <span class="tag">L{{ s.layer + 1 }}</span>
              <span class="tag">{{ s.contours.length }}</span>
            </div>
          </div>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny" @click="delShape" :disabled="!selectedShape">删除形状</button>
            <button class="tiny" @click="addLayer" :disabled="!selectedShape">移到新图层</button>
          </div>
        </div>

        <div class="section">
          <div class="section-title">项目</div>
          <div class="field">
            <label>项目名</label>
            <input type="text" :value="project.name" @input="setName(($event.target as HTMLInputElement).value)" />
          </div>
          <div class="btn-row">
            <button class="tiny" @click="router.push(`/layout/${project.id}`)">进入排版</button>
            <button class="tiny" @click="router.push(`/export/${project.id}`)">进入导出</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 中：预览 -->
    <div class="panel canvas-panel">
      <div class="panel-head">
        <div class="mode-switch">
          <button :class="{ active: mode === 'outline' }" @click="mode = 'outline'">成品轮廓</button>
          <button :class="{ active: mode === 'toolpath' }" @click="mode = 'toolpath'">刀路 · 顺序</button>
          <button :class="{ active: mode === 'bridge' }" @click="mode = 'bridge'">连刀点放大 ×8</button>
          <button :class="{ active: mode === 'risk' }" @click="mode = 'risk'">掉落风险</button>
        </div>
        <span class="spacer"></span>
        <span class="tag mono">光标 {{ cursorPt.x }}, {{ cursorPt.y }} mm</span>
      </div>
      <PreviewCanvas
        ref="canvas"
        :shapes="shapes"
        :computed="computedMap"
        :mode="mode"
        :tool="tool"
        :show-numbers="mode === 'toolpath'"
        :show-travel="mode === 'toolpath'"
        :magnify="true"
        :selected-contour-id="selectedContourId"
        :status-text="mode === 'bridge' ? '缺口已放大 8 倍' : ''"
        @select-contour="onSelectContour"
        @create-rect="onRect"
        @create-circle="onCircle"
        @create-polygon="onPolygon"
        @manual-bridge="onManualBridge"
        @cursor="cursorPt = $event"
      />
      <div class="panel-foot">
        <div class="legend">
          <span v-if="mode === 'outline'"><i style="background: #cfd9e4"></i>轮廓</span>
          <span><i style="background: #ffc857"></i>未闭合</span>
          <span><i style="background: #ff6b6b"></i>自交</span>
          <span><i style="background: #b48cff"></i>重复路径</span>
          <span v-if="mode === 'toolpath'"><i style="background: #ff8f3c"></i>刀路</span>
          <span v-if="mode === 'toolpath'"><i style="background: #7f8fa3"></i>跳刀</span>
          <span v-if="mode === 'bridge'"><i style="background: #47c07a"></i>连刀点缺口</span>
          <template v-if="mode === 'risk'">
            <span><i style="background: #47c07a"></i>安全</span>
            <span><i style="background: #ffc857"></i>注意</span>
            <span><i style="background: #ff8f3c"></i>高危</span>
            <span><i style="background: #ff5252"></i>危险</span>
          </template>
        </div>
      </div>
    </div>

    <!-- 右：属性与规则 -->
    <div class="panel">
      <div class="panel-head">属性与规则</div>
      <div class="panel-body">
        <div v-if="error" class="banner err">{{ error }}</div>

        <div class="stat-grid">
          <div class="stat"><div class="k">轮廓 / 闭合</div><div class="v">{{ totalStats.contours }}<small>/{{ totalStats.closed }}</small></div></div>
          <div class="stat"><div class="k">未闭合</div><div class="v" :style="{ color: totalStats.open ? 'var(--err)' : '' }">{{ totalStats.open }}</div></div>
          <div class="stat"><div class="k">连刀点</div><div class="v">{{ totalStats.bridges }}</div></div>
          <div class="stat"><div class="k">刀路总长</div><div class="v">{{ totalStats.cutLen.toFixed(0) }}<small>mm</small></div></div>
          <div class="stat"><div class="k">跳刀 / 优化</div><div class="v">{{ totalStats.travel.toFixed(0) }}<small>mm · {{ totalStats.improve >= 0 ? '−' : '+' }}{{ Math.abs(totalStats.improve).toFixed(1) }}%</small></div></div>
          <div class="stat"><div class="k">嵌套层数</div><div class="v">{{ totalStats.maxDepth }}</div></div>
          <div class="stat"><div class="k">几何偏差</div><div class="v">{{ totalStats.dev.toFixed(3) }}<small>mm</small></div></div>
          <div class="stat"><div class="k">计算耗时</div><div class="v">{{ totalStats.ms.toFixed(1) }}<small>ms</small></div></div>
        </div>

        <div class="section">
          <div class="section-title" @click="showRisk = !showRisk">
            掉落风险试算
            <span class="tag" :style="riskSummary.critical ? { color: '#ff5252', borderColor: 'rgba(255,82,82,.5)' } : riskSummary.high ? { color: 'var(--warn)' } : { color: 'var(--ok)' }">
              预计掉 {{ riskSummary.expectedDrops }} 片
            </span>
            <span class="spacer"></span>
            <button class="tiny" @click.stop="takeSnapshot('A')">存为 A 版</button>
            <button class="tiny" @click.stop="takeSnapshot('B'); showCompare = true">存为 B 版对照</button>
          </div>
          <div v-show="showRisk">
            <!-- 总体结论 -->
            <div
              class="risk-banner"
              :style="{ borderColor: riskSummary.critical ? '#ff525266' : riskSummary.high ? '#ff8f3c66' : riskSummary.watch ? '#ffc85755' : '#47c07a55' }"
            >
              <template v-if="riskRows.length === 0">
                <div class="empty" style="padding: 8px">还没有闭合轮廓可试算。</div>
              </template>
              <template v-else>
                <div class="risk-verdict">
                  <strong>
                    照当前参数切完，预计会掉 <em>{{ riskSummary.expectedDrops }}</em> 片
                  </strong>
                  <span class="hint">（保留岛按经验掉率求和 ≈ {{ riskSummary.expectedDropsRaw }} 片；不含镂空废料）</span>
                </div>
                <div class="risk-gradebar">
                  <span class="g" :style="{ background: RISK_GRADE_COLOR.safe }">{{ riskSummary.safe }} 安全</span>
                  <span class="g" :style="{ background: RISK_GRADE_COLOR.watch }">{{ riskSummary.watch }} 注意</span>
                  <span class="g" :style="{ background: RISK_GRADE_COLOR.high }">{{ riskSummary.high }} 高危</span>
                  <span class="g" :style="{ background: RISK_GRADE_COLOR.critical }">{{ riskSummary.critical }} 危险</span>
                </div>
                <div v-if="riskSummary.worst" class="risk-worst">
                  最危险：
                  <a @click="locateWorst">
                    <i class="dot" :style="{ background: RISK_GRADE_COLOR[riskSummary.worst.grade] }"></i>
                    {{ contourLabelOf(riskRows.find((r) => r.contourId === riskSummary.worst!.id)!) }}
                    · {{ riskSummary.worst.score }} 分
                  </a>
                </div>
              </template>
            </div>

            <!-- 档位过滤 -->
            <div v-if="riskRows.length" class="risk-filters">
              <button class="tiny" :class="{ active: riskGradeFilter === 'all' }" @click="riskGradeFilter = 'all'">全部 {{ riskRows.length }}</button>
              <button class="tiny" :class="{ active: riskGradeFilter === 'critical' }" @click="riskGradeFilter = 'critical'">危险 {{ riskSummary.critical }}</button>
              <button class="tiny" :class="{ active: riskGradeFilter === 'high' }" @click="riskGradeFilter = 'high'">高危 {{ riskSummary.high }}</button>
              <button class="tiny" :class="{ active: riskGradeFilter === 'watch' }" @click="riskGradeFilter = 'watch'">注意 {{ riskSummary.watch }}</button>
              <button class="tiny" :class="{ active: riskGradeFilter === 'safe' }" @click="riskGradeFilter = 'safe'">安全 {{ riskSummary.safe }}</button>
            </div>

            <!-- 逐片清单 -->
            <div class="list risk-list">
              <div
                v-for="r in filteredRiskRows"
                :key="r.contourId"
                class="list-item risk-item"
                :class="{ active: r.contourId === selectedContourId }"
                @click="locateRisk(r)"
              >
                <span class="risk-score" :style="{ color: RISK_GRADE_COLOR[r.risk.grade] }">{{ r.risk.score }}</span>
                <span class="risk-body">
                  <span class="grow risk-title">
                    <i class="dot" :style="{ background: RISK_GRADE_COLOR[r.risk.grade] }"></i>
                    {{ contourLabelOf(r) }}
                    <span class="tag" :style="{ color: RISK_GRADE_COLOR[r.risk.grade] }">{{ RISK_GRADE_LABEL[r.risk.grade] }}</span>
                  </span>
                  <span class="risk-meta mono">
                    {{ r.area.toFixed(2) }}mm² · 细长{{ r.risk.factors.slenderness.toFixed(1) }} · L{{ r.layer + 1 }} · 缺口×{{ r.bridgeCount }} · 掉率≈{{ r.risk.probabilityPct }}%
                  </span>
                  <span v-if="r.risk.suggestion.kind !== 'none'" class="risk-advice">
                    <template v-if="r.risk.suggestion.kind === 'widen'">
                      <button class="tiny" @click.stop="applyRiskWidth(r)">加宽到 {{ r.risk.suggestion.widthRangeMm?.[0] }}~{{ r.risk.suggestion.widthRangeMm?.[1] }}mm ×{{ r.risk.suggestion.bridgeCount }}</button>
                    </template>
                    <template v-else>
                      <button class="tiny danger" @click.stop="mergeContour(r)">并入相邻轮廓</button>
                    </template>
                    <span class="risk-reason">{{ r.risk.suggestion.reason }}</span>
                  </span>
                </span>
              </div>
            </div>
            <div v-if="riskRows.length && filteredRiskRows.length === 0" class="empty">该档位下没有轮廓。</div>

            <!-- A / B 对照 -->
            <div v-if="snapshotA || snapshotB" class="section compare-section">
              <div class="section-title" @click="showCompare = !showCompare">
                两版结论对照
                <span class="spacer"></span>
                <button
                  v-if="snapshotA && snapshotB"
                  class="tiny danger"
                  @click.stop="clearSnapshots"
                >
                  清空
                </button>
              </div>
              <div v-show="showCompare" class="compare">
                <div v-if="!snapshotA || !snapshotB" class="hint">
                  已存{{ snapshotA ? ` A 版（${fmtTime(snapshotA.at)}，缺口 ${snapshotA.bridgeWidthMm}mm / 阈值 ${snapshotA.areaThresholdMm2}mm²）` : '' }}{{ snapshotB ? ` B 版（${fmtTime(snapshotB.at)}，缺口 ${snapshotB.bridgeWidthMm}mm / 阈值 ${snapshotB.areaThresholdMm2}mm²）` : '' }}，
                  调整缺口宽度、面积阈值或层级归属后再点「存为 {{ snapshotA ? 'B' : 'A' }} 版」即可对照。
                </div>
                <template v-else>
                  <div class="compare-head">
                    <span>A {{ fmtTime(snapshotA.at) }}｜缺口 {{ snapshotA.bridgeWidthMm }}mm · 阈值 {{ snapshotA.areaThresholdMm2 }}mm²</span>
                    <span class="accent">B {{ fmtTime(snapshotB.at) }}｜缺口 {{ snapshotB.bridgeWidthMm }}mm · 阈值 {{ snapshotB.areaThresholdMm2 }}mm²</span>
                  </div>
                  <div class="compare-summary">
                    预计掉片 <b>{{ snapshotA.summary.expectedDrops }}</b> → <b>{{ snapshotB.summary.expectedDrops }}</b>
                    ｜危险/高危 {{ snapshotA.summary.critical + snapshotA.summary.high }} → {{ snapshotB.summary.critical + snapshotB.summary.high }}
                    ｜平均分 {{ snapshotA.summary.avgScore }} → {{ snapshotB.summary.avgScore }}
                  </div>
                  <div class="list">
                    <div v-for="cr in compareRows.slice(0, 40)" :key="cr.key" class="list-item compare-row" @click="cr.row && locateRisk(cr.row)">
                      <span class="grow">{{ cr.label }}</span>
                      <span class="mono compare-scores">
                        <em :class="scoreClass(cr.scoreA)">{{ cr.scoreA ?? '—' }}</em>
                        <span class="arrow">{{ cr.delta === null ? '' : cr.delta < 0 ? '↓改善' : cr.delta > 0 ? '↑恶化' : '＝' }}</span>
                        <em :class="scoreClass(cr.scoreB)">{{ cr.scoreB ?? '—' }}</em>
                      </span>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title" @click="showProblems = !showProblems">
            问题清单
            <span class="tag" :class="problems.length ? 'err' : 'ok'">{{ problems.length }}</span>
            <span class="spacer"></span>
            <button class="tiny" @click.stop="closeAll">一键闭合未闭合轮廓</button>
          </div>
          <div v-show="showProblems">
            <div v-if="problems.length === 0" class="empty">未发现问题：路径闭合、无自交、无重复。</div>
            <div class="list">
              <div v-for="p in problems" :key="p.id" class="list-item" @click="locate(p)">
                <span class="tag" :class="p.level === 'err' ? 'err' : p.level === 'warn' ? 'warn' : 'info'">{{ p.kind }}</span>
                <span class="grow">{{ p.text }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title" @click="showContour = !showContour">
            选中轮廓
            <span class="spacer"></span>
            <button class="tiny" :disabled="!selectedContour" @click.stop="closeOne">闭合</button>
            <button class="tiny danger" :disabled="!selectedContour" @click.stop="delContour">删除</button>
          </div>
          <div v-show="showContour">
            <div v-if="!selectedContour" class="empty">在画布上点选一条轮廓</div>
            <template v-else>
              <div class="stat-grid">
                <div class="stat"><div class="k">点数</div><div class="v">{{ selectedContour.points.length }}</div></div>
                <div class="stat"><div class="k">面积</div><div class="v">{{ selectedContour.area.toFixed(2) }}<small>mm²</small></div></div>
                <div class="stat"><div class="k">周长</div><div class="v">{{ selectedContour.length.toFixed(2) }}<small>mm</small></div></div>
                <div class="stat"><div class="k">状态</div><div class="v" style="font-size: 12px">{{ selectedContour.closed ? '已闭合' : '未闭合' }}</div></div>
                <div class="stat"><div class="k">内层数</div><div class="v">{{ selectedContour.holes.length }}</div></div>
                <div class="stat"><div class="k">连刀点</div><div class="v">{{ selMetrics?.anchors.length ?? 0 }}</div></div>
              </div>
              <div v-if="selMetrics" class="hint" style="margin-top: 6px">
                {{ selMetrics.bridgeMetrics.reason }}｜几何偏差 {{ selMetrics.bridgeMetrics.geometryDeviationMm.toFixed(3) }}mm
              </div>
              <div v-if="selMetrics && selMetrics.anchors.length" class="bridge-list">
                <div v-for="(b, i) in selMetrics.anchors.slice(0, 30)" :key="i" class="mono">
                  #{{ i + 1 }} 锚点 ({{ b.at.x.toFixed(2) }}, {{ b.at.y.toFixed(2) }})｜宽 {{ b.widthMm.toFixed(3) }}mm
                </div>
              </div>
            </template>
          </div>
        </div>

        <div class="section" v-if="settings">
          <div class="section-title" @click="showRules = !showRules">切割规则</div>
          <div v-show="showRules">
            <div class="field-row">
              <label>连刀规则</label>
              <select :value="settings.bridgeRule" @change="patch((s) => (s.bridgeRule = ($event.target as HTMLSelectElement).value as never))">
                <option value="by_area">按片段面积（碎片必连刀）</option>
                <option value="by_length">按轮廓长度（每 L mm）</option>
                <option value="manual">手工放置</option>
              </select>
            </div>
            <div class="field-row">
              <label>面积阈值</label>
              <input type="number" step="0.5" min="0" :value="settings.areaThresholdMm2" @change="patch((s) => (s.areaThresholdMm2 = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm²</span>
            </div>
            <div class="field-row">
              <label>缺口宽度</label>
              <input type="number" step="0.05" min="0.1" max="2" :value="settings.bridgeWidthMm" @change="patch((s) => (s.bridgeWidthMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>每 L 一个</label>
              <input type="number" step="1" min="1" :value="settings.bridgeEveryMm" @change="patch((s) => (s.bridgeEveryMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>跳刀优化</label>
              <select :value="settings.travelOptimize" @change="patch((s) => (s.travelOptimize = ($event.target as HTMLSelectElement).value as never))">
                <option value="nearest_2opt">最近邻 + 2-opt</option>
                <option value="nearest">仅最近邻</option>
              </select>
            </div>
            <div class="field-row">
              <label>曲线容差</label>
              <input type="number" step="0.05" min="0.02" :value="settings.toleranceMm" @change="patch((s) => (s.toleranceMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <div class="field-row">
              <label>闭合容差</label>
              <input type="number" step="0.05" min="0.01" :value="settings.closeToleranceMm" @change="patch((s) => (s.closeToleranceMm = Number(($event.target as HTMLInputElement).value)))" />
              <span class="hint">mm</span>
            </div>
            <label class="check"><input type="checkbox" :checked="settings.useBladeOffset" @change="patch((s) => (s.useBladeOffset = ($event.target as HTMLInputElement).checked))" /> 启用刀补（刀偏置，凹角自交自动裁剪）</label>
            <div class="btn-row" style="margin-top: 6px">
              <button class="tiny" @click="rule === 'manual' ? store.clearManualBridges(project, selectedContourId ?? undefined) : null">
                清空手工连刀点
              </button>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">材料</div>
          <select :value="project.materialId" @change="store.setMaterial(project, ($event.target as HTMLSelectElement).value)">
            <option v-for="m in state.materials" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <div class="hint" style="margin-top: 5px">
            刀压 {{ store.materialOf(project)?.force }}｜速度 {{ store.materialOf(project)?.speedMmS }}mm/s｜重复 {{ store.materialOf(project)?.passes }} 次｜刀偏
            {{ store.materialOf(project)?.bladeOffsetMm }}mm
          </div>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny" @click="router.push('/materials')">管理材料预设</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
  padding: 6px 8px;
  border-radius: 5px;
  margin-bottom: 8px;
  font-size: 12px;
}

.section-title {
  cursor: pointer;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}

.bridge-list {
  margin-top: 6px;
  max-height: 90px;
  overflow: auto;
  font-size: 11px;
  color: var(--text-mute);
  line-height: 1.7;
}

/* ---------- 掉落风险 ---------- */
.risk-banner {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 9px;
  background: var(--panel-2);
}

.risk-verdict {
  font-size: 12.5px;
}

.risk-verdict em {
  font-style: normal;
  font-family: var(--mono);
  font-size: 15px;
  color: var(--err);
  padding: 0 2px;
}

.risk-gradebar {
  display: flex;
  gap: 5px;
  margin: 7px 0 5px;
  flex-wrap: wrap;
}

.risk-gradebar .g {
  flex: 1 1 auto;
  text-align: center;
  font-size: 10.5px;
  color: #10151a;
  font-weight: 700;
  border-radius: 4px;
  padding: 2px 4px;
  opacity: 0.85;
}

.risk-worst {
  font-size: 11.5px;
  color: var(--text-dim);
}

.risk-worst a {
  cursor: pointer;
  color: var(--accent-2);
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 3px;
}

.risk-filters {
  display: flex;
  gap: 4px;
  margin: 8px 0 6px;
  flex-wrap: wrap;
}

.risk-filters .tiny.active {
  border-color: var(--accent);
  color: var(--accent-2);
}

.risk-list {
  max-height: 300px;
  overflow: auto;
}

.risk-item {
  align-items: flex-start;
  gap: 8px;
}

.risk-score {
  flex: 0 0 30px;
  font-family: var(--mono);
  font-size: 17px;
  font-weight: 700;
  text-align: center;
  line-height: 1.2;
  padding-top: 2px;
}

.risk-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.risk-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
}

.risk-meta {
  font-size: 10.5px;
  color: var(--text-mute);
}

.risk-advice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  flex-wrap: wrap;
}

.risk-reason {
  font-size: 10.5px;
  color: var(--text-mute);
  line-height: 1.45;
  flex: 1 1 160px;
}

.compare-section {
  margin-left: -10px;
  margin-right: -10px;
  padding-left: 10px;
  padding-right: 10px;
}

.compare-head {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text-mute);
  margin-bottom: 5px;
  flex-wrap: wrap;
}

.compare-head .accent {
  color: var(--accent-2);
}

.compare-summary {
  font-size: 11.5px;
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 5px;
  padding: 5px 7px;
  margin-bottom: 6px;
}

.compare-row .compare-scores {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-style: normal;
}

.compare-scores em {
  font-style: normal;
  min-width: 22px;
  text-align: center;
}

.compare-scores .arrow {
  color: var(--text-mute);
  font-size: 10.5px;
  min-width: 38px;
  text-align: center;
}

.s-safe {
  color: var(--ok);
}

.s-watch {
  color: var(--warn);
}

.s-high {
  color: var(--accent-2);
}

.s-critical {
  color: #ff5252;
}
</style>