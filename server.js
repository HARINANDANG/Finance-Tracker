const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 55432),
  database: process.env.PGDATABASE || "student_finance_tracker",
  user: process.env.PGUSER || "student_finance_app",
  password: process.env.PGPASSWORD || "student_finance_app"
});

const defaultData = {
  users: [],
  monthlyLimit: 0,
  categories: [
    { id: "food", name: "Food", limit: 0 },
    { id: "studies", name: "Studies", limit: 0 },
    { id: "transport", name: "Transport", limit: 0 },
    { id: "hostel", name: "Hostel", limit: 0 },
    { id: "other", name: "Other", limit: 0 }
  ],
  expenses: []
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
  });
}

function sanitizeName(value) {
  return String(value || "").trim().slice(0, 40);
}

function sanitizeAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeUsername(value) {
  return String(value || "").trim().slice(0, 24);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function publicData(data, user = null) {
  return {
    user,
    monthlyLimit: data.monthlyLimit,
    categories: data.categories,
    expenses: data.expenses
  };
}

function formatDateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function mapDataRows(settings, categories, expenses) {
  return {
    users: [],
    monthlyLimit: Number(settings.monthly_limit || 0),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      limit: Number(category.limit_amount)
    })),
    expenses: expenses.map((expense) => ({
      id: expense.id,
      title: expense.title,
      amount: Number(expense.amount),
      categoryId: expense.category_id,
      date: formatDateOnly(expense.spent_on)
    }))
  };
}

async function readDatabase(client = pool) {
  const [settingsResult, categoriesResult, expensesResult] = await Promise.all([
    client.query("SELECT monthly_limit FROM app_settings WHERE id = 1"),
    client.query("SELECT id, name, limit_amount FROM categories ORDER BY created_at ASC"),
    client.query("SELECT id, title, amount, category_id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on FROM expenses ORDER BY created_at DESC")
  ]);

  return mapDataRows(
    settingsResult.rows[0] || { monthly_limit: 0 },
    categoriesResult.rows,
    expensesResult.rows
  );
}

