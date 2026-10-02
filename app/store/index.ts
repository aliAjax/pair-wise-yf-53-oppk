import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked' | 'rolled-back';
export type GateDecision = 'freeze' | 'rollback';
export type RollbackStatus = 'queued' | 'running' | 'completed' | 'rejected';

export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
  published: boolean;
  decision?: GateDecision;
  decisionAt?: string;
}

export interface RollbackItem {
  id: string;
  gateId: string;
  repository: string;
  version: string;
  status: RollbackStatus;
  predecessors: string[];
  attempts: number;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface RollbackReceipt {
  id: string;
  rollbackId: string;
  gateId: string;
  repository: string;
  version: string;
  kind: 'rollback' | 'legacy';
  at: string;
}

export interface ConflictInfo {
  gateId: string;
  repository: string;
  attempted: GateDecision;
  held: GateDecision;
  message: string;
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  gates: RepositoryGate[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
  rollbackQueue: RollbackItem[];
  receipts: RollbackReceipt[];
  conflict: ConflictInfo | null;
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

function nowTime() { return new Date().toLocaleTimeString(); }
function nowIso() { return new Date().toISOString(); }

/** Parse "shared-ui@4.2" -> "shared-ui". Returns null for empty/external deps. */
function repoNameOf(dep: string): string | null {
  if (!dep) return null;
  const name = dep.split('@')[0].trim();
  return name.length > 0 ? name : null;
}

/** gateId -> set of gateIds it directly depends on (internal repos only). */
function buildDeps(gates: RepositoryGate[]): Map<string, Set<string>> {
  const byName = new Map(gates.map((g) => [g.repository, g]));
  const deps = new Map<string, Set<string>>();
  for (const g of gates) {
    const set = new Set<string>();
    const name = repoNameOf(g.dependency);
    if (name) {
      const target = byName.get(name);
      if (target && target.id !== g.id) set.add(target.id);
    }
    deps.set(g.id, set);
  }
  return deps;
}

/** True if gateId (transitively) depends on targetId. */
function dependsOn(gateId: string, targetId: string, gates: RepositoryGate[], deps?: Map<string, Set<string>>): boolean {
  const d = deps ?? buildDeps(gates);
  const visited = new Set<string>();
  const queue = [gateId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === targetId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const nxt of d.get(cur) ?? []) queue.push(nxt);
  }
  return false;
}

/** GateIds that (transitively) depend on gateId — the reverse dependency closure. */
function findTransitiveDependents(gateId: string, gates: RepositoryGate[], deps?: Map<string, Set<string>>): string[] {
  const d = deps ?? buildDeps(gates);
  const result: string[] = [];
  const visited = new Set<string>();
  const queue = [gateId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const g of gates) {
      if (g.id === cur || visited.has(g.id)) continue;
      if (dependsOn(g.id, cur, gates, d)) {
        visited.add(g.id);
        result.push(g.id);
        queue.push(g.id);
      }
    }
  }
  return result;
}

/**
 * Rollback order: dependents first (reverse topological).
 * If A depends on B, A is rolled back before B, so A comes first in the result.
 */
function topoRollbackOrder(ids: string[], gates: RepositoryGate[], deps?: Map<string, Set<string>>): string[] {
  const d = deps ?? buildDeps(gates);
  const idSet = new Set(ids);
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const g of gates) {
      if (!idSet.has(g.id) || g.id === id) continue;
      if (dependsOn(g.id, id, gates, d)) visit(g.id);
    }
    result.push(id);
  };
  for (const id of ids) visit(id);
  return result;
}

/** Gates in the rollback set that must complete before gateId (its transitive dependents). */
function predecessorsOf(gateId: string, allIds: string[], gates: RepositoryGate[], deps?: Map<string, Set<string>>): string[] {
  const d = deps ?? buildDeps(gates);
  return allIds.filter((otherId) => otherId !== gateId && dependsOn(otherId, gateId, gates, d));
}

/**
 * Legacy data migration: a train with no rollback records gets historical
 * receipts generated from the frozen version of each gate.
 */
