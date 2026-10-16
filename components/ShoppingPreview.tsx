import type { ComponentProps } from '@swell/apps-sdk/components';
import { useEffect, useRef, useState } from 'preact/hooks';
import { callRoute } from './lib/api';
import { previewModel, type PreviewCard, type PreviewContext } from './lib/preview';
import type { SwellProduct } from '../functions/lib/mapping/types';
import { Button, Card, Notice, Pill, Root } from './lib/ui';

export const config = { description: 'How the product looks in Google Shopping' };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Offer({ card }: { card: PreviewCard }) {
  return (
    <div class="gmc-row">
      {card.image ? (
        <img src={card.image} alt="" width={96} height={96} style={{ objectFit: 'contain', flex: 'none', borderRadius: 6, border: '1px solid var(--border)', background: '#fff' }} />
      ) : (
        <div class="gmc-muted" style={{ width: 96, height: 96, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border)', borderRadius: 6 }}>
          No image
        </div>
      )}
      <div class="gmc-body">
        <strong>{card.title}</strong>
        <div class="gmc-actions">
          {card.salePrice ? (
            <>
              <strong>{card.salePrice}</strong>
              <s class="gmc-muted">{card.price}</s>
            </>
          ) : (
            <strong>{card.price}</strong>
          )}
        </div>
        <Pill tone={card.availability === 'In stock' ? 'ok' : 'bad'}>{card.availability}</Pill>
        <span class="gmc-muted">{card.host}</span>
      </div>
    </div>
  );
}

function MarketCard({ market, cards }: { market: string; cards: PreviewCard[] }) {
  const [picked, setPicked] = useState(0);
  const card = cards[Math.min(picked, cards.length - 1)];
  return (
    <Card>
      <div class="gmc-actions">
        <strong>{market}</strong>
        {cards.length > 1 && (
          <select class="gmc-input" style={{ width: 'auto' }} aria-label={`Variant for ${market}`} value={picked} onChange={(e) => setPicked(Number((e.currentTarget as HTMLSelectElement).value))}>
            {cards.map((c, i) => (
              <option key={i} value={i}>
                {c.variant ?? c.title}
              </option>
            ))}
          </select>
        )}
      </div>
      <Offer card={card} />
    </Card>
  );
}

export default function ShoppingPreview(props: ComponentProps) {
  const [context, setContext] = useState<PreviewContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const fetchRef = useRef(props.fetch);
  fetchRef.current = props.fetch;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    callRoute<PreviewContext>(fetchRef.current, 'product?view=preview')
      .then((next) => !cancelled && setContext(next))
      .catch((e) => !cancelled && setError(messageOf(e)));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (!context) {
    return (
      <Root>
        {error ? (
          <>
            <Notice tone="bad">{error}</Notice>
            <div class="gmc-actions">
              <Button kind="text" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          </>
        ) : (
          <span class="gmc-muted" role="status">
            Loading the preview…
          </span>
        )}
      </Root>
    );
  }

  const record = props.context?.record as SwellProduct | undefined;
  if (!record) {
    return (
      <Root>
        <span class="gmc-muted">The preview appears once the product has a name and a price.</span>
      </Root>
    );
  }

  const model = previewModel(record, context);

  if ('skipped' in model) {
    return (
      <Root>
        <Notice tone="neutral">{model.skipped}. Google will not list this product.</Notice>
      </Root>
    );
  }

  if (!model.cards.length) {
    return (
      <Root>
        <Notice tone="info">Add a market on the Google settings page to see the preview.</Notice>
      </Root>
    );
  }

  const markets = [...new Set(model.cards.map((c) => c.market))];
  return (
    <Root>
      {markets.map((market) => (
        <MarketCard key={market} market={market} cards={model.cards.filter((c) => c.market === market)} />
      ))}
    </Root>
  );
}
