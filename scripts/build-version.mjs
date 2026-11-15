import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function buildVersion(channel, commit, commitDate) {
  if (channel !== "main" && channel !== "development") throw new Error("Unsupported release channel");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Expected the full build commit SHA");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(commitDate) ||
      new Date(`${commitDate}T00:00:00Z`).toISOString().slice(0, 10) !== commitDate) {
    throw new Error("Expected the commit date in YYYY-MM-DD format");
  }
  const short = commit.slice(0, 7);
  const prerelease = channel === "development";
  const version = `${prerelease ? "vdev" : "v"}${commitDate.replaceAll("-", ".")}.${short}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) throw new Error("Invalid build version");
  return {
    version,
    prerelease,
    tags: prerelease ? [version, `dev-${short}`, "dev"] : [version, short, "latest"],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const commit = process.env.GITHUB_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("GITHUB_SHA must identify the build commit");
  const date = execFileSync("git", ["show", "-s", "--format=%cs", commit], { encoding: "utf8" }).trim();
  const metadata = buildVersion(process.env.CHANNEL, commit, date);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT,
    `version=${metadata.version}\nprerelease=${metadata.prerelease}\ntags=${JSON.stringify(metadata.tags)}\n`);
}
