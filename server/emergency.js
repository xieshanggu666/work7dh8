import db, { getSetting, setSetting, tx } from './db.js'

// 园区应急指挥模块：安全事件 发现上报 → 定级 → 封控 → 疏散 → 控制 → 复园 → 复盘 状态流转
// 联动：事件中心 / 设施停运（预约时段关停+在途退款+团行程） / 投诉与统一补偿 /
//       岗位调度（安保/维修/保洁应急任务，排班在岗门控） / 财务（救援处置费与补偿）
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 由 index.js 注入共享上下文（时钟/现金/财务/声誉/停运联动/投诉建单/排班校验/完工回写/动态调度）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  reputation: () => num(getSetting('reputation'), 70),
  setReputation: (v) => setSetting('reputation', Math.round(Math.max(5, Math.min(100, v)) * 10) / 10),
  logFinance: null,
  syncRideSlots: null,       // 设施停运/恢复：关停或重开预约时段（在途退款/团行程重排）
  createComplaint: null,     // 投诉建单（复用投诉补救模块）
  staffDutyState: null,      // 派工前排班在岗校验
  onWorkComplete: null,      // 复盘时完工回写排班工时满意度
  dispatchAfter: null,       // 事件/任务变化联动动态岗位调度
  requestRepair: null        // 复园后事故设施转检修工单（由 index.js 注入 maintenance.createMaintenanceOrder）
}
export function initEmergencyContext(deps) {
  Object.assign(ctx, deps)
}

// ---------------- 常量 ----------------
// 事件类型：name 名称 / icon / allowLoc 允许的定位（ride/zone/park）/ spawnWeight 模拟生成权重
export const INCIDENT_TYPES = {
  fire:     { name: '火情火灾', icon: '🔥', locs: ['ride', 'zone', 'park'], weight: 2 },
  stampede: { name: '人群踩踏', icon: '👣', locs: ['zone', 'park'], weight: 2 },
  injury:   { name: '游客受伤', icon: '🩹', locs: ['ride', 'zone'], weight: 3 },
  ride:     { name: '设施事故', icon: '🎢', locs: ['ride'], weight: 2 },
  blackout: { name: '停电故障', icon: '⚡', locs: ['ride', 'zone', 'park'], weight: 1 },
  food:     { name: '食物中毒', icon: '🤢', locs: ['zone'], weight: 1 },
  weather:  { name: '极端天气', icon: '⛈️', locs: ['park'], weight: 2 },
  lost:     { name: '儿童走失', icon: '🧒', locs: ['zone', 'park'], weight: 2 },
  security: { name: '治安事件', icon: '🚨', locs: ['zone', 'park'], weight: 1 }
}

// 分级：Ⅳ 一般 / Ⅲ 较大 / Ⅱ 重大 / Ⅰ 特别重大；sla = 上报后限时定级小时数，超时自动升级
export const LEVELS = {
  1: { name: 'Ⅳ级', alias: '一般', sla: 6, rescue: 2000, comp: 50 },
  2: { name: 'Ⅲ级', alias: '较大', sla: 4, rescue: 5000, comp: 100 },
  3: { name: 'Ⅱ级', alias: '重大', sla: 3, rescue: 12000, comp: 200 },
  4: { name: 'Ⅰ级', alias: '特别重大', sla: 2, rescue: 30000, comp: 400 }
}

export const STATUS_META = {
  reported:   { name: '待核实', cls: 'st-open', step: 0 },
  grading:    { name: '待分级', cls: 'st-ready', step: 1 },
  locked:     { name: '已封控', cls: 'st-processing', step: 2 },
  evacuating: { name: '疏散中', cls: 'st-processing', step: 3 },
  contained:  { name: '已控制', cls: 'st-ready', step: 4 },
  reviewing:  { name: '待复盘', cls: 'st-ready', step: 5 },
  reopened:   { name: '已复园', cls: 'st-done', step: 6 },
  cancelled:  { name: '已撤销', cls: 'st-bad', step: -1 },
  false_alarm:{ name: '虚惊结案', cls: 'st-done', step: -1 }
}
// 主流程节点（进度条）
export const FLOW_STEPS = ['发现上报', '研判分级', '封控布设', '游客疏散', '现场控制', '复园开放', '复盘结案']
const OPEN_STATUSES = ['reported', 'grading', 'locked', 'evacuating', 'contained', 'reviewing']
const CLOSED_STATUSES = ['reopened', 'cancelled', 'false_alarm']

// 上报角色：游客（热线/一键报警）/ 安保巡逻 / 运营 / 维修 / 客服
export const REPORTER_ROLES = {
  guest: '游客报警', security: '安保巡逻', ops: '运营巡查', maintenance: '维修报事', service: '客服上报'
}

// 应急任务 [kind, 适用岗位(任一), 关卡(contain 封控控制前 / reopen 复园前), 任务名]
const T = (kind, roles, gate, name) => ({ kind, roles, gate, name })
const GUARD = '保安/安保'
const TYPE_PLANS = {
  fire: [
    T('lockdown', GUARD, 'contain', '警戒封控与火源警戒区布设'),
    T('evacuate', GUARD, 'contain', '游客疏散引导至集结点'),
    T('rescue', GUARD, 'contain', '搜救受困游客与初期灭火'),
    T('repair', '维修', 'contain', '断电断气与火源排查'),
    T('clean', '保洁', 'reopen', '火场清理与烟损保洁')
  ],
  stampede: [
    T('lockdown', GUARD, 'contain', '事发区域警戒封控'),
    T('evacuate', GUARD, 'contain', '人流疏导与疏散引导'),
    T('rescue', GUARD, 'contain', '踩踏伤员搜救与急救')
  ],
  injury: [
    T('lockdown', GUARD, 'contain', '现场警戒与急救通道布设'),
    T('evacuate', GUARD, 'contain', '周边游客疏散避让'),
    T('rescue', GUARD, 'contain', '伤员急救与转运通道开辟')
  ],
  ride: [
    T('lockdown', GUARD, 'contain', '设施区域封控与游客拦截'),
    T('evacuate', GUARD, 'contain', '排队区游客疏散'),
    T('rescue', GUARD, 'contain', '受困乘客解救与伤员救助'),
    T('repair', '维修', 'contain', '设施停机锁定与机械抢修')
  ],
  blackout: [
    T('lockdown', GUARD, 'contain', '停电区域警戒布防'),
    T('evacuate', GUARD, 'contain', '备用照明引导游客撤离'),
    T('repair', '维修', 'contain', '供电抢修与设备复位')
  ],
  food: [
    T('lockdown', GUARD, 'contain', '涉事餐饮点位封控'),
    T('rescue', GUARD, 'contain', '不适游客登记与送医'),
    T('clean', '保洁', 'reopen', '可疑食材封存与点位消毒')
  ],
  weather: [
    T('lockdown', GUARD, 'contain', '露天区域封控与广播告知'),
    T('evacuate', GUARD, 'contain', '室外游客疏散至室内避险点'),
    T('repair', '维修', 'contain', '风雨隐患排查与设施加固')
  ],
  lost: [
    T('rescue', GUARD, 'contain', '全园广播搜寻走失儿童')
  ],
  security: [
    T('lockdown', GUARD, 'contain', '事发点封控与人员隔离'),
    T('rescue', GUARD, 'contain', '控制肇事人员并报警移交'),
    T('evacuate', GUARD, 'contain', '周边围观游客疏离')
  ]
}
export const TASK_KIND_META = {
  lockdown: { name: '封控布设', icon: '🚧' },
  evacuate: { name: '疏散引导', icon: '🏃' },
  rescue:   { name: '救援救助', icon: '🚑' },
  repair:   { name: '抢修排险', icon: '🔧' },
  clean:    { name: '清场清洁', icon: '🧹' },
  patrol:   { name: '复园巡验', icon: '🔍' }
}
// 受伤比例（占受影响游客估算）
const INJURY_RATE = { fire: 0.06, stampede: 0.12, injury: 0.02, ride: 0.1, blackout: 0, food: 0.15, weather: 0.01, lost: 0, security: 0.03 }

