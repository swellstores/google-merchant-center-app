import type { ComponentProps } from '@swell/apps-sdk/components';
import { APP_ID } from './lib/api';
import { choose, needRows, type NeedRow } from './lib/google-needs';
import type { AttributeOptions, OptionAttribute } from '../functions/lib/mapping/attributes';
import { Root, Stack } from './lib/ui';

export const config = { description: 'The variant options that hold the details Google asks for' };

const CSS = `
.gmc-needs-row { display: flex; flex-direction: column; gap: 4px; }
.gmc-needs-label { font-weight: 600; color: var(--muted); }
.gmc-needs-bad { color: var(--bad); font-size: 12px; }
`;

function NeedField(props: { row: NeedRow; readonly: boolean; onChoose: (optionId: string | null) => void }) {
  const { row } = props;
  const selectId = `gmc-needs-${row.attribute}`;
  const problemId = `${selectId}-missing`;
  return (
    <div class="gmc-needs-row">
      {row.kind === 'option' ? (
        <>
          <label class="gmc-needs-label" for={selectId}>
            {row.label}
          </label>
          <select
            id={selectId}
            class="gmc-input"
            value={row.chosen ?? ''}
            disabled={props.readonly}
            aria-invalid={row.missing}
            aria-describedby={row.missing ? problemId : undefined}
            onChange={(e) => props.onChoose((e.currentTarget as HTMLSelectElement).value || null)}
          >
            <option value="">Not sent</option>
            {row.missing && row.chosen && <option value={row.chosen}>Removed option</option>}
            {row.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          {row.missing && (
            <span id={problemId} class="gmc-needs-bad">
              The chosen option no longer exists
            </span>
          )}
        </>
      ) : (
        <>
          <span class="gmc-needs-label">{row.label}</span>
          <span class="gmc-muted">
            {row.kind === 'field'
              ? `Set “${row.label}” above.`
              : `Create a variant option for the ${row.label.toLowerCase()} on the Options tab, then pick it here.`}
          </span>
        </>
      )}
    </div>
  );
}

export default function GoogleNeeds(props: ComponentProps) {
  const value = (props.value ?? null) as AttributeOptions | null;
  const rows = needRows(props.context?.record, value, APP_ID);
  const readonly = Boolean(props.readonly);

  return (
    <Root>
      <style>{CSS}</style>
      {rows.length === 0 ? (
        <span class="gmc-muted">Google needs nothing from this product right now.</span>
      ) : (
        <Stack gap={12}>
          {rows.map((row) => (
            <NeedField
              key={row.attribute}
              row={row}
              readonly={readonly}
              onChoose={(optionId) => props.setValue(choose(value, row.attribute as OptionAttribute, optionId))}
            />
          ))}
        </Stack>
      )}
    </Root>
  );
}
