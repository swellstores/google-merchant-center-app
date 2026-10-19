import type { ComponentProps } from '@swell/apps-sdk/components';
import { useEffect, useRef, useState } from 'preact/hooks';
import { APP_ID, callRoute } from './lib/api';
import { latestWins } from './lib/latest-wins';
import {
  gtinProblem,
  gtinTableModel,
  setCell,
  tableValidity,
  variantList,
  variantPage,
  variantsNote,
  type GtinRow,
  type Identifiers,
  type VariantList,
} from './lib/gtin-table';
import { Root, Stack } from './lib/ui';

export const config = { description: 'Barcodes and part numbers per variant' };

const CSS = `
.gmc-gtin-scroll { overflow: auto; max-height: 640px; }
.gmc-gtin { width: 100%; border-collapse: collapse; table-layout: fixed; }
.gmc-gtin th { text-align: left; font-weight: 600; color: var(--muted); padding: 0 8px 8px 0; }
.gmc-gtin td { padding: 8px 8px 8px 0; vertical-align: top; }
.gmc-gtin tbody tr + tr > td { border-top: 1px solid var(--border); }
.gmc-gtin .gmc-gtin-variant { padding-top: 16px; overflow-wrap: anywhere; }
.gmc-gtin-caption { font-weight: 600; color: var(--muted); }
.gmc-gtin-field { display: flex; flex-direction: column; gap: 4px; }
.gmc .gmc-input.bad, .gmc .gmc-input.bad:focus { border-color: var(--bad); }
.gmc-gtin-reason { color: var(--bad); font-size: 12px; }
`;

function GtinInput(props: { row: GtinRow; label: string; readonly: boolean; onInput: (text: string) => void }) {
  const problem = gtinProblem(props.row);
  const reasonId = `gmc-gtin-reason-${props.row.key}`;
  return (
    <div class="gmc-gtin-field">
      <input
        class={problem ? 'gmc-input bad' : 'gmc-input'}
        inputMode="numeric"
        aria-label={props.label}
        aria-invalid={problem !== null}
        aria-describedby={problem ? reasonId : undefined}
        value={props.row.gtin}
        disabled={props.readonly}
        onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value)}
      />
      {problem && (
        <span id={reasonId} class="gmc-gtin-reason">
          {problem}
        </span>
      )}
    </div>
  );
}

export default function GtinTable(props: ComponentProps) {
  const record = (props.context?.record ?? {}) as { id?: string; variants?: unknown; $app?: Record<string, any> };
  const value = (props.value ?? null) as Identifiers | null;
  const page = variantPage(record);
  const [loaded, setLoaded] = useState<VariantList | null>(null);
  const [failed, setFailed] = useState(false);
  const loads = useRef(latestWins());
  const wantsAll = Boolean(record.id && page);

  useEffect(() => {
    if (!wantsAll) return;
    const ticket = loads.current.start();
    callRoute<unknown>(props.fetch, `product?id=${encodeURIComponent(record.id!)}&view=variants`)
      .then((answer) => {
        const list = variantList(answer);
        loads.current.accept(ticket, () => (list?.variants.length ? setLoaded(list) : setFailed(true)));
      })
      .catch(() => loads.current.accept(ticket, () => setFailed(true)));
    // An unmount counts as a newer start, so a late answer is dropped.
    return () => {
      loads.current.start();
    };
  }, [record.id, wantsAll]);

  const model = gtinTableModel(record, value, APP_ID, loaded?.variants);
  const shownNote = variantsNote(page, loaded, failed);
  const validity = tableValidity(model);
  const readonly = Boolean(props.readonly);

  useEffect(() => {
    props.setValidity(validity);
  }, [validity]);

  // The admin unmounts the table while "No barcode" hides it
  useEffect(() => () => props.setValidity(null), []);

  function change(row: GtinRow, cell: 'gtin' | 'mpn', text: string) {
    props.setValue(setCell(value, row.key, cell, text));
  }

  if (!model.perVariant) {
    const [row] = model.rows;
    return (
      <Root>
        <style>{CSS}</style>
        <Stack gap={4}>
          <span class="gmc-gtin-caption" aria-hidden="true">
            GTIN
          </span>
          <GtinInput row={row} label="GTIN" readonly={readonly} onInput={(text) => change(row, 'gtin', text)} />
        </Stack>
      </Root>
    );
  }

  return (
    <Root>
      <style>{CSS}</style>
      <Stack gap={8}>
        {shownNote && <span class="gmc-muted">{shownNote}</span>}
        {model.rows.length === 0 ? (
          <span class="gmc-muted">This product has no active variants.</span>
        ) : (
          <div class={model.rows.length > 20 ? 'gmc-gtin-scroll' : undefined}>
            <table class="gmc-gtin">
              <colgroup>
                <col style={{ width: '22%' }} />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Variant</th>
                  <th scope="col">GTIN</th>
                  <th scope="col">MPN</th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => (
                  <tr key={row.key}>
                    <td class="gmc-gtin-variant">{row.label}</td>
                    <td>
                      <GtinInput row={row} label={`GTIN of ${row.label}`} readonly={readonly} onInput={(text) => change(row, 'gtin', text)} />
                    </td>
                    <td>
                      <input
                        class="gmc-input"
                        aria-label={`MPN of ${row.label}`}
                        value={row.mpn ?? ''}
                        placeholder={row.mpnPlaceholder}
                        disabled={readonly}
                        onInput={(e) => change(row, 'mpn', (e.currentTarget as HTMLInputElement).value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Stack>
    </Root>
  );
}
