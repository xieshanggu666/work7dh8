<script setup>
import { ref, computed, reactive } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const INCIDENT_TYPES = [
  { k: 'fire', name: '火情火灾', icon: '🔥', locs: ['ride', 'zone', 'park'] },
  { k: 'stampede', name: '人群踩踏', icon: '👣', locs: ['zone', 'park'] },
  { k: 'injury', name: '游客受伤', icon: '🩹', locs: ['ride', 'zone'] },
  { k: 'ride', name: '设施事故', icon: '🎢', locs: ['ride'] },
  { k: 'blackout', name: '停电故障', icon: '⚡', locs: ['ride', 'zone', 'park'] },
  { k: 'food', name: '食物中毒', icon: '🤢', locs: ['zone'] },
  { k: 'weather', name: '极端天气', icon: '⛈️', locs: ['park'] },
  { k: 'lost', name: '儿童走失', icon: '🧒', locs: ['zone', 'park'] },
  { k: 'security', name: '治安事件', icon: '🚨', locs: ['zone', 'park'] }
]
const LEVELS = {
  1: { name: 'Ⅳ级', alias: '一般' }, 2: { name: 'Ⅲ级', alias: '较大' },
  3: { name: 'Ⅱ级', alias: '重大' }, 4: { name: 'Ⅰ级', alias: '特别重大' }
}
const FLOW_STEPS = ['发现上报', '研判分级', '封控布设', '游客疏散', '现场控制', '复园开放', '复盘结案']
const REPORTER_ROLES = [
  { k: 'guest', name: '游客报警' }, { k: 'security', name: '安保巡逻' },
  { k: 'ops', name: '运营巡查' }, { k: 'maintenance', name: '维修报事' },
  { k: 'service', name: '客服上报' }
]
const ACTION_LABEL = {
  report: '发现上报', grade: '研判分级', lockdown: '启动封控', evacuate: '下达疏散',
  contain: '现场控制', reopen: '复园开放', review: '复盘结案', cancel: '撤销',
  false_alarm: '虚惊结案', compensate: '统一补偿', auto_escalate: '超时自动升级',
  task_create: '任务下达', task_assign: '任务派工', task_done: '任务完成', task_release: '任务退回'
}

const tabs = [
  { k: 'open', label: '处置中' },
  { k: 'review', label: '待复盘/补偿' },
  { k: 'closed', label: '已结案' },
  { k: 'all', label: '全部' }
]
const tab = ref('open')
const OPEN = ['reported', 'grading', 'locked', 'evacuating', 'contained', 'reviewing']
const list = computed(() => {
  const all = store.emergencies
  if (tab.value === 'open') return all.filter(e => OPEN.includes(e.status))
  if (tab.value === 'review') return all.filter(e => ['contained', 'reviewing'].includes(e.status))
  if (tab.value === 'closed') return all.filter(e => !OPEN.includes(e.status))
  return all
})

const stats = computed(() => store.emergencyStats)
const lvCls = lv => (lv >= 4 ? 'lv4' : lv === 3 ? 'lv3' : lv === 2 ? 'lv2' : 'lv1')

// ---- 详情 ----
const detail = ref(null)
const detailLogs = ref([])
const taskPicks = reactive({})   // taskId -> staffId
async function openDetail(e) {
  const r = await store.emergencyDetail(e.id)
  if (r?.incident) { detail.value = r.incident; detailLogs.value = r.logs || [] }
}
function closeDetail() { detail.value = null }
function refreshDetail() { if (detail.value) openDetail(detail.value) }

const supervisors = computed(() => store.staff.filter(s => s.active && s.role === '运营主管'))
const allActiveStaff = computed(() => store.staff.filter(s => s.active))
function staffText(s) { return `${s.name} · ${s.role} · Lv.${s.skill}${s.morale < 45 ? ' · 低士气' : ''}` }
function assignableTasks(roles) {
  return allActiveStaff.value.filter(s => roles.split('/').includes(s.role))
}
async function doAction(fn, ...args) {
  const r = await fn(...args)
  if (r?.ok) await store.refresh()
  return r
}
async function assignT(t) {
  const sid = taskPicks[t.id]
  if (!sid) return
  const r = await store.assignEmergencyTask(t.id, sid)
  if (r?.ok) { await store.refresh(); refreshDetail() }
  taskPicks[t.id] = undefined
}

