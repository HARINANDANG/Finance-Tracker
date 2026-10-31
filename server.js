const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 55432),
  database: process.env.PGDATABASE || "student_finance_tracker",
  user: process.env.PGUSER || "student_finance_app",
  password: process.env.PGPASSWORD || "student_finance_app"
});

const SESSION_COOKIE = "finance_tracker_session";
const SESSION_DAYS = 7;
const DEFAULT_CATEGORIES = ["Food", "Studies", "Transport", "Hostel", "Other"];

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) return resolve({});

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function sanitizeName(value) {
  return String(value || "").trim().slice(0, 40);
}

function sanitizeUsername(value) {
  return String(value || "").trim().slice(0, 24);
}

function sanitizeAmount(value) {
  const amount = Number(value);

  return Number.isFinite(amount) && amount >= 0
    ? Math.round(amount * 100) / 100
    : null;
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(
    String(password),
    salt,
    310000,
    64,
    "sha512"
  ).toString("hex");

  return { salt, hash };
}

function safePasswordMatch(password, salt, expectedHash) {
  const actual = Buffer.from(hashPassword(password, salt).hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");

  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map(part => {
      const index = part.indexOf("=");

      if (index < 0) return ["", ""];

      return [
        part.slice(0, index).trim(),
        decodeURIComponent(part.slice(index + 1).trim())
      ];
    }).filter(([key]) => key)
  );
}

function sessionCookie(token, maxAge = SESSION_DAYS * 24 * 60 * 60) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function formatDateOnly(value) {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

async function initializeDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_schema_version (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const versionResult = await client.query(
      "SELECT MAX(version)::int AS version FROM app_schema_version"
    );

    const version = versionResult.rows[0].version || 0;

    // One-time reset of the old shared-data schema.
    // Later server starts preserve user data.
    if (version < 2) {
      await client.query(`
        DROP TABLE IF EXISTS
          sessions,
          expenses,
          categories,
          budgets,
          app_settings,
          users
        CASCADE
      `);

      await client.query(`
        CREATE TABLE users (
          id text PRIMARY KEY,
          username text NOT NULL,
          password_salt text NOT NULL,
          password_hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE UNIQUE INDEX users_username_lower_idx
        ON users (lower(username));

        CREATE TABLE categories (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id)
            ON DELETE CASCADE,
          name text NOT NULL,
          limit_amount numeric(12,2) NOT NULL DEFAULT 0
            CHECK (limit_amount >= 0),
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (id, user_id),
          UNIQUE (user_id, name)
        );

        CREATE TABLE expenses (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id)
            ON DELETE CASCADE,
          category_id text NOT NULL,
          title text NOT NULL,
          amount numeric(12,2) NOT NULL CHECK (amount > 0),
          spent_on date NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          FOREIGN KEY (category_id, user_id)
            REFERENCES categories(id, user_id)
            ON DELETE RESTRICT
        );

        CREATE INDEX expenses_user_date_idx
        ON expenses(user_id, spent_on DESC);

        CREATE TABLE budgets (
          id text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id)
            ON DELETE CASCADE,
          monthly_limit numeric(12,2) NOT NULL DEFAULT 0
            CHECK (monthly_limit >= 0),
          month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
          year integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
          UNIQUE (user_id, month, year)
        );

        CREATE TABLE sessions (
          token_hash text PRIMARY KEY,
          user_id text NOT NULL REFERENCES users(id)
            ON DELETE CASCADE,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE INDEX sessions_user_idx ON sessions(user_id);
      `);

      await client.query(
        "INSERT INTO app_schema_version(version) VALUES (2)"
      );
    }

    await client.query("COMMIT");

    console.log("Database schema v2 is ready (user-isolated data).");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("base64url");

  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
  );

  await pool.query(
    `INSERT INTO sessions(token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [hashToken(token), userId, expiresAt]
  );

  res.setHeader("Set-Cookie", sessionCookie(token));
}

async function getAuthenticatedUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];

  if (!token) return null;

  const result = await pool.query(
    `SELECT u.id, u.username
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()`,
    [hashToken(token)]
  );

  return result.rows[0] || null;
}

async function getUserData(userId, username) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const [
    budgetResult,
    categoriesResult,
    expensesResult
  ] = await Promise.all([
    pool.query(
      `SELECT monthly_limit
       FROM budgets
       WHERE user_id = $1 AND month = $2 AND year = $3`,
      [userId, month, year]
    ),

    pool.query(
      `SELECT id, name, limit_amount
       FROM categories
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId]
    ),

    pool.query(
      `SELECT id, title, amount, category_id,
              to_char(spent_on, 'YYYY-MM-DD') AS spent_on
       FROM expenses
       WHERE user_id = $1
       ORDER BY spent_on DESC, created_at DESC`,
      [userId]
    )
  ]);

  return {
    user: { username },

    monthlyLimit: Number(
      budgetResult.rows[0]?.monthly_limit || 0
    ),

    categories: categoriesResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      limit: Number(row.limit_amount)
    })),

    expenses: expensesResult.rows.map(row => ({
      id: row.id,
      title: row.title,
      amount: Number(row.amount),
      categoryId: row.category_id,
      date: formatDateOnly(row.spent_on)
    }))
  };
}

