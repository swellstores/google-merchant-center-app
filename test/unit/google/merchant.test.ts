import { describe, expect, it } from 'vitest';
import {
  createDataSource,
  dataSourceName,
  deleteDataSource,
  deleteProductInput,
  getAccount,
  getHomepage,
  insertProductInput,
  listDataSources,
  listQuotas,
  patchProductInput,
  productInputId,
  registerGcp,
  type ProductInput,
} from '../../../functions/lib/google/merchant';

const INPUT: ProductInput = {
  offerId: 'v1',
  contentLanguage: 'en',
  feedLabel: 'US',
  versionNumber: '1',
  productAttributes: {
    title: 'Mug',
    link: 'https://shop.example.com/products/mug',
    imageLink: 'https://cdn.example.com/mug.jpg',
    availability: 'IN_STOCK',
    price: { amountMicros: '12500000', currencyCode: 'USD' },
  },
};

describe('merchant calls', () => {
  it('names a product input by language, feed label and offer id', () => {
    expect(productInputId(INPUT)).toBe('en~US~v1');
  });

  it('builds account calls', () => {
    expect(getAccount('123')).toEqual({ method: 'GET', path: '/accounts/v1/accounts/123' });
    expect(getHomepage('123')).toEqual({ method: 'GET', path: '/accounts/v1/accounts/123/homepage' });
    expect(registerGcp('123')).toEqual({
      method: 'POST',
      path: '/accounts/v1/accounts/123/developerRegistration:registerGcp',
      body: {},
    });
    expect(listQuotas('123')).toEqual({ method: 'GET', path: '/quota/v1/accounts/123/quotas', query: { pageSize: '1000' } });
  });

  it('creates a primary API data source for one market', () => {
    expect(createDataSource('123', { country: 'US', language: 'en' })).toEqual({
      method: 'POST',
      path: '/datasources/v1/accounts/123/dataSources',
      body: {
        displayName: 'Swell — US en',
        primaryProductDataSource: { feedLabel: 'US', contentLanguage: 'en', countries: ['US'] },
      },
    });
    expect(dataSourceName({ country: 'US', language: 'en' })).toBe('Swell — US en');
    expect(listDataSources('123')).toEqual({ method: 'GET', path: '/datasources/v1/accounts/123/dataSources', query: { pageSize: '1000' } });
    expect(deleteDataSource('accounts/123/dataSources/9')).toEqual({
      method: 'DELETE',
      path: '/datasources/v1/accounts/123/dataSources/9',
    });
  });

  it('inserts, patches and deletes product inputs in a data source', () => {
    const ds = 'accounts/123/dataSources/9';
    expect(insertProductInput('123', ds, INPUT)).toEqual({
      method: 'POST',
      path: '/products/v1/accounts/123/productInputs:insert',
      query: { dataSource: ds },
      body: INPUT,
    });
    expect(patchProductInput('123', ds, INPUT, ['price', 'salePrice', 'availability'])).toEqual({
      method: 'PATCH',
      path: '/products/v1/accounts/123/productInputs/en~US~v1',
      query: { dataSource: ds, updateMask: 'productAttributes.price,productAttributes.salePrice,productAttributes.availability' },
      body: INPUT,
    });
    expect(deleteProductInput('123', ds, INPUT)).toEqual({
      method: 'DELETE',
      path: '/products/v1/accounts/123/productInputs/en~US~v1',
      query: { dataSource: ds },
    });
  });
});
