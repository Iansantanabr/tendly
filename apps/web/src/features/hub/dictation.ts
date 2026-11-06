import { getCurrentInstance, onBeforeUnmount, ref, type Ref } from "vue";

/**
 * Dictation for a composer, through the browser's Web Speech API.
 *
 * Interim words show while the person speaks; each final phrase goes to
 * `onFinal`, which the composer inserts at its cursor so it can be edited
 * before sending. The first use asks the person to acknowledge that the
 * browser's speech service hears the audio (Chrome sends it to Google).
 */

/** The part of `SpeechRecognition` used here, so a test can stand in for it. */
export interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; [index: number]: { transcript: string } | undefined }>;
}
export interface KeyStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

export const NOTICE_KEY = "tendly.hub.dictation-notice";

export type DictationError = "" | "denied" | "no-microphone" | "network" | "failed";

/** Why dictation stopped, in words for the person, with how to fix it. English source; translated by the caller. */
export const DICTATION_ERRORS: Record<Exclude<DictationError, "">, string> = {
  denied: "Microphone access is blocked. Allow it in the browser’s site settings (the icon left of the address), then try again.",
  "no-microphone": "No microphone was found. Connect one or pick it in the system’s sound settings, then try again.",
  network: "The browser’s speech service could not be reached. Check the connection and try again.",
  failed: "Dictation stopped unexpectedly. Try again.",
};

/** The browser's recognizer, if it has one. */
export function browserRecognizer(scope: unknown = typeof window === "undefined" ? undefined : window): (() => Recognizer) | undefined {
  const holder = scope as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer } | undefined;
  const Constructor = holder?.SpeechRecognition ?? holder?.webkitSpeechRecognition;
  return Constructor ? () => new Constructor() : undefined;
}

/** The recognizer's language for a UI locale: pt-BR unless the interface is in another language. */
export function speechLang(locale: string | undefined): string {
  if (!locale) return "pt-BR";
  if (locale === "en") return "en-US";
  return locale;
}

function defaultStorage(): KeyStore | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

export interface DictationOptions {
  lang: () => string;
  onFinal: (text: string) => void;
  create?: (() => Recognizer) | undefined;
  storage?: KeyStore | undefined;
}

export interface Dictation {
  supported: boolean;
  listening: Ref<boolean>;
  interim: Ref<string>;
  error: Ref<DictationError>;
  /** The one-time notice is showing, waiting for "Got it". */
  notice: Ref<boolean>;
  toggle(): void;
  start(): void;
  stop(): void;
  acknowledge(): void;
  dismissError(): void;
  dispose(): void;
}

/** The state machine, without Vue's lifecycle: idle → (notice) → listening → idle | error. */
export function createDictation(options: DictationOptions): Dictation {
  const create = "create" in options ? options.create : browserRecognizer();
  const storage = "storage" in options ? options.storage : defaultStorage();
  const listening = ref(false), interim = ref(""), error = ref<DictationError>(""), notice = ref(false);
  let recognizer: Recognizer | undefined;
  /** The person wants it on: a recognizer that ends on silence is started again. */
  let wanted = false;

  const acknowledged = () => { try { return storage?.getItem(NOTICE_KEY) === "1"; } catch { return true; } };

  function begin() {
    if (!create) return;
    const current = create();
    recognizer = current;
    current.lang = options.lang();
    current.continuous = true;
    current.interimResults = true;
    current.onresult = event => {
      if (recognizer !== current) return;
      let pending = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]!;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) { const said = text.trim(); if (said) options.onFinal(said); }
        else pending += text;
      }
      interim.value = pending.trim();
    };
    current.onerror = event => {
      if (recognizer !== current) return;
      const code = event.error;
      if (code === "no-speech" || code === "aborted") return;
      error.value = code === "not-allowed" || code === "service-not-allowed" ? "denied"
        : code === "audio-capture" ? "no-microphone"
        : code === "network" ? "network" : "failed";
      wanted = false;
    };
    current.onend = () => {
      if (recognizer !== current) return;
      if (wanted) { try { current.start(); return; } catch { wanted = false; } }
      recognizer = undefined; listening.value = false; interim.value = "";
    };
    try { current.start(); listening.value = true; wanted = true; error.value = ""; }
    catch { recognizer = undefined; listening.value = false; error.value = "failed"; }
  }

  function start() {
    if (!create || listening.value) return;
    if (!acknowledged()) { notice.value = true; return; }
    begin();
  }
  function stop() {
    wanted = false;
    const current = recognizer;
    if (!current) { listening.value = false; interim.value = ""; return; }
    // stop() still delivers what was heard; the end event then settles the state.
    try { current.stop(); }
    catch { recognizer = undefined; listening.value = false; interim.value = ""; }
  }
  function dispose() {
    wanted = false; notice.value = false;
    const current = recognizer;
    recognizer = undefined; listening.value = false; interim.value = "";
    if (current) { current.onresult = current.onerror = current.onend = null; try { current.abort(); } catch { /* Already ended. */ } }
  }
  return {
    supported: !!create,
    listening, interim, error, notice,
    toggle: () => (listening.value ? stop() : start()),
    start, stop, dispose,
    acknowledge() {
      try { storage?.setItem(NOTICE_KEY, "1"); } catch { /* Asked again next time, then. */ }
      notice.value = false;
      begin();
    },
    dismissError() { error.value = ""; },
  };
}

/** `createDictation`, stopped when the component that uses it unmounts. */
export function useDictation(options: DictationOptions): Dictation {
  const dictation = createDictation(options);
  if (getCurrentInstance()) onBeforeUnmount(() => dictation.dispose());
  return dictation;
}
