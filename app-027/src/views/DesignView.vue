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
  assessProject,
  plansForHypothetical,
  RISK_COLORS,
  type ContourRisk,
  type RiskInput,
  type RiskLevel,
  type RiskReport,
} from '@/logic/dropRisk'

type Mode = 'outline' | 'toolpath' | 'bridge'
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
const showRisk = ref(true)

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

// 切换项目时清掉上一个项目的对照快照与筛选
watch(projectId, () => {
  snapshot.value = null
  riskFilter.value = 'all'
  selectedContourId.value = null
})

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

const selRisk = computed<ContourRisk | null>(() => {
  if (!selectedContourId.value) return null
  return riskReport.value?.items.find((i) => i.contourId === selectedContourId.value) ?? null
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

const riskInput = computed<RiskInput | null>(() => {
  const p = project.value
  if (!p || !settings.value) return null
  return {
    areaThresholdMm2: p.settings.areaThresholdMm2,
    bridgeWidthMm: p.settings.bridgeWidthMm,
    bridgeEveryMm: p.settings.bridgeEveryMm,
    bridgeRule: p.settings.bridgeRule,
    material: store.materialOf(p),
  }
})

/** 当前版试算：参数/几何/层级一变，computed 依赖（shapes、settings）触发立刻重算 */
const riskReport = computed<RiskReport | null>(() => {
  const p = project.value
  const input = riskInput.value
  if (!p || !input) return null
  // 所有改动入口（设置/绘图/手工连刀点/层级/材料）都已同步调用 recomputeProject
  return assessProject(shapes.value, computedMap.value, input)
})

/** 对照版快照（冻结当时的参数 + 几何/层级结构指纹 + 试算结论） */
type RiskSnapshot = {
  label: string
  at: number
  widthMm: number
  thresholdMm2: number
  rule: string
  report: RiskReport
}
const snapshot = ref<RiskSnapshot | null>(null)
const riskFilter = ref<'all' | RiskLevel>('all')

function takeSnapshot(): void {
  const p = project.value
  const r = riskReport.value
  const s = settings.value
  if (!p || !r || !s) return
  snapshot.value = {
    label: `宽 ${s.bridgeWidthMm}mm · 阈值 ${s.areaThresholdMm2}mm²`,
    at: Date.now(),
    widthMm: s.bridgeWidthMm,
    thresholdMm2: s.areaThresholdMm2,
    rule: s.bridgeRule,
    report: JSON.parse(JSON.stringify(r)) as RiskReport,
  }
}

function clearSnapshot(): void {
  snapshot.value = null
}

/** 对照版结论在「假设快照参数 + 当前几何」下重算：宽度/阈值改了可立刻看到差异 */
const compareReport = computed<RiskReport | null>(() => {
  const p = project.value
  const snap = snapshot.value
  if (!p || !snap) return null
  const input: RiskInput = {
    areaThresholdMm2: snap.thresholdMm2,
    bridgeWidthMm: snap.widthMm,
    bridgeEveryMm: p.settings.bridgeEveryMm,
    bridgeRule: snap.rule as RiskInput['bridgeRule'],
    material: store.materialOf(p),
  }
  const plans = plansForHypothetical(shapes.value, input)
  return assessProject(shapes.value, computedMap.value, input, plans)
})

const riskRows = computed(() => {
  const r = riskReport.value
  if (!r) return []
  const rows = riskFilter.value === 'all' ? r.items : r.items.filter((i) => i.level.level === riskFilter.value)
  return rows
})

const riskCounts = computed(() => {
  const items = riskReport.value?.items ?? []
  return {
    low: items.filter((i) => i.level.level === 'low').length,
    medium: items.filter((i) => i.level.level === 'medium').length,
    high: items.filter((i) => i.level.level === 'high').length,
    critical: items.filter((i) => i.level.level === 'critical').length,
  }
})

/** 同一片在两版之间的评分差（正 = 对照版更危险） */
function scoreDelta(item: ContourRisk): number | null {
  const other = compareReport.value?.items.find((x) => x.contourId === item.contourId && x.shapeId === item.shapeId)
  if (!other) return null
  return other.level.score - item.level.score
}

function locateRisk(item: ContourRisk): void {
  selectedShapeId.value = item.shapeId
  selectedContourId.value = item.contourId
  mode.value = 'outline'
  canvas.value?.focusContour(item.contourId)
}

function applySuggestedWidth(item: ContourRisk): void {
  const p = project.value
  if (!p) return
  // 取下限四舍五入到 0.05
  const w = Math.round((item.suggestion.widthLo / 0.05)) * 0.05
  store.applyRiskSuggestion(p, w)
}

function mergeRiskPiece(item: ContourRisk): void {
  const p = project.value
  if (!p) return
  if (!confirm(`把这片（${item.areaMm2.toFixed(2)}mm²）并入相邻轮廓？该镂空将从纹样中消失。`)) return
  const ok = store.mergeContourIntoParent(p, item.contourId)
  if (!ok) error.value = '该片没有可并入的相邻父轮廓（外轮廓不能并入）'
  else {
    error.value = ''
    selectedContourId.value = null
  }
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
        :risk-items="riskReport?.items ?? null"
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
          <template v-if="mode !== 'toolpath'">
            <span><i :style="{ background: RISK_COLORS.low }"></i>低危</span>
            <span><i :style="{ background: RISK_COLORS.medium }"></i>中危</span>
            <span><i :style="{ background: RISK_COLORS.high }"></i>高风险</span>
            <span><i :style="{ background: RISK_COLORS.critical }"></i>危险</span>
            <span style="color: var(--text-mute)">｜</span>
          </template>
          <span v-if="mode === 'outline'"><i style="background: #cfd9e4"></i>无风险轮廓</span>
          <span><i style="background: #ffc857"></i>未闭合</span>
          <span><i style="background: #ff6b6b"></i>自交</span>
          <span><i style="background: #b48cff"></i>重复路径</span>
          <span v-if="mode === 'toolpath'"><i style="background: #ff8f3c"></i>刀路</span>
          <span v-if="mode === 'toolpath'"><i style="background: #7f8fa3"></i>跳刀</span>
          <span v-if="mode === 'bridge'"><i style="background: #47c07a"></i>连刀点缺口</span>
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
            <span class="tag" :class="riskReport && riskReport.dropCount ? 'err' : 'ok'">{{ riskReport?.dropCount ?? 0 }} 片会掉</span>
            <span class="spacer"></span>
            <button class="tiny" @click.stop="takeSnapshot">存为对照版</button>
          </div>
          <div v-show="showRisk">
            <div v-if="!riskReport || riskReport.items.length === 0" class="empty">还没有闭合轮廓可评估，先导入纹样或绘制图形。</div>
            <template v-else>
              <!-- 总体结论 -->
              <div class="risk-summary" :class="riskReport.criticalCount ? 'crit' : riskReport.highCount ? 'high' : 'ok'">
                <div class="rs-head">
                  <strong>总体结论</strong>
                  <span class="tag" :class="riskReport.dropCount ? 'err' : 'ok'">会掉 {{ riskReport.dropCount }} 片</span>
                </div>
                <div class="rs-text">{{ riskReport.summary }}</div>
                <div class="rs-levels">
                  <span class="rl-chip" :class="{ active: riskFilter === 'critical' }" @click="riskFilter = riskFilter === 'critical' ? 'all' : 'critical'">
                    <i :style="{ background: RISK_COLORS.critical }"></i>危险 {{ riskCounts.critical }}
                  </span>
                  <span class="rl-chip" :class="{ active: riskFilter === 'high' }" @click="riskFilter = riskFilter === 'high' ? 'all' : 'high'">
                    <i :style="{ background: RISK_COLORS.high }"></i>高 {{ riskCounts.high }}
                  </span>
                  <span class="rl-chip" :class="{ active: riskFilter === 'medium' }" @click="riskFilter = riskFilter === 'medium' ? 'all' : 'medium'">
                    <i :style="{ background: RISK_COLORS.medium }"></i>中 {{ riskCounts.medium }}
                  </span>
                  <span class="rl-chip" :class="{ active: riskFilter === 'low' }" @click="riskFilter = riskFilter === 'low' ? 'all' : 'low'">
                    <i :style="{ background: RISK_COLORS.low }"></i>低 {{ riskCounts.low }}
                  </span>
                </div>
              </div>

              <!-- 两版对照 -->
              <div v-if="snapshot" class="cmp-bar">
                <div class="cmp-row">
                  <span class="cmp-cell cur">
                    当前<br /><span class="mono">宽 {{ settings?.bridgeWidthMm }}mm · 阈 {{ settings?.areaThresholdMm2 }}mm²</span><br />
                    会掉 <b :class="riskReport.dropCount ? 'err-text' : 'ok-text'">{{ riskReport.dropCount }}</b> 片
                  </span>
                  <span class="cmp-arrow">⇄</span>
                  <span class="cmp-cell snap">
                    对照版<br /><span class="mono">{{ snapshot.label }}</span><br />
                    会掉 <b :class="compareReport && compareReport.dropCount ? 'err-text' : 'ok-text'">{{ compareReport?.dropCount ?? '—' }}</b> 片
                  </span>
                </div>
                <div class="cmp-note" v-if="compareReport">
                  改参数后两版按当前几何即时重算；最危险片评分 {{ riskReport.worst?.level.score ?? '—' }} → {{ compareReport.worst?.level.score ?? '—' }}
                  <button class="tiny" @click="clearSnapshot">清除对照</button>
                </div>
              </div>

              <!-- 逐片列表 -->
              <div class="list risk-list">
                <div
                  v-for="item in riskRows"
                  :key="`${item.shapeId}-${item.contourId}`"
                  class="list-item risk-item"
                  :class="{ active: item.contourId === selectedContourId }"
                  @click="locateRisk(item)"
                >
                  <span class="risk-bar" :style="{ background: item.level.color }"></span>
                  <span class="grow">
                    <span class="ri-top">
                      <span class="tag" :style="{ color: item.level.color, borderColor: item.level.color + '66' }">{{ item.level.label }}</span>
                      <span class="ri-name">{{ item.shapeName }}</span>
                    </span>
                    <span class="ri-meta mono">
                      {{ item.areaMm2.toFixed(2) }}mm² · 细长{{ item.slenderness.toFixed(1) }} · L{{ item.depth }} ·
                      缺口 {{ item.gapCount }}×{{ item.appliedWidthMm.toFixed(2) }}mm
                    </span>
                    <span class="ri-sug">{{ item.suggestion.strategyText }}：{{ item.suggestion.widthLo }}~{{ item.suggestion.widthHi }}mm ×{{ item.suggestion.count }}</span>
                  </span>
                  <span class="ri-score">
                    <b :style="{ color: item.level.color }">{{ item.level.score }}</b>
                    <small v-if="scoreDelta(item) !== null" :class="(scoreDelta(item) as number) > 0 ? 'err-text' : (scoreDelta(item) as number) < 0 ? 'ok-text' : ''">
                      {{ (scoreDelta(item) as number) > 0 ? '+' : '' }}{{ scoreDelta(item) }}
                    </small>
                  </span>
                </div>
              </div>
            </template>
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
              <template v-if="selRisk">
                <div class="risk-detail" :class="`lvl-${selRisk.level.level}`">
                  <div class="rd-head">
                    <span class="tag" :style="{ color: selRisk.level.color, borderColor: selRisk.level.color + '66' }">{{ selRisk.level.label }}风险 · {{ selRisk.level.score }}/100</span>
                    <span class="hint">{{ selRisk.level.verdict }}</span>
                  </div>
                  <div class="rd-factors">
                    <div v-for="f in selRisk.factors" :key="f.key" class="rd-factor">
                      <span class="rd-flabel">{{ f.label }}</span>
                      <span class="rd-bar"><i :style="{ width: Math.min(100, Math.abs(f.points) * 3) + '%', background: f.dir === 'up' ? 'var(--err)' : 'var(--ok)' }"></i></span>
                      <span class="rd-fval mono">{{ f.points > 0 ? '+' : '' }}{{ f.points }}</span>
                    </div>
                  </div>
                  <div class="hint" style="margin: 5px 0 3px">{{ selRisk.suggestion.reason }}</div>
                  <div class="rd-suggest mono">
                    建议缺口 {{ selRisk.suggestion.widthLo }}~{{ selRisk.suggestion.widthHi }}mm × {{ selRisk.suggestion.count }} 个
                    <span v-if="selRisk.suggestion.mergeParentId">｜可并入轮廓 {{ selRisk.suggestion.mergeParentId.slice(-4) }}</span>
                  </div>
                  <div class="btn-row" style="margin-top: 6px">
                    <button class="tiny" @click="applySuggestedWidth(selRisk)">应用建议宽度（全局）</button>
                    <button class="tiny danger" :disabled="!selRisk.suggestion.mergeParentId" @click="mergeRiskPiece(selRisk)">并入相邻轮廓</button>
                  </div>
                </div>
              </template>
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

/* ---------- 掉落风险试算 ---------- */
.risk-summary {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 9px;
  margin-bottom: 8px;
  background: var(--panel-2);
}

.risk-summary.ok {
  border-color: rgba(71, 192, 122, 0.4);
}
.risk-summary.high {
  border-color: rgba(255, 143, 60, 0.5);
}
.risk-summary.crit {
  border-color: rgba(255, 77, 77, 0.55);
  background: rgba(255, 77, 77, 0.07);
}

.rs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 12px;
}

.rs-text {
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.55;
}

.rs-levels {
  display: flex;
  gap: 5px;
  margin-top: 7px;
  flex-wrap: wrap;
}

.rl-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 1px 7px;
  cursor: pointer;
  background: var(--bg-grid);
}

.rl-chip.active {
  border-color: var(--accent);
  color: var(--accent-2);
}

.rl-chip i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.cmp-bar {
  border: 1px dashed var(--line);
  border-radius: 6px;
  padding: 7px 8px;
  margin-bottom: 8px;
  background: var(--bg-grid);
}

.cmp-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  font-size: 11px;
}

