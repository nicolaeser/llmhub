import { COMPOSE_PROJECT_LABEL, containerName } from "./container-config.mjs";
import { errorMessage, log } from "./log.mjs";
import { BACKUP_SUFFIX, isBackup, recreateContainer } from "./recreate.mjs";

export const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
export const REDIS_SNAPSHOT_FLAGS = ["--appendonly", "no", "--save", "60 1", "--stop-writes-on-bgsave-error", "no"];
const REDIS_IMAGE = /^(?:docker\.io\/)?(?:library\/)?redis(?:[:@].*)?$/;

export function snapshotRedisCommand(command) {
  if (!Array.isArray(command) || command.length !== 5) return null;
  const [server, appendFlag, appendValue, passwordFlag, password] = command;
  if (server !== "redis-server" || appendFlag !== "--appendonly" || appendValue !== "yes" || passwordFlag !== "--requirepass") {
    return null;
  }
  if (typeof password !== "string") return null;
  return [server, ...REDIS_SNAPSHOT_FLAGS, passwordFlag, password];
}

export async function switchRedisToSnapshots(docker, project, { skip = new Set(), waitOptions = {} } = {}) {
  const summaries = await docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${project}`, `${COMPOSE_SERVICE_LABEL}=redis`]);
  const switched = [];
  for (const summary of summaries ?? []) {
    if (skip.has(summary.Id)) continue;
    let name = summary.Id;
    try {
      const container = await docker.inspectContainer(summary.Id);
      if (!container || isBackup(container)) continue;
      const labels = container.Config?.Labels ?? {};
      if (labels[COMPOSE_PROJECT_LABEL] !== project || labels[COMPOSE_SERVICE_LABEL] !== "redis") continue;
      const command = snapshotRedisCommand(container.Config?.Cmd);
      if (!command || !REDIS_IMAGE.test(String(container.Config?.Image ?? ""))) continue;
      if (container.State?.Running !== true || container.State?.Paused || container.State?.Restarting || container.State?.Health?.Status !== "healthy") continue;
      const directory = container.Config?.WorkingDir || "/data";
      const persistentData = directory === "/data" && (container.Mounts ?? []).some(
        (mount) => mount.Destination === "/data" && mount.RW === true &&
          ((mount.Type === "bind" && mount.Source) || (mount.Type === "volume" && mount.Name)),
      );
      if (!persistentData) continue;
      const image = await docker.inspectImage(container.Image);
      if (!image || image.Id !== container.Image) continue;
      name = containerName(container);
      log("info", "updater.redis_switching", { container: name });
      await recreateContainer(docker, container, {
        imageRef: container.Config.Image,
        image,
        onPhase: async (phase) => {
          if (phase !== "recreating") return;
          if (await docker.inspectContainer(`${name}${BACKUP_SUFFIX}`)) {
            throw new Error("an unresolved Redis backup must be recovered before switching persistence");
          }
        },
        waitOptions,
        cleanStop: true,
        configure: (body) => {
          body.Image = container.Image;
          body.Cmd = command;
          if (!Number.isInteger(container.Config?.StopTimeout)) delete body.StopTimeout;
        },
      });
      switched.push(name);
      log("info", "updater.redis_switched", { container: name });
    } catch (err) {
      skip.add(summary.Id);
      log("error", "updater.redis_switch_failed", { container: name, err: errorMessage(err) });
    }
  }
  return switched;
}
