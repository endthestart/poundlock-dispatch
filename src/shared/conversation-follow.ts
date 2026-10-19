/**
 * Whether the conversation follows new content, decided apart from the DOM so
 * every case is testable. The renderer feeds it the events it observes and
 * does what `pin` says.
 *
 * Follow state changes only when the *user* scrolls. New content and a
 * resized viewport change neither the scroll position nor fire a scroll event,
 * so a view that was at the bottom stays "following" however much arrives, and
 * one the user scrolled away from stays put.
 */

/** Within this many pixels of the bottom counts as "at the latest". */
export const FOLLOW_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface FollowState {
  /** Pinned to the bottom: whatever arrives is scrolled into view. */
  following: boolean;
  /** Content arrived while the user was reading further up. */
  unseen: boolean;
}

/** What to do with the scroll position after an event. */
export interface FollowStep {
  state: FollowState;
  /** Scroll to the bottom now. */
  pin: boolean;
}

export const FOLLOWING: FollowState = { following: true, unseen: false };

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/** The user scrolled. Following resumes only once they are back at the bottom. */
export function afterScroll(
  state: FollowState,
  metrics: ScrollMetrics,
  threshold = FOLLOW_THRESHOLD_PX,
): FollowState {
  const following = distanceFromBottom(metrics) < threshold;
  return { following, unseen: following ? false : state.unseen };
}

/** Messages, streamed text or work status changed what the conversation holds. */
export function afterContentChange(state: FollowState): FollowStep {
  if (state.following) return { state, pin: true };
  return { state: state.unseen ? state : { ...state, unseen: true }, pin: false };
}

/**
 * The visible height or width changed: the decision dock appeared or grew, or
 * the window was resized. That is not new content, but a view that was at the
 * bottom would otherwise be left with its last lines cut off below the fold.
 */
export function afterViewportChange(state: FollowState): FollowStep {
  return { state, pin: state.following };
}

/** Opening a project, or "jump to latest": start following again, at the bottom. */
export function jumpToLatest(): FollowStep {
  return { state: FOLLOWING, pin: true };
}
