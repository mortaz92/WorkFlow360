import { createApp } from './app';
import { CONFIG } from './core/config';

const app = createApp();

app.listen(CONFIG.PORT, () => {
  console.log(`[SERVER] WorkFlow360 backend in ascolto sulla porta ${CONFIG.PORT} (${CONFIG.NODE_ENV})`);
});