async function initializeDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id integer PRIMARY KEY DEFAULT 1,
        monthly_limit numeric(12, 2) NOT NULL DEFAULT 0,
        CONSTRAINT single_settings_row CHECK (id = 1)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY,
        username text NOT NULL,
        password_salt text NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
      ON users (lower(username))
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id text PRIMARY KEY,
        name text NOT NULL,
        limit_amount numeric(12, 2) NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id text PRIMARY KEY,
        title text NOT NULL,
        amount numeric(12, 2) NOT NULL,
        category_id text NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        spent_on date NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("INSERT INTO app_settings (id, monthly_limit) VALUES (1, 0) ON CONFLICT (id) DO NOTHING");

    const categoryCount = await client.query("SELECT COUNT(*)::int AS count FROM categories");

    if (categoryCount.rows[0].count === 0) {
      await seedDatabase(client);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedDatabase(client) {
  let seedData = defaultData;

  if (fs.existsSync(dbPath)) {
    seedData = {
      ...defaultData,
      ...JSON.parse(fs.readFileSync(dbPath, "utf8"))
    };
  }

  await client.query("UPDATE app_settings SET monthly_limit = $1 WHERE id = 1", [sanitizeAmount(seedData.monthlyLimit) || 0]);

  for (const user of seedData.users || []) {
    await client.query(
      `
        INSERT INTO users (id, username, password_salt, password_hash)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO NOTHING
      `,
      [user.id, user.username, user.passwordSalt, user.passwordHash]
    );
  }

  for (const category of seedData.categories || defaultData.categories) {
    await client.query(
      `
        INSERT INTO categories (id, name, limit_amount)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING
      `,
      [category.id, category.name, sanitizeAmount(category.limit) || 0]
    );
  }

  for (const expense of seedData.expenses || []) {
    await client.query(
      `
        INSERT INTO expenses (id, title, amount, category_id, spent_on)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO NOTHING
      `,
      [expense.id, expense.title, sanitizeAmount(expense.amount) || 0, expense.categoryId, expense.date]
    );
  }
}

async function handleApi(req, res, pathname) {
  const data = await readDatabase();

  if (req.method === "POST" && pathname === "/api/register") {
    const body = await readBody(req);
    const username = sanitizeUsername(body.username);
    const password = String(body.password || "");

    if (!username || password.length < 4) {
      sendJson(res, 400, { message: "Enter a username and a password with at least 4 characters." });
      return;
    }

    const usernameExists = await pool.query("SELECT 1 FROM users WHERE lower(username) = lower($1)", [username]);

    if (usernameExists.rowCount > 0) {
      sendJson(res, 409, { message: "Username already registered." });
      return;
    }

    const passwordData = hashPassword(password);
    const user = {
      id: createId("user"),
      username,
      passwordSalt: passwordData.salt,
      passwordHash: passwordData.hash
    };

    await pool.query(
      "INSERT INTO users (id, username, password_salt, password_hash) VALUES ($1, $2, $3, $4)",
      [user.id, user.username, user.passwordSalt, user.passwordHash]
    );
    sendJson(res, 201, publicData(await readDatabase(), { username: user.username }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);
    const username = sanitizeUsername(body.username);
    const password = String(body.password || "");
    const userResult = await pool.query(
      "SELECT username, password_salt, password_hash FROM users WHERE lower(username) = lower($1)",
      [username]
    );
    const user = userResult.rows[0];

    if (!user) {
      sendJson(res, 401, { message: "Invalid username or password." });
      return;
    }

    const passwordData = hashPassword(password, user.password_salt);

    if (passwordData.hash !== user.password_hash) {
      sendJson(res, 401, { message: "Invalid username or password." });
      return;
    }

    sendJson(res, 200, publicData(data, { username: user.username }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/forgot-password/check") {
    const body = await readBody(req);
    const username = sanitizeUsername(body.username);
    const userResult = await pool.query("SELECT username FROM users WHERE lower(username) = lower($1)", [username]);
    const user = userResult.rows[0];

    if (!user) {
      sendJson(res, 404, { message: "Username not found." });
      return;
    }

    sendJson(res, 200, { username: user.username, message: "Username found. Enter a new password." });
    return;
  }

  if (req.method === "POST" && pathname === "/api/forgot-password/reset") {
    const body = await readBody(req);
    const username = sanitizeUsername(body.username);
    const password = String(body.password || "");
    const userResult = await pool.query("SELECT username FROM users WHERE lower(username) = lower($1)", [username]);
    const user = userResult.rows[0];

    if (!user) {
      sendJson(res, 404, { message: "Username not found." });
      return;
    }

    if (password.length < 4) {
      sendJson(res, 400, { message: "New password must have at least 4 characters." });
      return;
    }

    const passwordData = hashPassword(password);
    await pool.query(
      "UPDATE users SET password_salt = $1, password_hash = $2 WHERE lower(username) = lower($3)",
      [passwordData.salt, passwordData.hash, username]
    );
    sendJson(res, 200, { message: "Password updated. You can login now." });
    return;
  }

  if (req.method === "GET" && pathname === "/api/data") {
    sendJson(res, 200, publicData(data));
    return;
  }

  if (req.method === "PUT" && pathname === "/api/monthly-limit") {
    const body = await readBody(req);
    const limit = sanitizeAmount(body.limit);

    if (limit === null) {
      sendJson(res, 400, { message: "Enter a valid monthly limit." });
      return;
    }

    await pool.query("UPDATE app_settings SET monthly_limit = $1 WHERE id = 1", [limit]);
    sendJson(res, 200, publicData(await readDatabase()));
    return;
  }

  if (req.method === "POST" && pathname === "/api/categories") {
    const body = await readBody(req);
    const name = sanitizeName(body.name);
    const limit = sanitizeAmount(body.limit);

    if (!name || limit === null) {
      sendJson(res, 400, { message: "Enter a valid category name and limit." });
      return;
    }

    await pool.query(
      "INSERT INTO categories (id, name, limit_amount) VALUES ($1, $2, $3)",
      [createId("cat"), name, limit]
    );
    sendJson(res, 201, publicData(await readDatabase()));
    return;
  }

  if (req.method === "PUT" && pathname.startsWith("/api/categories/")) {
    const categoryId = decodeURIComponent(pathname.split("/").pop());
    const body = await readBody(req);
    const category = await pool.query("SELECT id FROM categories WHERE id = $1", [categoryId]);

    if (category.rowCount === 0) {
      sendJson(res, 404, { message: "Category not found." });
      return;
    }

    const name = sanitizeName(body.name);
    const limit = sanitizeAmount(body.limit);

    if (!name || limit === null) {
      sendJson(res, 400, { message: "Enter a valid category name and limit." });
      return;
    }

    await pool.query("UPDATE categories SET name = $1, limit_amount = $2 WHERE id = $3", [name, limit, categoryId]);
    sendJson(res, 200, publicData(await readDatabase()));
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/categories/")) {
    const categoryId = decodeURIComponent(pathname.split("/").pop());
    const usedByExpense = await pool.query("SELECT 1 FROM expenses WHERE category_id = $1 LIMIT 1", [categoryId]);

    if (usedByExpense.rowCount > 0) {
      sendJson(res, 409, { message: "This category has expenses, so it cannot be deleted." });
      return;
    }

    await pool.query("DELETE FROM categories WHERE id = $1", [categoryId]);
    sendJson(res, 200, publicData(await readDatabase()));
    return;
  }

  if (req.method === "POST" && pathname === "/api/expenses") {
    const body = await readBody(req);
    const title = sanitizeName(body.title);
    const amount = sanitizeAmount(body.amount);
    const categoryId = String(body.categoryId || "");
    const date = String(body.date || new Date().toISOString().slice(0, 10));

    if (!title || amount === null || amount <= 0 || !data.categories.some((item) => item.id === categoryId)) {
      sendJson(res, 400, { message: "Enter a valid expense." });
      return;
    }

    await pool.query(
      "INSERT INTO expenses (id, title, amount, category_id, spent_on) VALUES ($1, $2, $3, $4, $5)",
      [createId("exp"), title, amount, categoryId, date]
    );
    sendJson(res, 201, publicData(await readDatabase()));
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/expenses/")) {
    const expenseId = decodeURIComponent(pathname.split("/").pop());
    await pool.query("DELETE FROM expenses WHERE id = $1", [expenseId]);
    sendJson(res, 200, publicData(await readDatabase()));
    return;
  }

  sendJson(res, 404, { message: "API route not found." });
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json",
      ".svg": "image/svg+xml"
    };

    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, { message: error.message || "Something went wrong." });
  }
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Student Finance Tracker is running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Could not initialize PostgreSQL database:", error.message);
    process.exit(1);
  });
