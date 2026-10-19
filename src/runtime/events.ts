type DispatchEventType = "status" | "activity" | "tool" | "capacity" | "recovery" | "workflow";

export interface DispatchEvent {
  type: DispatchEventType;
  id: string;
  createdAt: string;
  projectId?: string;
  workflowId?: string;
  taskId?: string;
  attemptId?: string;
  piSessionId?: string;
  text?: string;
  payload?: Record<string, unknown>;
}

type DispatchEventListener = (event: DispatchEvent) => void;

export class DispatchEventBus {
  private listeners = new Set<DispatchEventListener>();
  private seen = new Set<string>();

  subscribe(listener: DispatchEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: DispatchEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > 4000) {
      this.seen = new Set([...this.seen].slice(-2000));
    }
    for (const listener of this.listeners) listener(event);
  }
}
