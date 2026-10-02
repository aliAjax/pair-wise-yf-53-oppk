import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, Menu, Progress, SimpleGrid, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  activateTrain,
  confirmGate,
  createTrain,
  dismissConflict,
  drainQueue,
  freezeTrain,
  reorderGates,
  resetTrain,
  resolveBlocker,
  setFailNextRemote,
  startRollback,
  submitCompetingDecisions,
  useAppDispatch,
  useAppSelector,
  useGetTrainHealthQuery,
  type DecisionResult,
  type ReleaseTrain,
  type RepositoryGate,
  type RollbackItem,
  type RollbackItemStatus
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const queueColor: Record<RollbackItemStatus, string> = { queued: 'gray', 'in-progress': 'blue', done: 'green', failed: 'red' };
const queueLabel: Record<RollbackItemStatus, string> = { queued: '排队中', 'in-progress': '回滚中', done: '已完成', failed: '远端拒绝' };

function SortableGate({ gate, locked, onConfirm, onRollback, onConcurrent }: {
  gate: RepositoryGate;
  locked: boolean;
  onConfirm: () => void;
  onRollback: () => void;
  onConcurrent: (winner: 'freeze' | 'rollback') => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Text fw={700}>{gate.repository}</Text>
            {gate.frozenAt && <Badge color="indigo" size="xs">已冻结 {gate.frozenAt}</Badge>}
            {gate.releasedAt && <Badge color="teal" size="xs">已发布 {gate.releasedAt}</Badge>}
            {gate.rolledBackAt && <Badge color="red" size="xs">已回滚 {gate.rolledBackAt}</Badge>}
          </Group>
          <Text size="sm" c="dimmed">
            负责人 {gate.owner} · 版本 {gate.version} · 依赖 {gate.dependency}
            {gate.dependsOn.length > 0 && <> · 同车上游 {gate.dependsOn.join('、')}</>}
          </Text>
        </div>
        <Group>
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed'}>
            {gate.status === 'confirmed' ? '门禁已确认' : '确认门禁'}
          </Button>
          <Button size="xs" color="red" variant="light" onClick={onRollback} disabled={!gate.releasedAt || Boolean(gate.rolledBackAt)}>
            进入回滚
          </Button>
          <Menu shadow="md" width={230}>
            <Menu.Target>
              <Button size="xs" variant="subtle" color="grape">并发提交</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>同一仓库同时提交两个决定</Menu.Label>
              <Menu.Item onClick={() => onConcurrent('freeze')}>冻结 + 回滚（冻结先落）</Menu.Item>
              <Menu.Item onClick={() => onConcurrent('rollback')}>冻结 + 回滚（回滚先落）</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          {!locked && <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽</Button>}
        </Group>
      </Group>
    </Card>
  );
}

