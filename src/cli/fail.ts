import { consola } from "consola";

export function fail(message: string): never {
  consola.error(message);
  process.exit(1);
}
