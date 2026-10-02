import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { useDispatch, useSelector } from 'react-redux';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';

export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  /** 展示用的主依赖（pkg@version），历史数据保留 */
  dependency: string;
  /** 同列车内直接依赖的仓库名，用于构建依赖图并级联回滚 */
  dependsOn: string[];
  status: GateStatus;
  version: string;
  /** 冻结（版本锁定）决定时间；每仓库只能落一个冻结/回滚决定 */
  frozenAt?: string | null;
  /** 已随列车发布时间；只有已发布仓库才进入回滚队列 */
  releasedAt?: string | null;
  /** 回滚完成时间 */
  rolledBackAt?: string | null;
}

export type RollbackItemStatus = 'queued' | 'in-progress' | 'done' | 'failed';

export interface RollbackItem {
  /** 回滚编号：同一编号在队列、执行记录和历史回执中只保留一条 */
  rollbackNo: string;
  trainId: string;
  gateId: string;
  repository: string;
  version: string;
  status: RollbackItemStatus;
  /** 直接/间接依赖的回滚源头仓库 */
  rootRepository: string;
  /** 发布时间，用于反向排序 */
  releasedAt: string | null;
  /** 在本次回滚计划中的位置（0 = 最先回滚），前驱优先于后继 */
  order: number;
  attempts: number;
  lastError: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 旧数据补录的历史回执 */
  historical?: boolean;
}

