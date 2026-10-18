import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { getDb } from './db';
import { registerErrorHandler, registerRoutes } from './routes';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.body.token', 'body.token', 'token'],
  },
});

await app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'POST', 'DELETE'] });
getDb(); // create tables + data dirs on boot
// JSON errors that keep a 4xx raised by a plugin or by validation as a 4xx, never a 500. Before the
// routes: Fastify binds each route to the error handler in force when its registration settles.
registerErrorHandler(app);
await registerRoutes(app);

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`AgentProof runner on http://localhost:${config.port} (data: ${config.dataDir})`);
