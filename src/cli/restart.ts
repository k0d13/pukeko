import { $ } from "bun";
import { defineCommand } from "citty";

export default defineCommand({
  meta: { name: "restart", description: "Restart the service" },
  run: () => $`systemctl --user restart pukeko`,
});
