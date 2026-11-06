/**
 * "Reply" from the conversation bar: once the conversation's tab is on the
 * Mesa, put the cursor in its composer. The Mesa marks each pane's own input
 * with `data-pane-input` (Canvas.focusContent looks for the same mark); a tab
 * just opened draws it a frame or a few later, so it is looked for again for
 * about a second, and given up if the person moved focus elsewhere meanwhile.
 */
export function focusSessionComposer(sessionId: string, frames = 60, from: Element | null = document.activeElement) {
  const active = document.activeElement;
  if (active !== from && active !== document.body) return;
  const panel = document.getElementById(`dock-panel-session-${sessionId}`);
  const input = panel?.querySelector<HTMLElement>("[data-pane-input]:not([disabled])");
  if (input) { input.focus({ preventScroll: true }); return; }
  if (frames > 0) requestAnimationFrame(() => focusSessionComposer(sessionId, frames - 1, document.activeElement === from ? from : document.body));
}
