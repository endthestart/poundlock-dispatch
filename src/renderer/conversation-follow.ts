import {
  afterContentChange,
  afterScroll,
  afterViewportChange,
  FOLLOWING,
  type FollowState,
  type FollowStep,
  jumpToLatest,
} from "@shared/conversation-follow";
import { type UIEvent, useCallback, useRef, useState } from "react";

/**
 * Keeps a scrolling conversation pinned to its newest content until the user
 * scrolls up, and reports when content arrived out of view. The decisions are
 * in `@shared/conversation-follow`; this attaches them to the DOM.
 *
 * Content is watched, not just the props that usually change it, because the
 * conversation grows in ways no single value tracks: streamed manager text, a
 * work-status line that changes while a task runs, a plan card, a tool trace.
 * The viewport is watched because the decision dock above the composer
 * shrinks it when a run starts.
 */
export function useConversationFollow() {
  const element = useRef<HTMLDivElement | null>(null);
  const state = useRef<FollowState>(FOLLOWING);
  const [unseen, setUnseen] = useState(false);

  const apply = useCallback((step: FollowStep) => {
    state.current = step.state;
    setUnseen(step.state.unseen);
    const node = element.current;
    if (step.pin && node) node.scrollTop = node.scrollHeight;
  }, []);

  // A callback ref: the conversation mounts and unmounts as the app moves
  // between the project view, settings and the setup wizard.
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      if (!node) return;
      const content = new MutationObserver(() => apply(afterContentChange(state.current)));
      content.observe(node, { childList: true, subtree: true, characterData: true });
      const viewport = new ResizeObserver(() => apply(afterViewportChange(state.current)));
      viewport.observe(node);
      apply(afterViewportChange(state.current));
      return () => {
        content.disconnect();
        viewport.disconnect();
        if (element.current === node) element.current = null;
      };
    },
    [apply],
  );

  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    state.current = afterScroll(state.current, { scrollTop, scrollHeight, clientHeight });
    setUnseen(state.current.unseen);
  }, []);

  const jump = useCallback(() => apply(jumpToLatest()), [apply]);

  return { ref, onScroll, unseen, jumpToLatest: jump };
}
