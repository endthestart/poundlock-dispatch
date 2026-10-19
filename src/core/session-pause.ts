import type { ProjectStatus } from "@shared/types";

/** In-flight statuses that must not continue after Dispatch quits or reopens. */
const PAUSE_ON_DISPATCH_SESSION: readonly ProjectStatus[] = [
  "planning",
  "running",
  "waiting_for_capacity",
  "reviewing",
  "failed",
];

export function shouldPauseOnDispatchSession(project: { status: ProjectStatus }): boolean {
  return PAUSE_ON_DISPATCH_SESSION.includes(project.status);
}
