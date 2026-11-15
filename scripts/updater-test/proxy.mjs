import { createServer, request } from "node:http";
import { once } from "node:events";

export async function responseDroppingProxy(socket, upstream, operation) {
  let dropped = false;
  const server = createServer((incoming, outgoing) => {
    const shouldDrop = !dropped && incoming.method === "POST" &&
      (operation === "create" ? incoming.url.startsWith("/containers/create?") : incoming.url.split("?")[0].endsWith(`/${operation}`));
    const forward = request({ socketPath: upstream, path: incoming.url, method: incoming.method, headers: incoming.headers }, (response) => {
      if (shouldDrop && response.statusCode < 400) {
        dropped = true;
        response.resume();
        response.on("end", () => outgoing.destroy());
      } else {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      }
    });
    forward.on("error", (error) => outgoing.destroy(error));
    incoming.pipe(forward);
  });
  server.listen(socket);
  await once(server, "listening");
  return {
    dropped: () => dropped,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
