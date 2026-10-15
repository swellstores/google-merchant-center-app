/** Who the pasted key belongs to, checked in the browser before anything is sent. */
export function summarizeKey(text: string): { clientEmail: string; projectId: string | null } | { error: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'This is not valid JSON. Paste the whole key file.' };
  }
  if (parsed?.type !== 'service_account' || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    return { error: 'This is not a service account key. Download a JSON key from the service account page.' };
  }
  return { clientEmail: parsed.client_email, projectId: typeof parsed.project_id === 'string' ? parsed.project_id : null };
}
