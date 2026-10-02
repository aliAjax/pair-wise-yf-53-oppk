import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain, clearConflict, confirmGate, createTrain, freezeGate,
  processRollback, reorderGates, resolveBlocker, retryRollback, rollbackGate,
  selectRunnableRollbacks, setFreeze, useGetTrainHealthQuery, useRollbackRemoteMutation,
  type RepositoryGate, type RollbackItem, type RootState
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const gateStatusColor: Record<RepositoryGate['status'], string> = {
  pending: 'yellow', confirmed: 'green', blocked: 'red', 'rolled-back': 'gray'
};
const rollbackStatusColor: Record<RollbackItem['status'], string> = {
  queued: 'yellow', running: 'blue', completed: 'green', rejected: 'red'
};

function SortableGate({ gate, rollbackItem, onConfirm, onFreeze, onRollback }: {
  gate: RepositoryGate;
  rollbackItem?: RollbackItem;
  onConfirm: () => void;
  onFreeze: () => void;
  onRollback: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Text fw={700}>{gate.repository}</Text>
            {gate.decision === 'freeze' && <Badge color="blue" size="sm">已冻结</Badge>}
            {gate.decision === 'rollback' && <Badge color="red" size="sm">已回滚</Badge>}
          </Group>
          <Text size="sm" c="dimmed">
            负责人 {gate.owner} · 依赖 {gate.dependency || '无'} · 版本 {gate.version}{gate.published ? ' · 已发布' : ''}
          </Text>
          {rollbackItem && (
            <Text size="xs" c="dimmed">
              回滚编号 {rollbackItem.id} · 尝试 {rollbackItem.attempts} 次
              {rollbackItem.lastError ? ` · ${rollbackItem.lastError}` : ''}
            </Text>
          )}
        </div>
        <Group>
          <Badge color={gateStatusColor[gate.status] ?? 'yellow'}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="outline" color="blue" onClick={onFreeze} disabled={gate.decision === 'rollback'}>冻结</Button>
          <Button size="xs" variant="outline" color="red" onClick={onRollback} disabled={gate.decision === 'freeze'}>回滚</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch();
  const store = useStore<RootState>();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const [rollbackRemote] = useRollbackRemoteMutation();
  const [running, setRunning] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;
  const rollbackDone = train?.rollbackQueue.filter((r) => r.status === 'completed').length ?? 0;
  const rollbackTotal = train?.rollbackQueue.length ?? 0;
  const hasRejected = train?.rollbackQueue.some((r) => r.status === 'rejected') ?? false;

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  async function runQueue() {
    if (!train || running) return;
    setRunning(true);
    try {
      const attempted = new Set<string>();
      while (true) {
        const t = store.getState().train;
        const currentTrain = t.trains.find((x) => x.id === t.activeId);
        const current = currentTrain ? selectRunnableRollbacks(currentTrain).find((r) => !attempted.has(r.id)) : undefined;
        if (!current || !currentTrain) break;
        attempted.add(current.id);
        const res = await rollbackRemote({
          trainId: currentTrain.id, gateId: current.gateId,
          rollbackId: current.id, attempt: current.attempts + 1
        }).unwrap();
        dispatch(processRollback({ rollbackId: current.id, ok: res.ok, error: res.error }));
        if (!res.ok) break;
      }
    } finally {
      setRunning(false);
    }
  }

  function retry() {
    if (!train) return;
    dispatch(retryRollback());
    void runQueue();
  }

  if (!train) return null;
  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>跨仓库版本、依赖、阻断项和门禁确认集中处理。回滚按反向依赖顺序排队，前驱未完成时后继留在队列。</Text></div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      {train.conflict && (
        <Alert color="red" mb="xl" withCloseButton onClose={() => dispatch(clearConflict())} title="决定冲突：先落决定生效">
          {train.conflict.message}。另一个请求已被拒绝，门禁与历史记录保持一致。
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder><Text size="xs">回滚队列</Text><Title order={3} c={hasRejected ? 'red' : undefined}>{rollbackDone}/{rollbackTotal}</Title><Progress mt="sm" value={rollbackTotal ? rollbackDone / rollbackTotal * 100 : 0} color={hasRejected ? 'red' : 'green'} /></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">冻结与回滚按仓库决定，先落生效</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => (
                  <SortableGate
                    key={gate.id}
                    gate={gate}
                    rollbackItem={train.rollbackQueue.find((r) => r.gateId === gate.id)}
                    onConfirm={() => dispatch(confirmGate(gate.id))}
                    onFreeze={() => dispatch(freezeGate(gate.id))}
                    onRollback={() => dispatch(rollbackGate({ gateId: gate.id }))}
                  />
                ))}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>可续作回滚队列</Title>
              <Group>
                <Button size="xs" variant="light" onClick={() => void runQueue()} loading={running} disabled={rollbackTotal === 0}>执行队列</Button>
                <Button size="xs" variant="outline" color="red" onClick={retry} loading={running} disabled={!hasRejected}>从最近完成处重试</Button>
              </Group>
            </Group>
            {train.rollbackQueue.length === 0 ? (
              <Text size="sm" c="dimmed">暂无回滚。在上方仓库卡片点击「回滚」，依赖它的已发布仓库会按反向顺序排队。</Text>
            ) : (
              <Stack gap="xs">
                {train.rollbackQueue.map((item) => {
                  const waiting = item.predecessors
                    .map((pid) => train.gates.find((g) => g.id === pid)?.repository)
                    .filter(Boolean) as string[];
                  return (
                    <Card key={item.id} withBorder padding="sm">
                      <Group justify="space-between">
                        <div>
                          <Group gap="xs">
                            <Text fw={600}>{item.repository}</Text>
                            <Badge size="xs" color={rollbackStatusColor[item.status]}>{item.status}</Badge>
                          </Group>
                          <Text size="xs" c="dimmed">编号 {item.id} · 版本 {item.version} · 尝试 {item.attempts} 次</Text>
                          {item.status !== 'completed' && waiting.length > 0 && (
                            <Text size="xs" c="orange">等待前驱：{waiting.join('、')}（未完成，留在队列）</Text>
                          )}
                          {item.status === 'rejected' && item.lastError && (
                            <Text size="xs" c="red">远端拒绝：{item.lastError}</Text>
                          )}
                        </div>
                        {item.status === 'rejected' && <Button size="xs" variant="subtle" onClick={retry}>重试此项</Button>}
                      </Group>
                    </Card>
                  );
                })}
              </Stack>
            )}
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => <Group key={item.id} justify="space-between" className="row"><div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div><Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button></Group>)}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">门禁未全部确认时仍可模拟冻结，审计会记录强制决定。</Text>
            <Group><Button onClick={() => dispatch(setFreeze('frozen'))}>冻结列车</Button><Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button><Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button></Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">回滚执行回执</Title>
            {train.receipts.length === 0 ? (
              <Text size="sm" c="dimmed">暂无回执。</Text>
            ) : (
              <Stack gap="xs">
                {train.receipts.map((rcpt) => (
                  <Card key={rcpt.id} withBorder padding="sm">
                    <Group justify="space-between">
                      <div>
                        <Group gap="xs">
                          <Text size="sm" fw={600}>{rcpt.repository}</Text>
                          <Badge size="xs" color={rcpt.kind === 'legacy' ? 'grape' : 'green'}>
                            {rcpt.kind === 'legacy' ? '历史回执' : '回滚回执'}
                          </Badge>
                        </Group>
                        <Text size="xs" c="dimmed">
                          {rcpt.kind === 'legacy' ? `按冻结版本 ${rcpt.version} 生成` : `版本 ${rcpt.version}`} · 编号 {rcpt.rollbackId} · {rcpt.at}
                        </Text>
                      </div>
                    </Group>
                  </Card>
                ))}
              </Stack>
            )}
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