async function seedUserCategories(client, userId) {
  for (const name of DEFAULT_CATEGORIES) {
    await client.query(
      `INSERT INTO categories(id, user_id, name)
       VALUES($1, $2, $3)`,
      [createId("cat"), userId, name]
    );
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "POST" && pathname === "/api/register") {
    const body = await readBody(req);

    const username = sanitizeUsername(body.username);
    const password = String(body.password || "");

    if (username.length < 2 || password.length < 8) {
      return sendJson(res, 400, {
        message: "Use a username with at least 2 characters and a password with at least 8 characters."
      });
    }

    const passwordData = hashPassword(password);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const userId = createId("user");

      await client.query(
        `INSERT INTO users(
          id, username, password_salt, password_hash
        ) VALUES($1, $2, $3, $4)`,
        [
          userId,
          username,
          passwordData.salt,
          passwordData.hash
        ]
      );

      await seedUserCategories(client, userId);

      await client.query("COMMIT");

      await createSession(userId, res);

      return sendJson(
        res,
        201,
        await getUserData(userId, username)
      );
    } catch (error) {
      await client.query("ROLLBACK");

      if (error.code === "23505") {
        return sendJson(res, 409, {
          message: "Username already registered."
        });
      }

      throw error;
    } finally {
      client.release();
    }
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);

    const username = sanitizeUsername(body.username);
    const password = String(body.password || "");

    const result = await pool.query(
      `SELECT id, username, password_salt, password_hash
       FROM users
       WHERE lower(username) = lower($1)`,
      [username]
    );

    const user = result.rows[0];

    if (
      !user ||
      !safePasswordMatch(
        password,
        user.password_salt,
        user.password_hash
      )
    ) {
      return sendJson(res, 401, {
        message: "Invalid username or password."
      });
    }

    await createSession(user.id, res);

    return sendJson(
      res,
      200,
      await getUserData(user.id, user.username)
    );
  }

  // The old username-only password reset was insecure.
  if (
    pathname === "/api/forgot-password/check" ||
    pathname === "/api/forgot-password/reset"
  ) {
    return sendJson(res, 410, {
      message: "Password reset is currently disabled. Please contact the application administrator to recover your account."
    });
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];

    if (token) {
      await pool.query(
        "DELETE FROM sessions WHERE token_hash = $1",
        [hashToken(token)]
      );
    }

    return sendJson(
      res,
      200,
      { message: "Logged out." },
      { "Set-Cookie": sessionCookie("", 0) }
    );
  }

  const user = await getAuthenticatedUser(req);

  if (!user) {
    return sendJson(res, 401, {
      message: "Please log in to continue."
    });
  }

  if (req.method === "GET" && pathname === "/api/data") {
    return sendJson(
      res,
      200,
      await getUserData(user.id, user.username)
    );
  }

  if (req.method === "PUT" && pathname === "/api/monthly-limit") {
    const body = await readBody(req);
    const limit = sanitizeAmount(body.limit);

    if (limit === null) {
      return sendJson(res, 400, {
        message: "Enter a valid monthly limit."
      });
    }

    const now = new Date();

    await pool.query(
      `INSERT INTO budgets(
        id, user_id, monthly_limit, month, year
      )
      VALUES($1, $2, $3, $4, $5)
      ON CONFLICT(user_id, month, year)
      DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit`,
      [
        createId("budget"),
        user.id,
        limit,
        now.getMonth() + 1,
        now.getFullYear()
      ]
    );

    return sendJson(
      res,
      200,
      await getUserData(user.id, user.username)
    );
  }

  if (req.method === "POST" && pathname === "/api/categories") {
    const body = await readBody(req);

    const name = sanitizeName(body.name);
    const limit = sanitizeAmount(body.limit);

    if (!name || limit === null) {
      return sendJson(res, 400, {
        message: "Enter a valid category name and limit."
      });
    }

    try {
      await pool.query(
        `INSERT INTO categories(
          id, user_id, name, limit_amount
        )
        VALUES($1, $2, $3, $4)`,
        [createId("cat"), user.id, name, limit]
      );
    } catch (error) {
      if (error.code === "23505") {
        return sendJson(res, 409, {
          message: "You already have a category with that name."
        });
      }

      throw error;
    }

    return sendJson(
      res,
      201,
      await getUserData(user.id, user.username)
    );
  }

  if (
    req.method === "PUT" &&
    pathname.startsWith("/api/categories/")
  ) {
    const categoryId = decodeURIComponent(
      pathname.split("/").pop()
    );

    const body = await readBody(req);

    const name = sanitizeName(body.name);
    const limit = sanitizeAmount(body.limit);

    if (!name || limit === null) {
      return sendJson(res, 400, {
        message: "Enter a valid category name and limit."
      });
    }

    try {
      const result = await pool.query(
        `UPDATE categories
         SET name = $1, limit_amount = $2
         WHERE id = $3 AND user_id = $4`,
        [name, limit, categoryId, user.id]
      );

      if (!result.rowCount) {
        return sendJson(res, 404, {
          message: "Category not found."
        });
      }
    } catch (error) {
      if (error.code === "23505") {
        return sendJson(res, 409, {
          message: "You already have a category with that name."
        });
      }

      throw error;
    }

    return sendJson(
      res,
      200,
      await getUserData(user.id, user.username)
    );
  }

  if (
    req.method === "DELETE" &&
    pathname.startsWith("/api/categories/")
  ) {
    const categoryId = decodeURIComponent(
      pathname.split("/").pop()
    );

    const used = await pool.query(
      `SELECT 1
       FROM expenses
       WHERE category_id = $1 AND user_id = $2
       LIMIT 1`,
      [categoryId, user.id]
    );

    if (used.rowCount) {
      return sendJson(res, 409, {
        message: "This category has expenses, so it cannot be deleted."
      });
    }

    const result = await pool.query(
      `DELETE FROM categories
       WHERE id = $1 AND user_id = $2`,
      [categoryId, user.id]
    );

    if (!result.rowCount) {
      return sendJson(res, 404, {
        message: "Category not found."
      });
    }

    return sendJson(
      res,
      200,
      await getUserData(user.id, user.username)
    );
  }

  if (req.method === "POST" && pathname === "/api/expenses") {
    const body = await readBody(req);

    const title = sanitizeName(body.title);
    const amount = sanitizeAmount(body.amount);
    const categoryId = String(body.categoryId || "");

    const date = String(
      body.date || new Date().toISOString().slice(0, 10)
    );

    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(`${date}T00:00:00.000Z`)
      : null;

    const validDate =
      parsedDate &&
      !Number.isNaN(parsedDate.getTime()) &&
      parsedDate.toISOString().slice(0, 10) === date;

    if (!title || amount === null || amount <= 0 || !validDate) {
      return sendJson(res, 400, {
        message: "Enter a valid expense."
      });
    }

    const result = await pool.query(
      `INSERT INTO expenses(
        id, user_id, category_id, title, amount, spent_on
      )
      SELECT $1, $2, c.id, $4, $5, $6
      FROM categories c
      WHERE c.id = $3 AND c.user_id = $2
      RETURNING id`,
      [
        createId("exp"),
        user.id,
        categoryId,
        title,
        amount,
        date
      ]
    );

    if (!result.rowCount) {
      return sendJson(res, 400, {
        message: "Choose one of your own categories."
      });
    }

    return sendJson(
      res,
      201,
      await getUserData(user.id, user.username)
    );
  }

  if (
    req.method === "DELETE" &&
    pathname.startsWith("/api/expenses/")
  ) {
    const expenseId = decodeURIComponent(
      pathname.split("/").pop()
    );

    const result = await pool.query(
      `DELETE FROM expenses
       WHERE id = $1 AND user_id = $2`,
      [expenseId, user.id]
    );

    if (!result.rowCount) {
      return sendJson(res, 404, {
        message: "Expense not found."
      });
    }

    return sendJson(
      res,
      200,
      await getUserData(user.id, user.username)
    );
  }

  return sendJson(res, 404, {
    message: "API route not found."
  });
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/"
    ? "/index.html"
    : pathname;

  const filePath = path.normalize(
    path.join(publicDir, requestedPath)
  );

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }

    const ext = path.extname(filePath).toLowerCase();

    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream"
    });

    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  try {
    if (pathname.startsWith("/api/")) {
      const origin = req.headers.origin;

      if (
        origin &&
        new URL(origin).host !== req.headers.host
      ) {
        return sendJson(res, 403, {
          message: "Cross-origin request blocked."
        });
      }

      return await handleApi(req, res, pathname);
    }

    return serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);

    if (error.code === "23505") {
      return sendJson(res, 409, {
        message: "That record already exists."
      });
    }

    return sendJson(res, 500, {
      message: "Something went wrong. Please try again."
    });
  }
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(
        `Student Finance Tracker is running at http://localhost:${PORT}`
      );
    });
  })
  .catch(error => {
    console.error(
      "Could not initialize PostgreSQL database:",
      error
    );

    process.exit(1);
  });

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});