const formatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0
});

const state = {
  currentUser: null,
  monthlyLimit: 0,
  categories: [],
  expenses: []
};

const elements = {
  authScreen: document.querySelector("#authScreen"),
  appScreen: document.querySelector("#appScreen"),
  authForm: document.querySelector("#authForm"),
  authUsername: document.querySelector("#authUsername"),
  authPassword: document.querySelector("#authPassword"),
  togglePassword: document.querySelector("#togglePassword"),
  forgotPasswordButton: document.querySelector("#forgotPasswordButton"),
  forgotForm: document.querySelector("#forgotForm"),
  forgotUsername: document.querySelector("#forgotUsername"),
  newPasswordGroup: document.querySelector("#newPasswordGroup"),
  newPassword: document.querySelector("#newPassword"),
  toggleNewPassword: document.querySelector("#toggleNewPassword"),
  forgotSubmitButton: document.querySelector("#forgotSubmitButton"),
  backToLoginButton: document.querySelector("#backToLoginButton"),
  authMessage: document.querySelector("#authMessage"),
  usernameLabel: document.querySelector("#usernameLabel"),
  logoutButton: document.querySelector("#logoutButton"),
  alerts: document.querySelector("#alerts"),
  monthLabel: document.querySelector("#monthLabel"),
  monthlyLimitText: document.querySelector("#monthlyLimitText"),
  monthlyLimitInput: document.querySelector("#monthlyLimitInput"),
  totalSpentText: document.querySelector("#totalSpentText"),
  remainingText: document.querySelector("#remainingText"),
  remainingHint: document.querySelector("#remainingHint"),
  monthlyMeter: document.querySelector("#monthlyMeter"),
  expenseCategory: document.querySelector("#expenseCategory"),
  expensePieChart: document.querySelector("#expensePieChart"),
  chartLegend: document.querySelector("#chartLegend"),
  categoryList: document.querySelector("#categoryList"),
  expenseTable: document.querySelector("#expenseTable"),
  expenseCount: document.querySelector("#expenseCount"),
  expenseDate: document.querySelector("#expenseDate"),
  emptyStateTemplate: document.querySelector("#emptyStateTemplate")
};

const chartColors = ["#176a5c", "#b55b18", "#4169a8", "#8a4f9e", "#157347", "#c2410c", "#596579"];
let resetUsername = "";

function money(value) {
  return formatter.format(value || 0);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function currentMonthExpenses() {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  return state.expenses.filter((expense) => {
    const date = new Date(`${expense.date}T00:00:00`);
    return date.getMonth() === month && date.getFullYear() === year;
  });
}

function categorySpent(categoryId) {
  return currentMonthExpenses()
    .filter((expense) => expense.categoryId === categoryId)
    .reduce((sum, expense) => sum + Number(expense.amount), 0);
}

function totalSpent() {
  return currentMonthExpenses().reduce((sum, expense) => sum + Number(expense.amount), 0);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.message || "Request failed.");
  }

  return payload;
}

function updateState(data) {
  if (data.user) {
    state.currentUser = data.user;
  }

  state.monthlyLimit = data.monthlyLimit;
  state.categories = data.categories;
  state.expenses = data.expenses;
  render();
}

function showApp(username) {
  state.currentUser = { username };
  elements.usernameLabel.textContent = username;
  elements.authScreen.classList.add("is-hidden");
  elements.appScreen.classList.remove("is-hidden");
}

function showAuth(message = "") {
  state.currentUser = null;
  elements.authMessage.textContent = message;
  elements.appScreen.classList.add("is-hidden");
  elements.authScreen.classList.remove("is-hidden");
}

function setPasswordVisibility(input, button, visible) {
  input.type = visible ? "text" : "password";
  button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
  button.title = visible ? "Hide password" : "Show password";
  button.classList.toggle("is-active", visible);
}

