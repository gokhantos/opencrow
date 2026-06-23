export type InfraPlistOptions = {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly throttleInterval?: number;
  // Optional per-service cap on the process/thread count (launchd
  // NumberOfProcesses, both Soft and Hard ResourceLimits). Defense-in-depth: it
  // bounds a runaway thread/fork regression to this service's own slice instead
  // of letting it exhaust the host-wide `maxproc` and wedge unrelated daemons.
  // Set well above the steady-state footprint so it never trips in normal
  // operation. Omitted → no limit dict is rendered (unchanged for other services).
  readonly processLimit?: number;
  // Optional per-service cap on the open-file-descriptor count (launchd
  // NumberOfFiles, both Soft and Hard ResourceLimits). launchd's default soft FD
  // limit is a stingy 256, which RocksDB / multi-collection processes blow past
  // and crash-loop on. Set this to lift the soft cap. Omitted → not rendered.
  readonly fileLimit?: number;
};

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildInfraPlist(opts: InfraPlistOptions): string {
  const throttle = opts.throttleInterval ?? 5;
  const args = opts.programArguments
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");

  const envEntries = Object.entries(opts.env ?? {});
  const envBlock =
    envEntries.length === 0
      ? ""
      : `
  <key>EnvironmentVariables</key>
  <dict>
${envEntries
  .map(
    ([k, v]) =>
      `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`,
  )
  .join("\n")}
  </dict>`;

  // A plist <dict> may contain each key only once, so both NumberOfProcesses and
  // NumberOfFiles must live inside the SAME Soft (and the SAME Hard) dict — never
  // emit two SoftResourceLimits dicts. The same inner body is reused for both.
  const limitEntries: string[] = [];
  if (opts.processLimit !== undefined) {
    limitEntries.push(
      `    <key>NumberOfProcesses</key>\n    <integer>${opts.processLimit}</integer>`,
    );
  }
  if (opts.fileLimit !== undefined) {
    limitEntries.push(
      `    <key>NumberOfFiles</key>\n    <integer>${opts.fileLimit}</integer>`,
    );
  }
  const limitInner = limitEntries.join("\n");
  const limitBlock =
    limitEntries.length === 0
      ? ""
      : `
  <key>SoftResourceLimits</key>
  <dict>
${limitInner}
  </dict>
  <key>HardResourceLimits</key>
  <dict>
${limitInner}
  </dict>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrPath)}</string>${limitBlock}${envBlock}
</dict>
</plist>
`;
}
