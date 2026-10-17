import { routes, type RouteDef, type RouteName } from '@clinic/contracts';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { authenticate } from './auth';
import { HttpError, toErrorResponse } from './errors';
import { handlers } from './handlers';
import { openApiDocument } from './openapi';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
  app.use(express.json({ limit: '1mb' }));

  const doc = openApiDocument();
  app.get('/api/openapi.json', (_req, res) => {
    res.json(doc);
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(doc));

  // Every route of the contract, registered generically: auth → RBAC → zod parse → handler → status.
  for (const [name, route] of Object.entries(routes) as [RouteName, RouteDef][]) {
    const handler = handlers[name] as (ctx: unknown) => Promise<unknown>;
    app[route.method.toLowerCase() as Method](route.path, async (req: Request, res: Response) => {
      const user = await authenticate(req, route);
      const ctx = {
        user,
        params: route.params?.parse(req.params),
        query: route.query?.parse(req.query),
        body: route.body?.parse(req.body ?? {}),
      };
      res.status(route.status ?? 200).json(await handler(ctx));
    });
  }

  app.use((_req, _res, next) => next(new HttpError('NOT_FOUND', 'Маршрут не знайдено')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const [status, body] = toErrorResponse(err);
    if (status >= 500) console.error(err);
    res.status(status).json(body);
  });
  return app;
}
