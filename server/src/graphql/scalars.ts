/**
 * The two scalars the contract declares but GraphQL does not define.
 *
 * `LongString` exists because JSON numbers are IEEE doubles: an epoch-millisecond
 * stamp fits, but a 64-bit source id does not, and the client already reads every
 * one of these through `Number(...)` on a string. Keeping it a decimal string on
 * the wire is what makes `sourceId` survive a round trip unchanged.
 *
 * `Upload` is opaque on purpose. By the time a resolver sees one, the multipart
 * parser has already turned the part into bytes; the scalar's only job is to let
 * the value through untouched and to refuse a literal, which could only ever be a
 * client sending a file it never attached.
 */
import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import type { ValueNode } from 'graphql';
import type { UploadedFile } from './multipart.js';

const INTEGER = /^-?\d+$/;

function longFrom(value: unknown, what: string): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new GraphQLError(`${what} must be a whole number, got ${String(value)}.`);
    }
    if (!Number.isSafeInteger(value)) {
      // Past 2^53 the number has already lost digits; turning it into a string
      // here would launder the loss rather than report it.
      throw new GraphQLError(`${what} is too large to be exact as a number; send it as a string.`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!INTEGER.test(trimmed)) {
      throw new GraphQLError(`${what} must be a decimal integer string, got "${value}".`);
    }
    return trimmed;
  }
  throw new GraphQLError(`${what} must be a string, number or bigint, got ${typeof value}.`);
}

/** A 64-bit integer carried as a decimal string. Every epoch-ms field uses it. */
export const LongString = new GraphQLScalarType<string, string>({
  name: 'LongString',
  description: 'A 64-bit integer serialised as a decimal string.',
  serialize: (value) => longFrom(value, 'LongString'),
  parseValue: (value) => longFrom(value, 'LongString'),
  parseLiteral: (ast: ValueNode) => {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) return longFrom(ast.value, 'LongString');
    throw new GraphQLError('LongString must be written as a string or an integer literal.', {
      nodes: ast,
    });
  },
});

function isUploadedFile(value: unknown): value is UploadedFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UploadedFile>;
  return typeof candidate.filename === 'string' && candidate.bytes instanceof Uint8Array;
}

/**
 * The file a multipart request attached. Input only: a query may never write one
 * down, and no field ever returns one.
 */
export const Upload = new GraphQLScalarType<UploadedFile, never>({
  name: 'Upload',
  description: 'A file attached to a multipart/form-data request.',
  serialize: () => {
    throw new GraphQLError('Upload is an input-only scalar and is never returned.');
  },
  parseValue: (value) => {
    if (isUploadedFile(value)) return value;
    throw new GraphQLError(
      'Expected an attached file. Send the operation as multipart/form-data with the file mapped to a top-level variable.',
    );
  },
  parseLiteral: (ast: ValueNode) => {
    throw new GraphQLError('Upload cannot be written inline; attach the file to the request.', {
      nodes: ast,
    });
  },
});

export const scalars = [LongString, Upload];
