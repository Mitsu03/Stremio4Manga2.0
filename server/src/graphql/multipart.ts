/**
 * Reading the body of POST /api/graphql, in both shapes the client sends.
 *
 * Ordinary operations arrive as JSON. Exactly two — `validateBackup` and
 * `restoreBackup` — arrive as multipart/form-data following the
 * graphql-multipart-request-spec, because they carry a backup archive. There is
 * no dependency for either: a multipart body is a byte string split on a
 * boundary, and the alternative is pulling a whole upload middleware in for two
 * calls.
 *
 * The quirk this reproduces on purpose (web/src/utils/backup.ts documents the
 * other side of it): **the file is always a top-level variable**. The Java server
 * this replaces resolved a map path with `substringBefore('.')`, so
 * `variables.backup` worked and `variables.input.backup` silently injected
 * nothing; the client was written to the working half and every upload operation
 * is declared `($backup: Upload!)` with the variable referenced from an inline
 * input object. Paths deeper than one segment are still walked here rather than
 * ignored — the client never sends one, and failing loudly beats a missing file
 * that surfaces later as "expected an attached file".
 */
import type { IncomingMessage } from 'node:http';

/** A backup archive is the largest thing anyone uploads; 512 MiB is far past any real one. */
export const UPLOAD_LIMIT = 512 * 1024 * 1024;
/** A JSON operation is a query plus variables. Anything near this is not one. */
export const JSON_LIMIT = 4 * 1024 * 1024;

/** Malformed input from the client — a 400, never a 500. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** What the `Upload` scalar hands to a resolver. */
export interface UploadedFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface GraphQLRequestBody {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
}

interface Part {
  name: string;
  filename?: string;
  mimeType: string;
  data: Buffer;
}

/** The boundary token, or null when this is not a multipart body. */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^\s*multipart\/form-data/i.test(contentType)) return null;
  const match = /;\s*boundary=(?:"([^"]*)"|([^;]*))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary) throw new BadRequestError('The multipart body declares no boundary.');
  return boundary;
}

/** Collect the request body, refusing anything past `limit` without buffering it. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      req.destroy();
      throw new BadRequestError(
        `The request body is larger than the ${Math.floor(limit / (1024 * 1024))} MiB limit.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function headerValue(headers: string, name: string): string | undefined {
  for (const line of headers.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim();
  }
  return undefined;
}

function dispositionParam(disposition: string, name: string): string | undefined {
  // RFC 5987 form first (`filename*=UTF-8''a%20b`), then the plain quoted form.
  const extended = new RegExp(`;\\s*${name}\\*=[^']*'[^']*'([^;]*)`, 'i').exec(disposition);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      return extended[1].trim();
    }
  }
  const plain = new RegExp(`;\\s*${name}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, 'i').exec(disposition);
  const raw = plain?.[1] ?? plain?.[2];
  return raw === undefined ? undefined : raw.replace(/\\(.)/g, '$1').trim();
}

/** Split a multipart body into its parts. Everything here is a client mistake, so BadRequest. */
export function splitParts(body: Buffer, boundary: string): Part[] {
  // Every delimiter but the first is preceded by CRLF; prepending one makes the
  // first indistinguishable from the rest and the loop below uniform.
  const buffer = Buffer.concat([Buffer.from('\r\n'), body]);
  const marker = Buffer.from(`\r\n--${boundary}`);

  if (buffer.indexOf(marker) !== 0) {
    throw new BadRequestError('The multipart body does not start with its boundary.');
  }

  const parts: Part[] = [];
  let cursor = 0;

  for (;;) {
    const afterBoundary = cursor + marker.length;
    // `--` closes the body; CRLF starts another part. Trailing whitespace before
    // either is allowed by the grammar and by every client in practice.
    if (buffer[afterBoundary] === 0x2d && buffer[afterBoundary + 1] === 0x2d) break;
    if (buffer[afterBoundary] !== 0x0d || buffer[afterBoundary + 1] !== 0x0a) {
      throw new BadRequestError('A multipart boundary is malformed.');
    }

    const headerStart = afterBoundary + 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', headerStart, 'latin1');
    if (headerEnd < 0) throw new BadRequestError('A multipart part has no headers.');

    const headers = buffer.subarray(headerStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const next = buffer.indexOf(marker, dataStart);
    if (next < 0) throw new BadRequestError('The multipart body ends inside a part.');

    const disposition = headerValue(headers, 'content-disposition');
    const name = disposition ? dispositionParam(disposition, 'name') : undefined;
    if (name === undefined) throw new BadRequestError('A multipart part has no name.');

    parts.push({
      name,
      filename: disposition ? dispositionParam(disposition, 'filename') : undefined,
      mimeType: headerValue(headers, 'content-type') ?? 'application/octet-stream',
      data: buffer.subarray(dataStart, next),
    });

    cursor = next;
    if (parts.length > 64) throw new BadRequestError('The multipart body has too many parts.');
  }

  return parts;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequestError(`${what} is not valid JSON.`);
  }
}

