'use strict';

const http = require('node:http');
const config = require('./src/config');
const routing = require('./src/routing');
const { Store } = require('./src/db');
const { createApp } = require('./src/app');

const store = new Store(config.dataDir);
const server = http.createServer(createApp({ store, config, routing }));

server.listen(config.port, () => {
  console.log(`joinmyride.com läuft auf http://localhost:${config.port}`);
  console.log(`Routing: ${config.googleMapsApiKey ? 'Google Maps' : 'OpenStreetMap (kein GOOGLE_MAPS_API_KEY gesetzt)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
