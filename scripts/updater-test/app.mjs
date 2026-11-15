import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

for (const directory of ["/data", "/journal"]) {
  if (!existsSync(`${directory}/sentinel`)) writeFileSync(`${directory}/sentinel`, process.env.FIXTURE_TOKEN);
}
const server = createServer((_request, response) => response.end(process.env.FIXTURE_VERSION));
server.listen(8080, "0.0.0.0");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
