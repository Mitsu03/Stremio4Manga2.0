/**
 * Source-wide actions that belong to no single source.
 *
 * One so far: throwing away the cookies. It lives here rather than in `search.ts` or `extension.ts`
 * because it is about the HTTP client every source shares, not about a source or an installation.
 */
import { resetSourceHttp } from '../../sources/registry.js';
import type { GraphQLContext } from '../../types.js';
import type { ResolverGroup } from './index.js';

export const group: ResolverGroup = {
  Mutation: {
    /**
     * There is one jar for the whole process, so this clears cookies for every account on the
     * server. That is a deliberate consequence of there being one client: the per-host queue, the
     * jar, the clearance and the circuit breaker are all per-client, and a jar per account would
     * mean a Cloudflare challenge per account - the loop this exists to escape. The interface says
     * so rather than the server pretending otherwise.
     */
    clearSourceCookies: (_parent: unknown, _args: unknown, context: GraphQLContext) => {
      const hosts = resetSourceHttp();
      context.log.info(`cleared source cookies for ${hosts} host(s), asked by "${context.userId}"`);
      return { hosts };
    },
  },
};
