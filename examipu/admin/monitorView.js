/* =====================================================================
 *  admin/monitorView.js — SC-14 受験モニタ画面ロジック
 *
 *  実装指示書§4 P3-6・FR-D10（違反回数/提出状態リセット）・FR-E07（モニタ自動更新）を
 *  実装根拠とする。gas/MonitorService.gs の getMonitor()/resetStudent() 応答形式が正。
 *  相互import禁止のため、本ファイルは apiClient.js のみに依存する
 *  （reportView.js 等の他画面スクリプトは参照しない。実装指示書§9）。
 * ===================================================================== */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var msgArea = $("msgArea");
  var listHost = $("listHost");
  var lastUpdatedEl = $("lastUpdated");

  var AUTO_REFRESH_MS = 30000; // FR-E07: 30秒ごとの自動更新
  var refreshTimer = null;
  var examId = "";

  // ===== 未ログインならログイン画面へ誘導（実装指示書P3-2 パターン踏襲） =====
  if (!window.ApiClient || !ApiClient.AdminSession.isLoggedIn()) {
    location.href = "index.html";
    return;
  }

  // ===== 文字列エスケープ（XSS対策。dashboard.jsのescパターンを踏襲） =====
  function esc(text) {
    return String(text == null ? "" : text).replace(/[<>&"]/g, function (c) {
      if (c === "<") return "&lt;";
      if (c === ">") return "&gt;";
      if (c === "&") return "&amp;";
      return "&quot;";
    });
  }

  function showError(text) {
    msgArea.innerHTML = '<div class="error-box"></div>';
    msgArea.firstChild.textContent = text;
  }
  function clearMsg() {
    msgArea.innerHTML = "";
  }

  // ===== examId取得（実装指示書: URLクエリ?exam=<examId>） =====
  examId = new URLSearchParams(location.search).get("exam") || "";
  if (!examId) {
    listHost.innerHTML = "";
    showError("試験IDが指定されていません（URLに ?exam=<examId> を付与してください）。");
    // examIdが無い場合はエラー表示して以降の処理をしない
  } else {
    init();
  }

  // state値に応じたバッジクラス・ラベルの出し分け（admin.css .badge.status-*）
  function stateBadge(state) {
    var cls = "status-in_progress", label = "受験中";
    if (state === "submitted") { cls = "status-submitted"; label = "提出済"; }
    else if (state === "violation") { cls = "status-violation"; label = "違反"; }
    else if (state === "in_progress") { cls = "status-in_progress"; label = "受験中"; }
    else { label = state || "-"; }
    return '<span class="badge ' + cls + '">' + esc(label) + "</span>";
  }

  // ISO文字列をja-JP整形表示に変換する
  function fmtDate(v) {
    if (!v) return "-";
    var d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return esc(d.toLocaleString("ja-JP"));
  }

  // ===== 一覧描画 =====
  function renderList(students) {
    if (!students || students.length === 0) {
      listHost.innerHTML = '<div class="empty">アクセス記録のある学生がまだいません。</div>';
      return;
    }

    var table = document.createElement("table");
    table.className = "datatable";
    var thead = document.createElement("thead");
    thead.innerHTML =
      "<tr>" +
      "<th>学籍番号</th><th>氏名</th><th>状態</th><th>違反回数</th><th>最終アクセス</th><th>操作</th>" +
      "</tr>";
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    students.forEach(function (st) {
      var tr = document.createElement("tr");

      var tdSid = document.createElement("td");
      tdSid.textContent = st.sid || "-";
      tr.appendChild(tdSid);

      var tdName = document.createElement("td");
      tdName.innerHTML = esc(st.name || "-") +
        // role="teacher"はテスト受験者。除外せず「テスト」バッジで区別表示（実装指示書§4.8 hintボックス）
        (st.role === "teacher" ? ' <span class="badge test">テスト</span>' : "");
      tr.appendChild(tdName);

      var tdState = document.createElement("td");
      tdState.innerHTML = stateBadge(st.state);
      tr.appendChild(tdState);

      var tdViol = document.createElement("td");
      tdViol.textContent = st.violations != null ? st.violations : 0;
      tr.appendChild(tdViol);

      var tdSeen = document.createElement("td");
      tdSeen.textContent = fmtDate(st.lastSeenAt);
      tr.appendChild(tdSeen);

      var tdOps = document.createElement("td");

      var btnResetViol = document.createElement("button");
      btnResetViol.type = "button";
      btnResetViol.className = "secondary";
      btnResetViol.textContent = "違反回数リセット";
      btnResetViol.addEventListener("click", function () {
        resetStudent(st.sid, "violations");
      });
      tdOps.appendChild(btnResetViol);
      tdOps.appendChild(document.createTextNode(" "));

      var btnResetDone = document.createElement("button");
      btnResetDone.type = "button";
      btnResetDone.className = "danger";
      btnResetDone.textContent = "提出状態リセット";
      btnResetDone.addEventListener("click", function () {
        resetStudent(st.sid, "done");
      });
      tdOps.appendChild(btnResetDone);

      tr.appendChild(tdOps);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    listHost.innerHTML = "";
    listHost.appendChild(table);
  }

  // ===== 一覧取得・再描画（自動更新・手動更新・リセット後の再取得で共通利用） =====
  function fetchAndRender() {
    clearMsg();
    return ApiClient.callGet("admin.monitor", { examId: examId }).then(function (res) {
      if (!res || res.ok !== true) {
        listHost.innerHTML = "";
        showError((res && res.error) || "受験状況の取得に失敗しました。");
        return;
      }
      renderList(res.students || []);
      lastUpdatedEl.textContent = "最終更新: " + new Date().toLocaleString("ja-JP");
    }).catch(function (err) {
      showError((err && err.message) || "通信に失敗しました。");
    });
  }

  // ===== 違反回数/提出状態リセット（FR-D10） =====
  function resetStudent(sid, target) {
    var label = target === "violations" ? "違反回数をリセット" : "提出状態をリセット";
    if (!confirm("学籍番号 " + sid + " の" + label + "します。よろしいですか？")) return;
    clearMsg();
    ApiClient.callPost("admin.resetStudent", { examId: examId, sid: sid, target: target }).then(function (res) {
      if (!res || res.ok !== true) {
        throw new Error((res && res.error) || "リセットに失敗しました。");
      }
      return fetchAndRender();
    }).catch(function (err) {
      showError((err && err.message) || "リセットに失敗しました。");
    });
  }

  // ===== 自動更新タイマーの開始・停止（FR-E07。beforeunload/pagehideで確実にclearInterval） =====
  function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(fetchAndRender, AUTO_REFRESH_MS);
  }
  function stopAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function init() {
    $("btnRefresh").addEventListener("click", fetchAndRender);
    $("btnLogout").addEventListener("click", function () {
      ApiClient.logout();
      location.href = "index.html";
    });

    window.addEventListener("beforeunload", stopAutoRefresh);
    window.addEventListener("pagehide", stopAutoRefresh);

    fetchAndRender();
    startAutoRefresh();
  }
})();
