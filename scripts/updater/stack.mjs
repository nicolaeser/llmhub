import { COMPOSE_PROJECT_LABEL, containerName } from "./container-config.mjs";
import { errorMessage, log } from "./log.mjs";
import { recreateContainer } from "./recreate.mjs";

export const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
export const REDIS_SNAPSHOT_FLAGS = ["--appendonly", "no", "--save", "60 1", "--stop-writes-on-bgsave-error", "no"];
const REDIS_IMAGE = /^(?:docker\.io\/)?(?:library\/)?redis(?:[:@].*)?$/;

export function snapshotRedisCommand(command) {
  if (!Array.isArray(command) || command.length !== 5) return null;
  const [server, appendFlag, appendValue, passwordFlag, password] = command;
  if (server !== "redis-server" || appendFlag !== "--appendonly" || appendValue !== "yes" || passwordFlag !== "--requirepass") {
    return null;
  }
  return [server, ...REDIS_SNAPSHOT_FLAGS, passwordFlag, password];
}

export async function switchRedisToSnapshots(docker, project, { skip = new Set(), waitOptions = {} } = {}) {
  const summaries = await docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${project}`, `${COMPOSE_SERVICE_LABEL}=redis`]);
  const switched = [];
  for (const summary of summaries ?? []) {
    if (skip.has(summary.Id)) continue;
    const container = await docker.inspectContainer(summary.Id);
    const command = snapshotRedisCommand(container?.Config?.Cmd);
    if (!container || !command || !REDIS_IMAGE.test(String(container.Config?.Image ?? ""))) continue;
    if (container.State?.Running !== true || container.State?.Health?.Status !== "healthy") continue;
    const image = await docker.inspectImage(container.Image);
    if (!image) continue;
    const name = containerName(container);
    log("info", "updater.redis_switching", { container: name });
    try {
      await recreateContainer(docker, container, {
        imageRef: container.Config.Image,
        image,
        onPhase: async () => {},
        waitOptions,
        cleanStop: true,
        configure: (body) => {
          body.Cmd = command;
          if (!Number.isInteger(container.Config?.StopTimeout)) delete body.StopTimeout;
        },
      });
      switched.push(name);
      log("info", "updater.redis_switched", { container: name });
    } catch (err) {
      skip.add(container.Id);
      log("error", "updater.redis_switch_failed", { container: name, err: errorMessage(err) });
    }
  }
  return switched;
}
