import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stopSeconds } from "../../scripts/updater/container-config.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

function file(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function routeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) return routeFiles(relative);
      return Promise.resolve(entry.name === "route.ts" ? [relative] : []);
    }),
  );
  return nested.flat();
}

function composeServices(source: string): Map<string, string> {
  const services = source.slice(source.indexOf("\nservices:\n"));
  return new Map([...services.matchAll(/^ {2}([a-z]+):\n((?: {4}.*\n|\n)*)/gm)].map((match) => [match[1], match[2]]));
}

test("next emits the standalone server the image runs", async () => {
  const config = await file("next.config.ts");
  assert.match(config, /output: "standalone"/);
});

test("the standalone trace carries the usage PDF fonts with their licenses", async () => {
  const config = await file("next.config.ts");
  assert.match(config, /"\/internal-api\/usage\/export": \["\.\/src\/lib\/export\/fonts\/\*"\]/);
  const fonts = (await readdir(path.join(root, "src/lib/export/fonts"))).sort();
  assert.deepEqual(fonts, [
    "Geist-Bold.ttf.br",
    "Geist-Regular.ttf.br",
    "NotoSans-Bold.ttf.br",
    "NotoSans-Regular.ttf.br",
    "NotoSansKR-Regular.ttf.br",
    "NotoSansSC-Regular.ttf.br",
    "OFL-Geist.txt",
    "OFL-NotoSans.txt",
    "OFL-NotoSansCJK.txt",
  ]);
  for (const license of fonts.filter((name) => name.endsWith(".txt"))) {
    assert.match(await file(`src/lib/export/fonts/${license}`), /SIL Open Font License, Version 1\.1/);
  }
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
  for (const tool of ["node_modules/npm", "node_modules/corepack", "/opt/yarn-v*", "bin/npx", "bin/yarn"]) {
    assert.ok(runner.slice(0, runner.indexOf("USER node")).includes(tool), tool);
  }
});

test("the dependency stage skips the postinstall generate that the builder runs with the schema", async () => {
  const [dockerfile, pkg] = await Promise.all([file("Dockerfile"), file("package.json")]);
  assert.equal(JSON.parse(pkg).scripts.postinstall, "prisma generate");
  const deps = dockerfile.slice(dockerfile.indexOf("AS deps"), dockerfile.indexOf("AS prismacli"));
  assert.match(deps, /npm ci --ignore-scripts/);
  const builder = dockerfile.slice(dockerfile.indexOf("AS builder"), dockerfile.indexOf("AS runner"));
  assert.match(builder, /npx prisma generate && npm run build/);
});

test("CI bakes the release version into the image as BUILD_ID", async () => {
  const dockerfile = await file("Dockerfile");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  assert.match(runner, /ARG BUILD_ID=development\nENV BUILD_ID=\$\{BUILD_ID\}/);
  const pipeline = await file(".github/workflows/pipeline.yml");
  assert.match(pipeline, /^ {2}workflow_call:$/m);
  assert.match(pipeline, /main\)\n {14}VERSION_PREFIX=v\n/);
  assert.match(pipeline, /development\)\n {14}VERSION_PREFIX=dev-\n/);
  assert.match(pipeline, /version="\$\{VERSION_PREFIX\}\$\(date -u \+%Y\.%m\.%d\)\.\$\{short_sha\}"/);
  assert.match(pipeline, /BUILD_ID: \$\{\{ needs\.version\.outputs\.version \}\}/);
  assert.match(pipeline, /build-args: \|\n {12}BUILD_ID=\$\{\{ env\.BUILD_ID \}\}/);
  for (const [workflow, channel] of [
    [".github/workflows/verify.yml", "github.base_ref"],
    [".github/workflows/release.yml", "github.ref_name"],
  ]) {
    const source = await file(workflow);
    assert.equal(source.match(/uses: \.\/\.github\/workflows\/pipeline\.yml/g)?.length, 1, workflow);
    assert.ok(source.includes(`channel: \${{ ${channel} }}`), workflow);
  }
});

