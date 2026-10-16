#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const DEFAULT_API_VERSION = '2026-07';
const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEMPLATE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEYCHAIN_SERVICES = Object.freeze({
  clientId: 'com.kufucat.shopify-page-admin.client-id',
  clientSecret: 'com.' + 'kufucat.shopify-page-admin.client-secret',
});

export function normalizeShop(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('SHOPIFY_SHOP is required (for example: store-name.myshopify.com).');
  }

  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)) {
    throw new Error('SHOPIFY_SHOP must be an exact *.myshopify.com hostname.');
  }
  return normalized;
}

export function validateApiVersion(value) {
  const version = value || DEFAULT_API_VERSION;
  if (!/^20\d{2}-(01|04|07|10)$/.test(version)) {
    throw new Error('SHOPIFY_API_VERSION must look like 2026-07.');
  }
  return version;
}

export function validateSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Page spec must be a JSON object.');
  }

  const spec = {
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    handle: typeof raw.handle === 'string' ? raw.handle.trim() : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    templateSuffix: typeof raw.templateSuffix === 'string' ? raw.templateSuffix.trim() : '',
    seoTitle: typeof raw.seoTitle === 'string' ? raw.seoTitle.trim() : '',
    seoDescription: typeof raw.seoDescription === 'string' ? raw.seoDescription.trim() : '',
  };

  if (!spec.title || spec.title.length > 255) {
    throw new Error('title is required and must be 255 characters or fewer.');
  }
  if (!HANDLE_PATTERN.test(spec.handle)) {
    throw new Error('handle must contain lowercase letters, numbers, and single hyphens only.');
  }
  if (!TEMPLATE_PATTERN.test(spec.templateSuffix)) {
    throw new Error('templateSuffix must contain lowercase letters, numbers, and single hyphens only.');
  }
  if (Object.hasOwn(raw, 'isPublished') && raw.isPublished !== false) {
    throw new Error('Page specs must not request publication. Publishing is a separate confirmed command.');
  }
  if (spec.seoTitle && spec.seoTitle.length > 70) {
    throw new Error('seoTitle must be 70 characters or fewer.');
  }
  if (spec.seoDescription && spec.seoDescription.length > 160) {
    throw new Error('seoDescription must be 160 characters or fewer.');
  }

  return Object.freeze(spec);
}

export function buildHiddenPageInput(spec) {
  return {
    title: spec.title,
    handle: spec.handle,
    body: spec.body,
    templateSuffix: spec.templateSuffix,
    isPublished: false,
  };
}

export function requirePublishConfirmation(handle, confirmation) {
  if (confirmation !== handle) {
    throw new Error(`Publishing requires --confirm-publish ${handle}`);
  }
}

export function requireSeoConfirmation(handle, confirmation) {
  if (confirmation !== handle) {
    throw new Error(`SEO metadata update requires --confirm-seo ${handle}`);
  }
}

export function redactSecrets(value, secrets = []) {
  let output = String(value);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      output = output.split(secret).join('[REDACTED]');
    }
  }
  return output;
}

