import { Hono } from "hono";
import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";
import { createLogger } from "../../logger";

const logger = createLogger("web");

const execAsync = promisify(exec);

export const systemRoutes = new Hono();

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  memoryMB: number;
}

interface DiskInfo {
  filesystem: string;
  mount: string;
  total: number;
  used: number;
  available: number;
  percentage: number;
}

async function getSystemMetrics() {
  // Get CPU usage
  const cpuUsage = await getCPUUsage();

  // Get accurate memory info from /proc/meminfo
  const memInfo = await getDetailedMemoryInfo();

  // Get load average
  const loadAvg = os.loadavg();

  // Get top processes
  const processes = await getTopProcesses();

  // Get disk usage
  const disk = await getDiskUsage();

  return {
    timestamp: Date.now(),
    cpu: {
      usage: cpuUsage,
      loadAvg: loadAvg as [number, number, number],
    },
    memory: {
      total: memInfo.total,
      used: memInfo.used,
      free: memInfo.free,
      available: memInfo.available,
      buffers: memInfo.buffers,
      cached: memInfo.cached,
      percentage: (memInfo.used / memInfo.total) * 100,
    },
    disk,
    processes,
  };
}

async function getCPUUsage(): Promise<number> {
  try {
    const { stdout } = await execAsync(
      "top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'",
    );
    return parseFloat(stdout.trim()) || 0;
  } catch {
    // Fallback method
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    return 100 - ~~((100 * totalIdle) / totalTick);
  }
}

async function getDetailedMemoryInfo(): Promise<{
  total: number;
  free: number;
  available: number;
  used: number;
  buffers: number;
  cached: number;
}> {
  try {
    const { stdout } = await execAsync("cat /proc/meminfo");
    const lines = stdout.split("\n");
    const memInfo: any = {};

    lines.forEach((line) => {
      const [key, value] = line.split(":");
      if (key && value) {
        const kb = parseInt(value.trim().split(" ")[0] ?? "0");
        memInfo[key] = kb * 1024; // Convert to bytes
      }
    });

    // Calculate actual used memory (excluding buffers/cache)
    // This matches what 'free' command shows as "used"
    const total = memInfo.MemTotal || os.totalmem();
    const free = memInfo.MemFree || os.freemem();
    const available = memInfo.MemAvailable || free;
    const buffers = memInfo.Buffers || 0;
    const cached = memInfo.Cached || 0;
    const sReclaimable = memInfo.SReclaimable || 0;

    // Used memory = Total - Free - Buffers - Cached - SReclaimable
    // This gives us the actual memory used by applications
    const used = total - free - buffers - cached - sReclaimable;

    return {
      total,
      free,
      available,
      used,
      buffers,
      cached,
    };
  } catch (error) {
    logger.warn("Error reading meminfo", { error: error instanceof Error ? error.message : String(error) });
    // Fallback to OS methods
    const total = os.totalmem();
    const free = os.freemem();
    return {
      total,
      free,
      available: free,
      used: total - free,
      buffers: 0,
      cached: 0,
    };
  }
}

async function getTopProcesses(): Promise<ProcessInfo[]> {
  try {
    // Get top processes by CPU and memory
    const { stdout } = await execAsync(
      'ps aux --sort=-%cpu,-%mem | head -20 | awk \'NR>1 {print $2 "|" $11 "|" $3 "|" $4 "|" $6}\'',
    );

    const processes: ProcessInfo[] = [];
    const lines = stdout.trim().split("\n");

    for (const line of lines) {
      const [pid, name, cpu, mem, rss] = line.split("|");
      if (pid && name) {
        // Extract just the process name from the full command
        const processName = name.split("/").pop()?.split(" ")[0] || name;

        processes.push({
          pid: parseInt(pid),
          name: processName.substring(0, 20), // Limit name length
          cpu: parseFloat(cpu ?? "0") || 0,
          memory: parseFloat(mem ?? "0") || 0,
          memoryMB: parseInt(rss ?? "0") / 1024, // RSS is in KB, convert to MB
        });
      }
    }

    return processes;
  } catch (error) {
    logger.warn("Error getting processes", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

async function getDiskUsage(): Promise<DiskInfo[]> {
  try {
    // -P for POSIX output, -x to exclude pseudo filesystems
    const { stdout } = await execAsync(
      'df -P -k 2>/dev/null | awk \'NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|shm|udev|none)/ {print $1 "|" $6 "|" $2 "|" $3 "|" $4 "|" $5}\'',
    );

    const disks: DiskInfo[] = [];
    const lines = stdout.trim().split("\n");

    for (const line of lines) {
      const [filesystem, mount, totalKB, usedKB, availKB, pctStr] =
        line.split("|");
      if (!filesystem || !mount) continue;

      // Skip pseudo/snap mounts
      if (
        mount.startsWith("/snap") ||
        mount.startsWith("/boot/efi") ||
        mount.startsWith("/dev")
      )
        continue;

      disks.push({
        filesystem,
        mount,
        total: parseInt(totalKB ?? "0") * 1024,
        used: parseInt(usedKB ?? "0") * 1024,
        available: parseInt(availKB ?? "0") * 1024,
        percentage: parseFloat(pctStr ?? "0") || 0,
      });
    }

    return disks;
  } catch {
    return [];
  }
}

systemRoutes.get("/metrics", async (c) => {
  try {
    const metrics = await getSystemMetrics();
    return c.json(metrics);
  } catch (error) {
    logger.error("Error fetching system metrics", { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: "Failed to fetch system metrics" }, 500);
  }
});
