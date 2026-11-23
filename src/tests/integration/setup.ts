import {
  assertDisposableDatabaseUrl,
  isolateOptionalServices,
  isTestExecution,
  TEST_APP_SECRET,
} from "../support/service-env";

if (isTestExecution()) {
  assertDisposableDatabaseUrl(process.env, "integration tests");
  isolateOptionalServices(process.env);
  process.env.APP_SECRET ??= TEST_APP_SECRET;
}
