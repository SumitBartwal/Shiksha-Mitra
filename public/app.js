const API_BASE = (() => {
  if (window.location.protocol === "file:") return "http://127.0.0.1:8000";
  if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
    return window.location.port === "8000" ? window.location.origin : "http://127.0.0.1:8000";
  }
  return window.location.origin;
})();
const PAGE_SIZE = 25;
const FACULTY_TABS = ["Overview", "Student List", "Intervention History"];

const state = {
  activeView: "faculty",
  activeTab: "Overview",
  students: [],
  metrics: null,
  analytics: null,
  modelMetrics: null,
  notifications: [],
  selectedStudentId: null,
  studentRecord: null,
  studentNotifications: [],
  studentError: "",
  errorBanner: "",
  analysisPreview: null,
  notifyingId: null,
  currentPage: 1,
  totalPages: 1,
  totalStudents: 0,
  isLoading: false,
  searchTerm: "",
  departmentFilter: "All",
  sortBy: "risk_priority",
  sortDir: "asc",
  analyzerForm: {
    Student_ID: "",
    Department: "CSE",
    Semester: "5",
    Attendance_Percentage: "74",
    Internal_Marks: "48",
    Assignment_Marks: "52",
    Quiz_Average: "47",
    Backlogs_Count: "1",
    CGPA: "6.1",
  },
};

const app = document.getElementById("app");
const toastRoot = document.getElementById("toast-root");
let filterDebounce = null;

document.addEventListener("DOMContentLoaded", init);
document.body.addEventListener("click", handleClick);
document.body.addEventListener("input", handleInput);
document.body.addEventListener("change", handleInput);
document.body.addEventListener("submit", handleSubmit);

async function init() {
  render();
  await loadDashboard(1);
}
//error handeling of loading error 
async function fetchJson(path, options) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, options);
  } catch (error) {
    throw new Error("Unable to reach the backend service.");
  }

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error((data && data.detail) || `Request failed (${response.status})`);
  }

  return data;
}

async function loadDashboard(page = state.currentPage) {
  state.isLoading = true;
  state.errorBanner = "";
  render();
  try {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      search: state.searchTerm,
      department: state.departmentFilter,
      sort_by: state.sortBy,
      sort_dir: state.sortDir,
    });
    const [studentsPayload, metricsPayload, analyticsPayload, metricsPanelPayload, notificationsPayload] = await Promise.all([
      fetchJson(`/students?${params.toString()}`),
      fetchJson("/dashboard-metrics"),
      fetchJson("/class-analytics"),
      fetchJson("/model-metrics"),
      fetchJson("/notifications"),
    ]);

    state.students = studentsPayload.students || [];
    state.totalStudents = studentsPayload.total || 0;
    state.currentPage = studentsPayload.page || page;
    state.totalPages = studentsPayload.total_pages || 1;
    state.metrics = metricsPayload;
    state.analytics = analyticsPayload;
    state.modelMetrics = metricsPanelPayload;
    state.notifications = notificationsPayload.notifications || [];

    if (!state.selectedStudentId && state.students.length) {
      state.selectedStudentId = state.students[0].Student_ID;
    }
    if (state.selectedStudentId) {
      await loadStudentDetails(state.selectedStudentId, { syncForm: !state.analyzerForm.Student_ID });
    }
  } catch (error) {
    state.errorBanner = error.message;
    showToast("Load Error", error.message);
  } finally {
    state.isLoading = false;
    render();
  }
}

async function loadStudentDetails(studentId, options = {}) {
  if (!studentId) return;
  const { syncForm = true } = options;
  try {
    state.studentError = "";
    const [studentPayload, notificationsPayload] = await Promise.all([
      fetchJson(`/students/${studentId}`),
      fetchJson(`/notifications?student_id=${studentId}`),
    ]);
    state.errorBanner = "";
    state.selectedStudentId = studentId;
    state.studentRecord = studentPayload;
    state.studentNotifications = notificationsPayload.notifications || [];
    state.analysisPreview = studentPayload;
    if (syncForm) syncAnalyzerFormFromStudent(studentPayload);
  } catch (error) {
    state.studentRecord = null;
    state.studentNotifications = [];
    state.studentError = error.message;
    state.errorBanner = error.message;
  }
}

