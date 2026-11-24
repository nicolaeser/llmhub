import { isolateServices, isTestExecution, TEST_APP_SECRET } from "./support/service-env";

if (isTestExecution()) {
  isolateServices(process.env);
  if (!process.env.NODE_ENV) Reflect.set(process.env, "NODE_ENV", "development");
  process.env.APP_SECRET ??= TEST_APP_SECRET;
}
