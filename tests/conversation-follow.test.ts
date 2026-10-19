import {
  afterContentChange,
  afterScroll,
  afterViewportChange,
  distanceFromBottom,
  FOLLOW_THRESHOLD_PX,
  FOLLOWING,
  type FollowState,
  jumpToLatest,
  type ScrollMetrics,
} from "@shared/conversation-follow";
import { describe, expect, it } from "vitest";

/** A scroll view of `height` px showing a document `total` px tall, `top` px down. */
function view(total: number, top: number, height = 500): ScrollMetrics {
  return { scrollTop: top, scrollHeight: total, clientHeight: height };
}

describe("following the newest content", () => {
  it("starts pinned to the bottom", () => {
    expect(FOLLOWING).toEqual({ following: true, unseen: false });
  });

  it("scrolls to new content while pinned, however much arrives and however it arrives", () => {
    // Streamed text, a work-status line, a plan card: each is just "content
    // changed". None of them scroll the view or fire a scroll event, so a view
    // that was pinned is still pinned when the next change lands.
    let state: FollowState = FOLLOWING;
    for (let change = 0; change < 5; change++) {
      const step = afterContentChange(state);
      expect(step.pin).toBe(true);
      expect(step.state.unseen).toBe(false);
      state = step.state;
    }
  });

  it("leaves a view the user scrolled up alone and remembers that something arrived", () => {
    const up = afterScroll(FOLLOWING, view(3000, 1200));
    expect(up.following).toBe(false);
    const first = afterContentChange(up);
    expect(first).toEqual({ state: { following: false, unseen: true }, pin: false });
    // Further changes keep it unpinned, and do not churn the state.
    const second = afterContentChange(first.state);
    expect(second.pin).toBe(false);
    expect(second.state).toBe(first.state);
  });

  it("resumes following, and clears the notice, when the user scrolls back to the bottom", () => {
    const up = afterContentChange(afterScroll(FOLLOWING, view(3000, 1200))).state;
    expect(up.unseen).toBe(true);
    const back = afterScroll(up, view(3000, 2500));
    expect(back).toEqual({ following: true, unseen: false });
    expect(afterContentChange(back).pin).toBe(true);
  });

  it("keeps the notice while the user is still reading further up", () => {
    const up = afterContentChange(afterScroll(FOLLOWING, view(3000, 1200))).state;
    const stillUp = afterScroll(up, view(3000, 1300));
    expect(stillUp).toEqual({ following: false, unseen: true });
  });

  it("counts a view within the threshold of the bottom as at the bottom", () => {
    const total = 3000;
    const height = 500;
    const nearBottom = total - height - (FOLLOW_THRESHOLD_PX - 1);
    expect(afterScroll(FOLLOWING, view(total, nearBottom)).following).toBe(true);
    expect(afterScroll(FOLLOWING, view(total, nearBottom - 2)).following).toBe(false);
  });

  it("jump to latest, or opening another project, follows again from the bottom", () => {
    expect(jumpToLatest()).toEqual({ state: FOLLOWING, pin: true });
  });

  it("measures distance from the bottom of the scrolled content", () => {
    expect(distanceFromBottom(view(3000, 2500))).toBe(0);
    expect(distanceFromBottom(view(3000, 2000))).toBe(500);
  });
});

describe("when the decision dock changes the visible height", () => {
  // The dock sits between the conversation and the composer, so when a run
  // starts it takes its height from the conversation. The scroll position does
  // not move, so a view that was at the bottom kept its old scrollTop and the
  // last lines ended up cut off below the fold, right under the dock.
  it("keeps a pinned view at the bottom, so the last line stays above the dock", () => {
    const step = afterViewportChange(FOLLOWING);
    expect(step).toEqual({ state: FOLLOWING, pin: true });
  });

  it("does not drag a view the user scrolled up back down", () => {
    const up = afterScroll(FOLLOWING, view(3000, 1200));
    expect(afterViewportChange(up)).toEqual({ state: up, pin: false });
  });

  it("is not new content, so it never raises the new-activity notice", () => {
    const up = afterScroll(FOLLOWING, view(3000, 1200));
    expect(afterViewportChange(up).state.unseen).toBe(false);
  });
});
