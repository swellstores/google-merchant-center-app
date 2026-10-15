import { describe, expect, it } from 'vitest';
import { summarizeKey } from '../../../components/lib/key-file';

describe('summarizeKey', () => {
  it('shows whose key it is without touching the secret', () => {
    const text = JSON.stringify({ type: 'service_account', client_email: 'sync@p.iam.gserviceaccount.com', private_key: 'x', project_id: 'p' });
    expect(summarizeKey(text)).toEqual({ clientEmail: 'sync@p.iam.gserviceaccount.com', projectId: 'p' });
  });

  it('explains what is wrong with other text', () => {
    expect(summarizeKey('{oops')).toEqual({ error: expect.stringContaining('not valid JSON') });
    expect(summarizeKey(JSON.stringify({ type: 'authorized_user' }))).toEqual({ error: expect.stringContaining('not a service account key') });
  });
});
