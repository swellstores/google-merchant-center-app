import type { ComponentProps } from '@swell/apps-sdk/components';
import { APP_ID } from './lib/api';
import { choose, needHint, needNote, needRows, type NeedNote, type NeedRow } from './lib/google-needs';
import type { AttributeOptions, OptionAttribute } from '../functions/lib/mapping/attributes';
import { Root, Stack } from './lib/ui';

export const config = { description: 'The variant options that hold the attributes Google reads for each variant' };

const CSS = `
.gmc-needs-row { display: flex; flex-direction: column; gap: 4px; }
.gmc-needs-label { font-weight: 600; color: var(--muted); }
.gmc-needs-warn { color: var(--warn); font-size: 13px; }
.gmc-needs-bad { color: var(--bad); font-size: 13px; }
`;

const NOTE_CLASS: Record<NeedNote['tone'], string> = { warn: 'gmc-needs-warn', bad: 'gmc-needs-bad', muted: 'gmc-muted' };

function NeedField(props: { row: NeedRow; readonly: boolean; onChoose: (optionId: string | null) => void }) {
  const { row } = props;
  const selectId = `gmc-needs-${row.attribute}`;
  const noteId = `${selectId}-note`;
  const note = needNote(row);
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
            aria-describedby={note ? noteId : undefined}
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
          {note && (
            <span id={noteId} class={NOTE_CLASS[note.tone]}>
              {note.text}
            </span>
          )}
        </>
      ) : (
        <>
          <span class="gmc-needs-label">{row.label}</span>
          <span class="gmc-muted">{needHint(row)}</span>
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
        <span class="gmc-muted">This product has no variant options.</span>
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