function logIncident(iid, action, note = '', staffId = null) {
  db.prepare('INSERT INTO emergency_logs(incident_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(iid, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}
function linkRef(iid, refType, refId, meta = '') {
  db.prepare('INSERT INTO emergency_links(incident_id,ref_type,ref_id,meta,create_tick,create_day) VALUES(?,?,?,?,?,?)')
    .run(iid, refType, refId, typeof meta === 'string' ? meta : JSON.stringify(meta), ctx.tick(), ctx.day())
}
function getIncident(id) {
  return db.prepare('SELECT * FROM emergency_incidents WHERE id=?').get(id)
}
function requireOpen(inc, ...statuses) {
  if (!inc) return '事件不存在'
  if (CLOSED_STATUSES.includes(inc.status)) return `事件已结案（${STATUS_META[inc.status]?.name || inc.status}）`
  if (statuses.length && !statuses.includes(inc.status)) return `当前状态「${STATUS_META[inc.status]?.name || inc.status}」不能执行该操作`
  return null
}
function setStatus(inc, status, patch = {}) {
  const fields = Object.entries(patch)
  db.prepare(`UPDATE emergency_incidents SET status=?${fields.map(([k]) => `,${k}=?`).join('')} WHERE id=?`)
    .run(status, ...fields.map(([, v]) => v), inc.id)
  inc.status = status
  Object.assign(inc, patch)
}
// 只更新字段，不改变当前状态
function updateIncident(inc, patch = {}) {
  const fields = Object.entries(patch)
  if (!fields.length) return
  db.prepare(`UPDATE emergency_incidents SET ${fields.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...fields.map(([, v]) => v), inc.id)
  Object.assign(inc, patch)
}

// ---------------- 发现上报 ----------------
function resolveLocation(type, locType, locId) {
  const allow = INCIDENT_TYPES[type]?.locs || ['zone', 'park']
  let lt = ['ride', 'zone', 'park'].includes(locType) ? locType : ''
  if (!allow.includes(lt)) lt = allow.includes('park') ? 'park' : allow[0]
  let name = '', id = null
  if (lt === 'ride') {
    const r = db.prepare('SELECT id,name FROM rides WHERE id=?').get(num(locId)) || db.prepare('SELECT id,name FROM rides LIMIT 1').get()
    if (r) { id = r.id; name = r.name } else lt = 'park'
  } else if (lt === 'zone') {
    const z = db.prepare('SELECT id,name FROM zones WHERE id=?').get(num(locId)) || db.prepare('SELECT id,name FROM zones WHERE unlocked=1 LIMIT 1').get()
    if (z) { id = z.id; name = z.name } else lt = 'park'
  }
  if (lt === 'park') name = '全园'
  return { locType: lt, locId: id, locName: name }
}

// 游客 / 安保 / 运营 / 维修 / 客服多角色上报安全事件（含游客一键报警与热线）
export function reportIncident({
  type, locationType, locationId, title = '', desc = '',
  source = 'manual', reporterRole = 'guest', guestName = '', guestPhone = '', staffId = null
} = {}) {
  const tp = INCIDENT_TYPES[type]
  if (!tp) return { ok: false, msg: '事件类型无效' }
  const role = REPORTER_ROLES[reporterRole] ? reporterRole : 'guest'
  const loc = resolveLocation(type, locationType, locationId)
  const auto = source === 'auto'
  const code0 = ''
  const r = db.prepare(`INSERT INTO emergency_incidents
      (code,type,title,desc,status,suggested_level,location_type,location_id,reporter_role,source,guest_name,guest_phone,deadline_tick,report_tick,report_day)
      VALUES(?,?,?,?,'reported',1,?,?,?,?,?,?,?,?,?)`)
    .run(code0, type, title || `${tp.name} · ${loc.locName}`, String(desc || '').slice(0, 300),
      loc.locType, loc.locId, role, auto ? 'auto' : 'manual',
      String(guestName || '').slice(0, 30), String(guestPhone || '').slice(0, 20),
      ctx.tick() + LEVELS[1].sla, ctx.tick(), ctx.day())
  const id = Number(r.lastInsertRowid)
  const code = 'YJ' + String(id).padStart(4, '0')
  db.prepare('UPDATE emergency_incidents SET code=? WHERE id=?').run(code, id)
  // 事件中心同步留痕（影响声誉/客流），结案时联动 resolve
  const ev = db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(ctx.tick(), ctx.day(), 'emergency', `🚨 安全事件 ${code} ${tp.name}`,
      `${REPORTER_ROLES[role]}：「${title || tp.name}」（${loc.locName}），待值班运营主管研判分级。`, -2, 'active')
  db.prepare('UPDATE emergency_incidents SET event_id=? WHERE id=?').run(Number(ev.lastInsertRowid), id)
  logIncident(id, 'report',
    `${REPORTER_ROLES[role]}上报${auto ? '（系统监测）' : ''}：${tp.name}，定位「${loc.locName}」${guestName ? `，联系人 ${guestName}` : ''}`, staffId)
  // 联动岗位调度：安全事件产生即时安保需求
  try { ctx.dispatchAfter?.(`安全事件${code}上报安保需求`) } catch { /* 调度失败不阻塞建单 */ }
  return { ok: true, id, code }
}

// ---------------- 研判分级 ----------------
function todayVisitors() {
  return db.prepare('SELECT COALESCE(SUM(count),0) n FROM visitors WHERE day=?').get(ctx.day()).n
}
// 受影响游客估算：设施=排队+在乘；区域=区域容量的 25%；全园=今日在园
export function estimateAffected(inc) {
  if (inc.location_type === 'ride') {
    const r = db.prepare('SELECT queue,capacity FROM rides WHERE id=?').get(inc.location_id)
    return r ? Math.round(r.queue + r.capacity) : 20
  }
  if (inc.location_type === 'zone') {
    const z = db.prepare('SELECT capacity FROM zones WHERE id=?').get(inc.location_id)
    return z ? Math.round(z.capacity * 0.25) : 50
  }
  return Math.max(100, todayVisitors())
}

export function gradeIncident(id, { level, commanderId, affectedGuests, injuredGuests, compPerGuest, note = '', staffId = null } = {}) {
  const inc = getIncident(id)
  const err = requireOpen(inc, 'reported', 'grading')
  if (err) return { ok: false, msg: err }
  const lv = Math.round(num(level, inc.suggested_level))
  if (!LEVELS[lv]) return { ok: false, msg: '事件等级需为 1~4 级' }
  const commander = db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(num(commanderId))
  if (!commander) return { ok: false, msg: '请指定在岗的应急指挥（运营主管/值班经理）' }
  const affected = Math.max(0, Math.round(num(affectedGuests, inc.affected_guests || estimateAffected(inc))))
  const injuredAuto = Math.max(0, Math.round(affected * (INJURY_RATE[inc.type] || 0)))
  const injured = Math.max(0, Math.min(affected, Math.round(num(injuredGuests, inc.injured_guests || injuredAuto))))
  // 单人补偿：未传或传 0 时按等级默认值回填（Ⅳ50/Ⅲ100/Ⅱ200/Ⅰ400），可在定级时显式覆盖
  const perGuest = Math.max(0, Math.round(num(compPerGuest, 0))) || LEVELS[lv].comp

  try {
    return tx(() => {
      setStatus(inc, 'grading', {
        level: lv,
        commander_id: commander.id,
        affected_guests: affected,
        injured_guests: injured,
        comp_per_guest: perGuest,
        grade_tick: ctx.tick(),
        deadline_tick: 0
      })
      db.prepare("UPDATE events SET impact=?, desc=?, feedback='' WHERE id=?")
        .run(lv >= 3 ? -4 : -2,
          `${INCIDENT_TYPES[inc.type].name}定级为${LEVELS[lv].name}（${LEVELS[lv].alias}），现场指挥 ${commander.name}；受影响约 ${affected} 人、伤 ${injured} 人，等待封控指令。`,
          inc.event_id)
      logIncident(id, 'grade',
        `研判定级 ${LEVELS[lv].name}（${LEVELS[lv].alias}），指挥 ${commander.name}（${commander.role}）；受影响 ${affected} 人、受伤 ${injured} 人；建议补偿 ¥${perGuest}/人。${note ? '研判：' + note : ''}`,
        staffId || commander.id)
      try { ctx.dispatchAfter?.(`安全事件${inc.code}定级后岗位调度`) } catch { /* 调度失败不阻塞定级 */ }
      return { ok: true, level: lv, affectedGuests: affected, injuredGuests: injured, compPerGuest: perGuest }
    })
  } catch (e) {
    console.error('[emergency] 定级失败，已回滚:', e)
    return { ok: false, msg: '定级失败，本次操作未生效，请稍后重试' }
  }
}

// ---------------- 封控（设施停运 / 区域关闭 / 任务生成 / 救援成本） ----------------
function lockTargets(inc) {
  if (inc.location_type === 'ride') {
    const r = db.prepare('SELECT * FROM rides WHERE id=?').get(inc.location_id)
    return r ? { rides: [r], zones: [] } : { rides: [], zones: [] }
  }
  if (inc.location_type === 'zone') {
    return {
      rides: db.prepare('SELECT * FROM rides WHERE zone_id=?').all(inc.location_id),
      zones: db.prepare('SELECT * FROM zones WHERE id=?').all(inc.location_id)
    }
  }
  return { rides: db.prepare('SELECT * FROM rides').all(), zones: db.prepare('SELECT * FROM zones WHERE unlocked=1').all() }
}

function addTask(inc, def) {
  const r = db.prepare(`INSERT INTO emergency_tasks(code,incident_id,kind,name,roles,gate,status,progress,create_tick,create_day)
                        VALUES(?,?,?,?,?,?, 'pending',0,?,?)`)
    .run('', inc.id, def.kind, def.name, def.roles, def.gate, ctx.tick(), ctx.day())
  const tid = Number(r.lastInsertRowid)
  const code = 'RW' + String(tid).padStart(4, '0')
  db.prepare('UPDATE emergency_tasks SET code=? WHERE id=?').run(code, tid)
  logIncident(inc.id, 'task_create', `${TASK_KIND_META[def.kind].icon} 新增应急任务「${def.name}」（责任岗位：${def.roles.replace('/', '/')}）`)
  return tid
}

export function lockdownIncident(id, { note = '', staffId = null } = {}) {
  const inc = getIncident(id)
  const err = requireOpen(inc, 'grading')
  if (err) return { ok: false, msg: err }
  if (!inc.level) return { ok: false, msg: '请先完成研判分级' }
  const { rides, zones } = lockTargets(inc)
  const operatingRides = rides.filter(r => r.status === 'operating')
  const bookedIds = new Set(operatingRides.flatMap(r =>
    db.prepare("SELECT id FROM reservations WHERE ride_id=? AND status='booked'").all(r.id).map(x => x.id)))
  const maxComplaintId = db.prepare('SELECT COALESCE(MAX(id),0) m FROM complaints').get().m
  const rescueCost = LEVELS[inc.level].rescue

  try {
    return tx(() => {
      // 1) 设施停运联动：关停预约时段、在途预约园方全额退款、团行程重排/退款（复用预约模块，同一事务）
      // 事故致损型事件（设施事故/火情/停电）：复园后不直接运营，转检修工单，健康度按等级损伤
      const damaging = ['ride', 'fire', 'blackout'].includes(inc.type)
      const healthDamage = { 1: 20, 2: 35, 3: 55, 4: 75 }[inc.level] || 30
      for (const r of operatingRides) {
        const healthAfter = damaging ? Math.max(5, Math.round(r.health - healthDamage)) : r.health
        db.prepare("UPDATE rides SET status='closed', health=? WHERE id=?").run(healthAfter, r.id)
        const sync = ctx.syncRideSlots?.({ ...r, status: 'closed' })
        if (sync && !sync.ok) throw new Error(`设施停运联动失败：${sync.msg || sync.code || '未知错误'}`)
        linkRef(inc.id, 'ride', r.id, { prev: 'operating', repair: damaging ? 1 : 0, healthBefore: r.health })
      }
      // 2) 区域关闭（疏散封控；复园时按记录恢复）
      for (const z of zones) {
        if (!z.open) continue
        db.prepare('UPDATE zones SET open=0 WHERE id=?').run(z.id)
        linkRef(inc.id, 'zone', z.id, { prev: 1 })
      }
      // 3) 停运引发的设施类投诉自动归集到本事件（统一补偿入口）
      const rideIds = operatingRides.map(r => r.id)
      if (rideIds.length) {
        const newComplaints = db.prepare(`SELECT id FROM complaints WHERE category='facility' AND target_type='ride'
                                          AND target_id IN (${rideIds.map(() => '?').join(',')}) AND id>?`).all(...rideIds, maxComplaintId)
        for (const c of newComplaints) linkRef(inc.id, 'complaint', c.id, { source: 'outage' })
      }
      // 4) 在途退款金额汇总（统一在事件财务口径中展示）
      let refundAmount = 0, refundQty = 0
      if (bookedIds.size) {
        const ids = [...bookedIds]
        const ref = db.prepare(`SELECT COALESCE(SUM(refund_amount),0) a, COALESCE(SUM(qty),0) q
                                FROM reservations WHERE id IN (${ids.map(() => '?').join(',')}) AND status='refunded'`).get(...ids)
        refundAmount = ref.a; refundQty = ref.q
      }
      // 5) 安全隐患投诉工单（游客侧诉求入口，后续随事件统一补偿结案）
      let complaintId = null
      try {
        const locName = inc.location_type === 'ride' ? operatingRides[0]?.name
          : inc.location_type === 'zone' ? zones[0]?.name : ''
        const c = ctx.createComplaint?.({
          category: 'safety',
          severity: Math.min(3, inc.level >= 3 ? 3 : inc.level),
          title: `安全事件 · ${inc.code} ${INCIDENT_TYPES[inc.type].name}`,
          content: `安全事件封控影响现场游客，受伤 ${inc.injured_guests} 人、疏散约 ${inc.affected_guests} 人，游客要求园方给说法并统一补偿。`,
          target: inc.location_type === 'ride' && operatingRides[0]
            ? { type: 'ride', id: operatingRides[0].id, name: operatingRides[0].name }
            : inc.location_type === 'zone' && zones[0]
              ? { type: 'zone', id: zones[0].id, name: zones[0].name }
              : { type: '', id: null, name: locName || '' },
          source: 'guest'
        })
        complaintId = c?.id ?? null
        if (complaintId) linkRef(inc.id, 'complaint', complaintId, { source: 'incident' })
      } catch (e) {
        throw new Error(`安全投诉建单失败：${e.message || e}`)
      }
      // 6) 生成应急任务（封控/救援/抢修/疏散/清洁，按事件类型预案）
      const taskIds = (TYPE_PLANS[inc.type] || []).map(def => addTask(inc, def))
      // 7) 救援处置成本（消防/急救/排险物料，按等级核定，财务留痕）
      setSetting('cash', Math.round(ctx.cash() - rescueCost))
      ctx.logFinance?.(ctx.day(), '应急处置', -rescueCost, `安全事件 ${inc.code} 封控救援成本（${LEVELS[inc.level].alias}）`)
      // 8) 封控当期声誉冲击
      ctx.setReputation(ctx.reputation() - inc.level * 3)

      setStatus(inc, 'locked', {
        lock_tick: ctx.tick(),
        rescue_cost: rescueCost,
        refund_amount: refundAmount,
        refund_qty: refundQty,
        rides_locked: operatingRides.length
      })
      db.prepare("UPDATE events SET desc=? WHERE id=?")
        .run(`事件已启动封控：停运设施 ${operatingRides.length} 项、关闭区域 ${zones.filter(z => z.open).length} 处，应急任务 ${taskIds.length} 项已下达；在途预约退款 ¥${refundAmount}。`, inc.event_id)
      logIncident(id, 'lockdown',
        `启动封控：停运设施 ${operatingRides.length} 项、关闭区域 ${zones.length} 处，下达应急任务 ${taskIds.length} 项；在途预约退款 ¥${refundAmount.toLocaleString()}（${refundQty} 人）；救援处置成本 ¥${rescueCost.toLocaleString()}。${note}`,
        staffId)
      return { ok: true, taskIds, refundAmount, refundQty, rescueCost, ridesLocked: operatingRides.length }
    })
  } catch (e) {
    console.error('[emergency] 封控联动失败，已整体回滚:', e)
    return { ok: false, msg: e.message?.startsWith('设施停运联动') || e.message?.startsWith('安全投诉') ? e.message : '封控联动失败，本次操作未生效，请稍后重试' }
  }
}

// ---------------- 疏散 ----------------
export function startEvacuation(id, { note = '', staffId = null } = {}) {
  const inc = getIncident(id)
  const err = requireOpen(inc, 'locked')
  if (err) return { ok: false, msg: err }
  const hasEvacTask = db.prepare("SELECT COUNT(*) n FROM emergency_tasks WHERE incident_id=? AND kind='evacuate'").get(inc.id).n
  if (!hasEvacTask) return { ok: false, msg: '该事件预案无需全园疏散，可直接推进现场控制' }
  setStatus(inc, 'evacuating', { evacuate_tick: ctx.tick() })
  db.prepare("UPDATE events SET desc=? WHERE id=?")
    .run(`广播疏散指令已下达，安保正在引导 ${inc.affected_guests} 名游客撤离至安全集结点。`, inc.event_id)
  logIncident(id, 'evacuate', `总指挥下达疏散指令，广播引导游客撤离，预计疏散 ${inc.affected_guests} 人。${note}`, staffId)
  return { ok: true }
}

// ---------------- 现场控制 ----------------
function taskGateBlocked(incidentId, gate) {
  return db.prepare("SELECT COUNT(*) n FROM emergency_tasks WHERE incident_id=? AND gate=? AND status<>'done' AND status<>'cancelled'")
    .get(incidentId, gate).n
}
export function containIncident(id, { note = '', staffId = null } = {}) {
  const inc = getIncident(id)
  // 无疏散任务的事件（走失/食安局部）封控后可直接控制；其余须先下达疏散
  const hasEvacTask = db.prepare("SELECT COUNT(*) n FROM emergency_tasks WHERE incident_id=? AND kind='evacuate'").get(inc.id).n
  const allow = hasEvacTask ? ['evacuating'] : ['locked', 'evacuating']
  const err = requireOpen(inc, ...allow)
  if (err) return { ok: false, msg: err }
  const blocked = taskGateBlocked(inc.id, 'contain')
  if (blocked) return { ok: false, code: 'TASKS_PENDING', msg: `尚有 ${blocked} 项封控/救援/抢修任务未完成，不能宣布现场控制` }

  return tx(() => {
    // 复园前置：复园巡验任务（控制后即可开始，完成后才允许复园）
    addTask(inc, T('patrol', GUARD, 'reopen', '复园前安全巡验与设施点检'))
    setStatus(inc, 'contained', { contain_tick: ctx.tick() })
    db.prepare("UPDATE events SET desc=? WHERE id=?")
      .run(`现场已得到控制，受伤游客已送治、风险源已排除；进入游客补偿与复园准备阶段。`, inc.event_id)
    logIncident(id, 'contain', `现场风险解除、人员得到救治，宣布现场已控制；复园巡验任务已下达，可登记游客补偿。${note}`, staffId)
    return { ok: true }
  })
}

// ---------------- 复园 ----------------
export function reopenIncident(id, { note = '', staffId = null } = {}) {
  const inc = getIncident(id)
  const err = requireOpen(inc, 'contained')
  if (err) return { ok: false, msg: err }
  const blocked = taskGateBlocked(inc.id, 'reopen')
  if (blocked) return { ok: false, code: 'TASKS_PENDING', msg: `尚有 ${blocked} 项复园前置任务（巡验/清洁）未完成` }

  const repairRideIds = []
  try {
    const result = tx(() => {
      // 按封控记录恢复：普通设施重新运营并重开时段、区域重新开放；
      // 事故致损设施（meta.repair=1）保持检修停运，事务提交后转交检修模块建工单
      const links = db.prepare("SELECT * FROM emergency_links WHERE incident_id=? AND ref_type IN ('ride','zone')").all(inc.id)
      let rides = 0, zones = 0
      for (const l of links) {
        if (l.ref_type === 'ride') {
          const r = db.prepare('SELECT * FROM rides WHERE id=?').get(l.ref_id)
          if (!r || r.status !== 'closed') continue
          let meta = {}
          try { meta = JSON.parse(l.meta || '{}') } catch { meta = {} }
          if (meta.repair) { repairRideIds.push(r.id); continue }   // 不在本事务恢复，转检修工单
          db.prepare("UPDATE rides SET status='operating' WHERE id=?").run(r.id)
          const sync = ctx.syncRideSlots?.({ ...r, status: 'operating' })
          if (sync && !sync.ok) throw new Error(`恢复运营联动失败：${sync.msg || sync.code || '未知错误'}`)
          rides += 1
        } else if (l.ref_type === 'zone') {
          db.prepare('UPDATE zones SET open=1 WHERE id=?').run(l.ref_id)
          zones += 1
        }
      }
      setStatus(inc, 'reviewing', { reopen_tick: ctx.tick() })
      db.prepare("UPDATE events SET desc=? WHERE id=?")
        .run(`封控解除：恢复运营设施 ${rides} 项、开放区域 ${zones} 处${repairRideIds.length ? `，另有 ${repairRideIds.length} 项事故设施转检修流程` : ''}；等待事故复盘结案。`, inc.event_id)
      logIncident(id, 'reopen',
        `复园核验通过，解除封控：恢复设施 ${rides} 项、开放区域 ${zones} 处${repairRideIds.length ? `，事故设施 ${repairRideIds.length} 项转检修工单（修复后才恢复运营）` : ''}。${note}`, staffId)
      return { ok: true, rides, zones, repairRides: [...repairRideIds] }
    })
    // 事务提交后转交检修模块（失败不影响已生效的复园，登记事件由检修模块驱动）
    for (const rid of repairRideIds) {
      try { ctx.requestRepair?.(rid, `安全事件 ${inc.code} 复园后事故设施检修`) }
      catch (e) { console.error(`[emergency] 事故设施 #${rid} 转检修失败:`, e) }
    }
    return result
  } catch (e) {
    console.error('[emergency] 复园联动失败，已整体回滚:', e)
    return { ok: false, msg: '复园失败，本次操作未生效，请稍后重试' }
  }
}

// ---------------- 游客统一补偿（财务 + 投诉联动结案） ----------------
// 现场控制后按人头发放补偿金；可分批发放，累计不超过受影响人数。
// 同一事务：现金扣减 + 财务流水 + 关联投诉统一补偿结案 + 声誉小幅回升。
export function compensateIncident(id, { qty = 0, perGuest = 0, staffId = null } = {}) {
  const inc = getIncident(id)
  const err = requireOpen(inc, 'contained', 'reviewing')
  if (err) return { ok: false, msg: err }
  const remain = inc.affected_guests - inc.comp_guests
  if (remain <= 0) return { ok: false, msg: '受影响游客已全部补偿' }
  const n = Math.min(remain, Math.round(num(qty, remain)))
  if (n <= 0) return { ok: false, msg: '补偿人数需大于 0' }
  // 单人金额：显式传入优先，否则取定级标准，再兜底等级默认（Ⅳ50/Ⅲ100/Ⅱ200/Ⅰ400）
  const per = Math.max(0, Math.round(num(perGuest, 0))) || inc.comp_per_guest || LEVELS[inc.level]?.comp || 0
  const amount = n * per
  if (per <= 0) return { ok: false, msg: '请设置单人补偿金额' }
  if (ctx.cash() < amount) return { ok: false, msg: `资金不足，本次补偿需 ¥${amount.toLocaleString()}` }

  try {
    return tx(() => {
      setSetting('cash', Math.round(ctx.cash() - amount))
      ctx.logFinance?.(ctx.day(), '应急补偿', -amount, `安全事件 ${inc.code} 游客补偿金 ${n} 人 × ¥${per}`)
      // 关联投诉统一按补偿结案（补偿金额在投诉间均摊留痕，统一取 4 星评价）
      const cids = db.prepare("SELECT ref_id id FROM emergency_links WHERE incident_id=? AND ref_type='complaint'").all(inc.id).map(x => x.id)
      const openCs = cids.length ? db.prepare(`SELECT id FROM complaints WHERE id IN (${cids.map(() => '?').join(',')}) AND status IN ('open','processing','ready')`).all(...cids) : []
      const each = openCs.length ? Math.floor(amount / openCs.length) : 0
      openCs.forEach((c, i) => {
        const cost = i === openCs.length - 1 ? amount - each * (openCs.length - 1) : each
        db.prepare(`UPDATE complaints SET status='closed_resolved', compensation='emergency', comp_cost=?, rating=4,
                    close_reason='随安全事件统一补偿结案', closed_tick=?, closed_day=? WHERE id=?`)
          .run(cost, ctx.tick(), ctx.day(), c.id)
        db.prepare('INSERT INTO complaint_logs(complaint_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
          .run(c.id, ctx.tick(), ctx.day(), ctx.hour(), 'resolve', `随安全事件 ${inc.code} 统一补偿结案，补偿金 ¥${cost}（4 星）`, staffId)
      })
      // 补偿诚意小幅回升声誉
      ctx.setReputation(ctx.reputation() + Math.min(4, inc.level * 0.6))
      updateIncident(inc, { comp_guests: inc.comp_guests + n, comp_amount: inc.comp_amount + amount })
      logIncident(id, 'compensate', `发放游客补偿金 ${n} 人 × ¥${per} = ¥${amount.toLocaleString()}，累计 ${inc.comp_guests + n}/${inc.affected_guests} 人；关联投诉 ${openCs.length} 件统一结案。`, staffId)
      return { ok: true, qty: n, perGuest: per, amount, closedComplaints: openCs.length }
    })
  } catch (e) {
    console.error('[emergency] 补偿发放失败，已回滚:', e)
    return { ok: false, msg: '补偿发放失败，本次操作未生效，请稍后重试' }
  }
}

// ---------------- 复盘结案 ----------------
export function reviewIncident(id, { rating = 0, cause = '', actions = '', note = '', staffId = null } = {}) {
  const inc = getIncident(id)
  const err = requireOpen(inc, 'reviewing')
  if (err) return { ok: false, msg: err }
  // 综合处置评价（留空自动评定）：响应时效（基准 3 星）+ 足额补偿 +1 + 超时升级/较多伤情扣分，限制在 1~5
  const elapsed = Math.max(1, (inc.contain_tick || ctx.tick()) - inc.report_tick)
  const timeliness = Math.max(-1.5, Math.min(1, 3 - elapsed))   // 3h 内 +0~1，每多 1h 扣 1，下限 -1.5
  const compScore = inc.comp_amount > 0 ? 1 : -0.8
  const autoRating = Math.round(3 + timeliness + compScore - inc.escalations * 0.5 - (inc.injured_guests > 2 ? 0.5 : 0))
  const rt = Math.max(1, Math.min(5, Math.round(num(rating, autoRating))))

  try {
    return tx(() => {
      // 参与处置员工士气与工时满意度回写
      const staffIds = [...new Set(db.prepare("SELECT assignee_id sid FROM emergency_tasks WHERE incident_id=? AND assignee_id IS NOT NULL").all(inc.id).map(x => x.sid))]
      for (const sid of staffIds) {
        const st = db.prepare('SELECT morale FROM staff WHERE id=? AND active=1').get(sid)
        if (st) db.prepare('UPDATE staff SET morale=? WHERE id=?').run(Math.max(20, Math.min(100, st.morale + (rt >= 4 ? 4 : rt === 3 ? 1 : -2))), sid)
        try { ctx.onWorkComplete?.(sid, 'emergency', { code: inc.code }) } catch { /* 工时回写失败不阻塞复盘 */ }
      }
      // 处置评价回流声誉（评级越高、等级越高挽回越多）
      ctx.setReputation(ctx.reputation() + rt * inc.level * 1.2 + (inc.comp_amount > 0 ? inc.level * 0.5 : 0))
      setStatus(inc, 'reopened', {
        rating: rt,
        review_cause: String(cause || '').slice(0, 400),
        review_actions: String(actions || '').slice(0, 400),
        review_note: String(note || '').slice(0, 200),
        close_tick: ctx.tick(),
        close_day: ctx.day()
      })
      if (inc.event_id) {
        db.prepare("UPDATE events SET status='resolved', feedback=? WHERE id=?")
          .run(`事故复盘完成，综合处置评价 ${rt} 星；${actions || '已记录整改措施。'}`, inc.event_id)
      }
      logIncident(id, 'review',
        `复盘结案：综合处置评价 ${rt} 星（响应 ${elapsed}h）。原因：${cause || '—'}；整改：${actions || '—'}。${note}`,
        staffId || inc.commander_id)
      return { ok: true, rating: rt, rewardedStaff: staffIds.length }
    })
  } catch (e) {
    console.error('[emergency] 复盘失败，已回滚:', e)
    return { ok: false, msg: '复盘失败，本次操作未生效，请稍后重试' }
  }
}

// ---------------- 撤销 / 虚惊 ----------------
export function cancelIncident(id, { falseAlarm = false, note = '', staffId = null } = {}) {
  const inc = getIncident(id)
  const err = requireOpen(inc, 'reported', 'grading')
  if (err) return { ok: false, msg: err }
  return tx(() => {
    setStatus(inc, falseAlarm ? 'false_alarm' : 'cancelled', {
      false_alarm: falseAlarm ? 1 : 0,
      close_tick: ctx.tick(),
      close_day: ctx.day(),
      deadline_tick: 0
    })
    if (inc.event_id) {
      db.prepare("UPDATE events SET status='resolved', impact=0, feedback=? WHERE id=?")
        .run(falseAlarm ? '经现场核实为误报/虚惊，未造成实际影响。' : '事件经核实后撤销。', inc.event_id)
    }
    logIncident(id, falseAlarm ? 'false_alarm' : 'cancel',
      falseAlarm ? `现场核实为误报/虚惊，解除戒备并结案。${note}` : `事件撤销。${note}`, staffId)
    return { ok: true }
  })
}

// ---------------- 应急任务：派工 / 推进 / 完工 ----------------
function taskRate(st, roles) {
  const match = roles.split('/').some(r => r === st.role)
  return (10 + st.skill * 5 + st.morale / 12) * (match ? 1.5 : 1)
}

// 派工：责任岗位任一匹配；每人同时只能承担一个进行中的应急任务；当日必须有排班（未到班可先接单）
export function assignTask(taskId, staffId) {
  const t = db.prepare('SELECT * FROM emergency_tasks WHERE id=?').get(taskId)
  if (!t || ['done', 'cancelled'].includes(t.status)) return { ok: false, msg: '任务不存在或已结束' }
  const inc = getIncident(t.incident_id)
  if (!inc || CLOSED_STATUSES.includes(inc.status)) return { ok: false, msg: '事件已结案，任务不可派工' }
  const st = db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(staffId)
  if (!st) return { ok: false, msg: '员工不存在或已离岗' }
  if (!t.roles.split('/').includes(st.role)) return { ok: false, msg: `该任务责任岗位为 ${t.roles}，${st.name}（${st.role}）不可承接` }
  const busy = db.prepare("SELECT * FROM emergency_tasks WHERE assignee_id=? AND status='processing' AND id<>?").get(st.id, t.id)
  if (busy) return { ok: false, msg: `${st.name} 正在执行应急任务「${busy.name}」，请先改派` }
  const duty = ctx.staffDutyState?.(st.id)
  if (duty && !duty.scheduled) return { ok: false, code: 'NOT_SCHEDULED', msg: duty.msg || `${st.name} 今日无排班，不能派工` }

  db.prepare("UPDATE emergency_tasks SET status='processing', assignee_id=?, start_tick=? WHERE id=?")
    .run(st.id, ctx.tick(), t.id)
  logIncident(t.incident_id, 'task_assign', `${st.name}（${st.role}）领取任务「${t.name}」`, st.id)
  return { ok: true }
}

function completeTask(t) {
  const inc = getIncident(t.incident_id)
  db.prepare("UPDATE emergency_tasks SET status='done', progress=100, done_tick=?, done_day=? WHERE id=?")
    .run(ctx.tick(), ctx.day(), t.id)
  const st = t.assignee_id ? db.prepare('SELECT name FROM staff WHERE id=?').get(t.assignee_id) : null
  if (st) db.prepare('UPDATE staff SET morale=MIN(100, morale+1) WHERE id=?').run(t.assignee_id)
  if (t.kind === 'evacuate' && inc) {
    db.prepare('UPDATE emergency_incidents SET evacuated_guests=affected_guests WHERE id=?').run(inc.id)
    logIncident(inc.id, 'evacuate', `疏散引导完成，${inc.affected_guests} 名游客全部到达集结点。`, t.assignee_id)
  }
  logIncident(t.incident_id, 'task_done', `✅ ${st ? st.name + ' 完成' : ''}任务「${t.name}」`, t.assignee_id)
}

// 每游戏小时推进：在岗员工按岗位匹配/技能/士气推进任务；离岗退回任务池；未定级事件超时自动升级
export function processEmergency() {
  // 1) 任务推进（逐单容错，不中断主循环）
  for (const t of db.prepare("SELECT * FROM emergency_tasks WHERE status='processing'").all()) {
    try {
      const st = t.assignee_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(t.assignee_id) : null
      if (!st || !st.active) {
        db.prepare("UPDATE emergency_tasks SET status='pending', assignee_id=NULL WHERE id=?").run(t.id)
        logIncident(t.incident_id, 'task_release', `执行人离岗，任务「${t.name}」退回任务池等待改派`)
        continue
      }
      const duty = ctx.staffDutyState?.(st.id)
      if (duty && !duty.onDuty) continue   // 有排班未到班：挂起等待，不退单
      const progress = t.progress + taskRate(st, t.roles)
      if (progress >= 100) tx(() => completeTask(t))
      else db.prepare('UPDATE emergency_tasks SET progress=? WHERE id=?').run(Math.round(progress * 10) / 10, t.id)
    } catch (e) {
      console.error(`[emergency] 任务 #${t.id} 推进失败（已跳过）:`, e)
    }
  }
  // 2) 未研判事件超时自动升级（建议等级 +1，声誉受损，重置定级时限；正式等级仅由指挥官研判决定）
  for (const inc of db.prepare("SELECT * FROM emergency_incidents WHERE status='reported' AND deadline_tick>0").all()) {
    if (ctx.tick() <= inc.deadline_tick) continue
    const nextLv = Math.min(4, inc.suggested_level + 1)
    db.prepare('UPDATE emergency_incidents SET suggested_level=?, escalations=escalations+1, deadline_tick=? WHERE id=?')
      .run(nextLv, ctx.tick() + LEVELS[nextLv].sla, inc.id)
    ctx.setReputation(ctx.reputation() - nextLv)
    logIncident(inc.id, 'auto_escalate',
      `超过 ${LEVELS[Math.max(inc.suggested_level, 1)].sla}h 未完成定级，系统自动上调建议等级至${LEVELS[nextLv].name}（${LEVELS[nextLv].alias}），声誉受损，请立即研判。`)
    if (inc.event_id) {
      db.prepare("UPDATE events SET impact=-4, desc=? WHERE id=?")
        .run(`安全事件 ${inc.code} 超时未定级，已自动上调至${LEVELS[nextLv].name}，亟待现场指挥处置。`, inc.event_id)
    }
  }
}

// ---------------- 模拟监测：随机安全事件 ----------------
// 每小时由引擎调用：低概率生成；健康度差的设施/低满意度/大客流/安全类投诉会抬升概率
export function maybeSpawnIncident({ entering = 0, satisfaction = 70 } = {}) {
  if (!num(getSetting('emergencyEnabled'), 1)) return null
  const openCount = db.prepare(`SELECT COUNT(*) n FROM emergency_incidents WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).get(...OPEN_STATUSES).n
  if (openCount >= 5) return null
  const badRides = db.prepare("SELECT COUNT(*) n FROM rides WHERE health<45 AND status='operating'").get().n
  const safetyComplaints = db.prepare("SELECT COUNT(*) n FROM complaints WHERE category='safety' AND status IN ('open','processing','ready')").get().n
  const chance = 0.025 + badRides * 0.02 + safetyComplaints * 0.05 + Math.max(0, 50 - satisfaction) * 0.002 + Math.min(0.03, entering / 120000)
  if (Math.random() >= chance) return null

  const entries = Object.entries(INCIDENT_TYPES)
  const total = entries.reduce((s, [, m]) => s + m.weight, 0)
  let roll = Math.random() * total, type = entries[0][0]
  for (const [k, m] of entries) { roll -= m.weight; if (roll <= 0) { type = k; break } }
  const meta = INCIDENT_TYPES[type]
  const locs = meta.locs
  const locType = locs[Math.floor(Math.random() * locs.length)]
  let locationId = null
  if (locType === 'ride') {
    const pool = db.prepare("SELECT id FROM rides WHERE status='operating' ORDER BY health ASC LIMIT 5").all()
    locationId = pool.length ? pool[Math.floor(Math.random() * pool.length)].id : null
  } else if (locType === 'zone') {
    const pool = db.prepare("SELECT id FROM zones WHERE unlocked=1 AND open=1").all()
    locationId = pool.length ? pool[Math.floor(Math.random() * pool.length)].id : null
  }
  const reporterPool = ['guest', 'guest', 'security', 'ops', 'service']
  const r = reportIncident({
    type,
    locationType: locType,
    locationId,
    desc: '系统监测与一线渠道汇集的异常信号，请立即核实。',
    source: 'auto',
    reporterRole: reporterPool[Math.floor(Math.random() * reporterPool.length)],
    guestName: ''
  })
  return r.ok ? r : null
}

// ---------------- 满意度联动 ----------------
// 未结安全事件按等级持续拉低满意度：封控疏散期权重 1，控制/复盘期权重 0.5
export function openIncidentDrag() {
  let d = 0
  for (const inc of db.prepare(`SELECT level,status FROM emergency_incidents WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).all(...OPEN_STATUSES)) {
    const lv = Math.max(1, inc.level || inc.suggested_level || 1)
    d += lv * 1.5 * (['contained', 'reviewing'].includes(inc.status) ? 0.5 : 1)
  }
  return Math.min(14, Math.round(d * 10) / 10)
}

// ---------------- 查询 ----------------
function enrichTask(t) {
  const st = t.assignee_id ? db.prepare('SELECT id,name,role,skill,morale,active FROM staff WHERE id=?').get(t.assignee_id) : null
  const match = st ? t.roles.split('/').includes(st.role) : false
  return { ...t, kind_name: TASK_KIND_META[t.kind]?.name || t.kind, kind_icon: TASK_KIND_META[t.kind]?.icon || '•', assignee: st || null, role_match: match }
}

function enrichIncident(inc, { withTasks = false } = {}) {
  const meta = INCIDENT_TYPES[inc.type] || { name: inc.type, icon: '🚨' }
  const lv = LEVELS[inc.level] || null
  const stm = STATUS_META[inc.status] || { name: inc.status, cls: '', step: -1 }
  const locName = inc.location_type === 'ride'
    ? db.prepare('SELECT name FROM rides WHERE id=?').get(inc.location_id)?.name || '设施#' + inc.location_id
    : inc.location_type === 'zone'
      ? db.prepare('SELECT name FROM zones WHERE id=?').get(inc.location_id)?.name || '区域#' + inc.location_id
      : '全园'
  const commander = inc.commander_id ? db.prepare('SELECT id,name,role FROM staff WHERE id=?').get(inc.commander_id) : null
  const taskRows = db.prepare('SELECT * FROM emergency_tasks WHERE incident_id=? ORDER BY id').all(inc.id)
  const counts = { total: taskRows.length, done: 0, processing: 0, pending: 0 }
  for (const t of taskRows) counts[t.status === 'done' ? 'done' : t.status === 'processing' ? 'processing' : 'pending'] += 1
  const links = {
    complaints: db.prepare("SELECT ref_id FROM emergency_links WHERE incident_id=? AND ref_type='complaint'").all(inc.id).map(x => x.ref_id),
    rides: db.prepare("SELECT COUNT(*) n FROM emergency_links WHERE incident_id=? AND ref_type='ride'").get(inc.id).n,
    zones: db.prepare("SELECT COUNT(*) n FROM emergency_links WHERE incident_id=? AND ref_type='zone'").get(inc.id).n
  }
  return {
    ...inc,
    type_name: meta.name,
    type_icon: meta.icon,
    level_name: lv ? lv.name : '未定级',
    level_alias: lv ? lv.alias : '',
    status_name: stm.name,
    status_cls: stm.cls,
    step: stm.step,
    location_name: locName,
    commander_name: commander?.name || '',
    commander_role: commander?.role || '',
    reporter_name: REPORTER_ROLES[inc.reporter_role] || inc.reporter_role,
    open: OPEN_STATUSES.includes(inc.status),
    has_evac_task: taskRows.some(t => t.kind === 'evacuate'),
    tasks: withTasks ? taskRows.map(enrichTask) : undefined,
    task_counts: counts,
    links,
    comp_remaining: Math.max(0, inc.affected_guests - inc.comp_guests)
  }
}

export function listIncidents({ status = null, limit = 100 } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM emergency_incidents WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM emergency_incidents ORDER BY id DESC LIMIT ?').all(limit)
  return rows.map(x => enrichIncident(x))
}

export function incidentDetail(id) {
  const inc = getIncident(id)
  if (!inc) return null
  const logs = db.prepare('SELECT * FROM emergency_logs WHERE incident_id=? ORDER BY id').all(id)
  const linkRows = db.prepare('SELECT * FROM emergency_links WHERE incident_id=? ORDER BY id').all(id)
  return { incident: enrichIncident(inc, { withTasks: true }), logs, links: linkRows }
}

export function incidentStats() {
  const byStatus = {}
  for (const s of [...OPEN_STATUSES, ...CLOSED_STATUSES]) byStatus[s] = 0
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM emergency_incidents GROUP BY status').all()) byStatus[r.status] = r.n
  const open = OPEN_STATUSES.reduce((s, k) => s + (byStatus[k] || 0), 0)
  const today = db.prepare('SELECT COUNT(*) n FROM emergency_incidents WHERE report_day=?').get(ctx.day()).n
  const closedToday = db.prepare('SELECT COUNT(*) n FROM emergency_incidents WHERE close_day=?').get(ctx.day()).n
  const fin = db.prepare("SELECT COALESCE(SUM(CASE WHEN label='应急补偿' THEN -amount ELSE 0 END),0) c, COALESCE(SUM(CASE WHEN label='应急处置' THEN -amount ELSE 0 END),0) r FROM finance WHERE day=?").get(ctx.day())
  const active = db.prepare(`SELECT COALESCE(SUM(affected_guests),0) a, COALESCE(SUM(evacuated_guests),0) e, COALESCE(SUM(injured_guests),0) i
                             FROM emergency_incidents WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).get(...OPEN_STATUSES)
  const tasksPending = db.prepare("SELECT COUNT(*) n FROM emergency_tasks WHERE status IN ('pending','processing')").get().n
  const rated = db.prepare("SELECT AVG(rating) a FROM emergency_incidents WHERE status='reopened' AND rating>0").get().a || 0
  return {
    open, byStatus, today, closedToday,
    rescueToday: fin.r, compToday: fin.c,
    affectedActive: active.a, evacuatedActive: active.e, injuredActive: active.i,
    tasksPending,
    total: db.prepare('SELECT COUNT(*) n FROM emergency_incidents').get().n,
    avgRating: Math.round(rated * 10) / 10
  }
}

export function emergencyConfig() {
  return {
    enabled: num(getSetting('emergencyEnabled'), 1) ? 1 : 0,
    compDefault: Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, v.comp])),
    rescueCost: Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, v.rescue]))
  }
}
export function saveEmergencyConfig({ enabled } = {}) {
  if (enabled !== undefined) setSetting('emergencyEnabled', enabled ? 1 : 0)
  return { ok: true, config: emergencyConfig() }
}