test("the Google OAuth client secret enters the image only as a BuildKit secret", async () => {
  const dockerfile = await file("Dockerfile");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  const step = runner.indexOf("RUN --mount=type=secret,id=antigravity_client_secret,required=false");
  assert.ok(step > runner.indexOf("ENV BUILD_ID=${BUILD_ID}"), "re-run on every build because secrets are not in the cache key");
  assert.ok(step < runner.indexOf("USER node"), "written by root");
  assert.match(
    runner,
    /if \[ -s \/run\/secrets\/antigravity_client_secret \]; then \\\n {6}install -o root -g node -m 0440 \/run\/secrets\/antigravity_client_secret antigravity-client-secret; \\\n {4}fi\n/,
  );
  assert.equal(dockerfile.match(/antigravity_client_secret/g)?.length, 3);
  assert.doesNotMatch(dockerfile, /^(?:ARG|ENV)\b.*antigravity/im);

  const pipeline = await file(".github/workflows/pipeline.yml");
  assert.match(pipeline, /^ {4}secrets:\n {6}antigravity_client_secret:\n {8}required: false\n/m);
  assert.match(pipeline, /secrets: \|\n {12}antigravity_client_secret=\$\{\{ secrets\.antigravity_client_secret \}\}\n/);
  assert.doesNotMatch(pipeline.slice(pipeline.indexOf("build-args:"), pipeline.indexOf("secrets: |")), /antigravity/i);
  for (const workflow of [".github/workflows/verify.yml", ".github/workflows/release.yml"]) {
    const source = await file(workflow);
    assert.match(source, /secrets:\n {6}antigravity_client_secret: \$\{\{ secrets\.ANTIGRAVITY_CLIENT_SECRET \}\}\n/, workflow);
    assert.doesNotMatch(source, /secrets: inherit/, workflow);
  }

  const [gitignore, dockerignore] = await Promise.all([file(".gitignore"), file(".dockerignore")]);
  assert.ok(gitignore.split("\n").includes("/antigravity-client-secret"));
  assert.ok(dockerignore.split("\n").includes("antigravity-client-secret"));
});

