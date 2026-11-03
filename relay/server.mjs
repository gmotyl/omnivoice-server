import { createServer } from "node:http";
import { toNodeHandler } from "anytts/server";
import { createRelayApp } from "./app.mjs";

const host = process.env.RELAY_HOST || "127.0.0.1";
const port = Number(process.env.RELAY_PORT || 8891);
const omnivoiceUrl = process.env.OMNIVOICE_URL || "http://127.0.0.1:8890";
const allowedOrigins = (process.env.RELAY_ALLOWED_ORIGINS || "https://motyl.dev")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = createRelayApp({ omnivoiceUrl, allowedOrigins });

createServer(toNodeHandler(app)).listen(port, host, () => {
  console.log(`omnivoice-relay on http://${host}:${port} -> ${omnivoiceUrl} (origins: ${allowedOrigins.join(", ")})`);
});