function showForgotMode() {
  resetUsername = "";
  elements.authMessage.textContent = "";
  elements.authForm.classList.add("is-hidden");
  elements.forgotPasswordButton.classList.add("is-hidden");
  elements.forgotForm.classList.remove("is-hidden");
  elements.forgotUsername.readOnly = false;
  elements.newPasswordGroup.classList.add("is-hidden");
  elements.newPassword.required = false;
  elements.newPassword.value = "";
  elements.forgotSubmitButton.textContent = "Check Username";
}

function showLoginMode(message = "") {
  resetUsername = "";
  elements.authMessage.textContent = message;
  elements.forgotForm.classList.add("is-hidden");
  elements.authForm.classList.remove("is-hidden");
  elements.forgotPasswordButton.classList.remove("is-hidden");
  elements.forgotUsername.readOnly = false;
  elements.newPasswordGroup.classList.add("is-hidden");
  elements.newPassword.required = false;
}

function renderSummary() {
  const spent = totalSpent();
  const remaining = state.monthlyLimit - spent;
  const percent = state.monthlyLimit > 0 ? Math.min((spent / state.monthlyLimit) * 100, 100) : spent > 0 ? 100 : 0;

  elements.monthlyLimitText.textContent = money(state.monthlyLimit);
  elements.monthlyLimitInput.value = state.monthlyLimit;
  elements.totalSpentText.textContent = money(spent);
  elements.remainingText.textContent = money(Math.max(remaining, 0));
  elements.remainingHint.textContent = remaining >= 0
    ? "You are within your plan."
    : "Monthly limit exceeded.";
  elements.monthlyMeter.style.width = `${percent}%`;
  elements.monthlyMeter.className = "meter__fill";

  if (spent > state.monthlyLimit) {
    elements.monthlyMeter.classList.add("danger");
  } else if (state.monthlyLimit > 0 && spent >= state.monthlyLimit * 0.8) {
    elements.monthlyMeter.classList.add("warning");
  }
}

function renderAlerts() {
  const alerts = [];
  const spent = totalSpent();

  if (spent > state.monthlyLimit) {
    alerts.push({
      type: "danger",
      text: `Monthly alert: you have spent ${money(spent)}, which is above your ${money(state.monthlyLimit)} limit.`
    });
  } else if (state.monthlyLimit > 0 && spent >= state.monthlyLimit * 0.8) {
    alerts.push({
      type: "warning",
      text: `Careful: you have used ${money(spent)} of your ${money(state.monthlyLimit)} monthly limit.`
    });
  }

  state.categories.forEach((category) => {
    const spentInCategory = categorySpent(category.id);

    if (spentInCategory > category.limit) {
      alerts.push({
        type: "danger",
        text: `${escapeHtml(category.name)} limit crossed: ${money(spentInCategory)} spent out of ${money(category.limit)}.`
      });
    } else if (category.limit > 0 && spentInCategory >= category.limit * 0.8) {
      alerts.push({
        type: "warning",
        text: `${escapeHtml(category.name)} is close to its limit: ${money(spentInCategory)} spent out of ${money(category.limit)}.`
      });
    }
  });

  elements.alerts.innerHTML = alerts
    .map((alert) => `<div class="alert alert--${alert.type}">${alert.text}</div>`)
    .join("");
}