// ---- 分级 ----
const gradeForm = reactive({ level: 2, commander_id: null, affected: '', injured: '', perGuest: '', note: '' })
function initGrade(e) {
  gradeForm.level = e.suggested_level || 2
  gradeForm.commander_id = e.commander_id || supervisors.value[0]?.id || null
  gradeForm.affected = e.affected_guests || ''
  gradeForm.injured = e.injured_guests || ''
  gradeForm.perGuest = e.comp_per_guest || store.emergencyConfig.compDefault[gradeForm.level] || 100
  gradeForm.note = ''
}
async function submitGrade(e) {
  const r = await doAction(store.gradeEmergency, e.id, {
    level: gradeForm.level,
    commander_id: gradeForm.commander_id,
    affected_guests: gradeForm.affected === '' ? undefined : Number(gradeForm.affected),
    injured_guests: gradeForm.injured === '' ? undefined : Number(gradeForm.injured),
    comp_per_guest: gradeForm.perGuest === '' ? undefined : Number(gradeForm.perGuest),
    note: gradeForm.note
  })
  if (r?.ok) refreshDetail()
}

// ---- 补偿 ----
const compForm = reactive({ qty: '', perGuest: '' })
function initComp(e) {
  compForm.qty = e.comp_remaining
  compForm.perGuest = e.comp_per_guest
}
const compCost = computed(() => Math.max(0, Math.round(Number(compForm.qty) || 0)) * Math.max(0, Math.round(Number(compForm.perGuest) || 0)))
async function submitComp(e) {
  const r = await doAction(store.compensateEmergency, e.id, { qty: Number(compForm.qty), per_guest: Number(compForm.perGuest) })
  if (r?.ok) { refreshDetail() }
  return r
}

// ---- 复盘 ----
const reviewForm = reactive({ rating: 0, cause: '', actions: '' })
function initReview(e) {
  reviewForm.rating = 0
  reviewForm.cause = ''
  reviewForm.actions = ''
}
async function submitReview(e) {
  if (!reviewForm.cause.trim()) return { ok: false, msg: '请填写事故原因分析' }
  const r = await doAction(store.reviewEmergency, e.id, {
    rating: reviewForm.rating || undefined, cause: reviewForm.cause, actions: reviewForm.actions
  })
  if (r?.ok) refreshDetail()
  return r
}

// ---- 新建上报 ----
const blankReport = () => ({
  type: 'fire', location_type: 'ride', location_id: '',
  reporter_role: 'guest', guest_name: '', guest_phone: '', title: '', desc: ''
})
const report = ref(blankReport())
const reportMsg = ref('')
const reportOpen = ref(false)
const locOptions = computed(() => {
  const t = INCIDENT_TYPES.find(x => x.k === report.value.type)
  return { ride: store.rides, zone: store.zones.filter(z => z.unlocked), park: [] }
})
function onTypeChange() {
  const t = INCIDENT_TYPES.find(x => x.k === report.value.type)
  if (!t.locs.includes(report.value.location_type)) report.value.location_type = t.locs[0]
  report.value.location_id = ''
}
async function submitReport() {
  const r = await store.reportEmergency({
    type: report.value.type,
    location_type: report.value.location_type,
    location_id: report.value.location_id || undefined,
    reporter_role: report.value.reporter_role,
    guest_name: report.value.guest_name,
    guest_phone: report.value.guest_phone,
    title: report.value.title,
    desc: report.value.desc
  })
  if (r?.ok) {
    reportMsg.value = `已上报 ${r.code}，请尽快研判分级`
    report.value = blankReport()
    reportOpen.value = false
  } else {
    reportMsg.value = r?.msg || '上报失败'
  }
}
function toggleAuto() {
  store.saveEmergencyConfig({ enabled: store.emergencyConfig.enabled ? 0 : 1 })
}

const gatesDone = (tasks, gate) => tasks.filter(t => t.gate === gate && t.status === 'done').length
const gatesTotal = (tasks, gate) => tasks.filter(t => t.gate === gate).length
</script>