test("only pushes get write permissions in CI", async () => {
  const pipeline = await file(".github/workflows/pipeline.yml");
  assert.doesNotMatch(pipeline, /: write/);
  assert.match(pipeline, /outputs: \$\{\{ inputs\.publish && format\('type=image,[^']*push=true'/);
  const verify = await file(".github/workflows/verify.yml");
  assert.match(verify, /^on:\n {2}pull_request:$/m);
  assert.match(verify, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(verify, /push:|: write|publish: true/);
  const release = await file(".github/workflows/release.yml");
  assert.match(release, /^on:\n {2}push:$/m);
  assert.match(release, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(release, /pull_request/);
  assert.match(release, /packages: write/);
  assert.match(release, /publish: true/);
  assert.match(release, /cancel-in-progress: false/);
});

test("CI smoke-tests each platform image natively before tagging it", async () => {
  const pipeline = await file(".github/workflows/pipeline.yml");
  const image = pipeline.slice(pipeline.indexOf("\n  image:\n"));
  assert.match(image, /runner: ubuntu-24\.04\n/);
  assert.match(image, /runner: ubuntu-24\.04-arm\n/);
  assert.doesNotMatch(pipeline, /setup-qemu-action/);
  const smoke = image.indexOf("scripts/smoke-image.sh");
  assert.ok(smoke > image.indexOf("docker/build-push-action"), "smoke test after build");
  assert.ok(smoke < image.indexOf("actions/upload-artifact"), "smoke test before digest upload");
  const release = await file(".github/workflows/release.yml");
  const publish = release.slice(release.indexOf("\n  publish:\n"), release.indexOf("\n  scan:\n"));
  assert.match(publish, /needs: \[build\]/);
  assert.match(publish, /docker buildx imagetools create/);
  assert.ok(publish.indexOf("imagetools create") < publish.indexOf("gh release create"));
  assert.match(release.slice(release.indexOf("\n  scan:\n")), /needs: \[publish\]/);
  const script = await file("scripts/smoke-image.sh");
  for (const probe of ["/internal-api/ready", "/internal-api/health", "/internal-api/version", "/internal-api/setup"]) {
    assert.ok(script.includes(probe), probe);
  }
  assert.match(script, /docker restart/);
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

test("CI rejects migrations that sort before the base branch's newest one", async () => {
  const pipeline = await file(".github/workflows/pipeline.yml");
  const quality = pipeline.slice(pipeline.indexOf("\n  quality:\n"), pipeline.indexOf("\n  image:\n"));
  const check = quality.indexOf("npm run migrations:check -- \"${base}\"");
  assert.ok(check > 0 && check < quality.indexOf("npx prisma migrate deploy"));
  assert.match(quality, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(quality, /BEFORE: \$\{\{ github\.event\.before \}\}/);
  const pkg = JSON.parse(await file("package.json"));
  assert.equal(pkg.scripts["migrations:check"], "node scripts/check-migration-order.mjs");
});

test("CI blocks fixable high and critical image findings before anything is tagged", async () => {
  const pipeline = await file(".github/workflows/pipeline.yml");
  const image = pipeline.slice(pipeline.indexOf("\n  image:\n"));
  const scan = image.indexOf("aquasecurity/trivy-action@");
  assert.ok(scan > image.indexOf("scripts/smoke-image.sh"), "scan after smoke test");
  assert.ok(scan < image.indexOf("actions/upload-artifact"), "scan before digest upload");
  const step = image.slice(scan, image.indexOf("\n\n", scan));
  assert.match(step, /severity: HIGH,CRITICAL/);
  assert.match(step, /ignore-unfixed: true/);
  assert.match(step, /exit-code: "1"/);
});

test("pull requests review new dependencies and audit production dependencies", async () => {
  const verify = await file(".github/workflows/verify.yml");
  const dependencies = verify.slice(verify.indexOf("\n  dependencies:\n"));
  assert.match(dependencies, /uses: actions\/dependency-review-action@v\d+(?:\.\d+){0,2}\n {8}with:\n {10}fail-on-severity: high\n/);
  assert.match(dependencies, /run: npm audit --omit=dev --audit-level=high/);
  assert.match(dependencies, /timeout-minutes: \d+/);
});

test("workflows reference every action by a release version tag", async () => {
  const workflows = (await readdir(path.join(root, ".github/workflows"))).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length > 0);
  for (const name of workflows) {
    const source = await file(`.github/workflows/${name}`);
    for (const [, ref] of source.matchAll(/^\s*(?:- )?uses: (.+)$/gm)) {
      if (ref.startsWith("./.github/workflows/")) continue;
      assert.match(ref, /^[\w.-]+\/[\w./-]+@v\d+(?:\.\d+){0,2}$/, `${name}: ${ref}`);
    }
  }
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
  for (const entry of [".env*", ".git", "node_modules", ".next", "src/generated", "src/tests"]) {
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

test("production compose drains requests on stop, rotates logs, and caps memory", async () => {
  const [deploy, au] = await Promise.all([file("docker-compose.yml"), file("docker-compose.au.yml")]);
  const durations = await Promise.all(
    (await routeFiles("src/app")).map(async (route) => Number(/export const maxDuration = (\d+);/.exec(await file(route))?.[1] ?? 0)),
  );
  const longest = Math.max(...durations);
  for (const source of [deploy, au]) {
    assert.match(source, /^x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: "\d+m"\n {4}max-file: "\d+"\n/);
    const services = composeServices(source);
    assert.ok(services.size >= 3);
    for (const [name, block] of services) {
      assert.match(block, /^ {4}logging: \*logging$/m, name);
      assert.match(block, /^ {4}mem_limit: \S+$/m, name);
    }
    const app = services.get("app") ?? "";
    const grace = Number(/^ {4}stop_grace_period: (\d+)s$/m.exec(app)?.[1]);
    assert.ok(grace > longest, `stop_grace_period ${grace}s must exceed the longest route maxDuration ${longest}s`);
    assert.equal(stopSeconds({ Config: {} }), grace);
    assert.match(app, /^ {4}mem_limit: \$\{LLMHUB_MEMORY_LIMIT:-\d+[mg]\}$/m);
    assert.match(services.get("postgres") ?? "", /^ {4}mem_limit: \$\{POSTGRES_MEMORY_LIMIT:-\d+[mg]\}$/m);
    assert.match(services.get("redis") ?? "", /^ {4}mem_limit: \$\{REDIS_MEMORY_LIMIT:-\d+[mg]\}$/m);
  }
  assert.ok(composeServices(au).has("updater"));
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
  for (const name of [
    "LLMHUB_TAG",
    "NEXT_PUBLIC_APP_URL",
    "LLMHUB_PORT",
    "IP_MODE",
    "POSTGRES_USER",
    "POSTGRES_DB",
    "SMTP_URL",
    "SMTP_FROM",
    "OIDC_CLIENT_SECRET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ]) {
    assert.match(script, new RegExp(`^\\s*ask(_secret)? ${name} `, "m"), name);
  }
  for (const name of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "APP_SECRET"]) {
    assert.match(script, new RegExp(`^generated ${name} `, "m"), name);
  }
  assert.doesNotMatch(script, /^\s*(?:set_value|ask|generated|remember) (?:DATABASE_URL|REDIS_URL) /m);
  assert.doesNotMatch(script, /127\.0\.0\.1:5433/);
  assert.doesNotMatch(script, /NODE_ENV development/);
});

const modernBash = spawnSync("bash", ["-c", "((BASH_VERSINFO[0] >= 5))"]).status === 0;

test("generate-env.sh --yes builds the production .env from the environment", { skip: !modernBash }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "llmhub-env-"));
  const output = path.join(dir, ".env");
  const run = (args: string[], answers: Record<string, string> = {}) =>
    spawnSync("bash", [path.join(root, "generate-env.sh"), ...args], {
      encoding: "utf8",
      input: "",
      env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", ENV_OUTPUT: output, ...answers },
    });
  try {
    const missing = run(["--yes"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Missing required values: NEXT_PUBLIC_APP_URL/);

    const first = run(["--yes"], {
      NEXT_PUBLIC_APP_URL: "Hub.Example.com/",
      SMTP_URL: "smtp://mailer%40example.com:p%40ss@mail.example.com:587",
    });
    assert.equal(first.status, 0, first.stderr);
    const written = await readFile(output, "utf8");
    assert.match(written, /^NODE_ENV=production$/m);
    assert.match(written, /^NEXT_PUBLIC_APP_URL=https:\/\/hub\.example\.com$/m);
    assert.match(written, /^LLMHUB_TAG=latest$/m);
    assert.match(written, /^IP_MODE=proxy$/m);
    assert.match(written, /^POSTGRES_PASSWORD=[A-Za-z0-9_-]{32}$/m);
    assert.match(written, /^APP_SECRET=[0-9a-f]{64}$/m);
    assert.match(written, /^SMTP_FROM=mailer@example\.com$/m);
    assert.doesNotMatch(written, /^(?:DATABASE_URL|REDIS_URL|OIDC_CLIENT_SECRET|S3_ACCESS_KEY_ID)=/m);

    const invalidMode = run(["--yes", "--force"], { IP_MODE: "x-forwarded-for" });
    assert.equal(invalidMode.status, 1);
    assert.match(invalidMode.stderr, /IP_MODE/);
    assert.equal(await readFile(output, "utf8"), written);

    const refused = run(["--yes"], { NEXT_PUBLIC_APP_URL: "https://other.example.com" });
    assert.equal(refused.status, 1);
    assert.equal(await readFile(output, "utf8"), written);

    await appendFile(output, "EXTRA_SETTING=kept\n");
    const updated = run(["--yes", "--force"], { OIDC_CLIENT_SECRET: "sso-secret", IP_MODE: "cloudflare" });
    assert.equal(updated.status, 0, updated.stderr);
    const next = await readFile(output, "utf8");
    for (const name of ["APP_SECRET", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "SMTP_URL", "NEXT_PUBLIC_APP_URL"]) {
      const line = new RegExp(`^${name}=.*$`, "m");
      assert.equal(line.exec(next)?.[0], line.exec(written)?.[0], name);
    }
    assert.match(next, /^OIDC_CLIENT_SECRET=sso-secret$/m);
    assert.match(next, /^IP_MODE=cloudflare$/m);
    assert.match(next, /^EXTRA_SETTING=kept$/m);
    assert.equal(await readFile(`${output}.bak`, "utf8"), `${written}EXTRA_SETTING=kept\n`);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the runner carries the updater next to the migration script", async () => {
  const dockerfile = await file("Dockerfile");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  assert.match(runner, /COPY --chown=node:node prisma\.config\.ts scripts\/migrate-deploy\.mjs scripts\/updater\.mjs \.\//);
  assert.match(runner, /COPY --chown=node:node scripts\/updater \.\/updater\n/);
  const entry = await file("scripts/updater.mjs");
  assert.match(entry, /from "\.\/updater\/agent\.mjs"/);
  assert.match(entry, /--healthcheck/);
});

test("the auto-update stack is the production stack plus the updater", async () => {
  const [deploy, dev, au, dockerignore] = await Promise.all([
    file("docker-compose.yml"),
    file("docker-compose.dev.yml"),
    file("docker-compose.au.yml"),
    file(".dockerignore"),
  ]);
  assert.doesNotMatch(deploy + dev, /docker\.sock|updater/);
  const appTarget = '    labels:\n      llmhub.updater.target: "true"\n';
  const updaterStart = au.indexOf("\n  updater:\n");
  assert.ok(au.includes(appTarget));
  assert.equal(au.slice(0, updaterStart + 1).replace(appTarget, "").trimEnd(), deploy.trimEnd());
  const updater = au.slice(updaterStart);
  assert.match(updater, /image: ghcr\.io\/nicolaeser\/llmhub:\$\{LLMHUB_TAG:-latest\}/);
  assert.match(updater, /pull_policy: always/);
  assert.match(updater, /restart: unless-stopped/);
  assert.match(updater, /user: "0:0"/);
  assert.match(updater, /command: \["node", "updater\.mjs"\]/);
  assert.match(updater, /environment:\n {6}APP_SECRET: \$\{APP_SECRET\}\n {4}volumes:/);
  assert.match(updater, /^ {6}- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock$/m);
  assert.match(updater, /test: \["CMD", "node", "updater\.mjs", "--healthcheck"\]/);
  assert.doesNotMatch(updater, /env_file|ports:|privileged|cap_add|build:/);
  assert.equal(au.split("\n").filter((line) => line.includes("docker.sock")).length, 1);
  assert.ok(dockerignore.split("\n").includes("docker-compose.au.yml"));
});
