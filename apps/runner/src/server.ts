import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { getDb } from './db';
import { registerRoutes } from './routes';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.register(cors, { origin: true });
getDb(); // create tables + data dirs on boot
await registerRoutes(app);

app.setErrorHandler((err: unknown, _req, reply) => {
  app.log.error(err);
  const message = err instanceof Error ? err.message : String(err);
  reply.code(500).send({ error: message });
});

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`AgentProof runner on http://localhost:${config.port} (data: ${config.dataDir})`);