export default function Home() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const [notice, setNotice] = useState<{ color: string; text: string } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5200);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!train) return null;

  const unresolved = train.blockers.filter((item) => !item.resolved).length;
  const confirmed = train.gates.filter((item) => item.status === 'confirmed').length;
  const queueDone = train.rollbackQueue.filter((q) => q.status === 'done').length;
  const queueFailed = train.rollbackQueue.find((q) => q.status === 'failed');
  const queueActive = train.rollbackQueue.some((q) => q.status === 'in-progress');
  const locked = train.status !== 'preparing' || Boolean(train.backfilled);

  function report(result: DecisionResult) {
    const color = result.kind === 'conflict' ? 'red' : result.kind === 'invalid' ? 'orange' : result.kind === 'duplicate' ? 'yellow' : 'green';
    setNotice({ color, text: result.message });
  }

  function onDragEnd(event: DragEndEvent) {
    if (locked) return;
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>开源项目发布列车 · 回滚队列控制台</Title>
          <Text>仓库进入回滚后，直接或间接依赖它的已发布仓库按反向顺序排队；前驱未完成，后继留在队列。</Text>
        </div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolling-back' ? 'orange' : train.status === 'rolled-back' ? 'red' : 'yellow'}>
          {train.status}
        </Badge>
      </header>

      {notice && <Alert color={notice.color} mb="md" withCloseButton onClose={() => setNotice(null)} title={notice.color === 'red' ? '冲突提示（409）' : '操作结果'}>{notice.text}</Alert>}

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={(confirmed / Math.max(train.gates.length, 1)) * 100} /></Card>
        <Card withBorder>
          <Text size="xs">回滚队列（已完成/总数）</Text>
          <Title order={3} c={queueFailed ? 'red' : undefined}>{queueDone}/{train.rollbackQueue.length}{queueFailed ? ' · 断点' : ''}</Title>
          <Progress mt="sm" color={queueFailed ? 'red' : 'green'} value={(queueDone / Math.max(train.rollbackQueue.length, 1)) * 100} />
        </Card>
        <Card withBorder><Text size="xs">未关闭阻断 / 远端</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved} · {health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          {train.backfilled && (
            <Alert color="violet" title="历史列车 · 回滚回执已补录">
              旧数据只记录了整列车回滚，系统已按当时冻结版本、依反向发布顺序为每个仓库补录一条历史回执，编号与正常回滚一致。
            </Alert>
          )}

          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>跨仓库依赖门禁</Title>
              <Text size="sm" c="dimmed">{locked ? '列车已锁定，顺序不可调整' : '拖动调整分批发布顺序'}</Text>
            </Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>
                  {train.gates.map((gate) => (
                    <SortableGate
                      key={gate.id}
                      gate={gate}
                      locked={locked}
                      onConfirm={() => dispatch(confirmGate(gate.id))}
                      onRollback={() => report(dispatch(startRollback(train.id, gate.id)))}
                      onConcurrent={(winner) => report(dispatch(submitCompetingDecisions(train.id, gate.id, winner)))}
                    />
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <QueueCard train={train} queueActive={queueActive} onContinue={() => void dispatch(drainQueue(train.id))} />

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.length === 0 && <Text size="sm" c="dimmed">无阻断项</Text>}
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div>
                <Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
              </Group>
            ))}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3} mb="md">发布控制</Title>
            <Stack gap="sm">
              <Group>
                <Button onClick={() => dispatch(freezeTrain())} disabled={locked}>冻结并按顺序发布</Button>
                {!train.backfilled && <Button variant="default" onClick={() => dispatch(resetTrain(train.id))}>重置列车</Button>}
              </Group>
              <Switch
                label="下一次远端回滚调用拒绝（模拟 503，验证断点续作）"
                checked={state.failNextRemote}
                onChange={(event) => dispatch(setFailNextRemote(event.currentTarget.checked))}
              />
              <Button variant="light" color="orange" disabled={!queueFailed || queueActive} onClick={() => void dispatch(drainQueue(train.id))}>
                {queueFailed ? `从断点继续重试（${queueFailed.repository}）` : '从最近完成位置继续'}
              </Button>
              <Text size="xs" c="dimmed">
                说明：重发同一个回滚编号只会沿用原来的执行记录；被远端拒绝时队列停在失败位置，前驱未完成前后继保持排队。
              </Text>
            </Stack>
          </Card>

          {train.conflicts.length > 0 && (
            <Card withBorder>
              <Title order={3} mb="md" c="red">并发决定冲突</Title>
              <Stack gap="xs">
                {train.conflicts.map((item) => (
                  <Alert key={item.id} color="red" withCloseButton onClose={() => dispatch(dismissConflict(item.id))} title={`${item.at} · ${item.repository}`}>
                    {item.message}
                  </Alert>
                ))}
              </Stack>
            </Card>
          )}

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" placeholder="2026-10-20 18:00" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史（执行记录每个回滚编号仅一条）</Title>
            <Stack gap="xs">{train.audit.slice(0, 12).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => (
              <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>
                {item.name}{item.backfilled ? '（回执已补录）' : ''}
              </Button>
            ))}
          </Card>
        </Stack>
      </div>
    </main>
  );
}

function QueueCard({ train, queueActive, onContinue }: { train: ReleaseTrain; queueActive: boolean; onContinue: () => void }) {
  if (train.rollbackQueue.length === 0) {
    return (
      <Card withBorder>
        <Title order={3} mb="xs">可续作回滚队列</Title>
        <Text size="sm" c="dimmed">暂无回滚。对任一已发布仓库点击「进入回滚」，其直接与间接依赖仓库会按反向发布顺序自动排队。</Text>
      </Card>
    );
  }
  return (
    <Card withBorder>
      <Group justify="space-between" mb="md">
        <Title order={3}>可续作回滚队列</Title>
        <Text size="sm" c="dimmed">{queueActive ? '远端执行中…' : '顺序：下游先回滚，上游后回滚'}</Text>
      </Group>
      <Stack gap="xs">
        {[...train.rollbackQueue]
          .sort((a: RollbackItem, b: RollbackItem) => {
            const rank = (s: RollbackItemStatus) => (s === 'failed' || s === 'in-progress' ? 0 : s === 'queued' ? 1 : 2);
            return rank(a.status) !== rank(b.status) ? rank(a.status) - rank(b.status) : a.order - b.order;
          })
          .map((item: RollbackItem, index) => (
            <Group key={item.rollbackNo} justify="space-between" className="row" wrap="nowrap">
              <div style={{ minWidth: 0 }}>
                <Group gap="xs">
                  <Text span fw={700}>#{item.order + 1}</Text>
                  <Badge color={queueColor[item.status]}>{queueLabel[item.status]}</Badge>
                  {item.historical && <Badge color="violet" variant="outline">历史回执</Badge>}
                  <Text span size="sm">{item.repository}@{item.version}</Text>
                </Group>
                <Text size="xs" c="dimmed" truncate>
                  {item.rollbackNo} · 源头 {item.rootRepository} · 尝试 {item.attempts} 次
                  {item.finishedAt && ` · 完成于 ${item.finishedAt}`}
                </Text>
                {item.lastError && <Text size="xs" c="red">{item.lastError}</Text>}
              </div>
              {item.status === 'failed' && <Button size="xs" color="orange" variant="light" onClick={onContinue}>从这里续作</Button>}
              {item.status === 'queued' && <Text size="xs" c="dimmed">{index === 0 ? '队首待执行' : '等待前驱完成'}</Text>}
            </Group>
          ))}
      </Stack>
    </Card>
  );
}
