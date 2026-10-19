import type { ComponentProps } from '@swell/apps-sdk/components';
import { listed, nextValue } from './lib/listing-switch';
import { Root } from './lib/ui';

export const config = { description: 'A switch that lists the product in Google or keeps it out' };

const CSS = `
.gmc-switch { display: inline-flex; align-items: center; gap: 10px; cursor: pointer; align-self: flex-start; }
.gmc-switch:has(input:disabled) { cursor: default; opacity: .6; }
.gmc-switch input { appearance: none; -webkit-appearance: none; position: relative; flex: none; width: 36px; height: 20px; margin: 0; border-radius: 999px; background: var(--border); cursor: inherit; transition: background .15s; }
.gmc-switch input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 2px rgba(0, 0, 0, .3); transition: transform .15s; }
.gmc-switch input:checked { background: var(--accent); }
.gmc-switch input:checked::after { transform: translateX(16px); background: var(--accent-text); }
@media (prefers-reduced-motion: reduce) { .gmc-switch input, .gmc-switch input::after { transition: none; } }
`;

export default function GoogleListingSwitch(props: ComponentProps) {
  return (
    <Root>
      <style>{CSS}</style>
      <label class="gmc-switch">
        <input
          type="checkbox"
          role="switch"
          checked={listed(props.value)}
          disabled={Boolean(props.readonly)}
          onChange={(e) => props.setValue(nextValue((e.currentTarget as HTMLInputElement).checked))}
        />
        <span>List this product in Google</span>
      </label>
    </Root>
  );
}