.cmp-cell {
  flex: 1;
  border-radius: 5px;
  padding: 5px 7px;
  line-height: 1.5;
  border: 1px solid var(--line-soft);
}

.cmp-cell.cur {
  background: rgba(255, 143, 60, 0.08);
  border-color: rgba(255, 143, 60, 0.35);
}

.cmp-cell.snap {
  background: rgba(90, 169, 255, 0.07);
  border-color: rgba(90, 169, 255, 0.35);
}

.cmp-arrow {
  align-self: center;
  color: var(--text-mute);
}

.cmp-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 5px;
  font-size: 10.5px;
  color: var(--text-mute);
}

.err-text {
  color: var(--err);
}
.ok-text {
  color: var(--ok);
}

.risk-list {
  max-height: 290px;
  overflow: auto;
}

.risk-item {
  padding: 5px 7px 5px 0;
  gap: 0;
}

.risk-bar {
  width: 4px;
  align-self: stretch;
  border-radius: 2px 0 0 2px;
  margin-right: 7px;
  flex: 0 0 4px;
}

.ri-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ri-name {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ri-meta {
  display: block;
  font-size: 10.5px;
  color: var(--text-mute);
  margin-top: 1px;
}

.ri-sug {
  display: block;
  font-size: 10.5px;
  color: var(--text-dim);
  margin-top: 1px;
}

.ri-score {
  margin-left: 6px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.1;
}

.ri-score b {
  font-family: var(--mono);
  font-size: 15px;
}

.ri-score small {
  font-family: var(--mono);
  font-size: 10px;
}

.risk-detail {
  margin-top: 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 8px;
  background: var(--panel-2);
}

.rd-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 5px;
}

.rd-factors {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rd-factor {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
}

.rd-flabel {
  flex: 0 0 56px;
  color: var(--text-mute);
}

.rd-bar {
  flex: 1 1 auto;
  height: 5px;
  background: var(--bg-grid);
  border-radius: 3px;
  overflow: hidden;
}

.rd-bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
}

.rd-fval {
  flex: 0 0 30px;
  text-align: right;
  color: var(--text-dim);
}

.rd-suggest {
  font-size: 11px;
  color: var(--accent-2);
}
</style>