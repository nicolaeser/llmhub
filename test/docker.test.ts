import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function file(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("next emits the standalone server the image runs", async () => {
  const config = await file("next.config.ts");
  assert.match(config, /output: "standalone"/);
});

test("every stage builds on Debian trixie slim", async () => {
  const dockerfile = await file("Dockerfile");
  const froms = [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)];
  assert.deepEqual(froms.map((match) => match[2]), ["base", "deps", "prismacli", "builder", "runner"]);
  assert.equal(froms[0][1], "node:${NODE_VERSION}-trixie-slim");
  for (const [, image] of froms.slice(1)) assert.equal(image, "base");
  assert.doesNotMatch(dockerfile, /apt-get|apk |dumb-init|useradd|groupadd/);
});

test("the runner only carries runtime files and runs as the node user", async () => {
  const dockerfile = await file("Dockerfile");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  assert.match(runner, /COPY --from=prismacli .*\/pc\/node_modules \.\/node_modules/);
  assert.match(runner, /COPY --from=builder .*\.next\/standalone/);
  assert.doesNotMatch(runner, /COPY --from=deps|npm (ci|install)|COPY \. /);
  assert.match(runner, /USER node/);
  assert.match(runner, /HEALTHCHECK[\s\S]*\/internal-api\/health/);
});

test("CI bakes the release version into the image as BUILD_ID", async () => {
  const dockerfile = await file("Dockerfile");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  assert.match(runner, /ARG BUILD_ID=development\nENV BUILD_ID=\$\{BUILD_ID\}/);
  const pipeline = await file(".github/workflows/pipeline.yml");
  assert.match(pipeline, /^ {2}workflow_call:$/m);
  assert.match(pipeline, /version="\$\{VERSION_PREFIX\}\$\(date -u \+%Y\.%m\.%d\)\.\$\{short_sha\}"/);
  assert.match(
    pipeline,
    /build-args: \|\n {12}BUILD_ID=\$\{\{ steps\.version\.outputs\.version \}\}/,
  );
  for (const [workflow, prefix] of [
    [".github/workflows/main.yml", "v"],
    [".github/workflows/development.yml", "dev-"],
  ]) {
    const source = await file(workflow);
    assert.equal(source.match(/uses: \.\/\.github\/workflows\/pipeline\.yml/g)?.length, 2, workflow);
    assert.equal(source.match(new RegExp(`version-prefix: ${prefix}\\n`, "g"))?.length, 2, workflow);
  }
});

test("only pushes get write permissions in CI", async () => {
  const pipeline = await file(".github/workflows/pipeline.yml");
  assert.doesNotMatch(pipeline, /: write/);
  assert.match(pipeline, /push: \$\{\{ inputs\.publish \}\}/);
  for (const workflow of [".github/workflows/main.yml", ".github/workflows/development.yml"]) {
    const source = await file(workflow);
    const verify = source.slice(source.indexOf("  verify:"), source.indexOf("  release:"));
    const release = source.slice(source.indexOf("  release:"));
    assert.match(source, /^permissions:\n {2}contents: read$/m, workflow);
    assert.match(verify, /if: github\.event_name == 'pull_request'/, workflow);
    assert.doesNotMatch(verify, /: write|publish: true/, workflow);
    assert.match(release, /if: github\.event_name == 'push'/, workflow);
    assert.match(release, /packages: write/, workflow);
    assert.match(release, /publish: true/, workflow);
  }
});

test("CI migrates a real Postgres, checks schema drift, and runs integration tests", async () => {
  const pipeline = await file(".github/workflows/pipeline.yml");
  const quality = pipeline.slice(pipeline.indexOf("\n  quality:\n"), pipeline.indexOf("\n  image:\n"));
  assert.match(quality, /image: postgres:18-alpine/);
  const steps = [
    "npx prisma migrate deploy",
    "npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code",
    "npm test",
    "npm run test:integration",
    "npx tsc --noEmit",
    "npm run lint",
  ].map((step) => quality.indexOf(step));
  assert.ok(steps.every((index, i) => index > 0 && (i === 0 || index > steps[i - 1])), String(steps));
});

test("the container applies migrations before the web server starts", async () => {
  const dockerfile = await file("Dockerfile");
  const cmd = /^CMD \[(.*)\]$/m.exec(dockerfile)?.[1] ?? "";
  assert.ok(cmd.indexOf("node migrate-deploy.mjs") < cmd.indexOf("exec node server.js"));
  assert.match(cmd, /&& exec node server\.js/);
  assert.doesNotMatch(dockerfile, /ENTRYPOINT|seed/);
});

