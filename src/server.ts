
import app from './app.js';
import { env } from './config/env.js';

app.listen(env.PORT, () => {
  console.log(`
  ============================
       AI-TOOL BACKEND
  ============================

  Server: http://localhost:${env.PORT}
  API:    http://localhost:${env.PORT}/api
  Status: RUNNING

  `);
});
