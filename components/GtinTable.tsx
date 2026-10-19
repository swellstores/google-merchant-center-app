import type { ComponentProps } from '@swell/apps-sdk/components';
import { useEffect, useRef, useState } from 'preact/hooks';
import { APP_ID, callRoute } from './lib/api';
import { latestWins } from './lib/latest-wins';
import {
  editRow,
  gtinProblem,
  gtinTableModel,
  tableValidity,
  variantList,
  variantPage,
  variantsNote,
  type GtinRow,
  type Identifiers,
  type VariantList,
} from './lib/gtin-table';
import { Notice, Root, Stack } from './lib/ui';

export const config = { description: 'Barcodes and part numbers per variant' };

const SCROLL = `
.gmc-gtin-scroll { overflow: auto; max-height: 640px; }
.gmc-gtin { width: 100%; border-collapse: collapse; }
.gmc-gtin th { text-align: left; font-weight: 600; color: var(--muted); padding: 0 8px 8px 0; }
.gmc-gtin td { padding: 4px 8px 4px 0; vertical-align: middle; }
.gmc-gtin td:first-child { min-width: 120px; }
.gmc-input.bad { border-color: var(--bad); }
.gmc-gtin.off { opacity: .55; }
.gmc-gtin.off .gmc-input { cursor: not-allowed; }
`;

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
  const locked = model.disabled || Boolean(props.readonly);

  useEffect(() => {
    props.setValidity(validity);
  }, [validity]);

  useEffect(() => () => props.setValidity(null), []);

  function change(row: GtinRow, cell: 'gtin' | 'mpn', text: string) {
    props.setValue(editRow(value, row, cell, text));
  }

  const problems = model.disabled ? [] : model.rows.map((row) => ({ key: row.key, text: gtinProblem(row) })).filter((p) => p.text);
  const scrolls = model.rows.length > 20;

  return (
    <Root>
      <style>{SCROLL}</style>
      <Stack gap={8}>
        {model.note && <span class="gmc-muted">{model.note}</span>}
        {shownNote && <span class="gmc-muted">{shownNote}</span>}
        <div class={scrolls ? 'gmc-gtin-scroll' : undefined}>
          <table class={model.disabled ? 'gmc-gtin off' : 'gmc-gtin'}>
            <thead>
              <tr>
                <th scope="col">Variant</th>
                <th scope="col">GTIN</th>
                <th scope="col">MPN</th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row) => {
                const bad = !model.disabled && gtinProblem(row) !== null;
                return (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>
                      {row.gtin === null ? (
                        <span class="gmc-muted">Per variant</span>
                      ) : (
                        <input
                          class={bad ? 'gmc-input bad' : 'gmc-input'}
                          inputMode="numeric"
                          aria-label={`GTIN of ${row.label}`}
                          aria-invalid={bad}
                          value={row.gtin}
                          disabled={locked}
                          onInput={(e) => change(row, 'gtin', (e.currentTarget as HTMLInputElement).value)}
                        />
                      )}
                    </td>
                    <td>
                      <input
                        class="gmc-input"
                        aria-label={`MPN of ${row.label}`}
                        value={row.mpn}
                        placeholder={row.mpnPlaceholder}
                        disabled={locked}
                        onInput={(e) => change(row, 'mpn', (e.currentTarget as HTMLInputElement).value)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {problems.length > 0 && (
          <Notice tone="bad">
            {problems.map((p) => (
              <div key={p.key}>{p.text}</div>
            ))}
          </Notice>
        )}
      </Stack>
    </Root>
  );
}
