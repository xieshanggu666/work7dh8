// 园区应急指挥模块测试：
// 上报→定级→封控（设施停运+预约退款+投诉归集+任务下达+救援费）→派工推进→疏散/控制→统一补偿→复园（重开时段）→复盘
// 覆盖：状态门控 / 任务岗位与排班门控 / 自动升级 / 虚惊撤销 / 封控联动失败整体回滚
// 运行：node --test server/emergency.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前设置，隔离真实库

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')
const SCH = await import('./scheduling.js')
const EM = await import('./emergency.js')

// ---- 测试上下文：财务流水 + 投诉建单（真实预约停运联动，复用 RSV.syncRideSlots） ----
const finLogs = []
const repairRequests = []
let failRefund = false
// mock 投诉建单写入真实 complaints 表（补偿联动需按 id 查询并结案），返回真实 id
function mockCreateComplaint(p) {
  const r = db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,content,target_type,target_id,status,deadline_tick,source)
                        VALUES(?,?,?,?,?,?,?,?,?,'open',999,'guest')`)
    .run('TS' + Date.now() + Math.floor(Math.random() * 1000), 0, 1, p.category || 'service', p.severity || 1,
      p.title || '测试投诉', p.content || '', p.target?.type || '', p.target?.id ?? null)
  return { ok: true, id: Number(r.lastInsertRowid), code: 'TS' + String(r.lastInsertRowid).padStart(4, '0') }
}
RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => {
    if (failRefund && label !== undefined && amount < 0 && label !== '门票') throw new Error('模拟退款流水失败')
    finLogs.push({ day, label, amount, detail })
  },
  createComplaint: mockCreateComplaint,
  handleParkOutageGroup: () => {}
})
SCH.initSchedulingContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail })
})
EM.initEmergencyContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  syncRideSlots: ride => RSV.syncRideSlots(ride),
  createComplaint: mockCreateComplaint,
  staffDutyState: id => SCH.staffDutyState(id),
  onWorkComplete: () => {},
  dispatchAfter: () => {},
  requestRepair: (rideId, note) => { repairRequests.push({ rideId, note }); return { ok: true } }
})

const cash = () => Number(getSetting('cash'))
const rideSlot = (rideId, day, hour) =>
  db.prepare("SELECT * FROM reservation_slots WHERE scope='ride' AND ride_id=? AND day=? AND hour=?").get(rideId, day, hour)
const rideById = id => db.prepare('SELECT * FROM rides WHERE id=?').get(id)
const incById = id => db.prepare('SELECT * FROM emergency_incidents WHERE id=?').get(id)
const tasksOf = iid => db.prepare('SELECT * FROM emergency_tasks WHERE incident_id=? ORDER BY id').all(iid)
const staffByRole = role => db.prepare("SELECT * FROM staff WHERE role=? AND active=1").all(role)

// 清理跨用例残留排班/考勤（同一员工同一游戏日仅允许一个有效排班）
function resetRosters() {
  db.prepare('DELETE FROM staff_attendance').run()
  db.prepare("DELETE FROM staff_schedules").run()
  db.prepare('DELETE FROM shift_logs').run()
}

// 给员工安排今日早班并打卡（应急任务派工的排班/在岗门控）；已有排班则复用
function putOnDuty(staffId) {
  const shift = db.prepare("SELECT * FROM shift_templates WHERE code='morning'").get()
  let sch = db.prepare('SELECT * FROM staff_schedules WHERE staff_id=? AND day=1 AND status<>\'cancelled\' ORDER BY id DESC LIMIT 1').get(staffId)
  if (!sch) {
    const r = SCH.createSchedule({ staffId, shiftId: shift.id, day: 1, requestId: `sch-${staffId}-${Date.now()}`, allowStarted: true })
    if (!r.ok) throw new Error('排班失败：' + r.msg)
    sch = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(r.id)
  }
  const att = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=? AND status=\'checked_in\'').get(sch.id)
  if (!att) SCH.checkin(sch.id, { requestId: `ci-${staffId}-${Date.now()}` })
}

// 安排今日中班（12 点开始），仅排班不打卡（到点后再 checkin）
function scheduleMid(staffId) {
  const shift = db.prepare("SELECT * FROM shift_templates WHERE code='mid'").get()
  SCH.createSchedule({ staffId, shiftId: shift.id, day: 1, requestId: `sch-m-${staffId}-1` })
}
function checkinMid(staffId) {
  const sch = db.prepare('SELECT * FROM staff_schedules WHERE staff_id=? AND day=1 ORDER BY id DESC LIMIT 1').get(staffId)
  return SCH.checkin(sch.id, { requestId: `ci-m-${staffId}-1` })
}

// 补招保安（种子数据安保角色数量不足以并行领取全部封控任务）
function ensureExtraGuards(n) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES(?,?,1,320,1,80,1)')
      .run(`应急保安${i + 1}`, '保安')
  }
}

// 推进任务直到全部完成（在岗员工每小时推进，多次 tick 必然完工）
function runTasks(iid) {
  for (let i = 0; i < 40; i++) {
    EM.processEmergency()
    if (!tasksOf(iid).some(t => t.status !== 'done')) return
  }
}

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 500000)
  setSetting('ticket', 100)
  RSV.ensureSlots()
})

test('全流程：上报→定级→封控（停运退款+投诉+任务+救援费）→疏散→控制→补偿→复园→复盘', () => {
  setSetting('day', 1); setSetting('hour', 9); setSetting('tick', 0)
  resetRosters()
  // 在途设施预约（封控时园方全额退款）
  const s1 = rideSlot(1, 2, 10)
  const s2 = rideSlot(1, 2, 11)
  const b1 = RSV.createReservation({ scope: 'ride', rideId: 1, slotId: s1.id, qty: 3, requestId: 'em-b1' })
  const b2 = RSV.createReservation({ scope: 'ride', rideId: 1, slotId: s2.id, qty: 2, requestId: 'em-b2' })
  assert.equal(b1.ok, true); assert.equal(b2.ok, true)
  const cash0 = cash()

  // ① 游客一键报警（设施事故）
  const rep = EM.reportIncident({ type: 'ride', locationType: 'ride', locationId: 1, reporterRole: 'guest' })
  assert.equal(rep.ok, true)
  assert.ok(rep.code.startsWith('YJ'))
  const iid = rep.id
  assert.equal(incById(iid).status, 'reported')
  assert.ok(db.prepare('SELECT * FROM events WHERE id=?').get(incById(iid).event_id), '应同步创建事件中心记录')

  // 未定级不能封控
  assert.equal(EM.lockdownIncident(iid).ok, false)

  // ② 运营主管定级Ⅱ级
  const supervisor = db.prepare("SELECT * FROM staff WHERE role='运营主管' AND active=1 LIMIT 1").get()
  const g = EM.gradeIncident(iid, { level: 3, commanderId: supervisor.id, affectedGuests: 40, injuredGuests: 3, compPerGuest: 200 })
  assert.equal(g.ok, true)
  assert.equal(incById(iid).level, 3)
  assert.equal(incById(iid).affected_guests, 40)

  // ③ 封控：停运+退款+投诉归集+任务+救援成本（同一事务）
  const lock = EM.lockdownIncident(iid)
  assert.equal(lock.ok, true, lock.msg)
  assert.equal(rideById(1).status, 'closed', '设施应停运')
  assert.equal(s1 ? rideSlot(1, 2, 10).status : 'closed', 'closed', '时段应关停')
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(b1.id).status, 'refunded', '在途预约应全额退款')
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(b2.id).status, 'refunded')
  assert.ok(lock.refundAmount > 0, '退款金额应为正')
  assert.equal(lock.refundQty, 5, '退款人数应为 5 人')
  assert.equal(lock.rescueCost, 12000, 'Ⅱ级救援成本应为 12000')
  assert.equal(cash(), cash0 - lock.rescueCost - lock.refundAmount, '现金 = 救援费+退款')
  const incidentComplaints = db.prepare("SELECT COUNT(*) n FROM emergency_links WHERE incident_id=? AND ref_type='complaint'").get(iid).n
  assert.ok(incidentComplaints >= 1, '应归集安全/设施投诉')
  const tasks = tasksOf(iid)
  assert.ok(tasks.some(t => t.kind === 'lockdown'), '应下达封控任务')
  assert.ok(tasks.some(t => t.kind === 'evacuate'), '设施事故应有疏散任务')
  assert.ok(tasks.some(t => t.kind === 'repair'), '应有抢修任务')

  // 任务未完成不能疏散后控制；先完成封控前置任务
  assert.equal(EM.containIncident(iid).ok, false, '任务未完成不能宣布控制')

  // 派工：保洁不能承接安保任务（岗位门控）
  const cleaner = staffByRole('保洁')[0]
  const lockdownTask = tasks.find(t => t.kind === 'lockdown')
  assert.equal(EM.assignTask(lockdownTask.id, cleaner.id).ok, false, '岗位不符应拒绝派工')
  // 无排班拒绝派工
  const guard0 = staffByRole('保安')[0]
  const noSch = EM.assignTask(lockdownTask.id, guard0.id)
  assert.equal(noSch.ok, false)
  assert.equal(noSch.code, 'NOT_SCHEDULED')

  // 安排安保/维修到岗并派工全部封控前置任务（并行任务，每人只领 1 项 → 需补足保安人数）
  ensureExtraGuards(3)
  const guards = staffByRole('保安').concat(staffByRole('安保'))
  guards.forEach(s => putOnDuty(s.id))
  staffByRole('维修').slice(0, 2).forEach(s => putOnDuty(s.id))
  let gi = 0
  for (const t of tasks.filter(t => t.gate === 'contain' && t.kind !== 'repair')) {
    // 每人只允许一个进行中任务：循环寻找空闲保安派工
    let assigned = false
    for (let k = 0; k < guards.length; k++) {
      const cand = guards[(gi + k) % guards.length]
      if (EM.assignTask(t.id, cand.id).ok) { gi = (gi + k + 1) % guards.length; assigned = true; break }
    }
    assert.ok(assigned, `任务「${t.name}」应能派出`)
  }
  const repairTask = tasks.find(t => t.kind === 'repair')
  assert.equal(EM.assignTask(repairTask.id, staffByRole('维修')[0].id).ok, true)

  // ④ 下达疏散
  assert.equal(EM.startEvacuation(iid).ok, true)
  assert.equal(incById(iid).status, 'evacuating')

  // 推进至封控前置任务全部完成
  runTasks(iid)
  assert.equal(tasksOf(iid).filter(t => t.gate === 'contain' && t.status !== 'done').length, 0, '封控前置任务应全部完成')

  // ⑤ 现场控制：自动生成复园巡验任务
  const contain = EM.containIncident(iid)
  assert.equal(contain.ok, true, contain.msg)
  assert.equal(incById(iid).status, 'contained')
  const patrol = tasksOf(iid).find(t => t.kind === 'patrol')
  assert.ok(patrol, '控制后应生成复园巡验任务')
  assert.equal(patrol.gate, 'reopen')
  assert.equal(rideById(1).status, 'closed', '控制后设施仍应停运，待复园')

  // 巡验未完成不能复园
  assert.equal(EM.reopenIncident(iid).ok, false)

  // ⑥ 统一补偿（分两批），关联投诉随补偿结案
  const comp1 = EM.compensateIncident(iid, { qty: 20, perGuest: 200 })
  assert.equal(comp1.ok, true)
  assert.equal(comp1.amount, 4000)
  const comp2 = EM.compensateIncident(iid, { qty: 20, perGuest: 200 })
  assert.equal(comp2.ok, true, '第二批补偿应成功')
  assert.equal(EM.compensateIncident(iid, { qty: 1, perGuest: 200 }).ok, false, '超额补偿应拒绝')
  const inc = incById(iid)
  assert.equal(inc.comp_guests, 40)
  assert.equal(inc.comp_amount, 8000)
  assert.ok(comp1.closedComplaints + comp2.closedComplaints >= 1, '归集投诉应随统一补偿结案')
  assert.ok(finLogs.some(f => f.label === '应急补偿' && f.amount === -4000), '补偿流水应入账')

  // 完成复园前置（巡验 + 清洁，本类型可能无清洁）
  for (const t of tasksOf(iid).filter(t => t.gate === 'reopen' && t.status !== 'done')) {
    const pool = t.kind === 'patrol' ? guards : staffByRole('保洁')
    if (t.kind === 'clean') staffByRole('保洁').slice(0, 2).forEach(putOnDuty)
    const cand = pool.find(p => !tasksOf(iid).some(x => x.assignee_id === p.id && x.status === 'processing'))
    assert.ok(cand, `应存在可派工员工：${t.kind}`)
    assert.equal(EM.assignTask(t.id, cand.id).ok, true)
  }
  runTasks(iid)
  assert.equal(tasksOf(iid).filter(t => t.gate === 'reopen' && t.status !== 'done').length, 0)

  // ⑦ 复园：区域开放；事故设施（设施事故为致损型）转检修工单，不直接恢复运营
  const healthBefore = 100
  const reopen = EM.reopenIncident(iid)
  assert.equal(reopen.ok, true, reopen.msg)
  assert.ok(repairRequests.some(r => r.rideId === 1), '事故设施复园后应转检修工单')
  assert.equal(rideById(1).status, 'closed', '事故设施保持停运待检修')
  assert.ok(rideById(1).health < healthBefore, '事故设施健康度应受损')

  // ⑧ 复盘结案：评价、事件联动 resolve、员工士气
  const rv = EM.reviewIncident(iid, { rating: 5, cause: '设备安全装置老化', actions: '全面排查同类设施并加密点检' })
  assert.equal(rv.ok, true)
  assert.equal(incById(iid).status, 'reopened')
  assert.equal(incById(iid).rating, 5)
  assert.equal(db.prepare('SELECT status FROM events WHERE id=?').get(inc.event_id).status, 'resolved')
})

test('派工推进：未到班任务挂起不推进；执行人离岗任务退回任务池', () => {
  setSetting('day', 1); setSetting('hour', 9); setSetting('tick', 0)
  resetRosters()
  const rep = EM.reportIncident({ type: 'lost', locationType: 'zone', locationId: 1, reporterRole: 'security' })
  const iid = rep.id
  const supervisor = db.prepare("SELECT * FROM staff WHERE role='运营主管' AND active=1 LIMIT 1").get()
  assert.equal(EM.gradeIncident(iid, { level: 1, commanderId: supervisor.id }).ok, true)
  assert.equal(EM.lockdownIncident(iid).ok, true)
  const task = tasksOf(iid).find(t => t.kind === 'rescue')

  // 安排中班（12 点开始）：当前 9 点有排班但未到班 → 任务挂起
  const guard = staffByRole('保安').find(s => s.id > 2) || staffByRole('安保')[0]
  scheduleMid(guard.id)
  assert.equal(EM.assignTask(task.id, guard.id).ok, true, '有排班但未到班可先接单')
  EM.processEmergency()
  assert.equal(db.prepare('SELECT progress FROM emergency_tasks WHERE id=?').get(task.id).progress, 0, '未到班不应推进')

  // 到班后（13 点）打卡在岗，任务开始推进
  setSetting('hour', 13); setSetting('tick', 4)
  assert.equal(checkinMid(guard.id).ok, true)
  EM.processEmergency()
  assert.ok(db.prepare('SELECT progress FROM emergency_tasks WHERE id=?').get(task.id).progress > 0, '到班后应推进')

  // 离岗 → 任务退回 pending
  db.prepare('UPDATE staff SET active=0 WHERE id=?').run(guard.id)
  EM.processEmergency()
  const t = db.prepare('SELECT * FROM emergency_tasks WHERE id=?').get(task.id)
  assert.equal(t.status, 'pending')
  assert.equal(t.assignee_id, null)
  db.prepare('UPDATE staff SET active=1 WHERE id=?').run(guard.id)
})

test('超时未定级自动升级：声誉受损、建议等级上调、时限重置', () => {
  const rep = EM.reportIncident({ type: 'security', locationType: 'park', reporterRole: 'ops' })
  const iid = rep.id
  const before = incById(iid)
  assert.equal(before.suggested_level, 1)
  // 超过Ⅳ级 6h 定级时限
  setSetting('tick', before.deadline_tick + 1)
  const rep0 = Number(getSetting('reputation'))
  EM.processEmergency()
  const after = incById(iid)
  assert.equal(after.suggested_level, 2, '应自动上调建议等级')
  assert.equal(after.escalations, 1)
  assert.ok(after.deadline_tick > before.deadline_tick, '时限应重置')
  assert.ok(Number(getSetting('reputation')) < rep0, '声誉应受损')
})

test('虚惊结案：封控前可撤销/虚惊，封控后不允许；事件同步关闭', () => {
  const rep = EM.reportIncident({ type: 'fire', locationType: 'zone', locationId: 1, reporterRole: 'guest' })
  const iid = rep.id
  const supervisor = db.prepare("SELECT * FROM staff WHERE role='运营主管' AND active=1 LIMIT 1").get()
  EM.gradeIncident(iid, { level: 1, commanderId: supervisor.id })

  // 直接虚惊结案（graded 状态允许）
  const r = EM.cancelIncident(iid, { falseAlarm: true })
  assert.equal(r.ok, true)
  assert.equal(incById(iid).status, 'false_alarm')
  assert.equal(db.prepare('SELECT status FROM events WHERE id=?').get(incById(iid).event_id).status, 'resolved')

  // 封控后不可撤销（区域级事件，避免全园封控污染后续用例）
  const rep2 = EM.reportIncident({ type: 'blackout', locationType: 'zone', locationId: 1, reporterRole: 'security' })
  const iid2 = rep2.id
  EM.gradeIncident(iid2, { level: 2, commanderId: supervisor.id })
  assert.equal(EM.lockdownIncident(iid2).ok, true)
  assert.equal(EM.cancelIncident(iid2, { falseAlarm: true }).ok, false, '封控后不能撤销')

  // 恢复用例 2 封控的区域 1 设施/时段，保持后续用例环境干净
  for (const r of db.prepare("SELECT * FROM rides WHERE zone_id=1 AND status='closed'").all()) {
    db.prepare("UPDATE rides SET status='operating' WHERE id=?").run(r.id)
    db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='ride' AND ride_id=? AND day>=1").run(r.id)
  }
  db.prepare('UPDATE zones SET open=1 WHERE id=1').run()
})

test('非致损事件（儿童走失）：区域设施封控后复园直接恢复运营，不转检修', () => {
  setSetting('day', 1); setSetting('hour', 9); setSetting('tick', 0)
  resetRosters()
  // 选择仍有运营设施的开放区域（前序用例可能已封控部分设施）
  const zone = db.prepare(`SELECT z.id FROM zones z
                           WHERE z.unlocked=1 AND EXISTS (SELECT 1 FROM rides r WHERE r.zone_id=z.id AND r.status='operating')
                           ORDER BY z.id LIMIT 1`).get()
  assert.ok(zone, '应存在含运营设施的区域')
  const lockedIds = db.prepare("SELECT id FROM rides WHERE zone_id=? AND status='operating'").all(zone.id).map(r => r.id)
  const rep = EM.reportIncident({ type: 'lost', locationType: 'zone', locationId: zone.id, reporterRole: 'service' })
  const iid = rep.id
  const supervisor = db.prepare("SELECT * FROM staff WHERE role='运营主管' AND active=1 LIMIT 1").get()
  assert.equal(EM.gradeIncident(iid, { level: 1, commanderId: supervisor.id }).ok, true)
  const lock = EM.lockdownIncident(iid)
  assert.equal(lock.ok, true)
  assert.ok(lockedIds.length > 0, '区域内应有被停运设施')
  // 走失无疏散任务：封控后可直接控制，但需先完成封控前置的救援（搜寻）任务
  const rescueTask = tasksOf(iid).find(t => t.gate === 'contain')
  ensureExtraGuards(1)   // 确保前序用例离岗/占用后仍有可派工安保
  const guard = staffByRole('保安').concat(staffByRole('安保')).find(s =>
    !tasksOf(iid).some(x => x.assignee_id === s.id && x.status === 'processing'))
  assert.ok(guard, '应存在可派工安保')
  putOnDuty(guard.id)
  assert.equal(EM.assignTask(rescueTask.id, guard.id).ok, true)
  runTasks(iid)
  assert.equal(EM.containIncident(iid).ok, true)
  // 控制后生成复园巡验任务（reopen 门控），同样派工完成
  const patrolTask = tasksOf(iid).find(t => t.gate === 'reopen' && t.status !== 'done')
  if (patrolTask) {
    assert.equal(EM.assignTask(patrolTask.id, guard.id).ok, true)
    runTasks(iid)
  }
  const repairBefore = repairRequests.length
  const reopen = EM.reopenIncident(iid)
  assert.equal(reopen.ok, true, reopen.msg)
  assert.equal(repairRequests.length, repairBefore, '走失事件不应产生检修转单')
  for (const rid of lockedIds) assert.equal(rideById(rid).status, 'operating', '非事故设施复园应直接恢复运营')
})

test('封控联动失败整体回滚：退款异常 → 事件保持已定级，设施仍运营，无任务无费用', () => {
  setSetting('day', 1); setSetting('hour', 9); setSetting('tick', 0)
  resetRosters()
  // 恢复前序用例可能封控的设施 3 及其时段（本用例需要运营中设施 + 开放在途时段）
  db.prepare("UPDATE rides SET status='operating' WHERE id=3 AND status<>'operating'").run()
  db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='ride' AND ride_id=3 AND day>=1").run()
  const s = rideSlot(3, 2, 10)
  const b = RSV.createReservation({ scope: 'ride', rideId: 3, slotId: s.id, qty: 2, requestId: 'em-rollback-b' })
  assert.ok(b.ok, '应能在恢复后的时段下单')
  const rep = EM.reportIncident({ type: 'fire', locationType: 'ride', locationId: 3, reporterRole: 'ops' })
  const iid = rep.id
  const supervisor = db.prepare("SELECT * FROM staff WHERE role='运营主管' AND active=1 LIMIT 1").get()
  EM.gradeIncident(iid, { level: 2, commanderId: supervisor.id })
  const cash0 = cash()

  failRefund = true
  const r = EM.lockdownIncident(iid)
  failRefund = false

  assert.equal(r.ok, false, '联动失败必须返回失败')
  assert.equal(incById(iid).status, 'grading', '事件应回滚为已定级待封控')
  assert.equal(rideById(3).status, 'operating', '设施应仍在运营')
  assert.equal(rideSlot(3, 2, 10).status, 'open', '时段应仍开放')
  assert.equal(tasksOf(iid).length, 0, '不应留下应急任务')
  assert.equal(incById(iid).rescue_cost, 0, '不应结算救援费')
  assert.equal(cash(), cash0, '现金不得变化')

  // 故障恢复后重试成功
  const retry = EM.lockdownIncident(iid)
  assert.equal(retry.ok, true, retry.msg)
  assert.equal(rideById(3).status, 'closed')
})
