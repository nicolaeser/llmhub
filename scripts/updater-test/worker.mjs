import { readFile } from "node:fs/promises";
import { setInterval } from "node:timers";
import { dockerClient } from "../updater/docker.mjs";
import { recreateGroup } from "../updater/transaction.mjs";

const settings = JSON.parse(await readFile(process.argv[2], "utf8"));
const docker = dockerClient(settings.socket);
const operation = docker[settings.interruptAfter];
docker[settings.interruptAfter] = async (...args) => {
  const result = await operation(...args);
  process.send({ interrupted: settings.interruptAfter });
  await new Promise(() => setInterval(() => {}, 1000));
  return result;
};
await recreateGroup(docker, settings.containers, {
  ...settings.options,
  onPhase: async () => {},
});
throw new Error("worker completed without reaching the interruption point");
