import type { GoogleCall } from './http';

export interface Price {
  amountMicros: string;
  currencyCode: string;
}

export interface ProductAttributes {
  title: string;
  description?: string;
  link: string;
  imageLink: string;
  additionalImageLinks?: string[];
  availability: 'IN_STOCK' | 'OUT_OF_STOCK';
  condition?: 'NEW' | 'USED' | 'REFURBISHED';
  price: Price;
  salePrice?: Price;
  brand?: string;
  mpn?: string;
  gtins?: string[];
  identifierExists?: boolean;
  googleProductCategory?: string;
  itemGroupId?: string;
  ageGroup?: string;
  gender?: string;
}

export interface ProductInput {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  /** int64 as a string; Google ignores a write older than the stored one */
  versionNumber?: string;
  productAttributes: ProductAttributes;
}

export interface InputKey {
  contentLanguage: string;
  feedLabel: string;
  offerId: string;
}

const account = (id: string) => `accounts/${id}`;

/** Swell ids are hex, so the plain `language~label~offer` form needs no encoding. */
export const productInputId = (key: InputKey) => `${key.contentLanguage}~${key.feedLabel}~${key.offerId}`;

export const getAccount = (accountId: string): GoogleCall => ({ method: 'GET', path: `/accounts/v1/${account(accountId)}` });

export const getHomepage = (accountId: string): GoogleCall => ({
  method: 'GET',
  path: `/accounts/v1/${account(accountId)}/homepage`,
});

export const registerGcp = (accountId: string): GoogleCall => ({
  method: 'POST',
  path: `/accounts/v1/${account(accountId)}/developerRegistration:registerGcp`,
  body: {},
});

export const listQuotas = (accountId: string): GoogleCall => ({
  method: 'GET',
  path: `/quota/v1/${account(accountId)}/quotas`,
  query: { pageSize: '1000' },
});

export const dataSourceName = (market: { country: string; language: string }) => `Swell — ${market.country} ${market.language}`;

export const listDataSources = (accountId: string): GoogleCall => ({
  method: 'GET',
  path: `/datasources/v1/${account(accountId)}/dataSources`,
  query: { pageSize: '1000' },
});

export function createDataSource(accountId: string, market: { country: string; language: string }): GoogleCall {
  return {
    method: 'POST',
    path: `/datasources/v1/${account(accountId)}/dataSources`,
    body: {
      displayName: dataSourceName(market),
      primaryProductDataSource: { feedLabel: market.country, contentLanguage: market.language, countries: [market.country] },
    },
  };
}

/** `name` is the data source's resource name, `accounts/{a}/dataSources/{id}`. */
export const deleteDataSource = (name: string): GoogleCall => ({ method: 'DELETE', path: `/datasources/v1/${name}` });

export const insertProductInput = (accountId: string, dataSource: string, input: ProductInput): GoogleCall => ({
  method: 'POST',
  path: `/products/v1/${account(accountId)}/productInputs:insert`,
  query: { dataSource },
  body: input,
});

/** A field in the mask but missing from the body is cleared, which ends a sale. */
export function patchProductInput(
  accountId: string,
  dataSource: string,
  input: ProductInput,
  fields: (keyof ProductAttributes)[],
): GoogleCall {
  return {
    method: 'PATCH',
    path: `/products/v1/${account(accountId)}/productInputs/${productInputId(input)}`,
    query: { dataSource, updateMask: fields.map((field) => `productAttributes.${field}`).join(',') },
    body: input,
  };
}

export const deleteProductInput = (accountId: string, dataSource: string, key: InputKey): GoogleCall => ({
  method: 'DELETE',
  path: `/products/v1/${account(accountId)}/productInputs/${productInputId(key)}`,
  query: { dataSource },
});
