/**
 * The seams between the parts of the server.
 *
 * Kept in one small module that everything may import, so that the HTTP layer,
 * the GraphQL layer, the sources and the workers can be written against each
 * other without any of them importing another's internals.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { Db } from './db/open.js';

/** Who the request is. There is no anonymous access to anything under /api. */
export interface Session {
  username: string;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  close(): void;
}

/** What every resolver is handed. `userId` is the account's username. */
export interface GraphQLContext {
  userId: string;
  db: Db;
  config: Config;
  log: Logger;
}

export type Req = IncomingMessage;
export type Res = ServerResponse;

/**
 * Handles POST /api/graphql, both the JSON and the multipart form of it.
 * Always writes a response.
 */
export type GraphQLHandler = (req: Req, res: Res, session: Session) => Promise<void>;

/**
 * Handles the REST endpoints under /api/v1. Returns false without writing
 * anything when the path is none of its own, so the router can fall through.
 */
export type ApiHandler = (req: Req, res: Res, session: Session, url: URL) => Promise<boolean>;

export interface AppDeps {
  config: Config;
  db: Db;
  log: Logger;
  graphql: GraphQLHandler;
  api: ApiHandler;
}
