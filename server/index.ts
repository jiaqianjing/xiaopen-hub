import { ConfigStore } from "./store.js";
import { startAdminApi } from "./api.js";
import { DeviceGateway } from "./gateway.js";

const store = new ConfigStore();
await store.init();
await store.ensureDeviceToken();
const config = store.getConfig();
const gateway = new DeviceGateway(store, config.gateway.devicePort);
await gateway.start();
await startAdminApi(store, gateway, config.gateway.adminPort);

console.log(
  `Xiaopen Lite admin API: http://127.0.0.1:${config.gateway.adminPort}`,
);
console.log(`Xiaozhi device gateway: 0.0.0.0:${config.gateway.devicePort}`);
console.log(`Encrypted data store: ${store.dataDir}`);
