# Finance Tracker Database Schema

## Tables

### 1. Users
- id: Primary key
- username: Unique username
- password_salt: Password salt
- password_hash: Hashed password
- created_at: Account creation time

### 2. Categories
- id: Primary key
- user_id: Foreign key referencing users
- name: Category name
- limit_amount: Category spending limit
- created_at: Creation time

### 3. Expenses
- id: Primary key
- user_id: Foreign key referencing users
- category_id: Foreign key referencing categories
- title: Expense description
- amount: Expense amount
- spent_on: Expense date
- created_at: Creation time

### 4. Budgets
- id: Primary key
- user_id: Foreign key referencing users
- monthly_limit: Monthly spending limit
- month: Budget month
- year: Budget year

### 5. Sessions
- token_hash: Session token hash
- user_id: Foreign key referencing users
- expires_at: Session expiration
- created_at: Session creation time

## Relationships

- One user can have multiple categories.
- One user can have multiple expenses.
- One user can have multiple monthly budgets.
- One user can have multiple login sessions.
- Each expense belongs to one category.
- An expense can only reference a category owned by the same user.

## Data Isolation

Every expense, category, and budget is associated
with a user_id.

All API queries verify ownership using the
authenticated user's ID.