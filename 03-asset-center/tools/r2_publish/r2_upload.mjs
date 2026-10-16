import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const localPath = new URL('./r2.local.json', import.meta.url);
const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath,'utf8')) : {};
const DEFAULTS = {
 accountId: process.env.R2_ACCOUNT_ID || local.accountId,
 bucket: process.env.R2_BUCKET || local.bucket,
 publicBase: process.env.R2_PUBLIC_BASE || local.publicBase,
 accessKeyService: process.env.R2_ACCESS_KEY_SERVICE || local.accessKeyService || 'r2-access-key-id',
 secretKeyService: process.env.R2_SECRET_KEY_SERVICE || local.secretKeyService || 'r2-secret-access-key',
 keychainAccount: process.env.R2_KEYCHAIN_ACCOUNT || local.keychainAccount || 'r2',
};

function usage() {
  return [
    'Usage:',
    '  node r2_upload.mjs --file <path> --key <object-key> --expected-sha256 <sha256>',
    '',
    'The script reads R2 credentials from macOS Keychain, refuses to overwrite a',
    'different object, uploads with immutable caching, and verifies the public copy.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if(argv[index]==='--plan'){args.plan=true;index-=1;continue;}
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(usage());
    args[flag.slice(2)] = value;
  }
  if (!args.file || !args.key || !args['expected-sha256']) throw new Error(usage());
  return args;
}

function keychainValue(service) {
  return execFileSync('/usr/bin/security', [
    'find-generic-password', '-w', '-a', DEFAULTS.keychainAccount, '-s', service,
  ], { encoding: 'utf8' }).trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.txt': 'text/plain; charset=utf-8',
  };
  return types[extension] ?? 'application/octet-stream';
}

function canonicalObjectUri(bucket, objectKey) {
  if (objectKey.startsWith('/') || objectKey.split('/').includes('..')) {
    throw new Error('Object key must be relative and cannot contain .. segments.');
  }
  return `/${bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
}

function buildAuthorization({ method, canonicalUri, headers, payloadHash, accessKeyId, secretAccessKey }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const normalized = { ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const headerNames = Object.keys(normalized).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = `${headerNames.map((name) => `${name}:${String(normalized[name]).trim()}`).join('\n')}\n`;
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, 'auto');
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: normalized,
  };
}

async function signedFetch({ method, canonicalUri, body, extraHeaders, accessKeyId, secretAccessKey, endpointHost }) {
  const payloadHash = sha256(body ?? Buffer.alloc(0));
  const signed = buildAuthorization({
    method,
    canonicalUri,
    headers: { host: endpointHost, ...extraHeaders },
    payloadHash,
    accessKeyId,
    secretAccessKey,
  });
  return fetch(`https://${endpointHost}${canonicalUri}`, {
    method,
    headers: { Authorization: signed.authorization, ...signed.headers },
    body,
  });
}

if(process.argv.includes('--help')){console.log(usage()+'\n  --plan validates a local upload plan without credentials or network.');process.exit(0);}
const args = parseArgs(process.argv.slice(2));
const filePath = path.resolve(args.file);
const objectKey = args.key;
const expectedSha256 = args['expected-sha256'].toLowerCase();
if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('Expected SHA-256 must contain 64 hexadecimal characters.');
if (!fs.statSync(filePath).isFile()) throw new Error(`Not a file: ${filePath}`);

const body = fs.readFileSync(filePath);
const sourceSha256 = sha256(body);
if (sourceSha256 !== expectedSha256) {
  throw new Error(`Source SHA-256 mismatch: expected ${expectedSha256}, received ${sourceSha256}`);
}

if(!DEFAULTS.accountId||!DEFAULTS.bucket||!DEFAULTS.publicBase)throw new Error('Explicit R2 account, bucket and public base are required');
canonicalObjectUri(DEFAULTS.bucket,objectKey);
if(args.plan){console.log(JSON.stringify({upload:false,network:false,key:objectKey,bytes:body.length,sha256:sourceSha256}));process.exit(0);}
const accessKeyId = process.env.R2_ACCESS_KEY_ID || keychainValue(DEFAULTS.accessKeyService);
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || keychainValue(DEFAULTS.secretKeyService);
const endpointHost = `${DEFAULTS.accountId}.r2.cloudflarestorage.com`;
const canonicalUri = canonicalObjectUri(DEFAULTS.bucket, objectKey);
const requestContext = { accessKeyId, secretAccessKey, endpointHost, canonicalUri };

const existing = await signedFetch({ method: 'HEAD', extraHeaders: {}, ...requestContext });
let uploaded = false;
if (existing.ok) {
  const storedSha256 = existing.headers.get('x-amz-meta-sha256');
  if (storedSha256 !== sourceSha256) {
    throw new Error(`Refusing to overwrite ${objectKey}: the existing object has a different SHA-256.`);
  }
} else if (existing.status === 404) {
  const contentType = contentTypeFor(filePath);
  const upload = await signedFetch({
    method: 'PUT',
    body,
    extraHeaders: {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': contentType,
      'x-amz-meta-sha256': sourceSha256,
    },
    ...requestContext,
  });
  if (!upload.ok) {
    const message = (await upload.text()).slice(0, 300);
    throw new Error(`R2 upload failed: HTTP ${upload.status} ${message}`);
  }
  uploaded = true;
} else {
  throw new Error(`R2 object check failed: HTTP ${existing.status}`);
}

const encodedPublicKey = objectKey.split('/').map(encodeURIComponent).join('/');
const publicUrl = `${DEFAULTS.publicBase}/${encodedPublicKey}`;
const verification = await fetch(`${publicUrl}?verify=${sourceSha256}`, { cache: 'no-store' });
const publicBody = Buffer.from(await verification.arrayBuffer());
if (!verification.ok || sha256(publicBody) !== sourceSha256) {
  throw new Error(`Public verification failed: HTTP ${verification.status}, bytes=${publicBody.length}`);
}

console.log(JSON.stringify({
  uploaded,
  objectKey,
  publicUrl,
  bytes: body.length,
  sha256: sourceSha256,
  contentType: contentTypeFor(filePath),
  publicReadStatus: verification.status,
}));
