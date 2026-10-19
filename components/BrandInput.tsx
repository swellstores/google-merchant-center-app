import type { ComponentProps } from '@swell/apps-sdk/components';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { callRoute } from './lib/api';
import { latestWins, suggestions } from './lib/brand-input';
import { Root } from './lib/ui';

export const config = { description: 'A brand field that suggests the brands already used in the store' };

const CSS = `
.gmc-brand { position: relative; }
.gmc-brand-list { position: absolute; z-index: 10; left: 0; right: 0; top: 100%; margin: 4px 0 0; padding: 4px; list-style: none; max-height: 240px; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 4px 12px rgba(0, 0, 0, .15); }
.gmc-brand-list li { padding: 6px 8px; border-radius: 4px; cursor: pointer; }
.gmc-brand-list li[aria-selected="true"] { background: var(--subtle); }
`;

export default function BrandInput(props: ComponentProps) {
  const text = typeof props.value === 'string' ? props.value : '';
  const [all, setAll] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const loads = useRef(latestWins());

  useEffect(() => {
    const ticket = loads.current.start();
    callRoute<{ brands: string[] }>(props.fetch, 'brands')
      .then((answer) => loads.current.accept(ticket, () => setAll(Array.isArray(answer?.brands) ? answer.brands : [])))
      .catch(() => {});
    // An unmount counts as a newer start, so a late answer is dropped.
    return () => {
      loads.current.start();
    };
  }, []);

  const shown = useMemo(() => suggestions(all, text), [all, text]);
  const listed = open && shown.length > 0;

  function pick(brand: string) {
    props.setValue(brand);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + shown.length) % shown.length);
    } else if (e.key === 'Enter' && listed && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    }
  }

  return (
    <Root>
      <style>{CSS}</style>
      <div class="gmc-brand">
        <input
          class="gmc-input"
          role="combobox"
          aria-expanded={listed}
          aria-autocomplete="list"
          autoComplete="off"
          value={text}
          disabled={Boolean(props.readonly)}
          onInput={(e) => {
            props.setValue((e.currentTarget as HTMLInputElement).value || null);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {listed && (
          <ul class="gmc-brand-list" role="listbox">
            {shown.map((brand, i) => (
              <li key={brand} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(brand); }} onClick={() => pick(brand)}>
                {brand}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Root>
  );
}
