/**
 * The terminal view, as data.
 *
 * Every function here is `AppStateView` in, `string[]` out — no terminal and
 * no pi-tui component. That keeps the screens testable as plain values, and
 * it keeps the rendering library replaceable: what the user sees is decided
 * here, how it reaches the terminal is decided in `app.ts`.
 *
 * Colour comes in as an argument. Left at the default (`PLAIN`) every function
 * returns exactly the text a test or a pipe wants; given an enabled `Colours`
 * it returns the same text with escape codes around it, so stripping them
 * gives the plain lines back (`tests/tui-render.test.ts` holds that property).
 *
 * Nothing in this file derives workflow meaning. Status, actions, approval
 * copy and whether the composer may send all come from `@shared`, which the
 * desktop app already uses, so the two front ends cannot disagree about what
 * a project is doing.
 */

export { wrap } from "./chrome.js";
export { renderBanner, renderHeader, renderTitleBar } from "./render-banner.js";
export {
  approvalCardBody,
  approvalCardParts,
  planCardBody,
  renderApproval,
  renderPlan,
} from "./render-cards.js";
export {
  actionHints,
  CONTROL_COMMANDS,
  composerHint,
  needsInputTitle,
  renderActions,
  renderComposerHint,
  renderConversationFooter,
  renderNeedsInput,
  renderNotices,
} from "./render-hints.js";
export { renderBoard, renderConversation, renderSetup } from "./render-screens.js";
export { renderStatusLines } from "./render-status.js";
export {
  bulleted,
  heading,
  OWN_MESSAGE_SHARE,
  renderTranscript,
  subheading,
} from "./render-text.js";
