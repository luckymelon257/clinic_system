import { createApp } from './app';
import { pool } from './db/pool';

const port = Number(process.env.PORT) || 4000;
const server = createApp().listen(port, () => console.log(`API on http://localhost:${port} (docs: /api/docs)`));

const stop = () => server.close(() => void pool.end());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
