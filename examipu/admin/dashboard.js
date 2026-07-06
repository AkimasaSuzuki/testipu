/* =====================================================================
 *  admin/dashboard.js — SC-11 試験一覧画面ロジック
 *
 *  実装指示書§7.1 admin.listExams / admin.saveExam / admin.deleteExam を
 *  実装根拠とする。ADMIN_TOKENはハードコードしない（apiClient.js経由のみ）。
 *  相互import禁止のため、本ファイルは apiClient.js のみに依存する
 *  （examEditor.js / keyEditor.js 等の他画面スクリプトは参照しない）。
 * ===================================================================== */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var msgArea = $("msgArea");
  var listHost = $("listHost");

  // ===== 未ログインならログイン画面へ誘導（実装指示書P3-2） =====
  if (!window.ApiClient || !ApiClient.AdminSession.isLoggedIn()) {
    location.href = "index.html";
    return;
  }

  // ===== 文字列エスケープ（XSS対策。index.htmlのshowErrorパターンを踏襲） =====
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
  function showOk(text) {
    msgArea.innerHTML = '<div class="error-box" style="background:#e5f6ec;border-left-color:#127a3e;color:#0b4d27"></div>';
    msgArea.firstChild.textContent = text;
  }
  function clearMsg() {
    msgArea.innerHTML = "";
  }

  // admin/dashboard.html から見て1つ上のディレクトリがリポジトリ公開ルート（受験ページの配置先）。
  function examUrl(examId) {
    var here = location.href.split("#")[0].split("?")[0];
    var root = here.replace(/admin\/dashboard\.html$/, "");
    return root + "?exam=" + encodeURIComponent(examId);
  }

  // state値に応じたバッジクラス・ラベルの出し分け
  function stateBadge(state) {
    var cls = "state-draft", label = "draft";
    if (state === "published") { cls = "state-published"; label = "published"; }
    else if (state === "closed") { cls = "state-closed"; label = "closed"; }
    else if (state === "draft") { cls = "state-draft"; label = "draft"; }
    else { label = state || "-"; }
    return '<span class="badge ' + cls + '">' + esc(label) + "</span>";
  }

  function fmtDate(v) {
    if (!v) return "-";
    return esc(v);
  }

  // ===== 一覧描画 =====
  function renderList(exams) {
    if (!exams || exams.length === 0) {
      listHost.innerHTML = '<div class="empty">試験がまだありません。「＋ 新規作成」から作成してください。</div>';
      return;
    }

    var table = document.createElement("table");
    table.className = "datatable";
    var thead = document.createElement("thead");
    thead.innerHTML =
      "<tr>" +
      "<th>タイトル</th><th>状態</th><th>公開開始</th><th>公開終了</th><th>更新日時</th><th>操作</th>" +
      "</tr>";
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    exams.forEach(function (exam) {
      var tr = document.createElement("tr");

      var tdTitle = document.createElement("td");
      tdTitle.textContent = exam.title || "(無題)";
      tr.appendChild(tdTitle);

      var tdState = document.createElement("td");
      tdState.innerHTML = stateBadge(exam.state);
      tr.appendChild(tdState);

      var tdOpen = document.createElement("td");
      tdOpen.textContent = exam.openAt || "-";
      tr.appendChild(tdOpen);

      var tdClose = document.createElement("td");
      tdClose.textContent = exam.closeAt || "-";
      tr.appendChild(tdClose);

      var tdUpdated = document.createElement("td");
      tdUpdated.textContent = exam.updatedAt || "-";
      tr.appendChild(tdUpdated);

      var tdOps = document.createElement("td");

      var btnCopyUrl = document.createElement("button");
      btnCopyUrl.type = "button";
      btnCopyUrl.className = "secondary";
      btnCopyUrl.textContent = "受験URLをコピー";
      btnCopyUrl.addEventListener("click", function () { copyExamUrl(exam.examId); });
      tdOps.appendChild(btnCopyUrl);
      tdOps.appendChild(document.createTextNode(" "));

      tdOps.appendChild(makeLink("編集", "examEditor.html?exam=" + encodeURIComponent(exam.examId)));
      tdOps.appendChild(document.createTextNode(" "));
      tdOps.appendChild(makeLink("正解入力", "keyEditor.html?exam=" + encodeURIComponent(exam.examId)));
      tdOps.appendChild(document.createTextNode(" "));
      tdOps.appendChild(makeLink("モニタ", "monitorView.html?exam=" + encodeURIComponent(exam.examId)));
      tdOps.appendChild(document.createTextNode(" "));
      tdOps.appendChild(makeLink("採点", "gradingView.html?exam=" + encodeURIComponent(exam.examId)));
      tdOps.appendChild(document.createTextNode(" "));
      tdOps.appendChild(makeLink("成績", "reportView.html?exam=" + encodeURIComponent(exam.examId)));
      tdOps.appendChild(document.createTextNode(" "));

      var btnCopy = document.createElement("button");
      btnCopy.type = "button";
      btnCopy.className = "secondary";
      btnCopy.textContent = "複製";
      btnCopy.addEventListener("click", function () { duplicateExam(exam.examId); });
      tdOps.appendChild(btnCopy);
      tdOps.appendChild(document.createTextNode(" "));

      var btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "danger";
      btnDel.textContent = "削除";
      btnDel.addEventListener("click", function () { deleteExam(exam.examId); });
      tdOps.appendChild(btnDel);

      tr.appendChild(tdOps);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    listHost.innerHTML = "";
    listHost.appendChild(table);
  }

  function makeLink(label, href) {
    var a = document.createElement("a");
    a.href = href;
    a.className = "btn secondary";
    a.textContent = label;
    return a;
  }

  // ===== 一覧再取得 =====
  function loadList() {
    listHost.innerHTML = '<div class="loading">読み込み中です…</div>';
    clearMsg();
    ApiClient.callGet("admin.listExams", {}).then(function (res) {
      if (!res || res.ok !== true) {
        listHost.innerHTML = "";
        showError((res && res.error) || "試験一覧の取得に失敗しました。");
        return;
      }
      renderList(res.exams || []);
    }).catch(function (err) {
      listHost.innerHTML = "";
      showError((err && err.message) || "通信に失敗しました。");
    });
  }

  // ===== 受験URLをクリップボードへコピー =====
  function copyExamUrl(examId) {
    clearMsg();
    var url = examUrl(examId);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        showOk("受験URLをコピーしました: " + url);
      }, function () {
        showError("コピーに失敗しました。手動でコピーしてください: " + url);
      });
      return;
    }
    // navigator.clipboard未対応時のフォールバック
    var ta = document.createElement("textarea");
    ta.value = url;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showOk("受験URLをコピーしました: " + url);
    } catch (e) {
      showError("自動コピーに失敗しました。手動でコピーしてください: " + url);
    }
    document.body.removeChild(ta);
  }

  // ===== 複製: exam取得→title変更・examId除去→saveExam(新規作成扱い) =====
  function duplicateExam(examId) {
    clearMsg();
    ApiClient.callGet("admin.getExam", { examId: examId }).then(function (res) {
      if (!res || res.ok !== true) {
        throw new Error((res && res.error) || "試験データの取得に失敗しました。");
      }
      var exam = res.exam;
      // examIdフィールドを削除し新規作成として扱う（実装指示書の複製仕様）
      var copy = JSON.parse(JSON.stringify(exam));
      copy.title = "(コピー) " + (copy.title || "");
      delete copy.examId;
      return ApiClient.callPost("admin.saveExam", { exam: copy });
    }).then(function (res) {
      if (!res || res.ok !== true) {
        throw new Error((res && res.error) || "複製の保存に失敗しました。");
      }
      loadList();
    }).catch(function (err) {
      showError((err && err.message) || "複製に失敗しました。");
    });
  }

  // ===== 削除 =====
  function deleteExam(examId) {
    if (!confirm("この試験を削除します。よろしいですか？")) return;
    clearMsg();
    ApiClient.callPost("admin.deleteExam", { examId: examId }).then(function (res) {
      if (!res || res.ok !== true) {
        throw new Error((res && res.error) || "削除に失敗しました。");
      }
      loadList();
    }).catch(function (err) {
      showError((err && err.message) || "削除に失敗しました。");
    });
  }

  // ===== 新規作成 =====
  $("btnNew").addEventListener("click", function () {
    location.href = "examEditor.html";
  });

  // ===== ログアウト =====
  $("btnLogout").addEventListener("click", function () {
    ApiClient.logout();
    location.href = "index.html";
  });

  loadList();
})();