<template>
  <div class="em">
    <div class="stat-grid">
      <div class="card stat" :class="{ alert: stats.open }">
        <span>🚨</span><b>{{ stats.open }}</b><em>处置中事件</em>
      </div>
      <div class="card stat" :class="{ alert: stats.tasksPending }">
        <span>🦺</span><b>{{ stats.tasksPending }}</b><em>进行中应急任务</em>
      </div>
      <div class="card stat"><span>👥</span><b>{{ stats.affectedActive }}</b><em>当前受影响游客</em></div>
      <div class="card stat"><span>🏃</span><b>{{ stats.evacuatedActive }}</b><em>已疏散</em></div>
      <div class="card stat" :class="{ alert: stats.injuredActive }">
        <span>🩹</span><b class="neg">{{ stats.injuredActive }}</b><em>受伤送医</em>
      </div>
      <div class="card stat"><span class="money">¥</span><b class="money neg">{{ stats.rescueToday.toLocaleString() }}</b><em>今日救援处置费</em></div>
      <div class="card stat"><span class="money">¥</span><b class="money neg">{{ stats.compToday.toLocaleString() }}</b><em>今日应急补偿金</em></div>
      <div class="card stat"><span>⭐</span><b>{{ stats.avgRating || '—' }}</b><em>复盘平均处置评价</em></div>
    </div>

    <div class="head-row">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
      </div>
      <div class="head-actions">
        <label class="switch">
          <input type="checkbox" :checked="store.emergencyConfig.enabled === 1" @change="toggleAuto" />
          <span>系统监测（随机安全事件）</span>
        </label>
        <button class="primary" @click="reportOpen = true; reportMsg = ''">📢 上报安全事件</button>
      </div>
    </div>

    <div class="elist">
      <div v-for="e in list" :key="e.id" class="eitem card" :class="[lvCls(e.level || e.suggested_level), { closed: !OPEN.includes(e.status) }]">
        <div class="ei-head">
          <span class="big-ic">{{ e.type_icon }}</span>
          <div class="ei-title">
            <b>{{ e.title }}</b>
            <em class="muted">{{ e.code }} · 第{{ e.report_day }}天 · {{ e.reporter_name }} · 定位 {{ e.location_name }}</em>
          </div>
          <span class="badge lv" :class="lvCls(e.level || e.suggested_level)">{{ e.level ? e.level_name : `建议${LEVELS[e.suggested_level].name}` }}</span>
          <span class="badge" :class="e.status_cls">{{ e.status_name }}</span>
          <span class="badge" v-if="e.source === 'auto'">系统监测</span>
          <button class="ghost sm" @click="openDetail(e)">指挥台</button>
        </div>

        <!-- 状态流转条 -->
        <div class="flow" v-if="e.step >= 0">
          <template v-for="(s, i) in FLOW_STEPS" :key="i">
            <span class="fnode" :class="{ done: i <= e.step, skip: (i === 3 && !e.has_evac_task && e.step > 3) }">
              <i>{{ i <= e.step ? '✓' : i + 1 }}</i><em>{{ s }}</em>
            </span>
            <b v-if="i < FLOW_STEPS.length - 1" class="fline" :class="{ done: i < e.step }"></b>
          </template>
        </div>

        <div class="ei-meta">
          <span v-if="e.commander_name">👮 总指挥 {{ e.commander_name }}（{{ e.commander_role }}）</span>
          <span>👥 受影响 {{ e.affected_guests }} 人</span>
          <span v-if="e.injured_guests" class="neg">🩹 伤 {{ e.injured_guests }} 人</span>
          <span v-if="e.evacuated_guests">🏃 已疏散 {{ e.evacuated_guests }} 人</span>
          <span v-if="e.rides_locked">🎢 停运 {{ e.rides_locked }} 项</span>
          <span v-if="e.refund_amount" class="money neg">↩️ 退款 ¥{{ e.refund_amount.toLocaleString() }}</span>
          <span v-if="e.comp_amount" class="money neg">💸 补偿 ¥{{ e.comp_amount.toLocaleString() }}（{{ e.comp_guests }}/{{ e.affected_guests }}人）</span>
          <span v-if="e.escalations" class="neg">⚠️ 自动升级 {{ e.escalations }} 次</span>
          <span v-if="e.rating">复盘 {{ '★'.repeat(e.rating) }}<span class="dim">{{ '★'.repeat(5 - e.rating) }}</span></span>
        </div>

        <!-- 快捷操作（列表内） -->
        <div class="ei-actions">
          <button v-if="['reported', 'grading'].includes(e.status) && !e.level" class="warn" @click="openDetail(e); initGrade(e)">研判分级</button>
          <button v-if="e.status === 'grading'" class="danger" @click="openDetail(e)">启动封控</button>
          <button v-if="e.status === 'locked' && e.has_evac_task" class="warn" @click="doAction(store.evacuateEmergency, e.id).then(() => refreshDetail())">📢 下达疏散</button>
          <button v-if="(e.status === 'evacuating') || (e.status === 'locked' && !e.has_evac_task)" class="succ" @click="openDetail(e)">✅ 现场控制</button>
          <button v-if="e.status === 'contained'" class="primary" @click="openDetail(e); initComp(e)">💸 统一补偿</button>
          <button v-if="e.status === 'contained'" class="ghost" @click="openDetail(e)">🔓 复园</button>
          <button v-if="e.status === 'reviewing'" class="succ" @click="openDetail(e); initReview(e)">📝 复盘结案</button>
          <button v-if="['reported', 'grading'].includes(e.status)" class="ghost" @click="openDetail(e)">核实/撤销</button>
        </div>
      </div>
      <div v-if="!list.length" class="muted empty">暂无事件。园区安全平稳 🎉 （可通过右上角「上报安全事件」发起应急演练）</div>
    </div>

    <!-- 指挥台详情 -->
    <div class="mask" v-if="detail" @click.self="closeDetail">
      <div class="dialog card">
        <h3>
          {{ detail.type_icon }} {{ detail.title }}
          <span class="badge lv" :class="lvCls(detail.level || detail.suggested_level)">{{ detail.level ? detail.level_name : `建议${LEVELS[detail.suggested_level].name}` }}</span>
          <span class="badge" :class="detail.status_cls">{{ detail.status_name }}</span>
          <button class="ghost x" @click="closeDetail">✕</button>
        </h3>
        <p class="content">{{ detail.desc || '（无补充描述）' }}</p>
        <div class="d-meta muted">
          {{ detail.code }} · 第{{ detail.report_day }}天 {{ detail.reporter_name }} · 定位 {{ detail.location_name }}
          <span v-if="detail.commander_name"> · 总指挥 {{ detail.commander_name }}（{{ detail.commander_role }}）</span>
        </div>

        <!-- 流转条 -->
        <div class="flow big" v-if="detail.step >= 0">
          <template v-for="(s, i) in FLOW_STEPS" :key="i">
            <span class="fnode" :class="{ done: i <= detail.step, skip: (i === 3 && !detail.has_evac_task && detail.step > 3) }">
              <i>{{ i <= detail.step ? '✓' : i + 1 }}</i><em>{{ s }}</em>
            </span>
            <b v-if="i < FLOW_STEPS.length - 1" class="fline" :class="{ done: i < detail.step }"></b>
          </template>
        </div>

        <!-- 经营联动汇总 -->
        <div class="link-grid">
          <div><em>受影响</em><b>{{ detail.affected_guests }} 人</b></div>
          <div><em>受伤送医</em><b :class="{ neg: detail.injured_guests }">{{ detail.injured_guests }} 人</b></div>
          <div><em>已疏散</em><b>{{ detail.evacuated_guests }} 人</b></div>
          <div><em>停运设施</em><b>{{ detail.links.rides }} 项</b></div>
          <div><em>关闭区域</em><b>{{ detail.links.zones }} 处</b></div>
          <div><em>归集投诉</em><b>{{ detail.links.complaints.length }} 件</b></div>
          <div><em>救援成本</em><b class="money neg">¥{{ detail.rescue_cost.toLocaleString() }}</b></div>
          <div><em>停运退款</em><b class="money neg">¥{{ detail.refund_amount.toLocaleString() }}</b></div>
          <div><em>已发补偿</em><b class="money neg">¥{{ detail.comp_amount.toLocaleString() }}（{{ detail.comp_guests }}人）</b></div>
        </div>

        <!-- ① 分级表单 -->
        <div class="block" v-if="['reported', 'grading'].includes(detail.status) && !detail.level">
          <h4>① 值班主管研判分级</h4>
          <div class="form">
            <label>事件等级
              <select v-model.number="gradeForm.level" @change="gradeForm.perGuest = store.emergencyConfig.compDefault[gradeForm.level]">
                <option v-for="(l, k) in LEVELS" :key="k" :value="Number(k)">{{ l.name }}（{{ l.alias }}） · 救援成本 ¥{{ store.emergencyConfig.rescueCost[k] }} · 补偿建议 ¥{{ store.emergencyConfig.compDefault[k] }}/人</option>
              </select>
            </label>
            <label>现场指挥
              <select v-model.number="gradeForm.commander_id">
                <option v-for="s in supervisors" :key="s.id" :value="s.id">{{ staffText(s) }}</option>
              </select>
            </label>
            <label>受影响游客
              <input v-model="gradeForm.affected" type="number" min="0" :placeholder="detail.affected_guests || '自动估算'" />
            </label>
            <label>受伤人数
              <input v-model="gradeForm.injured" type="number" min="0" :placeholder="detail.injured_guests || 0" />
            </label>
            <label>单人补偿建议（¥）
              <input v-model="gradeForm.perGuest" type="number" min="0" />
            </label>
            <label class="full">研判意见
              <input v-model="gradeForm.note" placeholder="风险源、波及范围、处置要点……" />
            </label>
          </div>
          <div class="row-actions">
            <button class="warn" :disabled="!gradeForm.commander_id" @click="submitGrade(detail)">确认分级</button>
            <button class="ghost" @click="store.cancelEmergency(detail.id, { false_alarm: true }).then(r => r?.ok && closeDetail())">虚惊结案</button>
            <button class="ghost danger" @click="store.cancelEmergency(detail.id, { false_alarm: false }).then(r => r?.ok && closeDetail())">撤销事件</button>
          </div>
        </div>

        <!-- ② 封控 / ③ 疏散 -->
        <div class="block" v-if="detail.status === 'grading'">
          <h4>② 启动封控</h4>
          <p class="muted tip">封控将联动：涉事设施立即停运并全额退还在途预约（团行程自动重排/退款）、关闭涉事区域、归集相关投诉、按等级结算救援处置费、下达封控/救援/抢修等应急任务。</p>
          <div class="row-actions">
            <button class="danger" @click="store.lockdownEmergency(detail.id).then(r => r?.ok && refreshDetail())">🚧 立即封控</button>
          </div>
        </div>

        <div class="block" v-if="detail.status === 'locked' && detail.has_evac_task">
          <h4>③ 下达游客疏散</h4>
          <p class="muted tip">广播疏散指令，现场安保引导约 {{ detail.affected_guests }} 名游客撤离至集结点；疏散任务完成后人数自动回填。</p>
          <div class="row-actions">
            <button class="warn" @click="store.evacuateEmergency(detail.id).then(r => r?.ok && refreshDetail())">📢 广播疏散</button>
          </div>
        </div>

        <!-- 应急任务（派工/进度） -->
        <div class="block" v-if="detail.tasks.length">
          <h4>🦺 应急任务调度 <em class="muted">（岗位匹配 1.5 倍效率；须当日有排班，到岗后自动推进；每人同时只领 1 项）</em></h4>
          <div class="tasks">
            <div v-for="t in detail.tasks" :key="t.id" class="task" :class="t.status">
              <div class="t-head">
                <span>{{ t.kind_icon }} {{ t.name }}</span>
                <span class="muted">{{ t.code }} · {{ t.roles }} · <i :class="t.gate === 'reopen' ? 'gate2' : 'gate1'">{{ t.gate === 'reopen' ? '复园前置' : '封控前置' }}</i></span>
                <span class="badge" :class="t.status === 'done' ? 'st-done' : t.status === 'processing' ? 'st-processing' : 'st-open'">
                  {{ t.status === 'done' ? '已完成' : t.status === 'processing' ? '执行中' : '待派工' }}
                </span>
              </div>
              <div class="pbar" v-if="t.status !== 'done'"><i :style="{ width: t.progress + '%' }"></i><b>{{ Math.round(t.progress) }}%</b></div>
              <div class="t-foot">
                <template v-if="t.assignee">
                  👷 {{ t.assignee.name }}（{{ t.assignee.role }}）
                  <i :class="t.role_match ? 'match' : 'mismatch'">{{ t.role_match ? '岗位匹配' : '岗位不符' }}</i>
                </template>
                <span v-else class="muted">待派工</span>
                <span v-if="t.status !== 'done'" class="assign">
                  <select v-model.number="taskPicks[t.id]">
                    <option :value="undefined" disabled>选择执行人…</option>
                    <option v-for="s in assignableTasks(t.roles)" :key="s.id" :value="s.id">{{ staffText(s) }}</option>
                  </select>
                  <button class="succ sm" :disabled="!taskPicks[t.id]" @click="assignT(t)">派工</button>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- ④ 现场控制 -->
        <div class="block" v-if="(detail.status === 'evacuating') || (detail.status === 'locked' && !detail.has_evac_task)">
          <h4>④ 宣布现场控制</h4>
          <p class="muted tip">
            封控前置任务 {{ gatesDone(detail.tasks, 'contain') }}/{{ gatesTotal(detail.tasks, 'contain') }} 完成；
            全部完成后可宣布现场控制，并自动生成「复园前安全巡验」任务。
          </p>
          <div class="row-actions">
            <button class="succ" @click="store.containEmergency(detail.id).then(r => { if (r?.ok) refreshDetail(); else alert(r.msg || '操作失败') })">✅ 现场已控制</button>
          </div>
        </div>

        <!-- ⑤ 统一补偿 -->
        <div class="block" v-if="['contained', 'reviewing'].includes(detail.status) && detail.comp_remaining > 0">
          <h4>⑤ 游客统一补偿 <em class="muted">（剩余 {{ detail.comp_remaining }} 人，可分批）</em></h4>
          <div class="form inline">
            <label>本次人数<input v-model.number="compForm.qty" type="number" min="1" :max="detail.comp_remaining" @focus="initComp(detail)" /></label>
            <label>单人 ¥<input v-model.number="compForm.perGuest" type="number" min="0" /></label>
            <button class="primary" @click="submitComp(detail).then(r => { if (!r?.ok) alert(r?.msg || '补偿失败') })">发放 ¥{{ compCost.toLocaleString() }}</button>
          </div>
        </div>

        <!-- ⑥ 复园 -->
        <div class="block" v-if="detail.status === 'contained'">
          <h4>⑥ 复园核验与开放</h4>
          <p class="muted tip">
            复园前置任务 {{ gatesDone(detail.tasks, 'reopen') }}/{{ gatesTotal(detail.tasks, 'reopen') }} 完成；
            完成后解除封控、恢复停运设施运营并重开预约时段、开放关闭区域。
          </p>
          <div class="row-actions">
            <button class="ghost" @click="store.reopenEmergency(detail.id).then(r => { if (r?.ok) refreshDetail(); else alert(r.msg || '复园失败') })">🔓 复园开放</button>
          </div>
        </div>

        <!-- ⑦ 复盘 -->
        <div class="block" v-if="detail.status === 'reviewing'">
          <h4>⑦ 事故复盘结案</h4>
          <div class="form">
            <label class="full">事故原因分析<textarea v-model="reviewForm.cause" rows="2" placeholder="直接原因 / 管理原因 / 设施或流程缺陷……"></textarea></label>
            <label class="full">整改措施<textarea v-model="reviewForm.actions" rows="2" placeholder="设施整改、预案修订、岗位培训、巡查加频……"></textarea></label>
            <label>综合处置评价（留空自动评定）
              <select v-model.number="reviewForm.rating">
                <option :value="0">系统自动评定</option>
                <option v-for="n in 5" :key="n" :value="n">{{ '★'.repeat(n) }}</option>
              </select>
            </label>
          </div>
          <div class="row-actions">
            <button class="succ" @click="submitReview(detail).then(r => { if (!r?.ok) alert(r?.msg || '复盘失败') })">提交复盘并结案</button>
          </div>
        </div>

        <!-- 结案信息 -->
        <div class="block result" v-if="!OPEN.includes(detail.status)">
          <div v-if="detail.status === 'reopened'">
            <b class="pos">✅ 已复园并复盘结案</b> · 综合评价 <b class="stars">{{ '★'.repeat(detail.rating) }}<span class="dim">{{ '★'.repeat(5 - detail.rating) }}</span></b>
            <p class="muted" v-if="detail.review_cause">原因：{{ detail.review_cause }}</p>
            <p class="muted" v-if="detail.review_actions">整改：{{ detail.review_actions }}</p>
          </div>
          <div v-else><b class="muted">{{ detail.status === 'false_alarm' ? '🛎️ 虚惊结案：经现场核实未造成实际影响' : '事件已撤销' }}</b></div>
        </div>

        <!-- 时间线 -->
        <h4 class="tl-title">处理时间线</h4>
        <div class="logs">
          <div v-for="l in detailLogs" :key="l.id" class="log">
            <span class="dot"></span>
            <b>{{ ACTION_LABEL[l.action] || l.action }}</b>
            <em class="muted">第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 上报弹层 -->
    <div class="mask" v-if="reportOpen" @click.self="reportOpen = false">
      <div class="dialog card narrow">
        <h3>📢 安全事件上报 <button class="ghost x" @click="reportOpen = false">✕</button></h3>
        <div class="rtypes">
          <button v-for="t in INCIDENT_TYPES" :key="t.k" :class="{ on: report.type === t.k }" @click="report.type = t.k; onTypeChange()">
            <span>{{ t.icon }}</span><em>{{ t.name }}</em>
          </button>
        </div>
        <div class="form">
          <label>上报角色
            <select v-model="report.reporter_role">
              <option v-for="r in REPORTER_ROLES" :key="r.k" :value="r.k">{{ r.name }}</option>
            </select>
          </label>
          <label>事发位置
            <select v-model="report.location_type" @change="report.location_id = ''">
              <option value="park">全园</option>
              <option value="zone">指定区域</option>
              <option value="ride" :disabled="!INCIDENT_TYPES.find(t => t.k === report.type)?.locs.includes('ride')">指定设施</option>
            </select>
          </label>
          <select v-if="report.location_type !== 'park'" v-model.number="report.location_id">
            <option :value="''" disabled>请选择…</option>
            <option v-for="o in (report.location_type === 'ride' ? locOptions.ride : locOptions.zone)" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
          <label v-if="report.reporter_role === 'guest'">联系人姓名<input v-model="report.guest_name" placeholder="游客/家长（可选）" /></label>
          <label v-if="report.reporter_role === 'guest'">联系电话<input v-model="report.guest_phone" placeholder="一键报警回拨号码（可选）" /></label>
          <label class="full">事件标题<input v-model="report.title" placeholder="如：排队区护栏挤压疑似伤人" /></label>
          <label class="full">现场描述<textarea v-model="report.desc" rows="3" maxlength="300" placeholder="时间、位置、现象、人数、已采取的初步措施……"></textarea></label>
        </div>
        <div class="row-actions">
          <button class="danger" @click="submitReport">🚨 立即上报</button>
          <em v-if="reportMsg" class="muted">{{ reportMsg }}</em>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.em { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat.alert { border-color: rgba(255,107,107,.55); }
.neg { color: var(--red); }
.pos { color: var(--green); }
.money { color: var(--green); font-style: normal; }
.money.neg { color: var(--red); }

.head-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.tabs { display: flex; gap: 6px; }
.tabs button { padding: 5px 14px; font-size: 12px; }
.tabs button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.head-actions { display: flex; gap: 10px; align-items: center; }
.switch { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; cursor: pointer; }

.elist { display: flex; flex-direction: column; gap: 10px; }
.eitem { padding: 12px 14px; border-left-width: 3px; border-left-style: solid; }
.eitem.lv1 { border-left-color: var(--blue); }
.eitem.lv2 { border-left-color: var(--accent2); }
.eitem.lv3 { border-left-color: #ff8c42; }
.eitem.lv4 { border-left-color: var(--red); }
.eitem.closed { opacity: .85; }
.ei-head { display: flex; align-items: center; gap: 10px; }
.big-ic { font-size: 22px; }
.ei-title { flex: 1; min-width: 0; }
.ei-title b { display: block; font-size: 14px; }
.ei-title em { font-style: normal; font-size: 11px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); white-space: nowrap; }
.badge.lv.lv1 { color: var(--blue); border-color: rgba(102,166,255,.5); }
.badge.lv.lv2 { color: var(--accent2); border-color: rgba(255,209,102,.5); }
.badge.lv.lv3 { color: #ff8c42; border-color: rgba(255,140,66,.55); }
.badge.lv.lv4 { color: #fff; background: var(--red); border-color: var(--red); }
.st-open { color: var(--accent2) !important; }
.st-ready { color: var(--purple) !important; }
.st-processing { color: var(--blue) !important; }
.st-done { color: var(--green) !important; }
.st-bad { color: var(--muted) !important; }
.ghost.sm { padding: 4px 10px; font-size: 12px; }

/* 流转条 */
.flow { display: flex; align-items: center; margin: 12px 2px 8px; }
.flow.big { margin: 14px 0; }
.fnode { display: flex; flex-direction: column; align-items: center; gap: 3px; flex-shrink: 0; }
.fnode i { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); font-style: normal; font-size: 11px; display: flex; align-items: center; justify-content: center; font-weight: 700; }
.fnode em { font-style: normal; font-size: 10px; color: var(--muted); white-space: nowrap; }
.fnode.done i { background: var(--green); border-color: var(--green); color: #06121f; }
.fnode.done em { color: var(--green); }
.fnode.skip i { opacity: .35; }
.fnode.skip em { text-decoration: line-through; opacity: .55; }
.fline { flex: 1; height: 2px; background: var(--border); margin: 0 4px; align-self: flex-start; margin-top: 11px; min-width: 14px; }
.fline.done { background: var(--green); }

.ei-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); margin: 6px 0; }
.ei-meta .dim { color: #3a4366; }
.ei-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.ei-actions button { font-size: 12px; padding: 6px 12px; }
.empty { padding: 28px; text-align: center; }

/* 弹层 */
.mask { position: fixed; inset: 0; background: rgba(5,8,18,.65); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(760px, 100%); max-height: 88vh; overflow-y: auto; position: relative; }
.dialog.narrow { width: min(560px, 100%); }
.dialog h3 { position: sticky; top: -18px; background: linear-gradient(180deg, var(--panel) 70%, transparent); padding: 4px 0 10px; z-index: 1; display: flex; align-items: center; gap: 8px; }
.dialog .x { margin-left: auto; }
.content { font-size: 13px; margin: 8px 0; }
.d-meta { font-size: 12px; }

.link-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 12px 0; }
.link-grid div { background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.link-grid em { font-style: normal; font-size: 11px; color: var(--muted); }
.link-grid b { font-size: 15px; }

.block { border-top: 1px dashed var(--border); padding-top: 12px; margin-top: 12px; }
.block h4 { font-size: 13px; margin-bottom: 8px; }
.block h4 em { font-weight: normal; font-size: 11px; }
.tip { font-size: 12px; line-height: 1.6; margin-bottom: 8px; }
.row-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row-actions em { font-size: 12px; }

.form { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.form.inline { grid-template-columns: 1fr 1fr auto; align-items: end; }
.form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.form label.full { grid-column: 1 / -1; }
.form input, .form select, .form textarea { font-family: inherit; }

.tasks { display: flex; flex-direction: column; gap: 8px; }
.task { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: rgba(255,255,255,.02); }
.task.done { opacity: .75; }
.t-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; }
.t-head .muted { font-size: 11px; }
.gate1 { font-style: normal; color: var(--accent2); }
.gate2 { font-style: normal; color: var(--purple); }
.pbar { position: relative; height: 16px; background: var(--panel2); border-radius: 8px; overflow: hidden; margin: 6px 0; }
.pbar i { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--purple)); }
.pbar b { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; }
.t-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.t-foot .assign { display: flex; gap: 6px; align-items: center; }
.t-foot select { font-size: 12px; }
button.sm { padding: 4px 10px; font-size: 12px; }
.match { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 12px; background: rgba(109,213,160,.15); color: var(--green); }
.mismatch { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 12px; background: rgba(255,107,107,.15); color: var(--red); }

.result { background: var(--panel2); border-radius: 8px; padding: 10px 12px; }
.result p { font-size: 12px; margin-top: 6px; }
.stars { color: var(--accent2); letter-spacing: 1px; }
.stars .dim { color: #3a4366; }

.tl-title { margin: 16px 0 10px; font-size: 13px; }
.logs { display: flex; flex-direction: column; }
.log { position: relative; padding: 0 0 14px 18px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .dot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; }
.log p { font-size: 12px; margin-top: 2px; }

.rtypes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 10px 0; }
.rtypes button { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 2px; }
.rtypes button.on { border-color: var(--accent); background: rgba(255,107,107,.14); }
.rtypes span { font-size: 18px; }
.rtypes em { font-style: normal; font-size: 11px; color: var(--muted); }
</style>
