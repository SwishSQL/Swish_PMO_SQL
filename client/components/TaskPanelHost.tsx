import { useMemo } from 'react';
import type { ProjectDetail, Task } from '../../shared/types';
import { criticalPath } from '../../shared/schedule';
import { api } from '../api';
import { useApp, useLoad, useToast } from '../lib/app';
import { TaskPanel } from './TaskPanel';
import { ClosureDocsPanel } from './ClosureDocs';

// The task panel outside the project page (My work): the same panel, the same rules, loaded with the task's
// project. Changes save as they would on the plan, and the page that opened it refreshes.

/** Given to this person, as owner or co-owner. */
export function isMine(task: Task, me: { id: number; name: string }): boolean {
  if (task.assigneeId === me.id) return true;
  const name = me.name.trim().toLowerCase();
  return (task.coOwners ?? '').split(/\s*[,،]\s*/).some((n) => n.trim().toLowerCase() === name);
}

export function TaskPanelHost({ projectId, taskId, preset, onClose, onChanged }: { projectId: number; taskId: number; preset?: 'done' | 'reopen'; onClose: () => void; onChanged: () => void }) {
  const { meta, can, canGovernProject } = useApp();
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<ProjectDetail>(`/api/projects/${projectId}`), [projectId]);
  const crit = useMemo(() => (data ? criticalPath(data.tasks, data.dependencies) : null), [data]);
  if (!data || !crit) return null;
  const task = data.tasks.find((x) => x.id === taskId);
  if (!task) return null;
  const canGovern = canGovernProject(data.project.managerId, data.project.departmentId);
  if (task.systemKey === 'closure_docs') {
    return <ClosureDocsPanel detail={data} canGovern={canGovern} canClose={can('projects.approve_close')} onClose={onClose} />;
  }
  const canEdit = canGovern || (can('projects.edit_own') && task.kind !== 'summary' && isMine(task, meta.me));
  const after = async (work: Promise<unknown>) => {
    try {
      const r = await work;
      reload();
      onChanged();
      return r;
    } catch (e) {
      toast((e as Error).message, 'bad');
      return null;
    }
  };
  return (
    <TaskPanel
      task={task}
      tasks={data.tasks}
      dependencies={data.dependencies}
      users={meta.users}
      departmentId={data.project.departmentId}
      baselined={Boolean(data.project.baselineEnd)}
      canEdit={canEdit}
      canGovern={canGovern}
      isCritical={crit.critical.has(task.id)}
      floatDays={crit.floatDays.get(task.id)}
      preset={preset}
      onClose={onClose}
      onPatch={(patch) => after(api.patch(`/api/tasks/${task.id}`, patch))}
      onReload={() => (reload(), onChanged())}
      onAddDependency={(pred, lag) => void after(api.post(`/api/projects/${projectId}/dependencies`, { predecessorId: pred, successorId: task.id, lagDays: lag }))}
      onRemoveDependency={(depId) => void after(api.del(`/api/dependencies/${depId}`))}
      onDelete={() => void after(api.del(`/api/tasks/${task.id}`)).then(onClose)}
    />
  );
}