function renderCategoryOptions() {
  elements.expenseCategory.innerHTML = state.categories
    .map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`)
    .join("");
}

function renderPieChart() {
  const canvas = elements.expensePieChart;
  const context = canvas.getContext("2d");
  const center = canvas.width / 2;
  const radius = 104;
  const rows = state.categories
    .map((category, index) => ({
      name: category.name,
      amount: categorySpent(category.id),
      color: chartColors[index % chartColors.length]
    }))
    .filter((row) => row.amount > 0);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);

  context.clearRect(0, 0, canvas.width, canvas.height);

  if (total === 0) {
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.fillStyle = "#e7edf4";
    context.fill();
    context.fillStyle = "#687387";
    context.font = "700 16px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("No expenses", center, center);
    elements.chartLegend.innerHTML = '<p class="chart-empty">Add expenses to see category share.</p>';
    return;
  }

  let startAngle = -Math.PI / 2;

  rows.forEach((row) => {
    const sliceAngle = (row.amount / total) * Math.PI * 2;
    context.beginPath();
    context.moveTo(center, center);
    context.arc(center, center, radius, startAngle, startAngle + sliceAngle);
    context.closePath();
    context.fillStyle = row.color;
    context.fill();
    startAngle += sliceAngle;
  });

  context.beginPath();
  context.arc(center, center, 54, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.fillStyle = "#18212f";
  context.font = "800 18px Arial";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(money(total), center, center);

  elements.chartLegend.innerHTML = rows
    .map((row) => {
      const percent = Math.round((row.amount / total) * 100);
      return `
        <div class="legend-item">
          <span class="legend-dot" style="background: ${row.color}"></span>
          <span class="legend-name">${escapeHtml(row.name)}</span>
          <span>${percent}%</span>
        </div>
      `;
    })
    .join("");
}

function renderCategories() {
  elements.categoryList.innerHTML = state.categories
    .map((category) => {
      const spent = categorySpent(category.id);
      const percent = category.limit > 0 ? Math.min((spent / category.limit) * 100, 100) : spent > 0 ? 100 : 0;
      const status = spent > category.limit ? "danger" : category.limit > 0 && spent >= category.limit * 0.8 ? "warning" : "";

      return `
        <article class="category-item">
          <div class="category-topline">
            <div class="category-name">${escapeHtml(category.name)}</div>
            <div class="category-meta">${money(spent)} / ${money(category.limit)}</div>
          </div>
          <div class="meter" aria-hidden="true">
            <div class="meter__fill ${status}" style="width: ${percent}%"></div>
          </div>
          <form class="category-actions" data-category-id="${escapeHtml(category.id)}">
            <input name="name" value="${escapeHtml(category.name)}" aria-label="${escapeHtml(category.name)} name" required />
            <input name="limit" type="number" min="0" step="1" value="${category.limit}" aria-label="${category.name} limit" required />
            <button class="small-btn" type="submit">Save</button>
            <button class="danger-btn" type="button" data-delete-category="${escapeHtml(category.id)}">Delete</button>
          </form>
        </article>
      `;
    })
    .join("");
}

function renderExpenses() {
  const categoryById = new Map(state.categories.map((category) => [category.id, category.name]));
  elements.expenseCount.textContent = `${state.expenses.length} ${state.expenses.length === 1 ? "record" : "records"}`;

  if (state.expenses.length === 0) {
    elements.expenseTable.innerHTML = elements.emptyStateTemplate.innerHTML;
    return;
  }

  elements.expenseTable.innerHTML = state.expenses
    .map((expense) => `
      <tr>
        <td><strong>${escapeHtml(expense.title)}</strong></td>
        <td><span class="chip">${escapeHtml(categoryById.get(expense.categoryId) || "Unknown")}</span></td>
        <td>${escapeHtml(expense.date)}</td>
        <td class="amount-cell"><strong>${money(expense.amount)}</strong></td>
        <td class="amount-cell">
          <button class="danger-btn" type="button" data-delete-expense="${escapeHtml(expense.id)}">Delete</button>
        </td>
      </tr>
    `)
    .join("");
}

function render() {
  if (state.currentUser) {
    elements.usernameLabel.textContent = state.currentUser.username;
  }

  renderSummary();
  renderAlerts();
  renderCategoryOptions();
  renderPieChart();
  renderCategories();
  renderExpenses();
}

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const action = event.submitter?.dataset.authAction || "login";
  const username = elements.authUsername.value.trim();
  const password = elements.authPassword.value;

  try {
    elements.authMessage.textContent = "";
    const data = await api(`/api/${action}`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    updateState(data);
    showApp(data.user.username);
    elements.authForm.reset();
  } catch (error) {
    elements.authMessage.textContent = error.message;
  }
});

elements.togglePassword.addEventListener("click", () => {
  setPasswordVisibility(elements.authPassword, elements.togglePassword, elements.authPassword.type === "password");
});

elements.toggleNewPassword.addEventListener("click", () => {
  setPasswordVisibility(elements.newPassword, elements.toggleNewPassword, elements.newPassword.type === "password");
});

elements.forgotPasswordButton.addEventListener("click", showForgotMode);

elements.backToLoginButton.addEventListener("click", () => {
  elements.forgotForm.reset();
  showLoginMode();
});

elements.forgotForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    elements.authMessage.textContent = "";

    if (!resetUsername) {
      const data = await api("/api/forgot-password/check", {
        method: "POST",
        body: JSON.stringify({ username: elements.forgotUsername.value.trim() })
      });

      resetUsername = data.username;
      elements.forgotUsername.value = data.username;
      elements.forgotUsername.readOnly = true;
      elements.newPasswordGroup.classList.remove("is-hidden");
      elements.newPassword.required = true;
      elements.forgotSubmitButton.textContent = "Save Password";
      elements.authMessage.textContent = data.message;
      return;
    }

    const data = await api("/api/forgot-password/reset", {
      method: "POST",
      body: JSON.stringify({
        username: resetUsername,
        password: elements.newPassword.value
      })
    });

    elements.forgotForm.reset();
    elements.forgotUsername.readOnly = false;
    showLoginMode(data.message);
  } catch (error) {
    elements.authMessage.textContent = error.message;
  }
});

elements.logoutButton.addEventListener("click", () => {
  showAuth("Logged out.");
});

document.querySelector("#monthlyLimitForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const limit = Number(elements.monthlyLimitInput.value);
  updateState(await api("/api/monthly-limit", {
    method: "PUT",
    body: JSON.stringify({ limit })
  }));
});

document.querySelector("#expenseForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;

  updateState(await api("/api/expenses", {
    method: "POST",
    body: JSON.stringify({
      title: document.querySelector("#expenseTitle").value,
      amount: Number(document.querySelector("#expenseAmount").value),
      categoryId: elements.expenseCategory.value,
      date: elements.expenseDate.value
    })
  }));

  form.reset();
  elements.expenseDate.value = new Date().toISOString().slice(0, 10);
});

document.querySelector("#categoryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;

  updateState(await api("/api/categories", {
    method: "POST",
    body: JSON.stringify({
      name: document.querySelector("#categoryName").value,
      limit: Number(document.querySelector("#categoryLimit").value)
    })
  }));

  form.reset();
});

elements.categoryList.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const categoryId = form.dataset.categoryId;
  const formData = new FormData(form);

  updateState(await api(`/api/categories/${encodeURIComponent(categoryId)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: formData.get("name"),
      limit: Number(formData.get("limit"))
    })
  }));
});

elements.categoryList.addEventListener("click", async (event) => {
  const categoryId = event.target.dataset.deleteCategory;

  if (!categoryId) {
    return;
  }

  try {
    updateState(await api(`/api/categories/${encodeURIComponent(categoryId)}`, {
      method: "DELETE"
    }));
  } catch (error) {
    alert(error.message);
  }
});

elements.expenseTable.addEventListener("click", async (event) => {
  const expenseId = event.target.dataset.deleteExpense;

  if (!expenseId) {
    return;
  }

  updateState(await api(`/api/expenses/${encodeURIComponent(expenseId)}`, {
    method: "DELETE"
  }));
});

async function init() {
  elements.monthLabel.textContent = new Date().toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric"
  });
  elements.expenseDate.value = new Date().toISOString().slice(0, 10);
  showAuth();
}

init().catch((error) => {
  showAuth(error.message);
});
