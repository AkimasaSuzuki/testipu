/* =====================================================================
 *  admin/reportView.js — SC-16 成績集計・CSV出力画面ロジック
 *
 *  実装指示書§4 P3-8（UC-06・FR-E08/C14）・§7.1 API契約を実装根拠とする。
 *  - admin.getGrades: {ok:true, grades:[{examId,sid,totalScore,gradingState,
 *      detailJsonFileId,updatedAt,role}]}（集計行のみ。設問別得点は含まない）
 *  - admin.listSubmissions: 氏名・提出時刻・違反回数・role の補完に使用
 *  - admin.exportCsv: UTF-8 BOM付きCSVテキスト（JSON封筒なし。gas/GradeService.buildCsvが正）。
 *      設問別得点列はこのCSVにのみ含まれるため、画面表の設問別得点は
 *      CSV（includeTest=1で全件取得）をパースして補完する（設計疑義G-1のReportService相当を
 *      GAS側が包含しており、設問別集計の権威はサーバーのbuildCsvにある）。
 *  - role=teacherは既定除外＋「テスト受験者を表示」トグルで包含（FR-C14）。
 *  相互import禁止のため、本ファイルは apiClient.js のみに依存する（実装指示書§9）。
 * ===================================================================== */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var msgArea = $("msgArea");
  var listHost = $("listHost");

  var examId = "";
  var lastRows = null;   // 直近のマージ済み行キャッシュ（トグル切替時の再描画用）
  var lastQIds = [];     // CSVヘッダから得た設問ID列

  // ===== 未ログインならログイン画面へ誘導（実装指示書P3-2 パターン踏襲） =====
  if (!window.ApiClient || !ApiClient.AdminSession.isLoggedIn()) {
    location.href = "index.html";
    return;
  }

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
  function clearMsg() { msgArea.innerHTML = ""; }

  function fmtDate(v) {
    if (!v) return "-";
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString("ja-JP");
  }

  // ===== examId取得（URLクエリ ?exam=<examId>） =====
  examId = new URLSearchParams(location.search).get("exam") || "";
  if (!examId) {
    listHost.innerHTML = "";
    showError("試験IDが指定されていません（URLに ?exam=<examId> を付与してください）。");
  } else {
    init();
  }

  /* ===== CSVパーサ（RFC4180相当の最小実装。gas/GradeService.csvEscape_の出力と対） =====
   * ダブルクォート囲み・""エスケープ・改行(\r\n/\n)に対応。先頭のUTF-8 BOMは除去して解析する。 */
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM除去（解析用のみ）
    var rows = [];
    var row = [];
    var field = "";
    var inQuote = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuote) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuote = false; }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\r") {
        // \r\nは\n側で処理
      } else if (ch === "\n") {
        row.push(field); field = "";
        rows.push(row); row = [];
      } else {
        field += ch;
      }
    }
    if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return !(r.length === 1 && r[0] === ""); });
  }

  /* ===== データ取得（3ソースをマージ） =====
   * 1. admin.getGrades      → totalScore/gradingState/role
   * 2. admin.listSubmissions → name/submittedAt/violations/role/status
   * 3. admin.exportCsv(includeTest=1) → 設問別得点列（画面表示用。全件取得しクライアントでフィルタ） */
  function fetchAll() {
    clearMsg();
    listHost.innerHTML = '<div class="loading">読み込み中です…</div>';
    return Promise.all([
      ApiClient.callGet("admin.getGrades", { examId: examId }),
      ApiClient.callGet("admin.listSubmissions", { examId: examId }),
      ApiClient.callGetCsv({ examId: examId, includeTest: "1" })
    ]).then(function (results) {
      var gradesRes = results[0];
      var subsRes = results[1];
      var csvText = results[2];

      if (!gradesRes || gradesRes.ok !== true) {
        throw new Error((gradesRes && gradesRes.error) || "成績の取得に失敗しました。");
      }
      if (!subsRes || subsRes.ok !== true) {
        throw new Error((subsRes && subsRes.error) || "提出一覧の取得に失敗しました。");
      }

      var grades = gradesRes.grades || [];
      var subs = subsRes.submissions || [];

      // CSVから設問別得点を抽出（ヘッダ: 学籍番号,氏名,<qId...>,合計,提出時刻,違反回数,採点状態。実装指示書A-7）
      var qIds = [];
      var perQBySid = {};
      try {
        var csvRows = parseCsv(csvText || "");
        if (csvRows.length > 0) {
          var header = csvRows[0];
          // 先頭2列(学籍番号,氏名)と末尾4列(合計,提出時刻,違反回数,採点状態)を除いた中間列がqId
          if (header.length >= 6) {
            qIds = header.slice(2, header.length - 4);
          }
          for (var r = 1; r < csvRows.length; r++) {
            var cr = csvRows[r];
            if (!cr || cr.length < 2) continue;
            var scores = {};
            for (var qi = 0; qi < qIds.length; qi++) {
              scores[qIds[qi]] = cr[2 + qi];
            }
            perQBySid[cr[0]] = scores;
          }
        }
      } catch (e) {
        // CSV解析失敗時は設問別列なしで表示を継続（合計等はgetGrades由来のため影響しない）
        qIds = [];
        perQBySid = {};
      }

      // sidをキーにマージ（提出はあるが未採点の学生も表に出す）
      var bySid = {};
      subs.forEach(function (s) {
        bySid[s.sid] = {
          sid: s.sid,
          name: s.name || "",
          role: s.role || "student",
          status: s.status || "",
          submittedAt: s.submittedAt || "",
          violations: (s.violations != null ? s.violations : 0),
          totalScore: "",
          gradingState: "未採点"
        };
      });
      grades.forEach(function (g) {
        if (!bySid[g.sid]) {
          bySid[g.sid] = {
            sid: g.sid, name: "", role: g.role || "student",
            status: "", submittedAt: "", violations: 0,
            totalScore: "", gradingState: ""
          };
        }
        bySid[g.sid].totalScore = (g.totalScore != null && g.totalScore !== "") ? g.totalScore : "";
        bySid[g.sid].gradingState = g.gradingState || "未採点";
        if (!bySid[g.sid].role) bySid[g.sid].role = g.role || "student";
      });

      var rows = [];
      for (var sid in bySid) {
        if (!Object.prototype.hasOwnProperty.call(bySid, sid)) continue;
        var row = bySid[sid];
        row.perQ = perQBySid[sid] || {};
        rows.push(row);
      }
      rows.sort(function (a, b) { return String(a.sid).localeCompare(String(b.sid)); });

      lastRows = rows;
      lastQIds = qIds;
      renderTable();
    }).catch(function (err) {
      listHost.innerHTML = "";
      showError((err && err.message) || "データの取得に失敗しました。");
    });
  }

  // gradingState表示ラベル
  function gradingStateBadge(state) {
    if (state === "confirmed") return '<span class="badge review-done">確定</span>';
    if (state === "reviewed") return '<span class="badge review-done">レビュー済</span>';
    if (state === "auto") return '<span class="badge review-needed">自動採点（仮）</span>';
    return '<span class="badge">' + esc(state || "未採点") + "</span>";
  }

  // ===== 集計表の描画（role=teacherは既定除外＋トグル表示。FR-C14） =====
  function renderTable() {
    if (!lastRows) return;
    var includeTest = $("chkIncludeTest").checked;
    var rows = lastRows.filter(function (r) {
      return includeTest || r.role !== "teacher";
    });

    if (rows.length === 0) {
      listHost.innerHTML = '<div class="empty">表示できる成績データがまだありません。</div>';
      return;
    }

    var html = '<table class="datatable"><thead><tr>' +
      "<th>学籍番号</th><th>氏名</th>";
    lastQIds.forEach(function (q) { html += "<th>" + esc(q) + "</th>"; });
    html += "<th>合計</th><th>提出時刻</th><th>違反回数</th><th>採点状態</th></tr></thead><tbody>";

    rows.forEach(function (r) {
      html += "<tr><td>" + esc(r.sid) + "</td><td>" + esc(r.name) +
        (r.role === "teacher" ? ' <span class="badge test">テスト</span>' : "") + "</td>";
      lastQIds.forEach(function (q) {
        var v = r.perQ[q];
        html += "<td>" + esc(v == null ? "" : v) + "</td>";
      });
      html += "<td>" + esc(r.totalScore) + "</td>" +
        "<td>" + esc(fmtDate(r.submittedAt)) + "</td>" +
        "<td>" + esc(r.violations) + "</td>" +
        "<td>" + gradingStateBadge(r.gradingState) + "</td></tr>";
    });
    html += "</tbody></table>";
    listHost.innerHTML = html;
  }

  /* ===== CSVダウンロード（FR-E08） =====
   * admin.exportCsvの応答テキストをそのままBlob化する。サーバー（GradeService.buildCsv）が
   * UTF-8 BOMを付与済みのため、クライアント側でBOMを追加しない（二重BOM防止）。
   * includeTestトグルON時のみ includeTest=1 を付与（GAS側でrole=teacher包含）。 */
  function downloadCsv() {
    clearMsg();
    var includeTest = $("chkIncludeTest").checked;
    var params = { examId: examId };
    if (includeTest) params.includeTest = "1";
    ApiClient.callGetCsv(params).then(function (text) {
      if (!text) throw new Error("CSVの取得に失敗しました。");
      if (text.indexOf('"ok":false') !== -1 && text.charAt(0) === "{") {
        // 認証エラー等でJSONが返った場合
        throw new Error("CSVの取得に失敗しました（認証エラーの可能性があります）。");
      }
      var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "examforge_" + examId + "_grades.csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    }).catch(function (err) {
      showError((err && err.message) || "CSVダウンロードに失敗しました。");
    });
  }

  function init() {
    $("navGrading").setAttribute("href", "gradingView.html?exam=" + encodeURIComponent(examId));
    $("btnRefresh").addEventListener("click", fetchAll);
    $("btnCsv").addEventListener("click", downloadCsv);
    $("chkIncludeTest").addEventListener("change", renderTable); // トグルは再描画のみ（再取得不要）
    $("btnLogout").addEventListener("click", function () {
      ApiClient.logout();
      location.href = "index.html";
    });
    fetchAll();
  }
})();
