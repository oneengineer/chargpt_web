import { TaskItem } from "./types";

export function ensureSingleInProgress(tasks: TaskItem[]): TaskItem[] {
  const inProgress = tasks.filter(t => t.status === "in_progress");
  if (inProgress.length <= 1) return tasks;

  // Keep the earliest in_progress, revert others to todo
  const sorted = [...inProgress].sort((a, b) => a.updatedAt - b.updatedAt);
  const keepId = sorted[0].id;

  return tasks.map(t => {
    if (t.status !== "in_progress") return t;
    if (t.id === keepId) return t;
    return { ...t, status: "todo", updatedAt: Date.now() };
  });
}

export function selectNextTodo(tasks: TaskItem[]): TaskItem | undefined {
  const todos = tasks.filter(t => t.status === "todo").sort((a, b) => a.createdAt - b.createdAt);
  return todos[0];
}

export function getCurrent(tasks: TaskItem[]): TaskItem | undefined {
  return tasks.find(t => t.status === "in_progress");
}

export function markDoneAndAdvance(tasks: TaskItem[], taskId: string): { tasks: TaskItem[]; done?: TaskItem; next?: TaskItem } {
  const now = Date.now();
  let done: TaskItem | undefined;

  let updated = tasks.map(t => {
    if (t.id !== taskId) return t;
    done = { ...t, status: "done", updatedAt: now };
    return done!;
  });

  updated = ensureSingleInProgress(updated);

  const current = getCurrent(updated);
  if (current) {
    // There is still an in_progress (not the one we just done), do not advance.
    return { tasks: updated, done, next: current };
  }

  const next = selectNextTodo(updated);
  if (!next) return { tasks: updated, done };

  updated = updated.map(t => t.id === next.id ? { ...t, status: "in_progress", updatedAt: now } : t);
  return { tasks: updated, done, next: updated.find(t => t.id === next.id) };
}

export function addTask(tasks: TaskItem[], title: string, description?: string): { tasks: TaskItem[]; created: TaskItem } {
  const now = Date.now();
  const created: TaskItem = {
    id: `t_${Math.random().toString(16).slice(2)}${now.toString(16)}`,
    title: title.trim(),
    description: description?.trim(),
    status: "todo",
    createdAt: now,
    updatedAt: now
  };

  const updated = ensureSingleInProgress([...tasks, created]);

  // If there is no in_progress, start the first task automatically
  if (!updated.some(t => t.status === "in_progress")) {
    const next = selectNextTodo(updated);
    if (next && next.id === created.id) {
      return { tasks: updated.map(t => t.id === created.id ? { ...t, status: "in_progress", updatedAt: now } : t), created };
    }
  }

  return { tasks: updated, created };
}

export function promptTemplateFor(task: TaskItem): string {
  const lines: string[] = [];
  lines.push(`NEXT TASK: ${task.title}`);
  if (task.description?.trim()) {
    lines.push("");
    lines.push("CONTEXT:");
    lines.push(task.description.trim());
  }
  lines.push("");
  lines.push("DELIVERABLES:");
  lines.push("- Provide a clear plan with steps.");
  lines.push("- Provide the exact code changes (snippets), and where to place them.");
  lines.push("- If there are tradeoffs, list them briefly and recommend one.");
  lines.push("");
  lines.push("OUTPUT FORMAT:");
  lines.push("- Markdown");
  return lines.join("\n");
}


