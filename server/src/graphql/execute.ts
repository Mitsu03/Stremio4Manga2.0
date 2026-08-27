/**
 * The GraphQL endpoint: one schema, built once, executed per request.
 *
 * The schema is the contract in `schema.graphql`, bundled as text, so there is
 * exactly one description of the API and it is the one the client was read off.
 * Resolvers are attached to it afterwards rather than passed alongside it, which
 * means a resolver named for a field that does not exist is a startup failure
 * instead of a field that quietly returns null forever.
 *
 * Everything answers 200. urql's `fetchExchange` treats a non-2xx as a network
 * error and surfaces "the server is unreachable" for what is really a bad query,
 * so a failed operation comes back as `{ errors: [...] }` with a 200. Only a body
 * that is not an operation at all gets a 4xx.
 */
import {
  assertValidSchema,
  buildASTSchema,
  execute,
  GraphQLError,
  isObjectType,
  isScalarType,
  isUnionType,
  parse,
  Source,
  validate,
} from 'graphql';
import type {
  GraphQLFieldResolver,
  GraphQLFormattedError,
  GraphQLScalarType,
  GraphQLSchema,
} from 'graphql';

import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import type { GraphQLContext, GraphQLHandler, Logger, Req, Res, Session } from '../types.js';
import schemaSource from './schema.graphql';
import { LongString, Upload } from './scalars.js';
import {
  BadRequestError,
  JSON_LIMIT,
  multipartBoundary,
  readJsonRequest,
  readMultipartRequest,
  UPLOAD_LIMIT,
} from './multipart.js';
import { resolvers } from './resolvers/index.js';

/**
 * The eight members of the `Filter` union, keyed by the `kind` a source's filter
 * definition carries. The union exists because the three `default` fields have
 * three different types; `kind` is the discriminator the sources agree on, and it
 * never leaves the server — the client selects on `__typename`.
 */
const FILTER_TYPES: Record<string, string> = {
  header: 'HeaderFilter',
  separator: 'SeparatorFilter',
  select: 'SelectFilter',
  text: 'TextFilter',
  checkbox: 'CheckBoxFilter',
  tristate: 'TriStateFilter',
  sort: 'SortFilter',
  group: 'GroupFilter',
};

function installScalar(schema: GraphQLSchema, scalar: GraphQLScalarType<never, never>): void {
  const declared = schema.getType(scalar.name);
  if (!isScalarType(declared)) {
    throw new Error(`schema.graphql does not declare a scalar named ${scalar.name}.`);
  }
  // `buildASTSchema` gives a bare `scalar X` the identity coercers. Replacing the
  // three functions in place keeps every reference in the schema pointing at one
  // type object, which is what `parse`/`validate` compare against.
  const target = declared as unknown as {
    serialize: unknown;
    parseValue: unknown;
    parseLiteral: unknown;
  };
  const source = scalar as unknown as typeof target;
  target.serialize = source.serialize;
  target.parseValue = source.parseValue;
  target.parseLiteral = source.parseLiteral;
}

function buildSchema(): GraphQLSchema {
  const schema = buildASTSchema(parse(new Source(schemaSource, 'schema.graphql')), {
    assumeValidSDL: false,
  });

  installScalar(schema, LongString as unknown as GraphQLScalarType<never, never>);
  installScalar(schema, Upload as unknown as GraphQLScalarType<never, never>);

  const filter = schema.getType('Filter');
  if (!isUnionType(filter)) throw new Error('schema.graphql does not declare the Filter union.');
  filter.resolveType = (value: unknown) => {
    const kind = (value as { kind?: unknown }).kind;
    const typeName = typeof kind === 'string' ? FILTER_TYPES[kind.toLowerCase()] : undefined;
    if (!typeName) {
      throw new GraphQLError(
        `A source returned a filter of unknown kind ${JSON.stringify(kind)}. ` +
          `Expected one of: ${Object.keys(FILTER_TYPES).join(', ')}.`,
      );
    }
    return typeName;
  };

  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (!isObjectType(type)) {
      throw new Error(`A resolver group defines ${typeName}, which is not an object type.`);
    }
    const declared = type.getFields();
    for (const [fieldName, resolver] of Object.entries(fields)) {
      const field = declared[fieldName];
      if (!field) throw new Error(`A resolver group defines unknown field ${typeName}.${fieldName}.`);
      if (typeof resolver !== 'function') {
        throw new Error(`The resolver for ${typeName}.${fieldName} is not a function.`);
      }
      field.resolve = resolver as GraphQLFieldResolver<unknown, GraphQLContext>;
    }
  }

  assertValidSchema(schema);
  return schema;
}

