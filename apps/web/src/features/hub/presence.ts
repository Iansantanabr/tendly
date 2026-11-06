/**
 * Whether the person is here, looking at this window.
 *
 * The server pushes a notification to the phone when a conversation needs
 * attention, unless a browser says that very conversation is in front of the
 * person right now. "In front of" has to be more than a visible window: a Mac
 * left open on a conversation, with nobody at it, is exactly when the phone
 * should ring. So it takes a visible page, a focused window and a recent sign
 * of life (a key, a pointer, a touch).
 */
export const PRESENCE_INPUT_WINDOW_MS = 3 * 60_000;

export interface PresenceState {
  hidden: boolean;
  focused: boolean;
  /** When the person last touched the page (ms since epoch); 0 if never. */
  lastInputAt: number;
  now: number;
}

export function isPresent(state: PresenceState): boolean {
  if (state.hidden || !state.focused) return false;
  return state.lastInputAt > 0 && state.now - state.lastInputAt <= PRESENCE_INPUT_WINDOW_MS;
}

let lastInputAt = 0;
let installed = false;

/** Start noticing input. Safe to call twice; does nothing outside a browser. */
export function installPresence() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const seen = () => { lastInputAt = Date.now(); };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, seen, { passive: true, capture: true });
  }
}

/**
 * The conversation the person is looking at, to tell the server with the next
 * poll; nothing when a page covers the conversation or nobody is there.
 */
export function presentSession(sessionId: string | undefined, pageOpen: boolean): string | undefined {
  if (!sessionId || pageOpen || typeof document === "undefined") return undefined;
  const present = isPresent({ hidden: document.hidden, focused: document.hasFocus(), lastInputAt, now: Date.now() });
  return present ? sessionId : undefined;
}