export function readKeychainCredential(shop, service, runner = spawnSync) {
  const result = runner('/usr/bin/security', [
    'find-generic-password', '-a', shop, '-s', service, '-w',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(`Credential is unavailable in macOS Keychain (${service}).`);
  }
  return result.stdout.trim();
}

export function resolveCredentials({ shop, env = process.env, platform = process.platform, keychainReader = readKeychainCredential }) {
  if (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET) {
    return { clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET, source: 'environment' };
  }
  if (platform !== 'darwin') {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required outside macOS.');
  }
  return {
    clientId: keychainReader(shop, KEYCHAIN_SERVICES.clientId),
    clientSecret: keychainReader(shop, KEYCHAIN_SERVICES.clientSecret),
    source: 'macos-keychain',
  };
}

export function decideUpsert(existingPage) {
  if (!existingPage) return 'create-hidden';
  if (existingPage.isPublished) return 'refuse-live-update';
  return 'update-hidden';
}

async function readSpec(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  return validateSpec(raw);
}

async function requestJson(url, options, fetchImpl, secrets) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Shopify returned a non-JSON response (${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(`Shopify request failed (${response.status}): ${redactSecrets(JSON.stringify(json), secrets)}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAccessToken({ shop, clientId, clientSecret, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required.');
  }
  const url = `https://${shop}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const json = await requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, fetchImpl, [clientId, clientSecret]);

  if (!json.access_token) throw new Error('Shopify did not return an access token.');
  return json.access_token;
}

export async function graphql({ shop, apiVersion, accessToken, query, variables, fetchImpl = fetch }) {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  const json = await requestJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  }, fetchImpl, [accessToken]);

  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const FIND_PAGE = `
  query FindPageByHandle($query: String!) {
    pages(first: 2, query: $query) {
      nodes {
        id
        title
        handle
        body
        bodySummary
        isPublished
        publishedAt
        templateSuffix
        updatedAt
        seoTitle: metafield(namespace: "global", key: "title_tag") { value compareDigest }
        seoDescription: metafield(namespace: "global", key: "description_tag") { value compareDigest }
      }
    }
  }
`;

const CREATE_PAGE = `
  mutation CreatePage($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id title handle isPublished templateSuffix }
      userErrors { field message }
    }
  }
`;

const UPDATE_PAGE = `
  mutation UpdatePage($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id title handle isPublished templateSuffix }
      userErrors { field message }
    }
  }
`;

const SET_METAFIELDS = `
  mutation SetSeoMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace value createdAt updatedAt }
      userErrors { field message code }
    }
  }
`;

export async function findPageByHandle(client, handle) {
  const data = await graphql({ ...client, query: FIND_PAGE, variables: { query: `handle:${handle}` } });
  const exact = data.pages.nodes.filter((page) => page.handle === handle);
  if (exact.length > 1) throw new Error(`Shopify returned more than one exact match for ${handle}.`);
  return exact[0] || null;
}

function assertNoUserErrors(result, operation) {
  if (result.userErrors?.length) {
    throw new Error(`${operation} rejected: ${JSON.stringify(result.userErrors)}`);
  }
  if (!result.page) throw new Error(`${operation} returned no page.`);
  return result.page;
}

export async function upsertHiddenPage(client, spec) {
  const existing = await findPageByHandle(client, spec.handle);
  const decision = decideUpsert(existing);
  if (decision === 'refuse-live-update') {
    throw new Error(`Refusing to overwrite live page ${spec.handle}. Unpublish or use a reviewed live-update workflow.`);
  }

  const pageInput = buildHiddenPageInput(spec);
  if (decision === 'create-hidden') {
    const data = await graphql({ ...client, query: CREATE_PAGE, variables: { page: pageInput } });
    return { action: decision, page: assertNoUserErrors(data.pageCreate, 'pageCreate') };
  }

  const data = await graphql({ ...client, query: UPDATE_PAGE, variables: { id: existing.id, page: pageInput } });
  return { action: decision, page: assertNoUserErrors(data.pageUpdate, 'pageUpdate') };
}

export async function publishPage(client, spec, confirmation) {
  requirePublishConfirmation(spec.handle, confirmation);
  const existing = await findPageByHandle(client, spec.handle);
  if (!existing) throw new Error(`Cannot publish ${spec.handle}: page does not exist.`);
  if (existing.isPublished) return { action: 'already-live', page: existing };

  const data = await graphql({
    ...client,
    query: UPDATE_PAGE,
    variables: { id: existing.id, page: { isPublished: true } },
  });
  return { action: 'published', page: assertNoUserErrors(data.pageUpdate, 'pageUpdate') };
}

export async function setSeoMetadata(client, spec, confirmation) {
  requireSeoConfirmation(spec.handle, confirmation);
  if (!spec.seoTitle || !spec.seoDescription) {
    throw new Error('set-seo requires both seoTitle and seoDescription in the page spec.');
  }

  const existing = await findPageByHandle(client, spec.handle);
  if (!existing) throw new Error(`Cannot update SEO metadata for ${spec.handle}: page does not exist.`);

  const metafields = [
    {
      ownerId: existing.id,
      namespace: 'global',
      key: 'title_tag',
      type: 'single_line_text_field',
      value: spec.seoTitle,
      compareDigest: existing.seoTitle?.compareDigest ?? null,
    },
    {
      ownerId: existing.id,
      namespace: 'global',
      key: 'description_tag',
      type: 'single_line_text_field',
      value: spec.seoDescription,
      compareDigest: existing.seoDescription?.compareDigest ?? null,
    },
  ];

  const data = await graphql({ ...client, query: SET_METAFIELDS, variables: { metafields } });
  const result = data.metafieldsSet;
  if (result.userErrors?.length) {
    throw new Error(`metafieldsSet rejected: ${JSON.stringify(result.userErrors)}`);
  }
  if (result.metafields?.length !== 2) {
    throw new Error('metafieldsSet did not return both SEO metafields.');
  }
  return { action: 'seo-metadata-updated', handle: spec.handle, metafields: result.metafields };
}

function parseArgs(argv) {
  const [command, specPath, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--confirm-publish') options.confirmPublish = rest[index + 1];
    if (rest[index] === '--confirm-seo') options.confirmSeo = rest[index + 1];
  }
  return { command, specPath, options };
}

function printUsage() {
  console.log('Usage:');
  console.log('  node shopify-page-admin.mjs plan <page-spec.json>');
  console.log('  node shopify-page-admin.mjs status <page-spec.json>');
  console.log('  node shopify-page-admin.mjs upsert-hidden <page-spec.json>');
  console.log('  node shopify-page-admin.mjs publish <page-spec.json> --confirm-publish <handle>');
  console.log('  node shopify-page-admin.mjs set-seo <page-spec.json> --confirm-seo <handle>');
}

async function main() {
  const { command, specPath, options } = parseArgs(process.argv.slice(2));
  if (!command || !specPath || !['plan', 'status', 'upsert-hidden', 'publish', 'set-seo'].includes(command)) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const spec = await readSpec(specPath);
  if (command === 'plan') {
    console.log(JSON.stringify({
      action: 'upsert-hidden',
      page: buildHiddenPageInput(spec),
      publishRequiresSeparateConfirmation: spec.handle,
    }, null, 2));
    return;
  }

  const shop = normalizeShop(process.env.SHOPIFY_SHOP);
  const apiVersion = validateApiVersion(process.env.SHOPIFY_API_VERSION);
  const credentials = resolveCredentials({ shop });
  const accessToken = await getAccessToken({
    shop,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });
  const client = { shop, apiVersion, accessToken };

  if (command === 'status') {
    const page = await findPageByHandle(client, spec.handle);
    console.log(JSON.stringify({ found: Boolean(page), page }, null, 2));
    return;
  }

  if (command === 'set-seo') {
    const result = await setSeoMetadata(client, spec, options.confirmSeo);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = command === 'upsert-hidden'
    ? await upsertHiddenPage(client, spec)
    : await publishPage(client, spec, options.confirmPublish);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const secrets = [process.env.SHOPIFY_CLIENT_ID, process.env.SHOPIFY_CLIENT_SECRET];
    console.error(redactSecrets(error?.message || error, secrets));
    process.exitCode = 1;
  });
}
