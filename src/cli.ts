import { runServiceCommand } from "./cli/service.ts";
import type { ServiceName } from "./daemon/types.ts";
import { getVersion } from "./cli/prompts.ts";

const [, , command, ...rest] = process.argv;

function printHelp(): void {
  const w = process.stdout;
  w.write(`opencrow v${getVersion()}\n\n`);
  w.write("Usage: opencrow <command>\n\n");
  w.write("Commands:\n");
  w.write("  setup                           Interactive setup wizard\n");
  w.write(
    "  doctor                          Health check + repair suggestions\n",
  );
  w.write(
    "  start                           Start in foreground\n",
  );
  w.write("  status                          Show running service status\n");
  w.write(
    "  update                          Pull latest + reinstall + restart\n",
  );
  w.write("  native up                       Provision + start the native macOS stack\n");
  w.write("  native restage-mem0             Fast mem0 sidecar redeploy (app.py only, no venv rebuild)\n");
  w.write("  version                         Show version info\n");
  w.write(
    "  service [core|web] <cmd>        Service management (install|reinstall|uninstall|start|stop|restart|status)\n",
  );
}

async function main(): Promise<void> {
  switch (command) {
    case "setup": {
      const { runSetup } = await import("./cli/setup.ts");
      await runSetup();
      break;
    }

    case "doctor": {
      const { runDoctor } = await import("./cli/doctor.ts");
      await runDoctor();
      break;
    }

    case "native": {
      const sub = rest[0];
      if (sub === "up") {
        const { runNativeUp } = await import("./cli/native/provision.ts");
        await runNativeUp();
      } else if (sub === "restage-mem0") {
        const { runNativeRestageMem0 } = await import("./cli/native/provision.ts");
        await runNativeRestageMem0();
      } else {
        process.stderr.write("Usage: opencrow native <up|restage-mem0>\n");
        process.exit(1);
      }
      break;
    }

    case "update": {
      const { runUpdate } = await import("./cli/update.ts");
      await runUpdate();
      break;
    }

    case "start": {
      await import("./entries/core.ts");
      break;
    }

    case "status": {
      const { resolveService } = await import("./daemon/service.ts");
      const svc = resolveService("core");
      const runtime = await svc.status();
      const icon =
        runtime.status === "running"
          ? "\x1b[32m●\x1b[0m"
          : runtime.status === "stopped"
            ? "\x1b[31m○\x1b[0m"
            : "?";
      process.stdout.write(
        `${icon} OpenCrow — ${runtime.status.toUpperCase()}`,
      );
      if (runtime.pid) process.stdout.write(` (PID ${runtime.pid})`);
      process.stdout.write("\n");
      if (runtime.status !== "running") process.exit(1);
      break;
    }

    case "version":
    case "--version":
    case "-v": {
      process.stdout.write(`opencrow v${getVersion()}\n`);
      break;
    }

    case "service": {
      // Support: opencrow service <cmd>  (defaults to core)
      //          opencrow service core <cmd>
      //          opencrow service web <cmd>
      const first = rest[0];
      let serviceName: ServiceName = "core";
      let subcommand: string | undefined;

      if (first === "core" || first === "web") {
        serviceName = first;
        subcommand = rest[1];
      } else {
        subcommand = first;
      }

      if (!subcommand) {
        process.stderr.write(
          "Usage: opencrow service [core|web] <install|reinstall|uninstall|start|stop|restart|status>\n",
        );
        process.exit(1);
        return;
      }
      await runServiceCommand(subcommand, serviceName);
      break;
    }

    case "--help":
    case "-h":
    case "help":
      printHelp();
      break;

    default:
      if (command) {
        process.stderr.write(`Unknown command: ${command}\n\n`);
      }
      printHelp();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  process.stderr.write(
    `Error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
