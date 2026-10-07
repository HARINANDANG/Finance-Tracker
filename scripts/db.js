const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const rootDir = path.join(__dirname, "..");
const dataDir = path.join(rootDir, ".postgres-data");
const logPath = path.join(dataDir, "postgres.log");
const pidPath = path.join(dataDir, "postmaster.pid");
const passwordPath = path.join(rootDir, ".postgres-pwfile.txt");
const pgBin = process.env.POSTGRES_BIN || "C:\\Program Files\\PostgreSQL\\17\\bin";
const pgPort = process.env.PGPORT || "55432";
const appUser = process.env.PGUSER || "student_finance_app";
const appPassword = process.env.PGPASSWORD || "student_finance_app";
const appDatabase = process.env.PGDATABASE || "student_finance_tracker";

function bin(name) {
  return path.join(pgBin, process.platform === "win32" ? `${name}.exe` : name);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || "inherit",
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}) }
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  return result;
}

function ensurePostgresBinaries() {
  if (!fs.existsSync(bin("initdb")) || !fs.existsSync(bin("pg_ctl"))) {
    console.error(`PostgreSQL binaries were not found in ${pgBin}. Set POSTGRES_BIN to your PostgreSQL bin folder.`);
    process.exit(1);
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function query(database, sql, user = "postgres", password = "postgres") {
  run(
    bin("psql"),
    ["-h", "127.0.0.1", "-p", pgPort, "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", sql],
    { env: { PGPASSWORD: password } }
  );
}

function initCluster() {
  if (fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(passwordPath, "postgres", { mode: 0o600 });
  run(bin("initdb"), ["-D", dataDir, "-U", "postgres", "-A", "scram-sha-256", "--pwfile", passwordPath]);
  fs.unlinkSync(passwordPath);
}

async function start() {
  ensurePostgresBinaries();
  initCluster();

  if (!(await isPortOpen(pgPort))) {
    const log = fs.openSync(logPath, "a");
    const child = spawn(bin("postgres"), ["-D", dataDir, "-p", pgPort], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });

    child.unref();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (await isPortOpen(pgPort)) {
        break;
      }
    }
  }

  if (!(await isPortOpen(pgPort))) {
    console.error(`PostgreSQL did not start. See ${logPath}.`);
    process.exit(1);
  }

  query(
    "postgres",
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${appUser}') THEN CREATE ROLE ${appUser} LOGIN PASSWORD '${appPassword}'; ELSE ALTER ROLE ${appUser} WITH LOGIN PASSWORD '${appPassword}'; END IF; END $$;`
  );

  const exists = spawnSync(
    bin("psql"),
    ["-h", "127.0.0.1", "-p", pgPort, "-U", "postgres", "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${appDatabase}'`],
    { env: { ...process.env, PGPASSWORD: "postgres" }, encoding: "utf8" }
  );

  if (!exists.stdout.trim()) {
    run(bin("createdb"), ["-h", "127.0.0.1", "-p", pgPort, "-U", "postgres", "-O", appUser, appDatabase], {
      env: { PGPASSWORD: "postgres" }
    });
  }

  query("postgres", `ALTER DATABASE ${appDatabase} OWNER TO ${appUser};`);
  console.log(`PostgreSQL is ready on port ${pgPort}.`);
}

function stop() {
  ensurePostgresBinaries();

  if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    console.log("Project PostgreSQL data directory does not exist.");
    return;
  }

  if (!fs.existsSync(pidPath)) {
    console.log("Project PostgreSQL is not running.");
    return;
  }

  const pid = Number(fs.readFileSync(pidPath, "utf8").split(/\r?\n/)[0]);

  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`Could not read PostgreSQL PID from ${pidPath}.`);
    process.exit(1);
  }

  process.kill(pid, "SIGTERM");
  console.log("Project PostgreSQL stopped.");
}

const command = process.argv[2] || "start";

if (command === "start") {
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else if (command === "stop") {
  stop();
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
