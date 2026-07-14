// Dev entrypoint: relay + graph API on :8787 with the demo project.
import { GraphSession } from "./graph/session.js";
import { buildServer } from "./server.js";
import { RelayStores } from "./stores.js";

const server = await buildServer({
  stores: new RelayStores(),
  sessionToken: process.env.NORNS_TOKEN ?? "dev-token",
  graphSession: GraphSession.demo(),
});
await server.app.listen({ port: Number(process.env.PORT ?? 8787), host: "127.0.0.1" });
console.log("norns server on http://127.0.0.1:8787");
