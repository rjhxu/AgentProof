import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ConnectRepositoryRequest, RepositoryConnection, newId } from '@agentproof/shared';
import * as db from './db';
import { connectRepository, removeRepository, RepositoryConnectionError } from './repositories';

const connecting = new Set<string>();

/** This prototype has no accounts; source access is available only from the local dashboard. */
async function localAccess(request: FastifyRequest, reply: FastifyReply) {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(request.headers.host ?? '')) {
    return reply.code(403).send({ error: 'Repository connections require a localhost address.' });
  }
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) {
    return reply
      .code(403)
      .send({ error: 'Repository connections are available from the local dashboard only.' });
  }
  if (
    request.headers.origin &&
    !['http://localhost:3000', 'http://127.0.0.1:3000'].includes(request.headers.origin)
  ) {
    return reply
      .code(403)
      .send({ error: 'Connect repositories from the local AgentProof dashboard.' });
  }
}

export async function registerRepositoryRoutes(app: FastifyInstance): Promise<void> {
  const options = { onRequest: localAccess };
  app.get<{ Params: { id: string } }>('/runs/:id/repository', options, async (request, reply) => {
    if (!db.getRun(request.params.id)) return reply.code(404).send({ error: 'Run not found.' });
    return { repository: db.getRepository(request.params.id) ?? null };
  });

  app.post<{ Params: { id: string } }>('/runs/:id/repository', options, async (request, reply) => {
    const runId = request.params.id;
    const run = db.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'Run not found.' });
    if (
      run.agent.kind !== 'gamma_structured' ||
      run.status !== 'failed' ||
      !run.verification?.checkpoints.some((checkpoint) => checkpoint.status === 'failed')
    ) {
      return reply.code(409).send({
        error: 'Complete a Gamma run with failed checkpoints before connecting a repository.',
      });
    }
    const parsed = ConnectRepositoryRequest.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error:
          'Provide a GitHub repository URL and consent to read its source. Use a valid access token for a private repository.',
      });
    if (connecting.has(runId))
      return reply.code(409).send({ error: 'A repository connection is already in progress.' });
    if (db.getRepository(runId))
      return reply
        .code(409)
        .send({ error: 'Disconnect the current repository before connecting another.' });
    connecting.add(runId);
    const id = newId('repo');
    let cloned = false;
    try {
      const metadata = await connectRepository(parsed.data, id);
      cloned = true;
      const repository = RepositoryConnection.parse({ ...metadata, runId });
      db.saveRepository(repository);
      return { repository };
    } catch (error) {
      if (cloned) await removeRepository(id).catch(() => undefined);
      if (error instanceof RepositoryConnectionError)
        return reply.code(error.statusCode).send({ error: error.message });
      return reply
        .code(500)
        .send({ error: 'Could not save the repository connection. Please try again.' });
    } finally {
      connecting.delete(runId);
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/runs/:id/repository',
    options,
    async (request, reply) => {
      const runId = request.params.id;
      if (!db.getRun(runId)) return reply.code(404).send({ error: 'Run not found.' });
      if (connecting.has(runId))
        return reply
          .code(409)
          .send({ error: 'Wait for the current connection to finish before disconnecting.' });
      const repository = db.getRepository(runId);
      if (!repository) return { repository: null };
      connecting.add(runId);
      try {
        await removeRepository(repository.id);
        db.deleteRepository(runId);
        return { repository: null };
      } catch {
        return reply.code(500).send({
          error: 'Could not remove the local repository snapshot. Please try disconnecting again.',
        });
      } finally {
        connecting.delete(runId);
      }
    },
  );
}
