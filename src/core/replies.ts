import { join } from "node:path";
import { paths } from "./paths.ts";

/** Keeps the latest reply from a source that has nowhere to post it, for the owner to inspect */
export async function saveReply(name: string, reply: string) {
  await Bun.write(join(paths.state, "replies", `${name}.md`), reply);
}