export interface DecisionConflict {
  id: string;
  trainId: string;
  gateId: string;
  repository: string;
  landed: 'freeze' | 'rollback';
  rejected: 'freeze' | 'rollback';
  at: string;
  message: string;
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolling-back' | 'rolled-back';
  gates: RepositoryGate[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
  rollbackQueue: RollbackItem[];
  conflicts: DecisionConflict[];
  /** 历史数据已按冻结版本补录回执 */
  backfilled?: boolean;
}

interface TrainState {
  schemaVersion: number;
  activeId: string;
  trains: ReleaseTrain[];
  /** 远端拒绝模拟：置位后下一次远端回滚调用被拒绝一次，随后自动清除 */
  failNextRemote: boolean;
}

const SCHEMA_VERSION = 2;
const STATE_KEY = 'yf53-release-state';

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function auditId() {
  return `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeAudit(text: string, at = nowTime()) {
  return { id: auditId(), at, text };
}

const initial: TrainState = {
  schemaVersion: SCHEMA_VERSION,
  activeId: 'train-101',
  failNextRemote: false,
  trains: [
    {
      id: 'train-101',
      name: 'Sept 2026 发布列车',
      freezeAt: '2026-09-30 18:00',
      status: 'frozen',
      gates: [
        { id: 'g0', repository: 'shared-ui', owner: '基础架构组', dependency: '—', dependsOn: [], status: 'confirmed', version: '4.2.0', frozenAt: '2026-09-28 10:00', releasedAt: '2026-09-30 18:02' },
        { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', dependsOn: ['shared-ui'], status: 'confirmed', version: '4.8.0', frozenAt: '2026-09-28 10:01', releasedAt: '2026-09-30 18:05' },
        { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', dependsOn: [], status: 'confirmed', version: '2.12.0', frozenAt: '2026-09-28 10:02', releasedAt: '2026-09-30 18:08' },
        { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', dependsOn: ['gateway'], status: 'confirmed', version: '1.9.4', frozenAt: '2026-09-28 10:05', releasedAt: '2026-09-30 18:12' }
      ],
      blockers: [
        { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
        { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
      ],
      audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 4 个仓库' }],
      rollbackQueue: [],
      conflicts: []
    },
    // 旧数据：当时只把整个列车标成了回滚，没有逐仓库的回滚记录
    {
      id: 'train-legacy-77',
      name: 'Aug 2026 发布列车（历史）',
      freezeAt: '2026-08-25 18:00',
      status: 'rolled-back',
      gates: [
        { id: 'lg0', repository: 'shared-ui', owner: '基础架构组', dependency: '—', dependsOn: [], status: 'confirmed', version: '4.1.0', frozenAt: '2026-08-23 09:00', releasedAt: '2026-08-25 18:04', rolledBackAt: '2026-08-26 21:30' },
        { id: 'lg1', repository: 'web-console', owner: '林岚', dependency: 'shared-ui@4.1', dependsOn: ['shared-ui'], status: 'confirmed', version: '4.7.2', frozenAt: '2026-08-23 09:03', releasedAt: '2026-08-25 18:07', rolledBackAt: '2026-08-26 21:30' }
      ],
      blockers: [],
      audit: [{ id: 'a-legacy', at: '2026-08-26 21:30', text: '状态调整为 rolled-back（整列车标记，无逐仓库回滚记录）' }],
      rollbackQueue: [],
      conflicts: []
    }
  ]
};

// ---------- 纯函数：依赖图与回滚计划 ----------

function getTrain(state: TrainState, trainId = state.activeId) {
  return state.trains.find((item) => item.id === trainId);
}

/** 找出直接或间接依赖 root 的所有仓库名（反向依赖闭包） */
export function transitiveDependents(gates: RepositoryGate[], root: string): Set<string> {
  const result = new Set<string>();
  const walk = (dep: string) => {
    for (const gate of gates) {
      if (!result.has(gate.repository) && gate.dependsOn.includes(dep)) {
        result.add(gate.repository);
        walk(gate.repository);
      }
    }
  };
  walk(root);
  return result;
}

/**
 * 回滚顺序：依赖者在前、被依赖者（根）在后；同层按发布时间倒序（后发先滚）。
 * 只纳入已发布仓库。
 */
export function rollbackOrder(gates: RepositoryGate[], root: string): RepositoryGate[] {
  const names = transitiveDependents(gates, root);
  names.add(root);
  const selected = gates.filter((gate) => names.has(gate.repository));
  const indexOf = new Map(gates.map((gate, index) => [gate.repository, index]));

  // BFS 从根向外计算深度：深度越大离上游越远，越先回滚
  const depth = new Map<string, number>([[root, 0]]);
  let frontier = [root];
  let level = 0;
  while (frontier.length) {
    level += 1;
    const next: string[] = [];
    for (const name of frontier) {
      for (const gate of gates) {
        if (gate.dependsOn.includes(name) && !depth.has(gate.repository)) {
          depth.set(gate.repository, level);
          next.push(gate.repository);
        }
      }
    }
    frontier = next;
  }

  const releaseTs = (gate: RepositoryGate) => {
    if (!gate.releasedAt) return 0;
    const ts = Date.parse(gate.releasedAt.replace(' ', 'T'));
    return Number.isNaN(ts) ? 0 : ts;
  };

  return selected
    .filter((gate) => Boolean(gate.releasedAt))
    .sort((a, b) => {
      const da = depth.get(a.repository) ?? 0;
      const db = depth.get(b.repository) ?? 0;
      if (da !== db) return db - da; // 下游先回滚，根最后
      if (releaseTs(a) !== releaseTs(b)) return releaseTs(b) - releaseTs(a); // 后发先滚
      return (indexOf.get(b.repository) ?? 0) - (indexOf.get(a.repository) ?? 0);
    });
}

export function rollbackNumber(trainId: string, gate: Pick<RepositoryGate, 'id' | 'version'>) {
  return `RB-${trainId}-${gate.id}@${gate.version}`;
}

// ---------- 旧数据迁移 ----------

/**
 * 旧数据里没有回滚记录的已回滚列车：按当时冻结版本为每个仓库
 * 生成一条历史回执，顺序与反向发布顺序一致。
 */
function backfillLegacyTrain(train: ReleaseTrain) {
  const indexOf = new Map(train.gates.map((gate, index) => [gate.repository, index]));
  const releaseTs = (gate: RepositoryGate) => {
    const ts = Date.parse((gate.releasedAt ?? '').replace(' ', 'T'));
    return Number.isNaN(ts) ? 0 : ts;
  };
  const receipts: RollbackItem[] = [...train.gates]
    .filter((gate) => Boolean(gate.rolledBackAt ?? gate.frozenAt))
    .sort((a, b) => {
      if (releaseTs(a) !== releaseTs(b)) return releaseTs(b) - releaseTs(a);
      return (indexOf.get(b.repository) ?? 0) - (indexOf.get(a.repository) ?? 0);
    })
    .map((gate, index) => ({
      rollbackNo: rollbackNumber(train.id, gate),
      trainId: train.id,
      gateId: gate.id,
      repository: gate.repository,
      version: gate.version,
      status: 'done' as const,
      rootRepository: '整列车回滚（历史记录）',
      releasedAt: gate.releasedAt ?? null,
      order: index,
      attempts: 1,
      lastError: null,
      queuedAt: gate.rolledBackAt ?? train.freezeAt,
      startedAt: gate.rolledBackAt ?? train.freezeAt,
      finishedAt: gate.rolledBackAt ?? train.freezeAt,
      historical: true
    }));

  train.rollbackQueue = receipts;
  train.backfilled = true;
  train.audit.unshift(
    makeAudit(
      `历史数据补录：按当时冻结版本为 ${receipts.length} 个仓库生成回滚回执（${receipts
        .map((item) => `${item.repository}@${item.version}`)
        .join(' → ')}）`,
      '历史'
    )
  );
}

function migrate(raw: TrainState): TrainState {
  for (const train of raw.trains ?? []) {
    train.rollbackQueue ??= [];
    train.conflicts ??= [];
    for (const gate of train.gates) {
      gate.dependsOn ??= [];
      // 兼容更早的存档：从 dependency 文本（name@version）里恢复同车依赖边
      if (gate.dependsOn.length === 0 && gate.dependency) {
        const name = gate.dependency.split('@')[0];
        if (name && name !== '—' && train.gates.some((other) => other.repository === name)) gate.dependsOn = [name];
      }
    }
    // 只要数据形态是“已回滚但没有任何逐仓库回滚记录”，就按当时冻结版本补历史回执
    // （旧存档、旧种子都覆盖；补过一次后由 backfilled/非空队列保证幂等）
    if (train.status === 'rolled-back' && train.rollbackQueue.length === 0 && !train.backfilled) {
      backfillLegacyTrain(train);
    }
  }
  raw.schemaVersion = SCHEMA_VERSION;
  raw.failNextRemote ??= false;
  return raw;
}

// ---------- 队列排序 ----------

function sortQueue(train: ReleaseTrain) {
  // 失败/进行中（断点位置）在最前，排队中其次，已完成沉底；
  // 同状态内按回滚计划位置，保证前驱先于后继、后发仓库先于上游。
  const rank = (s: RollbackItemStatus) => (s === 'failed' || s === 'in-progress' ? 0 : s === 'queued' ? 1 : 2);
  train.rollbackQueue.sort((a, b) => {
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return a.order - b.order;
  });
}

// ---------- Slice ----------

interface RollbackPlanItem {
  rollbackNo: string;
  gateId: string;
  repository: string;
  version: string;
  rootRepository: string;
  releasedAt: string | null;
  order: number;
}

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({
        id,
        ...action.payload,
        status: 'preparing',
        gates: [],
        blockers: [],
        audit: [makeAudit('创建发布列车')],
        rollbackQueue: [],
        conflicts: []
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) {
      state.activeId = action.payload;
    },
    confirmGate(state, action: PayloadAction<string>) {
      const train = getTrain(state);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      train.audit.unshift(makeAudit(`${gate.repository} 门禁由发布负责人确认`));
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = getTrain(state);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift(makeAudit(`阻断项已关闭：${blocker.title}`));
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = getTrain(state);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      train.audit.unshift(makeAudit(`调整 ${moved.repository} 的发布顺序`));
    },

    /** 仓库级冻结决定落盘（先到先得，后到的冲突请求在 thunk 层拦截） */
    freezeGate(state, action: PayloadAction<{ trainId: string; gateId: string }>) {
      const train = getTrain(state, action.payload.trainId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate) return;
      gate.frozenAt ??= nowTime();
      train.audit.unshift(makeAudit(`${gate.repository} 冻结决定落盘（版本锁定 ${gate.version}）`));
    },

    /** 整列车冻结：门禁已确认的仓库按当前顺序发布 */
    freezeTrain(state) {
      const train = getTrain(state);
      if (!train) return;
      const stamp = nowTime();
      let count = 0;
      for (const gate of train.gates) {
        if (gate.status === 'confirmed') {
          gate.frozenAt ??= stamp;
          if (!gate.releasedAt) {
            gate.releasedAt = stamp;
            gate.rolledBackAt = null;
            count += 1;
          }
        }
      }
      train.status = 'frozen';
      train.audit.unshift(makeAudit(`列车冻结，${count} 个仓库按当前顺序发布`));
    },

    /** 回滚计划入队：同一回滚编号幂等合并，只保留一条执行记录 */
    enqueueRollback(state, action: PayloadAction<{ trainId: string; rootGateId: string; items: RollbackPlanItem[] }>) {
      const train = getTrain(state, action.payload.trainId);
      if (!train) return;
      const stamp = nowTime();
      let added = 0;
      for (const plan of action.payload.items) {
        const found = train.rollbackQueue.find((item) => item.rollbackNo === plan.rollbackNo);
        if (found) {
          if (found.status === 'done') continue; // 已完成记录不再变动
          found.rootRepository = plan.rootRepository;
          found.order = plan.order;
          continue;
        }
        train.rollbackQueue.push({
          ...plan,
          trainId: action.payload.trainId,
          status: 'queued',
          attempts: 0,
          lastError: null,
          queuedAt: stamp,
          startedAt: null,
          finishedAt: null
        });
        added += 1;
      }
      train.status = 'rolling-back';
      sortQueue(train);
      // 所有编号都已完成（重发已结束的回滚）时保持 rolled-back，避免状态卡在回滚中
      if (train.rollbackQueue.every((item) => item.status === 'done')) train.status = 'rolled-back';
      const root = train.gates.find((g) => g.id === action.payload.rootGateId);
      const scope = added > 0 ? `${added} 个新仓库入队` : '所有回滚编号均已有记录，不新增执行记录';
      train.audit.unshift(
        makeAudit(
          `${root?.repository ?? '仓库'} 进入回滚，依赖它的已发布仓库按反向顺序排队（${scope}）：${action.payload.items
            .map((item) => item.repository)
            .join(' → ')}`
        )
      );
    },

    /** 记录一次远端尝试：被拒绝则停在断点，否则置为进行中 */
    rollbackAttempt(state, action: PayloadAction<{ trainId: string; rollbackNo: string; rejected: boolean; error?: string }>) {
      const train = getTrain(state, action.payload.trainId);
      const item = train?.rollbackQueue.find((q) => q.rollbackNo === action.payload.rollbackNo);
      if (!train || !item) return;
      item.attempts += 1;
      if (action.payload.rejected) {
        item.status = 'failed';
        item.lastError = action.payload.error ?? '远端拒绝回滚请求';
        train.audit.unshift(makeAudit(`回滚 ${item.rollbackNo} 第 ${item.attempts} 次尝试被远端拒绝，停在该位置，后继继续等待`));
      } else {
        item.status = 'in-progress';
        item.startedAt ??= nowTime();
        item.lastError = null;
      }
      sortQueue(train);
    },

    rollbackSucceeded(state, action: PayloadAction<{ trainId: string; rollbackNo: string }>) {
      const train = getTrain(state, action.payload.trainId);
      const item = train?.rollbackQueue.find((q) => q.rollbackNo === action.payload.rollbackNo);
      if (!train || !item) return;
      item.status = 'done';
      item.finishedAt = nowTime();
      item.lastError = null;
      const gate = train.gates.find((g) => g.id === item.gateId);
      if (gate) gate.rolledBackAt = item.finishedAt;
      // 同一回滚编号始终只有一条审计执行记录，重试成功只更新这条
      const text = `执行回滚 ${item.rollbackNo}（${item.repository}@${item.version}）${item.attempts > 1 ? `，第 ${item.attempts} 次尝试成功` : '成功'}`;
      const prior = train.audit.find((a) => a.id === `exec-${item.rollbackNo}`);
      if (prior) {
        prior.at = item.finishedAt ?? prior.at;
        prior.text = text;
      } else {
        train.audit.unshift({ id: `exec-${item.rollbackNo}`, at: item.finishedAt ?? nowTime(), text });
      }
      if (train.rollbackQueue.every((q) => q.status === 'done')) {
        train.status = 'rolled-back';
        train.audit.unshift(makeAudit(`回滚队列全部处理完成，共 ${train.rollbackQueue.length} 个仓库`));
      }
      sortQueue(train);
    },

    recordConflict(state, action: PayloadAction<Omit<DecisionConflict, 'id' | 'at'>>) {
      const train = getTrain(state, action.payload.trainId);
      if (!train) return;
      train.conflicts.unshift({ ...action.payload, id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: nowTime() });
      train.audit.unshift(makeAudit(`并发冲突：${action.payload.message}`));
    },
    dismissConflict(state, action: PayloadAction<string>) {
      const train = getTrain(state);
      if (!train) return;
      train.conflicts = train.conflicts.filter((item) => item.id !== action.payload);
    },
    setFailNextRemote(state, action: PayloadAction<boolean>) {
      state.failNextRemote = action.payload;
    },

    /** 重新走流程（历史补录列车不允许重置） */
    resetTrain(state, action: PayloadAction<string>) {
      const train = getTrain(state, action.payload);
      if (!train || train.backfilled) return;
      train.status = 'preparing';
      train.rollbackQueue = [];
      train.conflicts = [];
      for (const gate of train.gates) {
        gate.frozenAt = null;
        gate.releasedAt = null;
        gate.rolledBackAt = null;
      }
      train.audit.unshift(makeAudit('列车重置为准备状态，回滚队列与已落决定已清空'));
    },

    replaceState(_state, action: PayloadAction<TrainState>) {
      return migrate(action.payload);
    }
  }
});

// ---------- Thunks：并发决定与可续作队列 ----------

type AppDispatch = (action: unknown) => unknown;
interface AppState {
  train: TrainState;
}

export interface DecisionResult {
  ok: boolean;
  kind: 'applied' | 'duplicate' | 'conflict' | 'invalid';
  message: string;
}

const kindLabel = (kind: 'freeze' | 'rollback') => (kind === 'freeze' ? '冻结' : '回滚');

/**
 * 维护者同时提交同一仓库的冻结和回滚：
 * 先落的决定生效，另一个请求得到冲突提示（409 语义）。
 */
export function submitCompetingDecisions(trainId: string, gateId: string, winner: 'freeze' | 'rollback') {
  return (dispatch: AppDispatch, getState: () => AppState): DecisionResult => {
    const train = getState().train.trains.find((item) => item.id === trainId);
    const gate = train?.gates.find((g) => g.id === gateId);
    if (!train || !gate) return { ok: false, kind: 'invalid', message: '仓库不存在' };

    const loser = winner === 'freeze' ? 'rollback' : 'freeze';

    if (winner === 'freeze') {
      dispatch(trainSlice.actions.freezeGate({ trainId, gateId }));
    } else {
      const result = dispatch(startRollback(trainId, gateId)) as DecisionResult;
      if (!result.ok) return result; // 回滚本身不成立（如未发布），冲突无从谈起
    }

    const message = `${gate.repository} 的${kindLabel(winner)}决定先落生效，同时提交的${kindLabel(loser)}请求冲突，已被拒绝（409）`;
    dispatch(trainSlice.actions.recordConflict({ trainId, gateId, repository: gate.repository, landed: winner, rejected: loser, message }));
    return { ok: false, kind: 'conflict', message };
  };
}

/**
 * 仓库进入回滚：直接或间接依赖它的已发布仓库按反向顺序排队。
 * 幂等：重发同一回滚编号只保留一条执行记录；失败后再次调用即从断点续作重试。
 */
export function startRollback(trainId: string, gateId: string) {
  return (dispatch: AppDispatch, getState: () => AppState): DecisionResult => {
    const state = getState().train;
    const train = getTrain(state, trainId);
    const root = train?.gates.find((g) => g.id === gateId);
    if (!train || !root) return { ok: false, kind: 'invalid', message: '仓库不存在' };

    const ordered = rollbackOrder(train.gates, root.repository);
    if (!ordered.some((g) => g.id === root.id)) {
      return { ok: false, kind: 'invalid', message: `${root.repository} 尚未发布，没有可回滚的已发布版本` };
    }

    const items: RollbackPlanItem[] = ordered.map((gate, index) => ({
      rollbackNo: rollbackNumber(trainId, gate),
      gateId: gate.id,
      repository: gate.repository,
      version: gate.version,
      rootRepository: root.repository,
      releasedAt: gate.releasedAt ?? null,
      order: index
    }));

    const rootNo = rollbackNumber(trainId, root);
    const before = train.rollbackQueue.find((q) => q.rollbackNo === rootNo);

    dispatch(trainSlice.actions.enqueueRollback({ trainId, rootGateId: gateId, items }));
    void dispatch(drainQueue(trainId));

    if (before) {
      return {
        ok: true,
        kind: 'duplicate',
        message:
          before.status === 'failed'
            ? `回滚编号 ${rootNo} 已存在（远端曾拒绝），从最近完成的位置继续重试，执行记录仍只有一条`
            : `回滚编号 ${rootNo} 已在队列中，保持同一条执行记录`
      };
    }
    return { ok: true, kind: 'applied', message: `${root.repository} 进入回滚，${items.length} 个仓库按反向顺序排队（${items.map((i) => i.repository).join(' → ')}）` };
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 续作执行：严格按队列顺序取第一个未完成项（最近完成位置的下一项）；
 * 远端拒绝则停在当前位置，后继留在队列里，等待再次调用继续重试。
 */
export function drainQueue(trainId: string) {
  return async (dispatch: AppDispatch, getState: () => AppState): Promise<void> => {
    for (let guard = 0; guard < 100; guard += 1) {
      const state = getState().train;
      const train = getTrain(state, trainId);
      if (!train) return;
      // 不在这里变异状态（Immer 冻结）；排序已在 reducer 内完成，直接取第一个未完成项，
      // 即“最近完成位置”的下一项。
      const next = train.rollbackQueue.find((q) => q.status === 'queued' || q.status === 'failed');
      if (!next) return;

      const rejected = state.failNextRemote;
      if (rejected) dispatch(trainSlice.actions.setFailNextRemote(false));
      dispatch(
        trainSlice.actions.rollbackAttempt({
          trainId,
          rollbackNo: next.rollbackNo,
          rejected,
          error: rejected ? `远端 503：拒绝 ${next.repository} 的回滚 ${next.rollbackNo}` : undefined
        })
      );
      if (rejected) return; // 断点停留，后继不动

      await delay(500);
      if (!getState().train.trains.some((t) => t.id === trainId)) return;
      dispatch(trainSlice.actions.rollbackSucceeded({ trainId, rollbackNo: next.rollbackNo }));
      await delay(120);
    }
  };
}

// ---------- API 与 Store ----------

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain,
  confirmGate,
  createTrain,
  dismissConflict,
  freezeTrain,
  reorderGates,
  replaceState,
  resetTrain,
  resolveBlocker,
  setFailNextRemote
} = trainSlice.actions;

// 种子数据同样走一次迁移，让历史列车自带补录回执
const migratedSeed = migrate(JSON.parse(JSON.stringify(initial)) as TrainState);
initial.trains = migratedSeed.trains;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem(STATE_KEY);
  if (saved) {
    try {
      store.dispatch(replaceState(JSON.parse(saved) as TrainState));
    } catch {
      // 损坏的旧存档忽略，使用种子数据
    }
  }
  store.subscribe(() => localStorage.setItem(STATE_KEY, JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
export type AppStoreDispatch = typeof store.dispatch;
export const useAppDispatch = useDispatch.withTypes<AppStoreDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
