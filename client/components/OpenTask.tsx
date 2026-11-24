import { useEffect, useState } from 'react';
import { TaskPanelHost } from './TaskPanelHost';

// Opening a milestone from anywhere (the "Needs your action" popup, a notification): its panel opens on top of the
// page you are on, with the same rules as on the plan. No page change, so it always opens, and closing it leaves
// you where you were. The panel has its project's name; the plan is one click away from there.

const EVENT = 'pmo:open-task';

export function openTask(projectId: number, taskId: number): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { projectId, taskId } }));
}

export function OpenTaskHost() {
  const [open, setOpen] = useState<{ projectId: number; taskId: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<{ projectId: number; taskId: number }>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (!open) return null;
  return (
    <TaskPanelHost
      key={`${open.projectId}-${open.taskId}`}
      projectId={open.projectId}
      taskId={open.taskId}
      onClose={() => setOpen(null)}
      onChanged={() => window.dispatchEvent(new Event('pmo:saved'))}
    />
  );
}
