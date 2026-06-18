function escapeSystemdArg(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildSystemdUnit({
  description,
  programArguments,
  workingDirectory,
  environmentFile,
  environment,
  after,
  requires,
  restartSec,
}: {
  description: string;
  programArguments: string[];
  workingDirectory: string;
  environmentFile?: string;
  environment?: Record<string, string>;
  after?: readonly string[];
  requires?: readonly string[];
  restartSec?: number;
}): string {
  const execStart = programArguments.map(escapeSystemdArg).join(" ");
  // `-` prefix = optional, systemd won't fail if the file doesn't exist
  const envFileLine = environmentFile
    ? `EnvironmentFile=-${environmentFile}`
    : null;
  const envLines = environment
    ? Object.entries(environment)
        .filter(([, v]) => v)
        .map(([k, v]) => `Environment=${escapeSystemdArg(`${k}=${v}`)}`)
    : [];

  const afterTargets = ["network-online.target", ...(after ?? [])].join(" ");
  const requiresLine =
    requires && requires.length > 0 ? `Requires=${requires.join(" ")}` : null;

  return [
    "[Unit]",
    `Description=${description}`,
    `After=${afterTargets}`,
    "Wants=network-online.target",
    requiresLine,
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    `WorkingDirectory=${workingDirectory}`,
    envFileLine,
    ...envLines,
    "Restart=always",
    `RestartSec=${restartSec ?? 5}`,
    "KillMode=control-group",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function buildLaunchdPlist({
  label,
  programArguments,
  workingDirectory,
  environmentFile,
  stdoutPath,
  stderrPath,
  throttleInterval = 5,
}: {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  environmentFile?: string;
  stdoutPath: string;
  stderrPath: string;
  /** Minimum seconds between respawns (launchd ThrottleInterval; systemd RestartSec parity) */
  throttleInterval?: number;
}): string {
  const args = programArguments
    .map((a) => `    <string>${a}</string>`)
    .join("\n");

  const envFileBlock = environmentFile
    ? `
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCROW_ENV_FILE</key>
    <string>${environmentFile}</string>
  </dict>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${workingDirectory}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttleInterval}</integer>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>${envFileBlock}
</dict>
</plist>
`;
}