test("migrations run through the Prisma CLI under an advisory lock", async () => {
  const runner = await file("scripts/migrate-deploy.mjs");
  assert.match(runner, /"migrate", "deploy"/);
  assert.match(runner, /"migrate", "status"/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /APP_SECRET/);
});

test("image context excludes secrets and local build output", async () => {
  const ignore = (await file(".dockerignore")).split("\n");
  for (const entry of [".env*", ".git", "node_modules", ".next", "src/generated", "test"]) {
    assert.ok(ignore.includes(entry), entry);
  }
});

test("deploy compose pulls the published image and dev compose builds it", async () => {
  const [deploy, dev] = await Promise.all([
    file("docker-compose.yml"),
    file("docker-compose.dev.yml"),
  ]);
  assert.match(deploy, /image: ghcr\.io\/nicolaeser\/llmhub:\$\{LLMHUB_TAG:-latest\}/);
  assert.doesNotMatch(deploy + dev, /:\?/);
  assert.doesNotMatch(deploy, /build:/);
  assert.match(dev, /build:\n {6}context: \./);
  assert.match(deploy, /"127\.0\.0\.1:\$\{LLMHUB_PORT:-3000\}:3000"/);
  for (const source of [deploy, dev]) assert.match(source, /NODE_ENV: production/);
});

test("compose keeps postgres and redis data in bind mounts next to the compose file", async () => {
  const [deploy, dev, gitignore, dockerignore] = await Promise.all([
    file("docker-compose.yml"),
    file("docker-compose.dev.yml"),
    file(".gitignore"),
    file(".dockerignore"),
  ]);
  for (const source of [deploy, dev]) {
    assert.match(source, /^ {6}- \.\/postgres-data:\/var\/lib\/postgresql$/m);
    assert.match(source, /^ {6}- \.\/redis-data:\/data$/m);
    assert.doesNotMatch(source, /^volumes:/m);
  }
  for (const dir of ["postgres-data", "redis-data"]) {
    assert.ok(gitignore.split("\n").includes(`/${dir}/`), dir);
    assert.ok(dockerignore.split("\n").includes(dir), dir);
  }
});

test("compose files read credentials from the generated .env", async () => {
  const [deploy, dev] = await Promise.all([
    file("docker-compose.yml"),
    file("docker-compose.dev.yml"),
  ]);
  for (const source of [deploy, dev]) {
    for (const name of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"]) {
      assert.match(source, new RegExp(`${name}: \\$\\{${name}\\}`), name);
    }
    assert.match(
      source,
      /DATABASE_URL: postgresql:\/\/\$\{POSTGRES_USER\}:\$\{POSTGRES_PASSWORD\}@postgres:5432\/\$\{POSTGRES_DB\}/,
    );
    assert.match(source, /REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD\}@redis:6379/);
    assert.match(source, /"--requirepass", "\$\{REDIS_PASSWORD\}"/);
    assert.match(source, /REDISCLI_AUTH: \$\{REDIS_PASSWORD\}/);
    assert.doesNotMatch(source, /llmhub:\$\{POSTGRES_PASSWORD\}|-U llmhub/);
    assert.match(source, /env_file:\n {6}- \.env/);
  }
  assert.match(dev, /RUSTFS_ACCESS_KEY: \$\{S3_ACCESS_KEY_ID\}/);
  assert.match(dev, /RUSTFS_SECRET_KEY: \$\{S3_SECRET_ACCESS_KEY\}/);
});

test("generate-env.sh writes the production .env and keeps an existing one", async () => {
  const script = await file("generate-env.sh");
  assert.match(script, /^#!\/usr\/bin\/env bash$/m);
  assert.match(script, /^set_value NODE_ENV production$/m);
  assert.match(script, /--force\) FORCE=true/);
  assert.match(script, /chmod 600 "\$tmp"/);
  for (const name of ["LLMHUB_TAG", "NEXT_PUBLIC_APP_URL", "LLMHUB_PORT", "POSTGRES_USER", "POSTGRES_DB", "SMTP_URL"]) {
    assert.match(script, new RegExp(`^\\s*ask(_secret)? ${name} `, "m"), name);
  }
  for (const name of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "APP_SECRET"]) {
    assert.match(script, new RegExp(`^generated ${name} `, "m"), name);
  }
  assert.doesNotMatch(script, /^\s*(?:set_value|ask|generated|keep_or) (?:DATABASE_URL|REDIS_URL) /m);
  assert.doesNotMatch(script, /127\.0\.0\.1:5433/);
  assert.doesNotMatch(script, /NODE_ENV development/);
});