function syncAnalyzerFormFromStudent(student) {
  if (!student) return;
  state.analyzerForm = {
    Student_ID: String(student.Student_ID ?? ""),
    Department: String(student.Department ?? ""),
    Semester: String(student.Semester ?? ""),
    Attendance_Percentage: String(student.Attendance_Percentage ?? ""),
    Internal_Marks: String(student.Internal_Marks ?? ""),
    Assignment_Marks: String(student.Assignment_Marks ?? ""),
    Quiz_Average: String(student.Quiz_Average ?? ""),
    Backlogs_Count: String(student.Backlogs_Count ?? ""),
    CGPA: String(student.CGPA ?? ""),
  };
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "switch-view") {
    state.activeView = button.dataset.view;
    render();
    return;
  }
  if (action === "switch-tab") {
    state.activeTab = button.dataset.tab;
    render();
    return;
  }
  if (action === "retry-load") {
    loadDashboard(state.currentPage);
    return;
  }
  if (action === "open-student") {
    state.activeTab = "Overview";
    loadStudentDetails(Number(button.dataset.studentId)).then(render);
    render();
    return;
  }
  if (action === "notify-student") {
    const studentId = Number(button.dataset.studentId);
    const student = state.students.find((item) => item.Student_ID === studentId)
      || (state.studentRecord && state.studentRecord.Student_ID === studentId ? state.studentRecord : null);
    if (student) notifyStudent(student);
    return;
  }
  if (action === "toggle-sort-dir") {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    loadDashboard(1);
    return;
  }
  if (action === "change-page") {
    const page = Number(button.dataset.page);
    if (page && page !== state.currentPage) loadDashboard(page);
    return;
  }
  if (action === "prev-page" && state.currentPage > 1) loadDashboard(state.currentPage - 1);
  if (action === "next-page" && state.currentPage < state.totalPages) loadDashboard(state.currentPage + 1);
}

function handleInput(event) {
  const field = event.target.dataset.field;
  if (field) {
    state.analyzerForm[field] = event.target.value;
    return;
  }

  const control = event.target.dataset.control;
  if (!control) return;
  state[control] = event.target.value;
  window.clearTimeout(filterDebounce);
  filterDebounce = window.setTimeout(() => loadDashboard(1), control === "searchTerm" ? 220 : 0);
}

function handleSubmit(event) {
  const form = event.target;
  if (form.matches("[data-analyzer-form]")) {
    event.preventDefault();
    analyzeStudent();
  }
  if (form.matches("[data-student-form]")) {
    event.preventDefault();
    const studentId = Number(form.querySelector("[data-student-input]").value);
    if (!studentId) {
      showToast("Student ID Required", "Enter a valid student ID to open the student view.");
      return;
    }
    loadStudentDetails(studentId, { syncForm: false }).then(render);
  }
}
async function analyzeStudent() {
  try {
    const payload = {
      Student_ID: Number(state.analyzerForm.Student_ID),
      Department: state.analyzerForm.Department,
      Semester: Number(state.analyzerForm.Semester),
      Attendance_Percentage: Number(state.analyzerForm.Attendance_Percentage),
      Internal_Marks: Number(state.analyzerForm.Internal_Marks),
      Assignment_Marks: Number(state.analyzerForm.Assignment_Marks),
      Quiz_Average: Number(state.analyzerForm.Quiz_Average),
      Backlogs_Count: Number(state.analyzerForm.Backlogs_Count),
      CGPA: Number(state.analyzerForm.CGPA),
    };
    state.analysisPreview = await fetchJson("/analyze-risk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast("Review Updated", `Student ${state.analysisPreview.student_id} performance record has been recalculated.`);
    render();
  } catch (error) {
    showToast("Review Error", error.message);
  }
}

async function notifyStudent(student) {
  try {
    state.notifyingId = student.Student_ID;
    render();
    const payload = await fetchJson("/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        student_id: student.Student_ID,
        primary_cause: student.primary_cause,
        suggested_action: student.suggested_action,
        faculty_name: "Class Advisor",
      }),
    });
    state.notifications = [payload.notification, ...state.notifications];
    if (state.metrics) state.metrics.intervention_count = state.notifications.length;
    await loadStudentDetails(student.Student_ID, { syncForm: false });
    state.activeTab = "Intervention History";
    showToast("Intervention Recorded", `A faculty intervention note has been added for student ${student.Student_ID}.`);
  } catch (error) {
    showToast("Notification Error", error.message);
  } finally {
    state.notifyingId = null;
    render();
  }
}

