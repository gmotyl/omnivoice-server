import { createServer } from "node:http";
import { toNodeHandler } from "anytts/server";
import { createRelayApp, parseAllowedOrigins } from "./app.mjs";

const host = process.env.RELAY_HOST || "127.0.0.1";
const port = Number(process.env.RELAY_PORT || 8891);
const omnivoiceUrl = process.env.OMNIVOICE_URL || "http://127.0.0.1:8890";
// No default origin: unset means no browser page may call the relay (`/health` still answers).
const allowedOrigins = parseAllowedOrigins(process.env.RELAY_ALLOWED_ORIGINS);

const app = createRelayApp({ omnivoiceUrl, allowedOrigins });

createServer(toNodeHandler(app)).listen(port, host, () => {
  const origins = allowedOrigins.length ? allowedOrigins.join(", ") : "none";
  console.log(`omnivoice-relay on http://${host}:${port} -> ${omnivoiceUrl} (origins: ${origins})`);
  if (!allowedOrigins.length) {
    console.log(
      "omnivoice-relay: no browser origins allowed; set RELAY_ALLOWED_ORIGINS (comma list, e.g. in relay.env) to let a page call it",
    );
  }
});
