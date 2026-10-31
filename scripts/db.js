const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.join(__dirname, "..");
const dataDir = path.join(rootDir, ".postgres-data");
const logPath = path.join(dataDir, "postgres.log");
const pidPath = path.join(dataDir, "postmaster.pid");
const passwordPath = path.join(rootDir, ".postgres-pwfile.txt");

const pgBin =
  process.env.POSTGRES_BIN ||
  "C:\\Program Files\\PostgreSQL\\17\\bin";

const pgPort = process.env.PGPORT || "55432";

const appUser =
  process.env.PGUSER || "student_finance_app";

const appPassword =
  process.env.PGPASSWORD || "student_finance_app";

const appDatabase =
  process.env.PGDATABASE || "student_finance_tracker";


function bin(name) {
  return path.join(
    pgBin,
    process.platform === "win32" ? `${name}.exe` : name
  );
}


function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ...(options.env || {})
    }
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  return result;
}


function ensurePostgresBinaries() {
  if (
    !fs.existsSync(bin("initdb")) ||
    !fs.existsSync(bin("pg_ctl")) ||
    !fs.existsSync(bin("psql")) ||
    !fs.existsSync(bin("createdb"))
  ) {
    console.error(
      `PostgreSQL binaries were not found in ${pgBin}. Set POSTGRES_BIN to your PostgreSQL bin folder.`
    );

    process.exit(1);
  }
}


function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: Number(port)
    });

    socket.setTimeout(500);

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      resolve(false);
    });
  });
}


function query(
  database,
  sql,
  user = "postgres",
  password = "postgres"
) {
  run(
    bin("psql"),
    [
      "-h",
      "127.0.0.1",
      "-p",
      pgPort,
      "-U",
      user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql
    ],
    {
      env: {
        PGPASSWORD: password
      }
    }
  );
}


function initCluster() {
  if (fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
    return;
  }

  fs.mkdirSync(dataDir, {
    recursive: true
  });

  fs.writeFileSync(
    passwordPath,
    "postgres",
    {
      mode: 0o600
    }
  );

  run(
    bin("initdb"),
    [
      "-D",
      dataDir,
      "-U",
      "postgres",
      "-A",
      "scram-sha-256",
      "--pwfile",
      passwordPath
    ]
  );

  if (fs.existsSync(passwordPath)) {
    fs.unlinkSync(passwordPath);
  }
}


async function start() {
  ensurePostgresBinaries();

  initCluster();

  /*
   * Check whether PostgreSQL is already running.
   * If it is already running, don't start another instance.
   */
  if (!(await isPortOpen(pgPort))) {

    fs.mkdirSync(dataDir, {
      recursive: true
    });

    /*
     * Start PostgreSQL using pg_ctl instead of directly
     * spawning postgres.exe.
     *
     * pg_ctl is designed to start PostgreSQL as a
     * background server.
     */
    const result = spawnSync(
      bin("pg_ctl"),
      [
        "start",
        "-D",
        dataDir,
        "-o",
        `-p ${pgPort}`,
        "-l",
        logPath,
        "-w"
      ],
      {
        windowsHide: true,
        stdio: "ignore"
      }
    );

    if (result.status !== 0) {
      console.error(
        `Could not start PostgreSQL. Check ${logPath}`
      );

      process.exit(result.status || 1);
    }

    /*
     * Wait until PostgreSQL starts accepting connections.
     */
    for (let attempt = 0; attempt < 30; attempt += 1) {

      await new Promise((resolve) =>
        setTimeout(resolve, 500)
      );

      if (await isPortOpen(pgPort)) {
        break;
      }
    }
  }


  /*
   * Make sure PostgreSQL actually started.
   */
  if (!(await isPortOpen(pgPort))) {
    console.error(
      `PostgreSQL did not start. See ${logPath}.`
    );

    process.exit(1);
  }


  /*
   * Create or update the application user.
   */
  query(
    "postgres",
    `DO $$ 
     BEGIN 
       IF NOT EXISTS (
         SELECT FROM pg_roles 
         WHERE rolname = '${appUser}'
       ) THEN
         CREATE ROLE ${appUser} 
         LOGIN PASSWORD '${appPassword}';
       ELSE
         ALTER ROLE ${appUser} 
         WITH LOGIN PASSWORD '${appPassword}';
       END IF;
     END $$;`
  );


  /*
   * Check whether the application database exists.
   */
  const exists = spawnSync(
    bin("psql"),
    [
      "-h",
      "127.0.0.1",
      "-p",
      pgPort,
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${appDatabase}'`
    ],
    {
      env: {
        ...process.env,
        PGPASSWORD: "postgres"
      },
      encoding: "utf8",
      windowsHide: true,
      stdio: [
        "ignore",
        "pipe",
        "ignore"
      ]
    }
  );


  /*
   * Create the application database if it doesn't exist.
   */
  if (!exists.stdout.trim()) {

    run(
      bin("createdb"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        pgPort,
        "-U",
        "postgres",
        "-O",
        appUser,
        appDatabase
      ],
      {
        env: {
          PGPASSWORD: "postgres"
        }
      }
    );
  }


  /*
   * Make the application user the database owner.
   */
  query(
    "postgres",
    `ALTER DATABASE ${appDatabase} OWNER TO ${appUser};`
  );


  console.log(
    `PostgreSQL is ready on port ${pgPort}.`
  );
}


function stop() {
  ensurePostgresBinaries();

  if (
    !fs.existsSync(
      path.join(dataDir, "PG_VERSION")
    )
  ) {
    console.log(
      "Project PostgreSQL data directory does not exist."
    );

    return;
  }


  if (!fs.existsSync(pidPath)) {
    console.log(
      "Project PostgreSQL is not running."
    );

    return;
  }


  /*
   * Use pg_ctl to stop PostgreSQL instead of
   * manually killing the process.
   */
  const result = spawnSync(
    bin("pg_ctl"),
    [
      "stop",
      "-D",
      dataDir,
      "-m",
      "fast",
      "-w"
    ],
    {
      windowsHide: true,
      stdio: "ignore"
    }
  );


  if (result.status !== 0) {
    console.error(
      `Could not stop PostgreSQL. Check ${logPath}.`
    );

    process.exit(result.status || 1);
  }


  console.log(
    "Project PostgreSQL stopped."
  );
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

  console.error(
    `Unknown command: ${command}`
  );

  process.exit(1);
}