function migrateTrain(train: ReleaseTrain): void {
  if (!train.rollbackQueue) train.rollbackQueue = [];
  if (!train.receipts) train.receipts = [];
  if (train.conflict === undefined) train.conflict = null;
  if (train.rollbackQueue.length === 0 && train.receipts.length === 0) {
    train.receipts = train.gates
      .filter((g) => g.version)
      .map((g) => ({
        id: `rcpt-legacy-${g.id}`,
        rollbackId: '—',
        gateId: g.id,
        repository: g.repository,
        version: g.version,
        kind: 'legacy' as const,
        at: train.freezeAt
      }));
  }
}

function migrateState(state: TrainState): TrainState {
  for (const t of state.trains) migrateTrain(t);
  return state;
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0', published: true },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0', published: true },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4', published: true },
      { id: 'g4', repository: 'shared-ui', owner: '林晓', dependency: '', status: 'confirmed', version: '4.2.1', published: true },
      { id: 'g5', repository: 'auth-sdk', owner: '赵磊', dependency: '', status: 'confirmed', version: '2.1.0', published: true }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }],
    rollbackQueue: [],
    receipts: [],
    conflict: null
  }]
};

const trainSlice = createSlice({
  name: 'train',
  initialState: migrateState(initial),
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({
        id, ...action.payload, status: 'preparing',
        gates: [], blockers: [],
        audit: [{ id: `a-${Date.now()}`, at: nowTime(), text: '创建发布列车' }],
        rollbackQueue: [], receipts: [], conflict: null
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `${gate.repository} 门禁由发布负责人确认` });
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `状态调整为 ${action.payload}` });
    },
    freezeGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      if (gate.decision === 'rollback') {
        train.conflict = {
          gateId: gate.id, repository: gate.repository, attempted: 'freeze', held: 'rollback',
          message: `冻结请求与已生效的回滚决定冲突：${gate.repository} 已先进入回滚`
        };
        train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `冻结被拒绝：${gate.repository} 已先进入回滚，先落决定生效` });
        return;
      }
      gate.decision = 'freeze';
      gate.decisionAt = nowIso();
      train.status = 'frozen';
      train.conflict = null;
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `${gate.repository} 冻结生效` });
    },
    rollbackGate(state, action: PayloadAction<{ gateId: string; rollbackNumber?: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate) return;
      train.conflict = null;
      if (gate.decision === 'freeze') {
        train.conflict = {
          gateId: gate.id, repository: gate.repository, attempted: 'rollback', held: 'freeze',
          message: `回滚请求与已生效的冻结决定冲突：${gate.repository} 已先冻结`
        };
        train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `回滚被拒绝：${gate.repository} 已先冻结，先落决定生效` });
        return;
      }
      // Idempotency: resending the same rollback number reuses the execution record.
      if (action.payload.rollbackNumber) {
        const existing = train.rollbackQueue.find((r) => r.id === action.payload.rollbackNumber);
        if (existing) {
          train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `重发回滚编号 ${action.payload.rollbackNumber}，复用已有执行记录（第 ${existing.attempts} 次尝试）` });
          return;
        }
      }
      const deps = buildDeps(train.gates);
      const dependentIds = findTransitiveDependents(gate.id, train.gates, deps)
        .filter((id) => {
          const g = train.gates.find((x) => x.id === id);
          return g?.published && g.decision !== 'freeze';
        });
      const unique = [...new Set([...dependentIds, gate.id])];
      const order = topoRollbackOrder(unique, train.gates, deps);
      const stamp = nowTime();
      const items: RollbackItem[] = order.map((gid, idx) => {
        const g = train.gates.find((x) => x.id === gid)!;
        const isTrigger = gid === gate.id;
        const id = isTrigger && action.payload.rollbackNumber ? action.payload.rollbackNumber : `rb-${gid}-${Date.now()}-${idx}`;
        return {
          id,
          gateId: gid,
          repository: g.repository,
          version: g.version,
          status: 'queued' as const,
          predecessors: predecessorsOf(gid, unique, train.gates, deps),
          attempts: 0,
          enqueuedAt: stamp
        };
      });
      train.rollbackQueue.push(...items);
      unique.forEach((id) => {
        const g = train.gates.find((x) => x.id === id);
        if (g && g.decision !== 'freeze') {
          g.decision = 'rollback';
          g.decisionAt = nowIso();
        }
      });
      train.status = 'rolled-back';
      train.audit.unshift({
        id: `a-${Date.now()}`, at: stamp,
        text: `${gate.repository} 进入回滚，${items.length} 个仓库按反向依赖顺序排队，前驱未完成的仓库留在队列中`
      });
    },
    processRollback(state, action: PayloadAction<{ rollbackId: string; ok: boolean; error?: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const item = train.rollbackQueue.find((r) => r.id === action.payload.rollbackId);
      if (!item) return;
      item.attempts += 1;
      if (!item.startedAt) item.startedAt = nowIso();
      if (action.payload.ok) {
        item.status = 'completed';
        item.completedAt = nowIso();
        const g = train.gates.find((x) => x.id === item.gateId);
        if (g) {
          g.status = 'rolled-back';
          g.decision = 'rollback';
        }
        train.receipts.push({
          id: `rcpt-${item.id}`, rollbackId: item.id, gateId: item.gateId,
          repository: item.repository, version: item.version, kind: 'rollback', at: nowIso()
        });
        train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `回滚完成：${item.repository}（编号 ${item.id}）` });
      } else {
        item.status = 'rejected';
        item.lastError = action.payload.error ?? '远端拒绝';
        train.audit.unshift({
          id: `a-${Date.now()}`, at: nowTime(),
          text: `回滚被远端拒绝：${item.repository} · ${item.lastError}（第 ${item.attempts} 次尝试）`
        });
      }
    },
    retryRollback(state, action: PayloadAction<string | undefined>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const targets = action.payload
        ? train.rollbackQueue.filter((r) => r.id === action.payload)
        : train.rollbackQueue.filter((r) => r.status === 'rejected');
      if (targets.length === 0) return;
      targets.forEach((r) => { r.status = 'queued'; r.lastError = undefined; });
      train.audit.unshift({
        id: `a-${Date.now()}`, at: nowTime(),
        text: `从最近完成位置续作回滚：${targets.map((r) => r.repository).join('、')}（已完成项跳过）`
      });
    },
    clearConflict(state) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (train) train.conflict = null;
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `阻断项已关闭：${blocker.title}` });
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      train.audit.unshift({ id: `a-${Date.now()}`, at: nowTime(), text: `调整 ${moved.repository} 的发布顺序` });
    },
    replaceState(_state, action: PayloadAction<TrainState>) { return migrateState(action.payload); }
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    }),
    rollbackRemote: builder.mutation<
      { ok: boolean; rollbackId: string; error?: string },
      { trainId: string; gateId: string; rollbackId: string; attempt: number }
    >({
      queryFn: async ({ rollbackId, attempt }) => {
        await new Promise((r) => setTimeout(r, 450));
        // Deterministic per-rollback behavior: ~30% reject on attempt 1, retries always succeed.
        if (attempt >= 2) return { data: { ok: true, rollbackId } };
        let h = 0;
        for (const ch of rollbackId) h = (h * 31 + ch.charCodeAt(0)) % 100000;
        const reject = h % 10 < 3;
        if (reject) {
          return { data: { ok: false, rollbackId, error: '远端门禁拒绝：回滚窗口校验未通过' } };
        }
        return { data: { ok: true, rollbackId } };
      }
    })
  })
});

export const { useGetTrainHealthQuery, useRollbackRemoteMutation } = releaseApi;
export const {
  activateTrain, clearConflict, confirmGate, createTrain, freezeGate,
  processRollback, reorderGates, replaceState, resolveBlocker, retryRollback,
  rollbackGate, setFreeze
} = trainSlice.actions;

/** Rollback items whose predecessors are all completed (queued or rejected). */
export function selectRunnableRollbacks(train: ReleaseTrain): RollbackItem[] {
  return train.rollbackQueue.filter((r) => {
    if (r.status !== 'queued' && r.status !== 'rejected') return false;
    return r.predecessors.every((pid) => {
      const p = train.rollbackQueue.find((x) => x.gateId === pid);
      return p?.status === 'completed';
    });
  });
}

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as TrainState));
  store.subscribe(() => localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
