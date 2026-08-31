/**
 * Every resolver group, merged into the one map the executor takes.
 *
 * The groups are split by feature and each lives in its own file so that they
 * can be written independently; this file is the only place that knows the full
 * list, which keeps a new group from having to touch anything else.
 */
import type { GraphQLContext } from '../../types.js';

import * as meta from './meta.js';
import * as category from './category.js';
import * as settings from './settings.js';
import * as extension from './extension.js';
import * as track from './track.js';
import * as library from './library.js';
import * as chapter from './chapter.js';
import * as search from './search.js';
import * as download from './download.js';
import * as backup from './backup.js';
import * as sources from './sources.js';
// Adding a group means adding it here and to `groups` below; nothing else in
// the server needs to learn about it.

export type Resolver = (
  parent: never,
  args: never,
  context: GraphQLContext,
) => unknown | Promise<unknown>;

export type FieldMap = Record<string, unknown>;

/**
 * A group contributes root fields and, optionally, field resolvers for object
 * types — `MangaType.chapters` and friends, which cannot be plain properties
 * because they take arguments.
 */
export interface ResolverGroup {
  Query?: FieldMap;
  Mutation?: FieldMap;
  types?: Record<string, FieldMap>;
}

const groups: ResolverGroup[] = [
  meta.group,
  category.group,
  settings.group,
  extension.group,
  track.group,
  library.group,
  chapter.group,
  search.group,
  download.group,
  backup.group,
  sources.group,
];

function merge(): Record<string, FieldMap> {
  const merged: Record<string, FieldMap> = { Query: {}, Mutation: {} };
  for (const group of groups) {
    Object.assign(merged.Query, group.Query ?? {});
    Object.assign(merged.Mutation, group.Mutation ?? {});
    for (const [typeName, fields] of Object.entries(group.types ?? {})) {
      merged[typeName] = { ...merged[typeName], ...fields };
    }
  }
  return merged;
}

export const resolvers = merge();
