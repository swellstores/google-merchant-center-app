export type StepId = 'project' | 'key' | 'access' | 'connect';
export interface CheckResult {
  id: string;
  ok: boolean;
  message: string;
  help?: string;
}
export interface StepState {
  status: 'idle' | 'ok' | 'failed';
  problems: CheckResult[];
}

/** Which setup step each of Google's checks belongs to. */
export const STEP_OF_CHECK: Record<string, StepId> = {
  key: 'key',
  token: 'key',
  registration: 'access',
  account: 'access',
  homepage: 'access',
};

/** Folds the route's check report into per-step states; steps without checks stay idle, except that a full pass marks every step ok. */
export function stepStates(checks: CheckResult[], allOk: boolean): Record<StepId, StepState> {
  const states: Record<StepId, StepState> = {
    project: { status: 'idle', problems: [] },
    key: { status: 'idle', problems: [] },
    access: { status: 'idle', problems: [] },
    connect: { status: 'idle', problems: [] },
  };
  for (const check of checks) {
    const step = STEP_OF_CHECK[check.id];
    if (!step) continue;
    const state = states[step];
    if (!check.ok) {
      state.status = 'failed';
      state.problems.push(check);
    } else if (state.status === 'idle') {
      state.status = 'ok';
    }
  }
  const tokenOk = checks.some((check) => check.id === 'token' && check.ok);
  if (allOk || tokenOk) states.project.status = 'ok';
  if (allOk) {
    for (const state of Object.values(states)) state.status = 'ok';
  }
  return states;
}
