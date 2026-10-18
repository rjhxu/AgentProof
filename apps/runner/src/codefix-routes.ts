import type { FastifyInstance } from 'fastify';
import { CodeFixRequest, nowIso } from '@agentproof/shared';
import { renderCodeFixMarkdown } from '@agentproof/codefix';
import { CodeFixError, startCodeFix } from './codefix';
import * as db from './db';
import { subscribeCodeFix } from './events';
import { localAccess } from './repository-routes';

const MARKDOWN = 'text/markdown; charset=utf-8';
const DIFF = 'text/x-diff; charset=utf-8';

/**
 * The code-fix agent's HTTP surface (docs/CODEFIX.md). Contract: packages/shared/src/codefix.ts.
 *
 *   POST /runs/:id/codefix       start a fix (localhost only: the body may carry a token)
 *   GET  /runs/:id/codefixes     every fix for a run
 *   GET  /codefix/:id            the record, updated after every stage
 *   GET  /codefix/:id/report.md  the Markdown rendering (the same text a pull request gets)
 *   GET  /codefix/:id/patch.diff the final diff
 *   GET  /codefix/:id/events     SSE: stage, log and done events
 */
export async function registerCodeFixRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/runs/:id/codefix',
    { onRequest: localAccess },
    async (req, reply) => {
      const run = db.getRun(req.params.id);
      if (!run) return reply.code(404).send({ error: 'run not found' });
      const parsed = CodeFixRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error:
            'Provide consent: true, a mode (diff | branch | pull_request) and, for branch or pull_request, a fine-grained token.',
        });
      }
      try {
        const codefix = startCodeFix(run, parsed.data);
        return reply.code(202).send({ codefix });
      } catch (err) {
        if (err instanceof CodeFixError)
          return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>('/runs/:id/codefixes', async (req, reply) => {
    if (!db.getRun(req.params.id)) return reply.code(404).send({ error: 'run not found' });
    return { codefixes: db.listCodeFixesForRun(req.params.id) };
  });

  app.get<{ Params: { id: string } }>('/codefix/:id', async (req, reply) => {
    const codefix = db.getCodeFix(req.params.id);
    if (!codefix) return reply.code(404).send({ error: 'codefix not found' });
    return { codefix };
  });

  app.get<{ Params: { id: string } }>('/codefix/:id/report.md', async (req, reply) => {
    const codefix = db.getCodeFix(req.params.id);
    if (!codefix) return reply.code(404).send({ error: 'codefix not found' });
    return reply.type(MARKDOWN).send(renderCodeFixMarkdown(codefix));
  });

  app.get<{ Params: { id: string } }>('/codefix/:id/patch.diff', async (req, reply) => {
    const codefix = db.getCodeFix(req.params.id);
    if (!codefix) return reply.code(404).send({ error: 'codefix not found' });
    const attempt =
      codefix.finalAttempt === undefined ? undefined : codefix.attempts[codefix.finalAttempt];
    if (!attempt?.diff) return reply.code(404).send({ error: 'no validated diff' });
    return reply.type(DIFF).send(attempt.diff);
  });

  app.get<{ Params: { id: string } }>('/codefix/:id/events', async (req, reply) => {
    const codefix = db.getCodeFix(req.params.id);
    if (!codefix) return reply.code(404).send({ error: 'codefix not found' });
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    send({
      type: 'stage',
      codefixId: codefix.id,
      stage: codefix.stage,
      status: codefix.status,
      at: nowIso(),
    });
    if (codefix.status !== 'running') {
      send({ type: 'done', codefixId: codefix.id, status: codefix.status, at: nowIso() });
      reply.raw.end();
      return reply;
    }
    const unsubscribe = subscribeCodeFix(codefix.id, (event) => {
      send(event);
      if (event.type === 'done') {
        unsubscribe();
        reply.raw.end();
      }
    });
    req.raw.on('close', unsubscribe);
    return reply;
  });
}