function showToast(title, message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>`;
  toastRoot.appendChild(node);
  window.setTimeout(() => node.remove(), 3200);
}

function render() {
  const isBootLoading = state.isLoading && !state.metrics && !state.analytics;
  app.innerHTML = `
    <div class="app-shell">
      ${renderHeader()}
      <main class="page-shell">
        ${isBootLoading ? renderLoadingState() : (state.activeView === "faculty" ? renderFacultyView() : renderStudentView())}
      </main>
    </div>
  `;
}

function renderLoadingState() {
  return `
    <section class="loading-state">
      <div class="loading-panel">
        <p class="eyebrow">Preparing Dashboard</p>
        <h2>Loading student records, class metrics, and faculty review data</h2>
        <p class="muted">The dashboard is building the current academic snapshot for the class.</p>
        <div class="loading-bars"><span></span><span></span><span></span></div>
      </div>
    </section>
  `;
}

function renderErrorBanner() {
  if (!state.errorBanner) return "";
  return `<div class="error-banner"><div><strong>Data Load Issue</strong><div>${escapeHtml(state.errorBanner)}</div></div><button class="ghost-btn" data-action="retry-load">Retry</button></div>`;
}

function renderHeader() {
  const navItems = ["Documents", "My", "Personal", "Academics", "Electives"];
  return `
    <header class="portal-header">
      <div class="portal-header-inner">
        <div class="portal-top-row">
          <div class="brand-block">
            <img src="./logo.jpg" alt="ICFAI University Dehradun" class="portal-logo" />
            <div class="portal-meta">
              <span>Program : <strong>BCA</strong></span>
              <span>Class of : <strong>2027</strong></span>
              <span>Semester : <strong>Current</strong></span>
            </div>
          </div>
          <div class="view-switch">
            <button class="${state.activeView === "faculty" ? "is-active" : ""}" data-action="switch-view" data-view="faculty">Faculty Desk</button>
            <button class="${state.activeView === "student" ? "is-active" : ""}" data-action="switch-view" data-view="student">Student Desk</button>
          </div>
        </div>
        <div class="portal-nav-row">${navItems.map((item) => `<span>${item}</span>`).join("")}</div>
      </div>
    </header>
  `;
}

function renderFacultyView() {
  return `
    <div class="faculty-layout">
      ${renderSidebar()}
      <section class="content-stack">
        ${renderErrorBanner()}
        ${renderMetricGrid()}
        ${state.activeTab === "Overview" ? renderOverviewTab() : ""}
        ${state.activeTab === "Student List" ? renderStudentListTab() : ""}
        ${state.activeTab === "Intervention History" ? renderHistoryTab() : ""}
      </section>
    </div>
  `;
}

function renderSidebar() {
  return `
    <aside class="sidebar">
      <p class="eyebrow">Faculty Dashboard</p>
      <h2>Student Performance Review</h2>
      <p class="muted">Monitor class standing, review risk causes, and record faculty intervention notes from one screen.</p>
      <div class="sidebar-nav">
        ${FACULTY_TABS.map((tab) => `<button class="${state.activeTab === tab ? "is-active" : ""}" data-action="switch-tab" data-tab="${tab}">${tab}</button>`).join("")}
      </div>
      <div class="note-box">
        <p class="eyebrow">Current Rules</p>
        <ul>
          <li>Low risk students remain in green.</li>
          <li>Medium risk students are highlighted in orange for follow-up.</li>
          <li>High risk students move into the red review queue.</li>
        </ul>
      </div>
    </aside>
  `;
}

function renderMetricGrid() {
  if (!state.metrics) {
    return `<div class="metric-grid">${Array.from({ length: 4 }).map(() => `<section class="metric-card"><p class="muted">Loading dashboard metrics...</p></section>`).join("")}</div>`;
  }
  const cards = [
    { title: "Total Students", value: state.metrics.total_students, note: `${state.metrics.low_risk_count} low | ${state.metrics.medium_risk_count} medium | ${state.metrics.high_risk_count} high` },
    { title: "Average Performance", value: `${Math.round(state.metrics.average_score)}%`, note: `${state.metrics.students_needing_follow_up} students currently require a review` },
    { title: "Follow-up Queue", value: state.metrics.high_risk_count + state.metrics.medium_risk_count, note: `${state.metrics.high_risk_count} high priority and ${state.metrics.medium_risk_count} scheduled follow-ups` },
    { title: "Interventions Logged", value: state.metrics.intervention_count, note: "Faculty interventions recorded in the current session" },
  ];
  return `<div class="metric-grid">${cards.map((card) => `<section class="metric-card"><p class="eyebrow">${escapeHtml(card.title)}</p><p class="metric-value">${escapeHtml(String(card.value))}</p><p class="metric-note">${escapeHtml(card.note)}</p></section>`).join("")}</div>`;
}
function renderOverviewTab() {
  return `
    <div class="content-stack">
      <div class="section-grid two-col">${renderDistributionPanel()}${renderDepartmentPanel()}</div>
      <div class="section-grid two-col">${renderSelectedStudentPanel()}${renderAnalyzerPanel()}</div>
      ${renderCausePanel()}
      ${renderModelMetricsPanel()}
    </div>
  `;
}

function renderStudentListTab() { return renderTableCard(); }

function renderHistoryTab() {
  return `<div class="section-grid two-col">${renderHistoryPanel()}${renderSelectedStudentPanel(true)}</div>`;
}

function renderDistributionPanel() {
  if (!state.analytics) return `<section class="panel"><p class="muted">Loading class distribution...</p></section>`;
  const distribution = state.analytics.risk_distribution || { Low: 0, Medium: 0, High: 0 };
  const total = state.analytics.total_students || 1;
  const lowAngle = (distribution.Low / total) * 360;
  const mediumAngle = (distribution.Medium / total) * 360;
  const donutStyle = `background: conic-gradient(var(--green) 0deg ${lowAngle.toFixed(2)}deg, var(--orange) ${lowAngle.toFixed(2)}deg ${(lowAngle + mediumAngle).toFixed(2)}deg, var(--red) ${(lowAngle + mediumAngle).toFixed(2)}deg 360deg);`;
  return `
    <section class="panel">
      <div class="panel-header"><div class="panel-title"><p class="eyebrow">Class Snapshot</p><h3>Overall Performance Distribution</h3></div><span class="count-chip">Whole Class</span></div>
      <div class="summary-layout">
        <div class="distribution-donut" style="${donutStyle}" title="Low ${distribution.Low} | Medium ${distribution.Medium} | High ${distribution.High}"><div class="distribution-center"><div><div class="center-value">${Math.round(state.analytics.average_score)}%</div><div class="center-label">Class Average</div></div></div></div>
        <div class="legend-list">${renderLegendRow("Low", distribution.Low, total)}${renderLegendRow("Medium", distribution.Medium, total)}${renderLegendRow("High", distribution.High, total)}</div>
      </div>
      <div class="footer-note">Hover over the class chart or labels to review the exact share for each performance band.</div>
    </section>
  `;
}

function renderLegendRow(label, count, total) {
  const percentage = total ? Math.round((count / total) * 100) : 0;
  const tone = toneFromBand(label);
  return `<div class="legend-row" title="${count} students | ${percentage}%"><div class="legend-top"><div class="legend-label"><span class="color-dot ${tone}"></span>${escapeHtml(label)} Risk</div><strong>${count}</strong></div><div class="legend-sub">${percentage}% of the class falls in this review band.</div></div>`;
}

function renderDepartmentPanel() {
  if (!state.analytics) return `<section class="panel"><p class="muted">Loading department view...</p></section>`;
  const departments = state.analytics.department_performance || [];
  return `
    <section class="panel">
      <div class="panel-header"><div class="panel-title"><p class="eyebrow">Department View</p><h3>Department Performance</h3></div><span class="count-chip">Average Score</span></div>
      <div class="bar-list">
        ${departments.map((item) => `<div class="bar-row" title="${item.department}: ${Math.round(item.average_score)}% average | ${item.high_risk_count} high risk"><div class="bar-head"><strong>${escapeHtml(item.department)}</strong><span>${Math.round(item.average_score)}%</span></div><div class="bar-sub">${item.student_count} students | ${item.high_risk_count} high risk</div><div class="bar-track"><div class="bar-fill" style="width: ${Math.max(4, item.average_score)}%"></div></div></div>`).join("")}
      </div>
    </section>
  `;
}

function renderCausePanel() {
  if (!state.analytics) return `<section class="panel"><p class="muted">Loading cause distribution...</p></section>`;
  const causes = Object.entries(state.analytics.cause_distribution || {}).slice(0, 6);
  const maxCount = Math.max(...causes.map(([, count]) => count), 1);
  return `
    <section class="panel">
      <div class="panel-header"><div class="panel-title"><p class="eyebrow">Cause Review</p><h3>Leading Performance Drivers</h3></div><span class="count-chip">Primary Cause Count</span></div>
      <div class="bar-list">
        ${causes.map(([cause, count]) => `<div class="bar-row" title="${cause}: ${count} students"><div class="bar-head"><strong>${escapeHtml(cause)}</strong><span>${count}</span></div><div class="bar-sub">${Math.round((count / (state.analytics.total_students || 1)) * 100)}% of the reviewed class</div><div class="bar-track"><div class="bar-fill attention" style="width: ${(count / maxCount) * 100}%"></div></div></div>`).join("")}
      </div>
    </section>
  `;
}

function renderModelMetricsPanel() {
  if (!state.modelMetrics) return `<section class="panel"><p class="muted">Loading model metrics...</p></section>`;
  const metrics = state.modelMetrics;
  const summaryCards = [
    ["Accuracy", `${Math.round(metrics.accuracy * 100)}%`],
    ["Macro Recall", `${Math.round(metrics.macro_recall * 100)}%`],
    ["Macro Precision", `${Math.round(metrics.macro_precision * 100)}%`],
    ["Macro F1", `${Math.round(metrics.macro_f1 * 100)}%`],
  ];
  const labels = metrics.confusion_matrix.labels || [];
  const matrix = metrics.confusion_matrix.matrix || [];
  return `
    <section class="panel">
      <div class="panel-header"><div class="panel-title"><p class="eyebrow">Model Review</p><h3>Ordinal Logistic Regression Metrics</h3></div><span class="count-chip">${escapeHtml(metrics.validation_method)}</span></div>
      <div class="metric-strip">${summaryCards.map(([label, value]) => `<div class="mini-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>
      <div class="section-grid two-col">
        <div class="panel-subsection"><p class="eyebrow">Per-Class Recall</p><div class="legend-list">${Object.entries(metrics.class_recall || {}).map(([label, value]) => `<div class="legend-row"><div class="legend-top"><div class="legend-label"><span class="color-dot ${toneFromBand(label)}"></span>${escapeHtml(label)} Risk</div><strong>${Math.round(value * 100)}%</strong></div><div class="legend-sub">Support: ${(metrics.class_support || {})[label] || 0} students</div></div>`).join("")}</div></div>
        <div class="panel-subsection"><p class="eyebrow">Why This Model</p><ol class="point-list">${(metrics.model_choice_reasons || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></div>
      </div>
      <div class="panel-subsection"><p class="eyebrow">Confusion Matrix</p><div class="matrix-grid"><div class="matrix-row matrix-header"><span></span>${labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div>${matrix.map((row, rowIndex) => `<div class="matrix-row"><span>${escapeHtml(labels[rowIndex] || "")}</span>${row.map((value) => `<span>${value}</span>`).join("")}</div>`).join("")}</div></div>
    </section>
  `;
}

function renderSelectedStudentPanel(compact = false) {
  if (state.studentError) return `<section class="panel"><p class="muted">${escapeHtml(state.studentError)}</p></section>`;
  if (!state.studentRecord) return `<section class="panel"><p class="muted">Select a student from the list to view the current review record.</p></section>`;
  const student = state.studentRecord;
  const recommendations = student.recommended_actions || textToPoints(student.suggested_action);
  const supporting = student.contributing_factors || [];
  return `
    <section class="panel">
      <div class="panel-header"><div class="panel-title"><p class="eyebrow">Selected Student</p><h3>Student ${student.Student_ID} Review Summary</h3></div><span class="inline-chip">${escapeHtml(student.Department)} | Semester ${student.Semester}</span></div>
      <div class="detail-grid">
        <div>${renderMeter(student.score, "Performance", student.risk_band, true)}</div>
        <div class="detail-copy">
          <div><div class="meter-row"><span class="status-badge ${toneFromBand(student.risk_band)}">${escapeHtml(student.risk_band)} Risk</span><span class="inline-chip">Primary Cause: ${escapeHtml(student.primary_cause)}</span></div><p class="small-note">${compact ? "Latest record for the selected student." : "Current record based on attendance, assessments, quiz trend, backlogs, and CGPA."}</p></div>
          <div class="detail-meta">
            <div class="meta-card"><strong>CGPA</strong>${escapeHtml(student.CGPA.toFixed(2))}</div>
            <div class="meta-card"><strong>Attendance</strong>${escapeHtml(String(student.Attendance_Percentage))}%</div>
            <div class="meta-card"><strong>Internal Marks</strong>${escapeHtml(String(student.Internal_Marks))}</div>
            <div class="meta-card"><strong>Backlogs</strong>${escapeHtml(String(student.Backlogs_Count))}</div>
          </div>
          ${supporting.length ? `<div><p class="eyebrow">Supporting Factors</p><ul class="emphasis-list">${supporting.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
          <div><p class="eyebrow">Recommended Faculty Follow-up</p>${renderPointList(recommendations)}</div>
          <div class="action-stack"><button class="ghost-btn" data-action="open-student" data-student-id="${student.Student_ID}">Open Record</button><button class="accent-btn" data-action="notify-student" data-student-id="${student.Student_ID}" ${state.notifyingId === student.Student_ID ? "disabled" : ""}>${state.notifyingId === student.Student_ID ? "Recording..." : "Notify Student"}</button></div>
        </div>
      </div>
    </section>
  `;
}

function renderAnalyzerPanel() {
  const preview = state.analysisPreview;
  return `
    <section class="panel">
      <div class="panel-header"><div class="panel-title"><p class="eyebrow">Performance Review Tool</p><h3>Recalculate Student Performance</h3></div><span class="count-chip">Ordinal Review</span></div>
      <form data-analyzer-form>
        <div class="form-grid">
          ${renderField("Student ID", "Student_ID", "number")}
          ${renderSelectField("Department", "Department", ["CSE", "ECE", "ME", "CE", "IT"])}
          ${renderField("Semester", "Semester", "number")}
          ${renderField("Attendance (%)", "Attendance_Percentage", "number")}
          ${renderField("Internal Marks", "Internal_Marks", "number")}
          ${renderField("Assignment Marks", "Assignment_Marks", "number")}
          ${renderField("Quiz Average", "Quiz_Average", "number")}
          ${renderField("Backlogs", "Backlogs_Count", "number")}
          ${renderField("CGPA", "CGPA", "number")}
        </div>
        <div class="form-actions"><button class="accent-btn" type="submit">Update Review</button></div>
      </form>
      ${preview ? renderPreviewCard(preview) : ""}
    </section>
  `;
}

function renderField(label, field, type) { return `<label><span>${escapeHtml(label)}</span><input type="${type}" data-field="${field}" value="${escapeHtml(state.analyzerForm[field] || "")}" /></label>`; }
function renderSelectField(label, field, options) { return `<label><span>${escapeHtml(label)}</span><select data-field="${field}">${options.map((option) => `<option value="${option}" ${state.analyzerForm[field] === option ? "selected" : ""}>${option}</option>`).join("")}</select></label>`; }

function renderPreviewCard(preview) {
  const recommendations = preview.recommended_actions || textToPoints(preview.suggested_action);
  return `<div class="preview-card"><div class="preview-head"><div><p class="eyebrow">Latest Review</p><h3>Student ${escapeHtml(String(preview.student_id || preview.Student_ID))}</h3></div><div class="meter-row"><span class="status-badge ${toneFromBand(preview.risk_band)}">${escapeHtml(preview.risk_band)} Risk</span><span class="inline-chip">${escapeHtml(preview.primary_cause)}</span></div></div><div class="detail-grid"><div>${renderMeter(preview.score, "Performance", preview.risk_band, true)}</div><div><p class="muted">Current review band is based on the cumulative profile across attendance, internal marks, assignments, quizzes, backlog load, and CGPA.</p>${renderPointList(recommendations)}</div></div></div>`;
}

function renderTableControls() {
  const departments = ["All", ...new Set((state.analytics?.department_performance || []).map((item) => item.department))];
  return `
    <div class="table-controls">
      <input type="search" placeholder="Search student ID, department, or cause" data-control="searchTerm" value="${escapeHtml(state.searchTerm)}" />
      <select data-control="departmentFilter">${departments.map((dept) => `<option value="${dept}" ${state.departmentFilter === dept ? "selected" : ""}>${dept}</option>`).join("")}</select>
      <select data-control="sortBy">${[["risk_priority", "Risk Priority"], ["student_id", "Student ID"], ["score", "Performance Score"], ["cgpa", "CGPA"], ["department", "Department"]].map(([value, label]) => `<option value="${value}" ${state.sortBy === value ? "selected" : ""}>${label}</option>`).join("")}</select>
      <button class="ghost-btn" data-action="toggle-sort-dir">${state.sortDir === "asc" ? "Ascending" : "Descending"}</button>
    </div>
  `;
}

function renderTableCard() {
  return `
    <section class="table-card">
      <div class="table-card-header"><div class="table-card-title"><p class="eyebrow">Student List</p><h2>Faculty Review Queue</h2></div><span class="count-chip">Showing ${state.students.length} of ${state.totalStudents}</span></div>
      <div class="table-toolbar">${renderTableControls()}</div>
      ${state.isLoading ? `<div class="table-loader">Loading student records...</div>` : `<div class="table-wrap"><table class="dense-table"><thead><tr><th>Student ID</th><th>Department</th><th>CGPA</th><th>Performance</th><th>Risk Band</th><th>Primary Cause</th><th>Recommended Action</th><th>Actions</th></tr></thead><tbody>${state.students.map(renderStudentRow).join("")}</tbody></table></div>`}
      ${renderPagination()}
    </section>
  `;
}

function renderStudentRow(student) {
  const actionPoints = (student.recommended_actions || textToPoints(student.suggested_action)).slice(0, 2);
  return `<tr><td><div class="student-code">${escapeHtml(String(student.Student_ID))}</div><div class="small-note">Semester ${student.Semester}</div></td><td>${escapeHtml(student.Department)}</td><td>${escapeHtml(student.CGPA.toFixed(2))}</td><td>${renderMeter(student.score, "Performance", student.risk_band, false)}</td><td><span class="status-badge ${toneFromBand(student.risk_band)}">${escapeHtml(student.risk_band)}</span></td><td><strong>${escapeHtml(student.primary_cause)}</strong>${student.contributing_factors && student.contributing_factors.length ? `<div class="small-note">Also observed: ${escapeHtml(student.contributing_factors.join(", "))}</div>` : ""}</td><td><ul class="point-list">${actionPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul></td><td><div class="action-stack"><button class="soft-btn" data-action="open-student" data-student-id="${student.Student_ID}">Open</button><button class="accent-btn" data-action="notify-student" data-student-id="${student.Student_ID}" ${state.notifyingId === student.Student_ID ? "disabled" : ""}>${state.notifyingId === student.Student_ID ? "Recording..." : "Notify"}</button></div></td></tr>`;
}

function renderPagination() {
  if (state.totalPages <= 1) return `<div class="pagination"><div class="footer-note">All students are visible on one page.</div></div>`;
  const pageNumbers = Array.from({ length: state.totalPages }, (_, index) => index + 1);
  return `<div class="pagination"><div class="footer-note">Page ${state.currentPage} of ${state.totalPages} | 25 students per page</div><div class="pagination-numbers"><button class="page-btn" data-action="prev-page" ${state.currentPage === 1 ? "disabled" : ""}>Previous</button>${pageNumbers.map((page) => `<button class="page-btn ${page === state.currentPage ? "is-active" : ""}" data-action="change-page" data-page="${page}">${page}</button>`).join("")}<button class="page-btn" data-action="next-page" ${state.currentPage === state.totalPages ? "disabled" : ""}>Next</button></div></div>`;
}
function renderHistoryPanel() {
  const history = state.notifications.length ? state.notifications : [];
  return `<section class="panel"><div class="panel-header"><div class="panel-title"><p class="eyebrow">Intervention History</p><h3>Faculty Notifications</h3></div><span class="count-chip">${history.length} Entries</span></div><div class="history-list">${history.length ? history.slice(0, 16).map(renderNotificationCard).join("") : `<div class="empty-state">No interventions have been recorded yet.</div>`}</div></section>`;
}

function renderNotificationCard(notification, index = 0) {
  const points = textToPoints(notification.suggested_action);
  return `<article class="notification-card ${index === 0 ? "latest" : ""}"><div class="notification-meta"><div><div class="notification-title">Student ${escapeHtml(String(notification.student_id))}</div><div class="small-note">${escapeHtml(notification.primary_cause)}</div></div><div class="small-note">${escapeHtml(formatDate(notification.created_at))}</div></div>${renderPointList(points)}</article>`;
}

function renderStudentView() {
  const student = state.studentRecord;
  const notifications = state.studentNotifications;
  const latestNotification = notifications[0];
  const currentRecommendations = latestNotification ? textToPoints(latestNotification.suggested_action) : (student ? (student.recommended_actions || textToPoints(student.suggested_action)) : []);
  const currentCause = latestNotification ? latestNotification.primary_cause : (student ? student.primary_cause : "No current alert");
  return `
    ${renderErrorBanner()}<section class="student-shell">
      <div class="student-shell-header">
        <div><p class="eyebrow">Student Portal</p><h1>Performance Review Record</h1></div>
        <div class="lookup-card"><div><strong>${student ? `Student ${student.Student_ID}` : "Student Lookup"}</strong><div class="small-note">Enter a student ID to open the personalized review record.</div></div><form class="inline-search" data-student-form><input type="number" data-student-input placeholder="Student ID" value="${escapeHtml(String(state.selectedStudentId || ""))}" /><button class="accent-btn" type="submit">Open</button></form></div>
      </div>
      ${student ? `<div class="student-grid"><div class="student-columns"><section class="panel"><div class="panel-header"><div class="panel-title"><p class="eyebrow">Performance Meter</p><h3>Current Academic Position</h3></div><span class="status-badge ${toneFromBand(student.risk_band)}">${escapeHtml(student.risk_band)} Risk</span></div><div class="detail-grid"><div>${renderMeter(student.score, "Performance", student.risk_band, true)}</div><div class="detail-copy"><div class="student-stat-list">${renderStudentStat("Primary Cause", currentCause)}${renderStudentStat("Department", `${student.Department} | Semester ${student.Semester}`)}${renderStudentStat("Attendance", `${student.Attendance_Percentage}%`)}${renderStudentStat("CGPA", student.CGPA.toFixed(2))}</div></div></div></section><section class="panel"><div class="panel-header"><div class="panel-title"><p class="eyebrow">Personalized Improvement Plan</p><h3>Faculty Recommendation</h3></div>${latestNotification ? `<span class="count-chip">Latest Faculty Note</span>` : `<span class="count-chip">Current Review Plan</span>`}</div><div class="notification-list"><article class="notification-card latest"><div class="notification-meta"><div><div class="notification-title">Alert: ${escapeHtml(currentCause)}</div><div class="small-note">Recommendation prepared for the current review cycle.</div></div>${latestNotification ? `<div class="small-note">${escapeHtml(formatDate(latestNotification.created_at))}</div>` : ""}</div>${renderPointList(currentRecommendations)}</article></div></section></div><div class="student-columns"><section class="panel"><div class="panel-header"><div class="panel-title"><p class="eyebrow">Notification Record</p><h3>Faculty Intervention History</h3></div><span class="count-chip">${notifications.length} Records</span></div><div class="notification-list">${notifications.length ? notifications.map(renderNotificationCard).join("") : `<div class="empty-state">No faculty intervention has been recorded for this student yet.</div>`}</div></section></div></div>` : `<div class="empty-state">Student data is not available. Enter a valid student ID to view the dashboard.</div>`}
    </section>
  `;
}

function renderStudentStat(label, value) { return `<div class="student-stat"><div class="student-stat-top"><strong>${escapeHtml(label)}</strong></div><div class="student-stat-sub">${escapeHtml(String(value))}</div></div>`; }
function renderMeter(score, label, band, large = false) { return `<div class="meter ${toneFromBand(band)} ${large ? "meter--large" : ""}" style="--score: ${Number(score)}"><div class="meter__inner"><div><div class="meter__value">${Math.round(Number(score))}%</div></div></div></div>`; }
function renderPointList(points) { const normalized = Array.isArray(points) ? points.filter(Boolean) : textToPoints(points); return `<ol class="point-list">${normalized.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ol>`; }
function textToPoints(text) { return String(text || "").split(/\n+/).map((line) => line.replace(/^\s*\d+\.\s*/, "").trim()).filter(Boolean); }
function toneFromBand(band) { if (band === "High") return "high"; if (band === "Medium") return "medium"; return "low"; }
function formatDate(value) { try { return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); } catch (error) { return value; } }
function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
