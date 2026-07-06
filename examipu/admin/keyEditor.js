/* =====================================================================
 *  admin/keyEditor.js — SC-13 正解データエディタ画面ロジック
 *
 *  実装指示書§7.5 EXAM_JSONスキーマ・§7.6 key.jsonスキーマを実装根拠とする。
 *  未入力判定ロジックは GradeService.gs の countUnfilled_ と完全一致させる。
 *  ADMIN_TOKENはハードコードしない（apiClient.js経由のみ）。
 *  相互import禁止のため、本ファイルは apiClient.js / ../exam/drawing.js のみに依存する
 *  （dashboard.js / examEditor.js 等の他画面スクリプトは参照しない）。
 * ===================================================================== */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var msgArea = $("msgArea");
  var bodyHost = $("bodyHost");
  var saveCard = $("saveCard");
  var saveMsg = $("saveMsg");
  var headNav = $("headNav");

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
  function showInfo(container, text) {
    container.innerHTML = '<div class="hint"></div>';
    container.firstChild.textContent = text;
  }
  function clearMsg(container) {
    container.innerHTML = "";
  }

  // ===== URLクエリから examId を取得 =====
  var examId = new URLSearchParams(location.search).get("exam");

  if (!examId) {
    showError("URLに ?exam=<examId> が指定されていません。試験一覧から操作してください。");
    return; // 以降の処理は行わない
  }

  // ===== 共通ヘッダーnavにexamId付きリンクを追加 =====
  (function buildHeadNav() {
    var q = "?exam=" + encodeURIComponent(examId);
    var links = [
      { label: "試験エディタ", href: "examEditor.html" + q },
      { label: "モニタ", href: "monitorView.html" + q },
      { label: "採点", href: "gradingView.html" + q },
      { label: "成績", href: "reportView.html" + q }
    ];
    links.forEach(function (l) {
      var a = document.createElement("a");
      a.href = l.href;
      a.textContent = l.label;
      headNav.appendChild(a);
    });
  })();

  $("btnLogout").addEventListener("click", function () {
    ApiClient.logout();
    location.href = "index.html";
  });

  // ===== 未入力判定ロジック（GradeService.gs の countUnfilled_ と完全一致） =====
  // exam: EXAM_JSON本体, key: {examId, entries}
  // 戻り値: 未入力の qId 配列
  function unfilledQuestions(exam, key) {
    var entries = (key && key.entries) || {};
    var result = [];
    (exam.sections || []).forEach(function (section) {
      (section.answers || []).forEach(function (answer) {
        var qId = answer.id;
        var entry = entries[qId];
        var isUnfilled;
        if (!entry) {
          isUnfilled = true;
        } else if (answer.type === "choice") {
          isUnfilled = !entry.correctChoiceIds || entry.correctChoiceIds.length === 0;
        } else if (answer.type === "text" || answer.type === "code") {
          var noModel = !entry.modelAnswer;
          var noRules = !entry.rules || entry.rules.length === 0;
          isUnfilled = noModel && noRules;
        } else if (answer.type === "draw") {
          isUnfilled = !entry.modelDraw && !entry.modelDrawFileId;
        } else {
          isUnfilled = false;
        }
        if (isUnfilled) result.push(qId);
      });
    });
    return result;
  }

  // ===== DrawPadインスタンス保持（qId -> DrawPad） =====
  var drawPads = {};

  // ===== ルール行エディタ（text/code用）状態はDOMから都度読み取る =====

  function makeRuleRow(rule) {
    rule = rule || { kind: "keyword_and", value: "", points: 0 };
    var row = document.createElement("div");
    row.className = "card-row rule-row";
    row.style.alignItems = "center";

    var selKind = document.createElement("select");
    var RULE_KIND_LABELS = {
      keyword_and: "keyword_and（すべてのキーワードを含む。カンマ区切りで複数指定）",
      keyword_or: "keyword_or（いずれかのキーワードを含む。カンマ区切りで複数指定）",
      regex: "regex（正規表現に一致する）",
      exact: "exact（解答が値と完全一致する）"
    };
    ["keyword_and", "keyword_or", "regex", "exact"].forEach(function (k) {
      var opt = document.createElement("option");
      opt.value = k;
      opt.textContent = RULE_KIND_LABELS[k];
      if (rule.kind === k) opt.selected = true;
      selKind.appendChild(opt);
    });
    selKind.className = "rule-kind";

    var inpValue = document.createElement("input");
    inpValue.type = "text";
    inpValue.className = "rule-value";
    inpValue.placeholder = "値（キーワード・正規表現など）";
    inpValue.value = rule.value || "";
    inpValue.style.flex = "1";

    var inpPoints = document.createElement("input");
    inpPoints.type = "number";
    inpPoints.className = "rule-points";
    inpPoints.placeholder = "配点";
    inpPoints.step = "1";
    inpPoints.value = rule.points != null ? rule.points : 0;
    inpPoints.style.width = "90px";

    var btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "secondary";
    btnDel.textContent = "削除";
    btnDel.addEventListener("click", function () {
      row.parentNode.removeChild(row);
    });

    row.appendChild(selKind);
    row.appendChild(inpValue);
    row.appendChild(inpPoints);
    row.appendChild(btnDel);
    return row;
  }

  function readRulesFromHost(rulesHost) {
    var rules = [];
    rulesHost.querySelectorAll(".rule-row").forEach(function (row) {
      var kind = row.querySelector(".rule-kind").value;
      var value = row.querySelector(".rule-value").value;
      var points = Number(row.querySelector(".rule-points").value) || 0;
      rules.push({ kind: kind, value: value, points: points });
    });
    return rules;
  }

  // ===== 設問1件分のUIを構築 =====
  // 戻り値: { qId, type, getEntry: function() -> entry }
  function buildAnswerBlock(answer, entry) {
    entry = entry || {};
    var block = document.createElement("div");
    block.className = "answer-block";

    var head = document.createElement("div");
    head.className = "ab-head";
    var labelSpan = document.createElement("span");
    labelSpan.textContent = (answer.label || "") + "（" + answer.id + " / " + answer.type + " / " + answer.points + "点）";
    head.appendChild(labelSpan);
    var badge = document.createElement("span");
    badge.className = "badge review-needed";
    badge.id = "badge_" + answer.id;
    head.appendChild(badge);
    block.appendChild(head);

    var getEntry;

    if (answer.type === "choice") {
      var correctIds = entry.correctChoiceIds || [];
      var checkboxMap = {};
      var choicesHost = document.createElement("div");
      (answer.choices || []).forEach(function (choice) {
        var row = document.createElement("label");
        row.className = "field";
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "6px";

        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = choice.id;
        cb.checked = correctIds.indexOf(choice.id) !== -1;
        checkboxMap[choice.id] = cb;

        var span = document.createElement("span");
        span.style.fontWeight = "400";
        span.textContent = choice.text || choice.id;

        row.appendChild(cb);
        row.appendChild(span);
        choicesHost.appendChild(row);
      });
      block.appendChild(choicesHost);

      var scoringLabel = document.createElement("label");
      scoringLabel.className = "field";
      var scoringSpan = document.createElement("span");
      scoringSpan.textContent = "採点方式（choiceScoring）";
      var selScoring = document.createElement("select");
      var CHOICE_SCORING_LABELS = {
        exact: "exact（完全一致のみ満点。1つでも過不足があれば0点）",
        proportional: "proportional（正解数で按分。誤答は減点、下限0点）"
      };
      ["exact", "proportional"].forEach(function (v) {
        var opt = document.createElement("option");
        opt.value = v;
        opt.textContent = CHOICE_SCORING_LABELS[v];
        if ((entry.choiceScoring || "exact") === v) opt.selected = true;
        selScoring.appendChild(opt);
      });
      scoringLabel.appendChild(scoringSpan);
      scoringLabel.appendChild(selScoring);
      block.appendChild(scoringLabel);

      getEntry = function () {
        var ids = [];
        Object.keys(checkboxMap).forEach(function (cid) {
          if (checkboxMap[cid].checked) ids.push(cid);
        });
        return {
          type: "choice",
          correctChoiceIds: ids,
          choiceScoring: selScoring.value
        };
      };

    } else if (answer.type === "text" || answer.type === "code") {
      var modelLabel = document.createElement("label");
      modelLabel.className = "field";
      var modelSpan = document.createElement("span");
      modelSpan.textContent = "模範解答（modelAnswer）";
      var taModel = document.createElement("textarea");
      taModel.rows = answer.type === "code" ? 6 : 3;
      taModel.value = entry.modelAnswer || "";
      modelLabel.appendChild(modelSpan);
      modelLabel.appendChild(taModel);
      block.appendChild(modelLabel);

      var rulesHost = document.createElement("div");
      rulesHost.className = "rules-host";
      (entry.rules || []).forEach(function (rule) {
        rulesHost.appendChild(makeRuleRow(rule));
      });
      block.appendChild(rulesHost);

      var btnAddRule = document.createElement("button");
      btnAddRule.type = "button";
      btnAddRule.className = "secondary";
      btnAddRule.textContent = "＋ 採点ルールを追加";
      btnAddRule.addEventListener("click", function () {
        rulesHost.appendChild(makeRuleRow());
      });
      block.appendChild(btnAddRule);

      getEntry = function () {
        return {
          type: answer.type,
          modelAnswer: taModel.value,
          rules: readRulesFromHost(rulesHost)
        };
      };

    } else if (answer.type === "draw") {
      var padHost = document.createElement("div");
      padHost.className = "drawpad-host";
      block.appendChild(padHost);

      var pad = new window.DrawPad(padHost, {
        height: answer.height || 420,
        template: entry.modelDraw || []
      });
      drawPads[answer.id] = pad;

      var modelDrawFileId = entry.modelDrawFileId || null;

      getEntry = function () {
        return {
          type: "draw",
          modelDraw: pad.toJSON(),
          modelDrawFileId: modelDrawFileId
        };
      };

    } else {
      var unknown = document.createElement("div");
      unknown.className = "warn";
      unknown.textContent = "未対応の設問タイプです（" + answer.type + "）。";
      block.appendChild(unknown);
      getEntry = function () { return entry; };
    }

    return { qId: answer.id, block: block, getEntry: getEntry };
  }

  // ===== 保存前・初期表示時の未入力バッジ更新 =====
  var answerHandles = []; // { qId, getEntry }

  function refreshBadges(exam) {
    var entries = {};
    answerHandles.forEach(function (h) {
      entries[h.qId] = h.getEntry();
    });
    var unfilled = unfilledQuestions(exam, { examId: examId, entries: entries });
    var unfilledSet = {};
    unfilled.forEach(function (qId) { unfilledSet[qId] = true; });

    answerHandles.forEach(function (h) {
      var badge = $("badge_" + h.qId);
      if (!badge) return;
      if (unfilledSet[h.qId]) {
        badge.className = "badge review-needed";
        badge.textContent = "要入力";
      } else {
        badge.className = "badge review-done";
        badge.textContent = "入力済み";
      }
    });
    return entries;
  }

  // ===== 画面構築 =====
  function renderBody(exam, key) {
    bodyHost.innerHTML = "";
    answerHandles = [];
    drawPads = {};

    var titleEl = $("pageTitle");
    titleEl.textContent = "正解データエディタ（" + (exam.title || exam.examId) + "）";

    (exam.sections || []).forEach(function (section) {
      var sb = document.createElement("div");
      sb.className = "section-block";

      var sbHead = document.createElement("div");
      sbHead.className = "sb-head";
      var sbTitle = document.createElement("div");
      sbTitle.className = "sb-title";
      sbTitle.textContent = (section.number || "") + "（" + (section.points || 0) + "点）";
      sbHead.appendChild(sbTitle);
      sb.appendChild(sbHead);

      if (section.instruction) {
        var instr = document.createElement("div");
        instr.className = "hint";
        instr.textContent = section.instruction;
        sb.appendChild(instr);
      }

      (section.answers || []).forEach(function (answer) {
        var entry = (key.entries || {})[answer.id];
        var handle = buildAnswerBlock(answer, entry);
        sb.appendChild(handle.block);
        answerHandles.push(handle);
      });

      bodyHost.appendChild(sb);
    });

    refreshBadges(exam);
    saveCard.style.display = "";

    $("btnSave").onclick = function () {
      saveKey(exam);
    };
  }

  // ===== 保存 =====
  function saveKey(exam) {
    clearMsg(saveMsg);
    var entries = refreshBadges(exam);
    var key = { examId: examId, entries: entries };

    var btn = $("btnSave");
    btn.disabled = true;
    showInfo(saveMsg, "保存中です…");

    ApiClient.callPost("admin.saveKey", { examId: examId, key: key }).then(function (res) {
      btn.disabled = false;
      if (!res || res.ok !== true) {
        throw new Error((res && res.error) || "保存に失敗しました。");
      }
      showInfo(saveMsg, "保存しました。");
    }).catch(function (err) {
      btn.disabled = false;
      saveMsg.innerHTML = '<div class="error-box"></div>';
      saveMsg.firstChild.textContent = (err && err.message) || "保存に失敗しました。";
    });
  }

  // ===== 初期読み込み: exam本体とkeyを並行取得 =====
  bodyHost.innerHTML = '<div class="loading">読み込み中です…</div>';

  Promise.all([
    ApiClient.callGet("admin.getExam", { examId: examId }),
    ApiClient.callGet("admin.getKey", { examId: examId })
  ]).then(function (results) {
    var examRes = results[0];
    var keyRes = results[1];

    if (!examRes || examRes.ok !== true) {
      throw new Error((examRes && examRes.error) || "試験データの取得に失敗しました。");
    }
    if (!keyRes || keyRes.ok !== true) {
      throw new Error((keyRes && keyRes.error) || "正解データの取得に失敗しました。");
    }

    var exam = examRes.exam;
    var key = keyRes.key || { examId: examId, entries: {} };
    if (!key.entries) key.entries = {};

    renderBody(exam, key);
  }).catch(function (err) {
    bodyHost.innerHTML = "";
    showError((err && err.message) || "データの読み込みに失敗しました。");
  });
})();
