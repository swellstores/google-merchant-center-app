import type { ComponentProps } from '@swell/apps-sdk/components';
import { CATEGORY_LIST_URL, categoryText, categoryValue } from './lib/category-field';
import { ExternalLink, Root } from './lib/ui';

export const config = { description: 'The Google product category, with a link to Google\'s list of categories' };

const CSS = `
.gmc-category { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.gmc-category .gmc-input { flex: 1 1 240px; width: auto; min-width: 0; }
.gmc-category a { white-space: nowrap; }
`;

export default function GoogleCategoryField(props: ComponentProps) {
  return (
    <Root>
      <style>{CSS}</style>
      <div class="gmc-category">
        <input
          class="gmc-input"
          type="text"
          aria-label="Google product category"
          placeholder="e.g. 1604 or Apparel & Accessories > Clothing > Shirts & Tops"
          value={categoryText(props.value)}
          readOnly={Boolean(props.readonly)}
          onInput={(e) => props.setValue(categoryValue((e.currentTarget as HTMLInputElement).value))}
        />
        <ExternalLink href={CATEGORY_LIST_URL}>Find your category</ExternalLink>
      </div>
    </Root>
  );
}
