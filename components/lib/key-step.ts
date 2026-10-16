import { summarizeKey } from './key-file';

/** The key in the browser: the one loaded (always valid), the last text's problem, and whether the drop zone is open to replace it. */
export interface KeyState {
  text: string;
  email: string | null;
  error: string | null;
  replacing: boolean;
}

export const NO_KEY: KeyState = { text: '', email: null, error: null, replacing: false };

/** A dropped or pasted text: a valid key takes the place of the loaded one; anything else only explains itself. */
export function offerKey(state: KeyState, text: string): KeyState {
  if (!text.trim()) return { ...state, error: null };
  const summary = summarizeKey(text);
  if ('error' in summary) return { ...state, error: summary.error };
  return { text, email: summary.clientEmail, error: null, replacing: false };
}

export const replaceKey = (state: KeyState): KeyState => ({ ...state, error: null, replacing: true });

export interface KeyStepView {
  /** "Key of …", with Remove */
  chip: string | null;
  /** "A key is stored." */
  stored: boolean;
  /** The label of the text button that opens the drop zone */
  replace: 'Replace' | 'Replace key' | null;
  /** The drop zone and the paste box */
  inputs: boolean;
}

/** The drop zone shows only while there is no key, or the merchant asked to replace it. */
export function keyStepView(state: KeyState, storedKey: boolean): KeyStepView {
  const loaded = Boolean(state.email);
  return {
    chip: loaded ? `Key of ${state.email}` : null,
    stored: !loaded && storedKey,
    replace: state.replacing ? null : loaded ? 'Replace' : storedKey ? 'Replace key' : null,
    inputs: state.replacing || (!loaded && !storedKey),
  };
}
