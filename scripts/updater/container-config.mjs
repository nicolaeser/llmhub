const IMAGE_DEFAULTS = ["WorkingDir", "User", "StopSignal", "Shell", "OnBuild", "ArgsEscaped"];
const HEALTHCHECK_FIELDS = ["Test", "Interval", "Timeout", "StartPeriod", "StartInterval", "Retries"];
const DEFAULT_STOP_SECONDS = 10;

export const COMPOSE_IMAGE_LABEL = "com.docker.compose.image";
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

function unset(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0) || value === "";
}

function same(a, b) {
  if (unset(a) && unset(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function withoutKeys(map, defaults) {
  if (!map) return map;
  const own = Object.fromEntries(Object.entries(map).filter(([key]) => !(defaults && key in defaults)));
  return Object.keys(own).length ? own : undefined;
}

function withoutEntries(map, defaults) {
  if (!map) return map;
  const own = Object.fromEntries(
    Object.entries(map).filter(([key, value]) => !(defaults && key in defaults && defaults[key] === value)),
  );
  return Object.keys(own).length ? own : undefined;
}

function envKey(entry) {
  const index = entry.indexOf("=");
  return index < 0 ? entry : entry.slice(0, index);
}

export function containerName(container) {
  return String(container.Name ?? "").replace(/^\//, "");
}

export function shortId(id) {
  return String(id).slice(0, 12);
}

export function stopSeconds(container) {
  const value = container.Config?.StopTimeout;
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_STOP_SECONDS;
}

export function hasHealthcheck(container) {
  const test = container.Config?.Healthcheck?.Test;
  return Array.isArray(test) && test.length > 0 && test[0] !== "NONE";
}

function healthcheckFor(own, defaults) {
  if (!own) return undefined;
  if (!defaults) return own;
  const kept = Object.fromEntries(HEALTHCHECK_FIELDS.filter((field) => !same(own[field], defaults[field])).map((field) => [field, own[field]]));
  return Object.keys(kept).length ? kept : undefined;
}

function hostConfigFor(container) {
  const host = clone(container.HostConfig ?? {});
  if (Array.isArray(host.Links)) {
    host.Links = host.Links.map((link) => {
      const [target, alias] = String(link).split(":");
      return `${target.replace(/^\//, "")}:${String(alias ?? "").split("/").pop()}`;
    });
  }
  return host;
}

export function networkingFor(container) {
  const networks = container.NetworkSettings?.Networks ?? {};
  const dropped = new Set([shortId(container.Id), container.Id]);
  const endpoints = {};
  for (const [network, endpoint] of Object.entries(networks)) {
    const aliases = (endpoint?.Aliases ?? []).filter((alias) => !dropped.has(alias));
    endpoints[network] = {
      ...(aliases.length ? { Aliases: aliases } : {}),
      ...(endpoint?.IPAMConfig ? { IPAMConfig: endpoint.IPAMConfig } : {}),
      ...(endpoint?.Links?.length ? { Links: endpoint.Links } : {}),
      ...(endpoint?.DriverOpts ? { DriverOpts: endpoint.DriverOpts } : {}),
    };
  }
  return { EndpointsConfig: endpoints };
}

function samePlatform(a, b) {
  return Boolean(a && b) && a.os === b.os && a.architecture === b.architecture && (a.variant ?? "") === (b.variant ?? "");
}

export function composeImageLabel(container, image) {
  const current = container.Config?.Labels?.[COMPOSE_IMAGE_LABEL];
  const descriptor = container.ImageManifestDescriptor;
  if (!current || !descriptor?.digest || current !== descriptor.digest || current === container.Image) return image.Id;
  const manifest = (image.Manifests ?? []).find(
    (entry) =>
      entry.Kind === "image" &&
      entry.Available !== false &&
      samePlatform(entry.ImageData?.Platform ?? entry.Descriptor?.platform, descriptor.platform),
  );
  return manifest?.ID ?? image.Id;
}

export function createConfigFor(container, oldImage, target) {
  const { imageRef, imageId } = target;
  const composeImage = target.composeImage ?? imageId;
  const extraEnv = Array.isArray(target.env) ? target.env : [];
  const config = clone(container.Config ?? {});
  const defaults = oldImage?.Config ?? {};
  config.Image = imageRef;
  const networkMode = String(container.HostConfig?.NetworkMode ?? "");
  if (config.Hostname === shortId(container.Id) || networkMode.startsWith("container:")) delete config.Hostname;
  if (unset(config.Domainname)) delete config.Domainname;
  for (const key of IMAGE_DEFAULTS) {
    if (same(config[key], defaults[key])) delete config[key];
  }
  if (same(config.Entrypoint, defaults.Entrypoint)) {
    delete config.Entrypoint;
    if (same(config.Cmd, defaults.Cmd)) delete config.Cmd;
  }
  const imageEnv = new Set(defaults.Env ?? []);
  const replaced = new Set(extraEnv.map(envKey));
  config.Env = [
    ...(config.Env ?? []).filter((entry) => !imageEnv.has(entry) && !replaced.has(envKey(entry))),
    ...extraEnv,
  ];
  if (!config.Env.length) delete config.Env;
  config.Labels = withoutEntries(config.Labels, defaults.Labels) ?? {};
  if (config.Labels[COMPOSE_PROJECT_LABEL] && composeImage) config.Labels[COMPOSE_IMAGE_LABEL] = composeImage;
  config.Volumes = withoutKeys(config.Volumes, defaults.Volumes);
  if (!config.Volumes) delete config.Volumes;
  const exposed = withoutKeys(config.ExposedPorts, defaults.ExposedPorts) ?? {};
  for (const port of Object.keys(container.HostConfig?.PortBindings ?? {})) exposed[port] = {};
  if (Object.keys(exposed).length) config.ExposedPorts = exposed;
  else delete config.ExposedPorts;
  const healthcheck = healthcheckFor(config.Healthcheck, defaults.Healthcheck);
  if (healthcheck) config.Healthcheck = healthcheck;
  else delete config.Healthcheck;
  return { ...config, HostConfig: hostConfigFor(container), NetworkingConfig: networkingFor(container) };
}
