export type InfraPlistOptions = {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly throttleInterval?: number;
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
  <string>${xmlEscape(opts.stderrPath)}</string>${envBlock}
</dict>
</plist>
`;
}