/** Pull `query`, `variables` and `operationName` out of a parsed operations object. */
function asOperation(raw: Record<string, unknown>): GraphQLRequestBody {
  if (typeof raw.query !== 'string' || raw.query.trim() === '') {
    throw new BadRequestError('The request carries no GraphQL query.');
  }
  const variables =
    raw.variables === undefined || raw.variables === null
      ? {}
      : asRecord(raw.variables, 'variables');
  const operationName = typeof raw.operationName === 'string' ? raw.operationName : undefined;
  return { query: raw.query, variables, operationName };
}

/**
 * Put `file` where `path` says, `path` being a dotted map path such as
 * `variables.backup`. Only the `variables` root exists; the client always writes
 * a single segment after it.
 */
function injectAt(variables: Record<string, unknown>, path: string, file: UploadedFile): void {
  const segments = path.split('.');
  if (segments.shift() !== 'variables' || segments.length === 0) {
    throw new BadRequestError(`The upload map path "${path}" does not name a variable.`);
  }

  let target: Record<string, unknown> | unknown[] = variables;
  while (segments.length > 1) {
    const key = segments.shift() as string;
    const next = Array.isArray(target) ? target[Number(key)] : target[key];
    if (!next || typeof next !== 'object') {
      throw new BadRequestError(
        `The upload map path "${path}" points inside a variable that was not sent. ` +
          'Declare the file as a top-level variable, e.g. ($backup: Upload!).',
      );
    }
    target = next as Record<string, unknown> | unknown[];
  }

  const last = segments[0];
  if (Array.isArray(target)) target[Number(last)] = file;
  else target[last] = file;
}

/**
 * Read a graphql-multipart-request-spec body: an `operations` field, a `map`
 * field, and one field per file named by the map's keys.
 */
export async function readMultipartRequest(
  req: IncomingMessage,
  boundary: string,
  limit = UPLOAD_LIMIT,
): Promise<GraphQLRequestBody> {
  const parts = splitParts(await readBody(req, limit), boundary);
  const byName = new Map(parts.map((part) => [part.name, part]));

  const operationsPart = byName.get('operations');
  if (!operationsPart) throw new BadRequestError('The upload has no "operations" field.');
  const body = asOperation(
    asRecord(parseJson(operationsPart.data.toString('utf8'), '"operations"'), '"operations"'),
  );

  const mapPart = byName.get('map');
  if (!mapPart) throw new BadRequestError('The upload has no "map" field.');
  const map = asRecord(parseJson(mapPart.data.toString('utf8'), '"map"'), '"map"');

  for (const [field, paths] of Object.entries(map)) {
    const filePart = byName.get(field);
    if (!filePart) throw new BadRequestError(`The upload map names a missing field "${field}".`);
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      throw new BadRequestError(`The upload map entry "${field}" must be a list of paths.`);
    }
    const file: UploadedFile = {
      filename: filePart.filename ?? field,
      mimeType: filePart.mimeType,
      bytes: filePart.data,
    };
    for (const path of paths as string[]) injectAt(body.variables, path, file);
  }

  return body;
}

/** Read the ordinary JSON body every other operation uses. */
export async function readJsonRequest(
  req: IncomingMessage,
  limit = JSON_LIMIT,
): Promise<GraphQLRequestBody> {
  const text = (await readBody(req, limit)).toString('utf8');
  if (text.trim() === '') throw new BadRequestError('The request body is empty.');
  return asOperation(asRecord(parseJson(text, 'The request body'), 'The request body'));
}
