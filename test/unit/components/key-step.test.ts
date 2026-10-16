import { describe, expect, it } from 'vitest';
import { keyStepView, NO_KEY, offerKey, replaceKey } from '../../../components/lib/key-step';

const keyOf = (email: string) => JSON.stringify({ type: 'service_account', client_email: email, private_key: 'x', project_id: 'p' });

describe('the key step', () => {
  it('shows the drop zone while no key is loaded or stored', () => {
    expect(keyStepView(NO_KEY, false)).toEqual({ chip: null, stored: false, replace: null, inputs: true });
  });

  it('shows only the chip once a valid key arrives', () => {
    const state = offerKey(NO_KEY, keyOf('a@p.iam.gserviceaccount.com'));
    expect(state).toMatchObject({ email: 'a@p.iam.gserviceaccount.com', error: null, replacing: false });
    expect(keyStepView(state, false)).toEqual({ chip: 'Key of a@p.iam.gserviceaccount.com', stored: false, replace: 'Replace', inputs: false });
  });

  it('keeps the chip while replacing until a new key arrives', () => {
    const loaded = offerKey(NO_KEY, keyOf('a@p.iam.gserviceaccount.com'));
    const replacing = replaceKey(loaded);
    expect(keyStepView(replacing, false)).toEqual({ chip: 'Key of a@p.iam.gserviceaccount.com', stored: false, replace: null, inputs: true });

    const wrong = offerKey(replacing, '{oops');
    expect(wrong).toMatchObject({ email: 'a@p.iam.gserviceaccount.com', text: loaded.text, error: expect.stringContaining('not valid JSON') });
    expect(keyStepView(wrong, false).inputs).toBe(true);

    const next = offerKey(wrong, keyOf('b@p.iam.gserviceaccount.com'));
    expect(keyStepView(next, false)).toEqual({ chip: 'Key of b@p.iam.gserviceaccount.com', stored: false, replace: 'Replace', inputs: false });
    expect(next.error).toBeNull();
  });

  it('explains a text that is not a key and keeps the drop zone', () => {
    const state = offerKey(NO_KEY, JSON.stringify({ type: 'authorized_user' }));
    expect(state).toMatchObject({ text: '', email: null, error: expect.stringContaining('not a service account key') });
    expect(keyStepView(state, false).inputs).toBe(true);
    expect(offerKey(state, '  ').error).toBeNull();
  });

  it('says a key is stored and opens the drop zone only on Replace key', () => {
    expect(keyStepView(NO_KEY, true)).toEqual({ chip: null, stored: true, replace: 'Replace key', inputs: false });
    expect(keyStepView(replaceKey(NO_KEY), true)).toEqual({ chip: null, stored: true, replace: null, inputs: true });
  });

  it('prefers a loaded key over the stored one', () => {
    expect(keyStepView(offerKey(NO_KEY, keyOf('a@p.iam.gserviceaccount.com')), true)).toMatchObject({ chip: expect.any(String), stored: false });
  });
});
