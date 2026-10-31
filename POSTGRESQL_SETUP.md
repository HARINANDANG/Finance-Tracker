# PostgreSQL Setup

## 1. Requirements

- Node.js
- PostgreSQL
- npm

## 2. Install dependencies

Run:

npm install

## 3. Configure PostgreSQL

The application uses these default settings:

Host: localhost
Port: 55432
Database: student_finance_tracker
Username: student_finance_app
Password: student_finance_app

You can override these settings using environment variables:

PGHOST
PGPORT
PGDATABASE
PGUSER
PGPASSWORD

Alternatively, configure DATABASE_URL.

## 4. Database initialization

On the first startup, the application:

1. Creates the schema version table.
2. Removes the old shared-data tables.
3. Creates the user-specific database tables.
4. Creates indexes and ownership constraints.

The reset is performed only once.

Subsequent startups preserve registered users and their data.

IMPORTANT:
The first initialization deletes old shared expenses,
categories, budgets, and user accounts.

## 5. Start the application

Run:

npm start

Open:

http://localhost:3000

## 6. Test user isolation

1. Register User A.
2. Add expenses and set a monthly budget.
3. Log out.
4. Register User B.
5. Verify User B has separate categories and no expenses.
6. Add expenses for User B.
7. Log back into User A.
8. Verify User A's original expenses remain unchanged.

## 7. Security

- Passwords are hashed using PBKDF2-SHA512.
- Sessions are stored in PostgreSQL.
- Session cookies are HttpOnly.
- Every financial record belongs to a user.
- API routes check record ownership.
- Expenses cannot reference another user's category.