/**
 * Keep server paths out of anything the client is handed. A resolver that lets an
 * ENOENT through would otherwise print the data directory into the browser.
 */
function scrubber(config: Config): (message: string) => string {
  const literals = [config.dataDir, config.uiDist, config.logging.file, process.cwd()].filter(
    (path) => path.length > 3,
  );
  return (message: string): string => {
    let clean = message;
    // The configured roots first, because one may contain a space and so end
    // early under the patterns below...
    for (const literal of literals) clean = clean.split(literal).join('<path>');
    return (
      clean
        .replace(/[A-Za-z]:[\\/][^\s"'`,;)]*/g, '<path>')
        .replace(/(?<![\w:/])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, '<path>')
        // ...and then whatever hung off the end of one, which is the file name
        // inside the directory and just as much of a leak as the directory.
        .replace(/<path>(?:[\\/][^\s"'`,;)]*)?/g, '<path>')
    );
  };
}

function send(res: Res, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function createGraphQLHandler(deps: {
  config: Config;
  db: Db;
  log: Logger;
}): GraphQLHandler {
  const { config, db, log } = deps;
  // Built at startup: a bad schema or a stray resolver name should stop the
  // server, not wait for the first request that happens to touch it.
  const schema = buildSchema();
  const scrub = scrubber(config);

  const publicError = (error: GraphQLError): GraphQLFormattedError => ({
    message: scrub(error.message),
    ...(error.locations ? { locations: error.locations } : {}),
    ...(error.path ? { path: error.path } : {}),
  });

  return async function handleGraphQL(req: Req, res: Res, session: Session): Promise<void> {
    if (req.method !== 'POST') {
      send(res, 405, { errors: [{ message: 'The GraphQL endpoint only accepts POST.' }] }, {
        allow: 'POST',
      });
      return;
    }

    let body;
    try {
      const boundary = multipartBoundary(req.headers['content-type']);
      body = boundary
        ? await readMultipartRequest(req, boundary, UPLOAD_LIMIT)
        : await readJsonRequest(req, JSON_LIMIT);
    } catch (error) {
      if (error instanceof BadRequestError) {
        send(res, 400, { errors: [{ message: scrub(error.message) }] });
        return;
      }
      log.error(`GraphQL body read failed: ${(error as Error).stack ?? String(error)}`);
      send(res, 400, { errors: [{ message: 'The request body could not be read.' }] });
      return;
    }

    let document;
    try {
      document = parse(new Source(body.query, 'operation'));
    } catch (error) {
      send(res, 200, { errors: [publicError(error as GraphQLError)] });
      return;
    }

    const invalid = validate(schema, document);
    if (invalid.length > 0) {
      send(res, 200, { errors: invalid.map(publicError) });
      return;
    }

    const contextValue: GraphQLContext = { userId: session.username, db, config, log };

    try {
      const result = await execute({
        schema,
        document,
        contextValue,
        variableValues: body.variables,
        ...(body.operationName ? { operationName: body.operationName } : {}),
      });

      for (const error of result.errors ?? []) {
        const cause = error.originalError ?? error;
        log.error(
          `GraphQL ${body.operationName ?? 'operation'} at ${error.path?.join('.') ?? '?'} ` +
            `for ${session.username}: ${cause.stack ?? cause.message}`,
        );
      }

      send(res, 200, {
        ...(result.data === undefined ? {} : { data: result.data }),
        ...(result.errors ? { errors: result.errors.map(publicError) } : {}),
      });
    } catch (error) {
      // Only reachable when execute() itself refuses — bad variables, mostly.
      log.error(`GraphQL execution failed: ${(error as Error).stack ?? String(error)}`);
      send(res, 200, { errors: [publicError(error as GraphQLError)] });
    }
  };
}
