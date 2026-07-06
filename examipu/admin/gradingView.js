/* =====================================================================
 *  admin/gradingView.js — SC-15 採点レビュー画面ロジック
 *
 *  実装指示書§7.5 SC-15・UC-05・FR-E05（設問単位横断採点＋学生単位ビュー）・
 *  FR-E06（作図模範解答の並列参考表示）・FR-E09（Drive原本リンク）・
 *  §8 C14（自動採点は選択式のみ確定、記述式/コード/作図は仮採点＋要確認のまま自動確定しない）
 *  を実装根拠とする。
 *
 *  データ根拠（gas/*.gs 実読取りにより確定）:
 *   - admin.listSubmissions 応答 submissions[] の各要素キー:
 *     {examId, sid, name, status, submittedAt, violations,
 *      answerBlobFileId, answerSheetFileId, writeSeq, role}
 *     （gas/Constants.gs SubmissionIndex列定義・gas/SubmitService.gs listSubmissions）
 *     Drive原本fileIdはこの応答にのみ含まれる（admin.getSubmission応答には含まれない）。
 *   - admin.getSubmission 応答: {ok, answer:{texts,codes,choices,draws_png,sid,name,role,...}}
 *     （gas/Code.gs dispatch admin.getSubmission実装、gas/GradeService.gs autoGradeでの参照キーより確認）
 *   - admin.autoGrade 応答: {ok, summary:{examId, gradedCount, needsReviewCount, choiceAutoScoredCount}}
 *     （gas/GradeService.gs autoGrade）。選択式=即時確定(needsReview:false)、
 *     記述式/コード=ルールベース仮採点(needsReview:true)、作図=採点せずneedsReview:trueのみ。
 *   - admin.saveGrades 呼出しパラメータ grades は「sidをキーとするオブジェクト」:
 *     { [sid]: { role, details:{ [qId]:{score,comment,needsReview} }, totalScore, gradingState } }
 *     （gas/GradeService.gs saveGrades: for (var sid in grades) ... 実装のコメント欄に明記された形式）
 *     gradingStateの実値はコード上 "auto" と "reviewed" のみ確認（"confirmed"は不使用）。
 *     教員が保存した時点では "reviewed" を設定する。
 *   - admin.getKey 応答: {ok, key:{examId, entries:{ [qId]:{modelAnswer,rules,correctChoiceIds,
 *     choiceScoring,modelDraw,modelDrawFileId} } } }（gas/GradeService.gs getKey）
 *   - admin.getExam 応答: {ok, exam: EXAM_JSON}（gas/ExamService.gs getExam）
 *
 *  他の admin/*.js とは相互import禁止。本ファイルは apiClient.js / ../exam/drawing.js にのみ依存する。
 * ===================================================================== */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // ===== ログインガード（実装指示書共通要件） =====
  if (!window.ApiClient || !ApiClient.AdminSession.isLoggedIn()) {
    location.href = "index.html";
    return;
  }

  var qs = new URLSearchParams(location.search);
  var EXAM_ID = qs.get("exam") || "";

  // ===== 画面状態 =====
  var state = {
    exam: null,              // EXAM_JSON（admin.getExam応答）
    submissions: [],         // admin.listSubmissions応答（fileId等含む生データ）
    keyEntries: {},          // admin.getKey応答 entries
    answersBySid: {},        // sid -> admin.getSubmission応答のanswer（横断ビューでキャッシュ）
    pendingGrades: {},       // sid -> {role, details:{qId:{score,comment,needsReview}}, totalScore, gradingState}
    currentQid: null,
    currentSid: null,
    view: "byQuestion"       // "byQuestion" | "byStudent"
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[<>&"]/g, function (c) {
      return c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;";
    });
  }

  function showMsg(el, text, cls) {
    el.innerHTML = '<div class="' + (cls || "hint") + '">' + escapeHtml(text) + "</div>";
  }

  // ===== 全設問のフラットリスト（EXAM_JSON sections[].answers[] を横断） =====
  function flatQuestions() {
    var out = [];
    if (!state.exam || !Array.isArray(state.exam.sections)) return out;
    state.exam.sections.forEach(function (sec) {
      (sec.answers || []).forEach(function (a) {
        out.push({ qId: a.id, type: a.type, label: a.label, points: a.points, sectionNumber: sec.number, lang: a.lang });
      });
    });
    return out;
  }

  function findQuestion(qId) {
    var list = flatQuestions();
    for (var i = 0; i < list.length; i++) if (list[i].qId === qId) return list[i];
    return null;
  }

  // ===== pendingGrades 初期化・アクセサ =====
  // 実装指示書§7.6 grades物理スキーマに合わせ、既存の状態（もしあれば）を壊さないよう
  // まず自動採点の結果は saveGrades で読み直せないため（getGradesはサマリのみ返す設計）、
  // 本画面では admin.getSubmission と併せて自動採点直後の一覧再取得のみを頼りに
  // 「未保存の教員入力」を pendingGrades に保持し、保存時に一括送信する。
  function ensurePendingSid(sid, role) {
    if (!state.pendingGrades[sid]) {
      state.pendingGrades[sid] = { role: role || "student", details: {}, totalScore: 0, gradingState: "reviewed" };
    }
    return state.pendingGrades[sid];
  }

  function ensurePendingDetail(sid, qId, role) {
    var g = ensurePendingSid(sid, role);
    if (!g.details[qId]) {
      g.details[qId] = { score: 0, comment: "", needsReview: false };
    }
    return g.details[qId];
  }

  function recomputeTotal(sid) {
    var g = state.pendingGrades[sid];
    if (!g) return;
    var total = 0;
    for (var qId in g.details) {
      if (Object.prototype.hasOwnProperty.call(g.details, qId)) {
        total += Number(g.details[qId].score) || 0;
      }
    }
    g.totalScore = total;
  }

  // ===== Drive原本リンク（FR-E09。教員クリック時のみ遷移。自動読み込みしない） =====
  function driveLink(fileId, label) {
    if (!fileId) return "";
    var url = "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/view";
    return '<a href="' + url + '" target="_blank" rel="noopener">' + escapeHtml(label || "Drive原本を開く") + "</a>";
  }

  function findSubmission(sid) {
    for (var i = 0; i < state.submissions.length; i++) {
      if (state.submissions[i].sid === sid) return state.submissions[i];
    }
    return null;
  }

  // ===== 提出一覧描画 =====
  function renderSubmissionList() {
    var host = $("submissionListHost");
    if (!state.submissions.length) {
      host.innerHTML = '<div class="empty">提出物がありません。</div>';
      return;
    }
    var rows = state.submissions.map(function (s) {
      var testBadge = s.role === "teacher" ? ' <span class="badge test">テスト</span>' : "";
      var statusCls = "status-" + (s.status || "");
      var links = [];
      if (s.answerBlobFileId) links.push(driveLink(s.answerBlobFileId, "提出データ"));
      if (s.answerSheetFileId) links.push(driveLink(s.answerSheetFileId, "回答用紙"));
      return (
        "<tr>" +
        "<td>" + escapeHtml(s.sid) + "</td>" +
        "<td>" + escapeHtml(s.name) + testBadge + "</td>" +
        '<td><span class="badge ' + statusCls + '">' + escapeHtml(s.status || "-") + "</span></td>" +
        "<td>" + escapeHtml(s.violations != null ? s.violations : 0) + "</td>" +
        "<td>" + escapeHtml(s.submittedAt || "-") + "</td>" +
        "<td>" + (links.join(" / ") || "-") + "</td>" +
        "</tr>"
      );
    }).join("");
    host.innerHTML =
      '<table class="datatable"><thead><tr>' +
      "<th>sid</th><th>氏名</th><th>状態</th><th>不正カウント</th><th>提出日時</th><th>Drive原本</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";
  }

  // ===== 設問ピッカー（横断ビュー） =====
  function renderQPicker() {
    var host = $("qPicker");
    var list = flatQuestions();
    if (!list.length) {
      host.innerHTML = '<div class="empty">設問がありません。</div>';
      return;
    }
    host.innerHTML = list.map(function (q) {
      var active = q.qId === state.currentQid ? " active" : "";
      return '<button type="button" class="qpick' + active + '" data-qid="' + escapeHtml(q.qId) + '">' +
        escapeHtml(q.sectionNumber) + " " + escapeHtml(q.label) + " (" + escapeHtml(q.type) + ")</button>";
    }).join("");
    Array.prototype.forEach.call(host.querySelectorAll(".qpick"), function (btn) {
      btn.addEventListener("click", function () {
        state.currentQid = btn.dataset.qid;
        renderQPicker();
        renderByQuestionView();
      });
    });
  }

  // ===== 設問単位ビュー（横断採点。FR-E05） =====
  function renderByQuestionView() {
    var host = $("byQuestionHost");
    var qId = state.currentQid;
    if (!qId) {
      host.innerHTML = '<div class="empty">設問を選択してください。</div>';
      return;
    }
    var q = findQuestion(qId);
    if (!q) {
      host.innerHTML = '<div class="empty">設問情報が見つかりません。</div>';
      return;
    }
    host.innerHTML = '<div class="loading">解答を読み込み中…</div>';

    var students = state.submissions.filter(function (s) { return s.status !== "in_progress"; });

    Promise.all(students.map(function (s) {
      if (state.answersBySid[s.sid]) return Promise.resolve();
      return ApiClient.callGet("admin.getSubmission", { examId: EXAM_ID, sid: s.sid }).then(function (res) {
        if (res && res.ok) state.answersBySid[s.sid] = res.answer || {};
      });
    })).then(function () {
      var blocks = students.map(function (s) {
        return renderAnswerRow(s, q);
      }).join("");
      host.innerHTML = blocks || '<div class="empty">対象の提出物がありません。</div>';
      bindScoreInputs(host);
    });
  }

  // 1学生×1設問の解答表示＋採点欄（横断ビュー・学生別ビュー共通部品）
  function renderAnswerRow(sub, q) {
    var sid = sub.sid;
    var ans = state.answersBySid[sid] || {};
    var detail = (ensurePendingDetail(sid, q.qId, sub.role)).score !== undefined ? state.pendingGrades[sid].details[q.qId] : null;
    var score = detail ? detail.score : 0;
    var comment = detail ? detail.comment : "";
    var needsReview = detail ? !!detail.needsReview : false;

    var reviewBadge = needsReview
      ? '<span class="badge review-needed">要確認</span>'
      : '<span class="badge review-done">確認済</span>';

    var answerHtml = renderAnswerBody(ans, q, sid);
    var testBadge = sub.role === "teacher" ? ' <span class="badge test">テスト</span>' : "";

    return (
      '<div class="gv-row" data-sid="' + escapeHtml(sid) + '" data-qid="' + escapeHtml(q.qId) + '">' +
      '<div class="gv-row-head">' +
      '<span class="name">' + escapeHtml(sub.name) + "（" + escapeHtml(sid) + "）" + testBadge + "</span>" +
      reviewBadge +
      '<span class="badge status-' + escapeHtml(sub.status || "") + '">' + escapeHtml(sub.status || "-") + "</span>" +
      (sub.answerBlobFileId ? driveLink(sub.answerBlobFileId, "Drive原本") : "") +
      "</div>" +
      answerHtml +
      renderScoreBar(sid, q, score, comment, needsReview) +
      "</div>"
    );
  }

  // 設問タイプ別の解答本体表示
  function renderAnswerBody(ans, q, sid) {
    var qId = q.qId;
    if (q.type === "text") {
      var t = (ans.texts && ans.texts[qId]) || "";
      return '<div class="gv-answer">' + (escapeHtml(t) || "（未回答）") + "</div>";
    }
    if (q.type === "code") {
      var c = (ans.codes && ans.codes[qId] && ans.codes[qId].code) || "";
      var lang = (ans.codes && ans.codes[qId] && ans.codes[qId].lang) || q.lang || "";
      return '<div class="hint" style="margin:4px 0 2px">言語: ' + escapeHtml(lang || "-") + '</div><div class="gv-answer code">' +
        (escapeHtml(c) || "（未回答）") + "</div>";
    }
    if (q.type === "choice") {
      var chosen = (ans.choices && ans.choices[qId]) || [];
      // EXAM_JSON側choicesはflatQuestions()には含めていないため、state.examから直接引く
      var secChoices = findChoicesInExam(qId);
      var text = chosen.map(function (cid) {
        var label = secChoices[cid] || cid;
        return escapeHtml(cid) + "：" + escapeHtml(label);
      }).join(" / ");
      return '<div class="gv-answer">' + (text || "（未回答）") + "</div>";
    }
    if (q.type === "draw") {
      var modelDraw = (state.keyEntries[qId] && state.keyEntries[qId].modelDraw) || null;
      var html = '<div class="gv-drawpair">';
      // 学生解答PNG（draws_png）は学生クライアント由来の値のため、innerHTML文字列連結で直挿ししない
      // （属性脱出によるStored XSS→ADMIN_TOKEN窃取の防止。FR-F02）。
      // ここではプレースホルダのみ描画し、bindScoreInputs()内でDOM API（img.src代入）により
      // "data:image/"で始まる場合に限り安全にマウントする（decrypt.htmlの表示方式と同一）。
      html += '<div><div class="cap">学生の解答</div>' +
        '<div class="gv-drawimg-host" data-draw-png="1" data-sid="' + escapeHtml(sid) + '" data-qid="' + escapeHtml(qId) + '"></div></div>';
      html += '<div><div class="cap">模範図（参考表示）</div>';
      if (modelDraw && modelDraw.length) {
        var hostId = "model_" + qId + "_" + Math.random().toString(36).slice(2);
        html += '<div class="gv-modeldraw-host" id="' + hostId + '" data-model-draw="1" data-qid="' + escapeHtml(qId) + '"></div>';
      } else {
        html += '<div class="empty">模範図の登録がありません</div>';
      }
      html += "</div></div>";
      return html;
    }
    return '<div class="gv-answer">（表示未対応の設問タイプ）</div>';
  }

  function findChoicesInExam(qId) {
    var map = {};
    if (!state.exam) return map;
    state.exam.sections.forEach(function (sec) {
      (sec.answers || []).forEach(function (a) {
        if (a.id === qId && Array.isArray(a.choices)) {
          a.choices.forEach(function (c) { map[c.id] = c.text; });
        }
      });
    });
    return map;
  }

  // 得点・コメント・要確認チェックの入力欄
  function renderScoreBar(sid, q, score, comment, needsReview) {
    return (
      '<div class="gv-scorebar">' +
      '<label class="field" style="margin:0"><span>得点（満点' + escapeHtml(q.points) + '点）</span>' +
      '<input type="number" class="gv-score" min="0" max="' + escapeHtml(q.points) + '" step="1" value="' + escapeHtml(score) + '"></label>' +
      '<input type="text" class="gv-comment" placeholder="コメント（任意）" value="' + escapeHtml(comment) + '">' +
      '<label class="chk"><input type="checkbox" class="gv-needsreview"' + (needsReview ? " checked" : "") + '>要確認のままにする</label>' +
      "</div>"
    );
  }

  // 得点欄・コメント欄・要確認チェックの変更をpendingGradesへ反映
  function bindScoreInputs(host) {
    Array.prototype.forEach.call(host.querySelectorAll(".gv-row"), function (row) {
      var sid = row.dataset.sid;
      var qId = row.dataset.qid;
      var sub = findSubmission(sid);
      var scoreInput = row.querySelector(".gv-score");
      var commentInput = row.querySelector(".gv-comment");
      var reviewInput = row.querySelector(".gv-needsreview");

      function sync() {
        var d = ensurePendingDetail(sid, qId, sub && sub.role);
        d.score = Number(scoreInput.value) || 0;
        d.comment = commentInput.value;
        d.needsReview = !!reviewInput.checked;
        recomputeTotal(sid);
      }
      scoreInput.addEventListener("input", sync);
      commentInput.addEventListener("input", sync);
      reviewInput.addEventListener("change", sync);
    });

    // 学生解答PNG（draws_png）の遅延マウント。信頼できない学生由来データのため、
    // innerHTMLではなくDOM API（createElement + src代入）で挿入し、
    // "data:image/" で始まるdataURLの場合のみ表示する（Stored XSS防止・FR-F02）。
    Array.prototype.forEach.call(host.querySelectorAll('[data-draw-png="1"]'), function (el) {
      if (el.dataset.mounted === "1") return; // 二重マウント防止
      el.dataset.mounted = "1";
      var sid = el.dataset.sid;
      var qId = el.dataset.qid;
      var ans = state.answersBySid[sid] || {};
      var png = (ans.draws_png && ans.draws_png[qId]) || "";
      if (typeof png === "string" && png.indexOf("data:image/") === 0) {
        var img = document.createElement("img");
        img.src = png; // DOM API代入のため属性脱出は不可能
        img.alt = "学生の作図解答";
        el.appendChild(img);
      } else {
        var emptyDiv = document.createElement("div");
        emptyDiv.className = "empty";
        emptyDiv.textContent = "未回答";
        el.appendChild(emptyDiv);
      }
    });

    // draw模範図の遅延マウント（DrawPadはDOM追加後にresizeするためここで生成）
    Array.prototype.forEach.call(host.querySelectorAll('[data-model-draw="1"]'), function (el) {
      var qId = el.dataset.qid;
      var modelDraw = (state.keyEntries[qId] && state.keyEntries[qId].modelDraw) || [];
      try {
        // 実装指示書 FR-E06: 模範図はShape配列でありPNGではないためDrawPadをテンプレート表示に流用する。
        // DrawPadに読み取り専用モードは無いため、pointer-events:none（CSS）で編集操作を無効化し
        // 参考表示専用として扱う（ツールバーは残るが操作不能）。
        new window.DrawPad(el, { template: modelDraw, height: 260 });
      } catch (e) { /* 描画失敗時は空表示のまま無視 */ }
    });
  }

  // ===== 学生単位ビュー =====
  function renderStudentPicker() {
    var sel = $("studentPicker");
    sel.innerHTML = '<option value="">-- 学生を選択 --</option>' + state.submissions.map(function (s) {
      var sel2 = s.sid === state.currentSid ? " selected" : "";
      return '<option value="' + escapeHtml(s.sid) + '"' + sel2 + ">" + escapeHtml(s.name) + "（" + escapeHtml(s.sid) + "）" +
        (s.role === "teacher" ? "［テスト］" : "") + "</option>";
    }).join("");
  }

  function renderByStudentView() {
    var host = $("byStudentHost");
    var sid = state.currentSid;
    if (!sid) {
      host.innerHTML = '<div class="empty">学生を選択してください。</div>';
      return;
    }
    var sub = findSubmission(sid);
    if (!sub) {
      host.innerHTML = '<div class="empty">提出情報が見つかりません。</div>';
      return;
    }
    host.innerHTML = '<div class="loading">解答を読み込み中…</div>';

    var loadPromise = state.answersBySid[sid]
      ? Promise.resolve()
      : ApiClient.callGet("admin.getSubmission", { examId: EXAM_ID, sid: sid }).then(function (res) {
          if (res && res.ok) state.answersBySid[sid] = res.answer || {};
        });

    loadPromise.then(function () {
      var list = flatQuestions();
      var blocks = list.map(function (q) {
        var rowHtml = renderAnswerRow(sub, q);
        return '<div class="gv-student-block"><div class="gv-qlabel">' + escapeHtml(q.sectionNumber) + " " +
          escapeHtml(q.label) + "</div>" + stripOuterRowWrapper(rowHtml) + "</div>";
      }).join("");
      host.innerHTML = blocks || '<div class="empty">設問がありません。</div>';
      bindScoreInputs(host);
    });
  }

  // renderAnswerRowは.gv-row枠を含むため学生別ビューでもそのまま利用する（部品共通化）。
  // ラップ剥がしは不要になったため、そのまま返すヘルパーとして維持（可読性のため関数は残す）。
  function stripOuterRowWrapper(html) { return html; }

  // ===== タブ切替 =====
  function switchView(view) {
    state.view = view;
    $("tabByQuestion").classList.toggle("active", view === "byQuestion");
    $("tabByStudent").classList.toggle("active", view === "byStudent");
    $("viewByQuestion").style.display = view === "byQuestion" ? "" : "none";
    $("viewByStudent").style.display = view === "byStudent" ? "" : "none";
  }

  // ===== 保存 =====
  function saveGrades() {
    var grades = {};
    for (var sid in state.pendingGrades) {
      if (!Object.prototype.hasOwnProperty.call(state.pendingGrades, sid)) continue;
      var g = state.pendingGrades[sid];
      recomputeTotal(sid);
      // 実装指示書§7.6: gradingStateは教員が保存した時点で"reviewed"に更新する
      grades[sid] = {
        role: g.role || "student",
        details: g.details,
        totalScore: g.totalScore,
        gradingState: "reviewed"
      };
    }
    if (!Object.keys(grades).length) {
      showMsg($("saveGradesMsg"), "採点入力がありません。得点を入力してから保存してください。", "warn");
      return;
    }
    $("btnSaveGrades").disabled = true;
    showMsg($("saveGradesMsg"), "保存中…");
    ApiClient.callPost("admin.saveGrades", { examId: EXAM_ID, grades: grades }).then(function (res) {
      $("btnSaveGrades").disabled = false;
      if (res && res.ok) {
        showMsg($("saveGradesMsg"), "採点結果を保存しました。");
      } else {
        showMsg($("saveGradesMsg"), "保存に失敗しました：" + ((res && res.error) || "不明なエラー"), "error-box");
      }
    }).catch(function (err) {
      $("btnSaveGrades").disabled = false;
      showMsg($("saveGradesMsg"), "保存に失敗しました：" + (err && err.message ? err.message : err), "error-box");
    });
  }

  // ===== 自動採点実行 =====
  function runAutoGrade() {
    $("btnAutoGrade").disabled = true;
    showMsg($("autoGradeMsg"), "自動採点を実行しています…");
    ApiClient.callPost("admin.autoGrade", { examId: EXAM_ID }).then(function (res) {
      $("btnAutoGrade").disabled = false;
      if (res && res.ok) {
        var s = res.summary || {};
        showMsg(
          $("autoGradeMsg"),
          "自動採点が完了しました。採点済み " + (s.gradedCount != null ? s.gradedCount : "-") +
          "件／要確認 " + (s.needsReviewCount != null ? s.needsReviewCount : "-") +
          "件／選択式自動確定 " + (s.choiceAutoScoredCount != null ? s.choiceAutoScoredCount : "-") + "件。"
        );
        // 自動採点後、一覧・レビュー内容を再取得（設計要求）。キャッシュとpendingGradesをクリアして最新化
        state.answersBySid = {};
        state.pendingGrades = {};
        loadAll();
      } else {
        showMsg($("autoGradeMsg"), "自動採点に失敗しました：" + ((res && res.error) || "不明なエラー"), "error-box");
      }
    }).catch(function (err) {
      $("btnAutoGrade").disabled = false;
      showMsg($("autoGradeMsg"), "自動採点に失敗しました：" + (err && err.message ? err.message : err), "error-box");
    });
  }

  // ===== 初期ロード =====
  function loadAll() {
    if (!EXAM_ID) {
      showMsg($("submissionListHost"), "examId がURLに指定されていません（?exam=xxxx）。", "error-box");
      return;
    }
    // 成績集計（reportView.html）への導線にexamIdを引き回す（reportView.jsのnavGradingと同パターン）
    $("navSummary").setAttribute("href", "reportView.html?exam=" + encodeURIComponent(EXAM_ID));
    Promise.all([
      ApiClient.callGet("admin.getExam", { examId: EXAM_ID }),
      ApiClient.callGet("admin.listSubmissions", { examId: EXAM_ID }),
      ApiClient.callGet("admin.getKey", { examId: EXAM_ID })
    ]).then(function (results) {
      var examRes = results[0], subRes = results[1], keyRes = results[2];
      if (examRes && examRes.ok) {
        state.exam = examRes.exam;
        $("examTitleLabel").textContent = state.exam && state.exam.title ? "（" + state.exam.title + "）" : "";
      }
      if (subRes && subRes.ok) {
        state.submissions = subRes.submissions || [];
      }
      if (keyRes && keyRes.ok) {
        state.keyEntries = (keyRes.key && keyRes.key.entries) || {};
      }
      renderSubmissionList();
      renderQPicker();
      renderStudentPicker();
      if (!state.currentQid) {
        var list = flatQuestions();
        if (list.length) state.currentQid = list[0].qId;
      }
      renderQPicker();
      if (state.view === "byQuestion") renderByQuestionView(); else renderByStudentView();
    }).catch(function (err) {
      showMsg($("submissionListHost"), "読み込みに失敗しました：" + (err && err.message ? err.message : err), "error-box");
    });
  }

  // ===== イベント結線 =====
  $("btnLogout").addEventListener("click", function () {
    ApiClient.logout();
    location.href = "index.html";
  });
  $("btnAutoGrade").addEventListener("click", runAutoGrade);
  $("btnReload").addEventListener("click", function () {
    state.answersBySid = {};
    loadAll();
  });
  $("btnSaveGrades").addEventListener("click", saveGrades);
  $("tabByQuestion").addEventListener("click", function () { switchView("byQuestion"); renderByQuestionView(); });
  $("tabByStudent").addEventListener("click", function () { switchView("byStudent"); renderByStudentView(); });
  $("studentPicker").addEventListener("change", function (e) {
    state.currentSid = e.target.value || null;
    renderByStudentView();
  });

  loadAll();
})();
