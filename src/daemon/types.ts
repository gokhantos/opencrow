export type ServiceName =
  | "core"
  | "web"
  | "telegram"
  | "whatsapp"
  | "scrapers";

export type ServiceRuntime = {
  status: "running" | "stopped" | "unknown";
  state?: string;
  subState?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
  detail?: string;
  missingUnit?: boolean;
};

export type ServiceInstallArgs = {
  programArguments: string[];
  workingDirectory: string;
  environmentFile?: string;
  stdout: NodeJS.WritableStream;
  /** If set, any process still holding this port will be killed before start */
  port?: number;
};

export type ServiceManageArgs = {
  stdout: NodeJS.WritableStream;
};

export type OpenCrowService = {
  label: string;
  install: (args: ServiceInstallArgs) => Promise<void>;
  uninstall: (args: ServiceManageArgs) => Promise<void>;
  start: (args: ServiceManageArgs) => Promise<void>;
  stop: (args: ServiceManageArgs) => Promise<void>;
  restart: (args: ServiceManageArgs) => Promise<void>;
  status: () => Promise<ServiceRuntime>;
  isInstalled: () => Promise<boolean>;
};
