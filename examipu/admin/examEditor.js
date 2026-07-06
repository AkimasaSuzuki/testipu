/* =====================================================================
 *  admin/examEditor.js — SC-12 試験エディタ画面ロジック
 *
 *  実装指示書§4 P3・UC-01・FR-B01〜B08、内部設計書 画面一覧SC-12・§5.3 FSM(state遷移)
 *  ・§7.5 EXAM_JSONスキーマ・§8 PreviewRenderer を実装根拠とする。
 *
 *  責務:
 *   - EXAM_JSON（examId/title/durationMin/notes/maxViolations/sections[]）の編集
 *   - 配点自動集計（computeTotalPoints）と満点不一致の警告表示（保存はブロックしない。E-11/FR-B04）
 *   - プレビュー（exam.jsのレンダラを複製したPreviewRendererでiframe描画。FR-B05）
 *   - JSONエクスポート/インポート（FR-B06）
 *   - 公開設定（open/close/state）の保存。published→draftは受験開始者ゼロの場合のみ許可（内部設計書§5.3）
 *   - drawタイプ設問のテンプレート編集（DrawPad。FR-B08）
 *
 *  相互import禁止（実装指示書§9）。本ファイルは apiClient.js の ApiClient と
 *  ../exam/drawing.js の DrawPad にのみ依存する。ADMIN_TOKENはハードコードしない。
 * ===================================================================== */
(function () {
  "use strict";

  // ===== 小ヘルパー =====
  var $ = function (id) { return document.getElementById(id); };
  var qs = function (sel, p) { return (p || document).querySelector(sel); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  function uid_(prefix) {
    // qId簡易自動生成（実装指示書に明記なし。UUID相当の一意文字列で代用）
    return (prefix || "q") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ===== ログインチェック（未ログインならindex.htmlへ） =====
  if (!window.ApiClient || !ApiClient.AdminSession.isLoggedIn()) {
    location.href = "index.html";
    return;
  }

  $("btnLogout").addEventListener("click", function () {
    ApiClient.logout();
    location.href = "index.html";
  });

  // ===== URLクエリ =====
  function getQueryParam_(name) {
    var m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
  }
  var currentExamId = getQueryParam_("exam") || "";

  // ===== EXAM_JSON 編集モデル（実装指示書§7.5スキーマ準拠） =====
  // code設問のlang選択肢。将来の言語追加はこの配列を増やすだけで対応できる構造（実装指示書A-6）。
  var CODE_LANGS = [
    { value: "python", label: "Python" },
    { value: "c", label: "C" }
  ];

  var exam = {
    examId: "",
    title: "",
    durationMin: 90,
    notes: [],
    maxViolations: 3,
    sections: []
  };

  // 公開設定（Examsシート由来。EXAM_JSON本体には含めない。admin.schedule専用）
  var scheduleState = { open: "", close: "", state: "draft" };

  // drawタイプ設問の DrawPad インスタンス（qId -> DrawPad）。保存時にtoJSON()して回収する。
  var drawpads = {};

  // ===== 画面初期化 =====
  function init() {
    if (currentExamId) {
      loadExam(currentExamId);
    } else {
      $("pageTitle").textContent = "試験エディタ（新規作成）";
      renderAll();
    }
    bindStaticEvents();
  }

  function loadExam(examId) {
    $("pageTitle").textContent = "試験エディタ（読込中…）";
    ApiClient.callGet("admin.getExam", { examId: examId }).then(function (res) {
      if (!res || res.ok !== true) {
        showSaveMsg("試験の取得に失敗しました。examId=" + esc(examId), true);
        return;
      }
      applyExamJson(res.exam || {});
      $("pageTitle").textContent = "試験エディタ（編集中： " + esc(exam.title || examId) + "）";
      renderAll();
      // 公開設定情報はadmin.getExamの応答に含まれないため、listExamsから該当行を拾う
      return ApiClient.callGet("admin.listExams", {});
    }).then(function (listRes) {
      if (!listRes || listRes.ok !== true) return;
      var row = (listRes.exams || []).filter(function (r) { return r.examId === currentExamId; })[0];
      if (row) {
        scheduleState.open = row.openAt || "";
        scheduleState.close = row.closeAt || "";
        scheduleState.state = row.state || "draft";
        applyScheduleToForm();
      }
    }).catch(function (err) {
      showSaveMsg("通信エラー: " + esc((err && err.message) || err), true);
    });
  }

  function applyExamJson(json) {
    exam.examId = json.examId || "";
    exam.title = json.title || "";
    exam.durationMin = json.durationMin != null ? json.durationMin : 90;
    exam.notes = Array.isArray(json.notes) ? json.notes.slice() : [];
    exam.maxViolations = json.maxViolations != null ? json.maxViolations : 3;
    exam.sections = Array.isArray(json.sections) ? json.sections : [];
    drawpads = {}; // 差し替え時はDrawPadインスタンスを作り直す
  }

  function applyScheduleToForm() {
    $("fOpen").value = isoToLocalInput_(scheduleState.open);
    $("fClose").value = isoToLocalInput_(scheduleState.close);
    $("fState").value = scheduleState.state || "draft";
  }

  // datetime-local入力値 <-> ISO8601 変換
  function isoToLocalInput_(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" +
      pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function localInputToIso_(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d.getTime())) return "";
    return d.toISOString();
  }

  // ===== フォーム <-> モデル 同期 =====
  function readFormIntoModel() {
    exam.title = $("fTitle").value.trim();
    exam.durationMin = parseInt($("fDuration").value, 10) || 0;
    exam.maxViolations = parseInt($("fMaxViolations").value, 10) || 0;
    exam.notes = $("fNotes").value.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
  }

  function writeModelIntoForm() {
    $("fExamId").value = exam.examId || "（新規作成後に採番されます）";
    $("fTitle").value = exam.title || "";
    $("fDuration").value = exam.durationMin || 90;
    $("fMaxViolations").value = (exam.maxViolations != null ? exam.maxViolations : 3);
    $("fNotes").value = (exam.notes || []).join("\n");
  }

  // ===== 配点自動集計（FR-B04・E-11） =====
  function computeTotalPoints() {
    var sumAnswers = 0;
    var sumSections = 0;
    (exam.sections || []).forEach(function (sec) {
      sumSections += Number(sec.points) || 0;
      (sec.answers || []).forEach(function (a) {
        sumAnswers += Number(a.points) || 0;
      });
    });
    return { sumAnswers: sumAnswers, sumSections: sumSections };
  }

  function refreshPointsSummary() {
    var totals = computeTotalPoints();
    $("sumAnswers").textContent = String(totals.sumAnswers);
    $("sumSections").textContent = String(totals.sumSections);
    var warnBox = $("pointsWarn");
    if (totals.sumAnswers !== totals.sumSections) {
      warnBox.innerHTML = '<div class="warn">設問のpoints合計（' + totals.sumAnswers +
        '点）と大問のpoints合計（' + totals.sumSections + '点）が一致していません。' +
        '保存は可能ですが、配点の見直しをおすすめします。</div>';
    } else {
      warnBox.innerHTML = "";
    }
  }

  // qId一意性チェック（UIレベル。実装指示書に方式明記なし・自己判断で補完）
  function checkDuplicateIds_() {
    var seen = {};
    var dups = {};
    (exam.sections || []).forEach(function (sec) {
      (sec.answers || []).forEach(function (a) {
        var id = a.id || "";
        if (!id) return;
        if (seen[id]) dups[id] = true;
        seen[id] = true;
      });
    });
    return Object.keys(dups);
  }

  // ===== 描画: 大問一覧 =====
  function renderAll() {
    writeModelIntoForm();
    applyScheduleToForm();
    renderSectionsEditor();
    refreshPointsSummary();
  }

  function renderSectionsEditor() {
    var host = $("sectionsHost");
    host.innerHTML = "";
    (exam.sections || []).forEach(function (sec, idx) {
      host.appendChild(buildSectionBlock(sec, idx));
    });
    if (!exam.sections.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "大問がまだありません。「＋ 大問を追加」から作成してください。";
      host.appendChild(empty);
    }
  }

  function buildSectionBlock(sec, idx) {
    var block = document.createElement("div");
    block.className = "section-block";

    // ---- ヘッダ（number・移動・削除） ----
    var head = document.createElement("div");
    head.className = "sb-head";
    var title = document.createElement("div");
    title.className = "sb-title";
    title.textContent = "大問 " + (idx + 1) + "（" + (sec.number || "") + "）";
    head.appendChild(title);

    var btnUp = document.createElement("button");
    btnUp.type = "button"; btnUp.className = "secondary"; btnUp.textContent = "↑";
    btnUp.disabled = idx === 0;
    btnUp.addEventListener("click", function () { moveSection(idx, -1); });

    var btnDown = document.createElement("button");
    btnDown.type = "button"; btnDown.className = "secondary"; btnDown.textContent = "↓";
    btnDown.disabled = idx === exam.sections.length - 1;
    btnDown.addEventListener("click", function () { moveSection(idx, 1); });

    var btnDel = document.createElement("button");
    btnDel.type = "button"; btnDel.className = "danger"; btnDel.textContent = "この大問を削除";
    btnDel.addEventListener("click", function () {
      if (confirm("大問「" + (sec.number || idx + 1) + "」を削除しますか？含まれる設問もすべて削除されます。")) {
        exam.sections.splice(idx, 1);
        renderAll();
      }
    });

    head.appendChild(btnUp);
    head.appendChild(btnDown);
    head.appendChild(btnDel);
    block.appendChild(head);

    // ---- 基本項目 ----
    var grid = document.createElement("div");
    grid.className = "grid2";

    grid.appendChild(fieldInput_("大問番号（number）", sec.number || "", function (v) {
      sec.number = v; title.textContent = "大問 " + (idx + 1) + "（" + v + "）";
    }));
    grid.appendChild(fieldNumber_("配点（points）", sec.points, function (v) {
      sec.points = v; refreshPointsSummary();
    }));
    block.appendChild(grid);

    block.appendChild(fieldTextarea_("説明文（instruction）", sec.instruction || "", 2, function (v) {
      sec.instruction = v;
    }));

    // ---- 素材（任意）: table / image / code / wordbank ----
    block.appendChild(buildMaterialsEditor(sec));

    // ---- 設問一覧 ----
    var ansHeading = document.createElement("h2");
    ansHeading.textContent = "設問（answers）";
    block.appendChild(ansHeading);

    var ansHost = document.createElement("div");
    (sec.answers || []).forEach(function (a, aIdx) {
      ansHost.appendChild(buildAnswerBlock(sec, a, aIdx));
    });
    block.appendChild(ansHost);

    var btnAddAnswer = document.createElement("button");
    btnAddAnswer.type = "button";
    btnAddAnswer.textContent = "＋ 設問を追加";
    btnAddAnswer.addEventListener("click", function () {
      if (!sec.answers) sec.answers = [];
      sec.answers.push({ id: uid_("q"), type: "text", label: "(" + (sec.answers.length + 1) + ")", points: 0, rows: 3 });
      renderAll();
    });
    block.appendChild(btnAddAnswer);

    return block;
  }

  function moveSection(idx, dir) {
    var newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= exam.sections.length) return;
    var tmp = exam.sections[idx];
    exam.sections[idx] = exam.sections[newIdx];
    exam.sections[newIdx] = tmp;
    renderAll();
  }

  // ---- 素材編集UI（table/image/code/wordbank） ----
  function buildMaterialsEditor(sec) {
    var wrap = document.createElement("div");

    // table
    var hasTable = !!sec.table;
    wrap.appendChild(materialToggle_("表（table）を使用する", hasTable, function (checked) {
      sec.table = checked ? (sec.table || { head: [], rows: [] }) : undefined;
      renderAll();
    }));
    if (hasTable) {
      wrap.appendChild(fieldTextarea_("表の見出し行（head。カンマ区切り）", (sec.table.head || []).join(","), 1, function (v) {
        sec.table.head = v.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
      }));
      wrap.appendChild(fieldTextarea_("表のデータ行（rows。1行=1レコード。セルはカンマ区切り）",
        (sec.table.rows || []).map(function (r) { return r.join(","); }).join("\n"), 3, function (v) {
        sec.table.rows = v.split("\n").filter(function (l) { return l.trim().length; })
          .map(function (line) { return line.split(",").map(function (s) { return s.trim(); }); });
      }));
    }

    // image
    var hasImage = !!sec.image;
    wrap.appendChild(materialToggle_("画像（image）を使用する", hasImage, function (checked) {
      sec.image = checked ? (sec.image || { src: "", maxWidth: 480 }) : undefined;
      renderAll();
    }));
    if (hasImage) {
      wrap.appendChild(buildImageEditor_(sec.image));
    }

    // code（大問の問題文用コード。設問typeのcodeとは別）
    var hasCode = sec.code != null;
    wrap.appendChild(materialToggle_("コード（code。問題文用のコード表示）を使用する", hasCode, function (checked) {
      sec.code = checked ? (sec.code || "") : undefined;
      renderAll();
    }));
    if (hasCode) {
      wrap.appendChild(fieldTextarea_("コード本文", sec.code || "", 6, function (v) { sec.code = v; }));
    }

    // wordbank
    var hasWordbank = Array.isArray(sec.wordbank);
    wrap.appendChild(materialToggle_("語群（wordbank）を使用する", hasWordbank, function (checked) {
      sec.wordbank = checked ? (sec.wordbank || []) : undefined;
      renderAll();
    }));
    if (hasWordbank) {
      wrap.appendChild(fieldTextarea_("語群（1行に1語）", (sec.wordbank || []).join("\n"), 3, function (v) {
        sec.wordbank = v.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
      }));
    }

    return wrap;
  }

  // ---- 設問編集ブロック ----
  function buildAnswerBlock(sec, a, aIdx) {
    var box = document.createElement("div");
    box.className = "answer-block";

    var head = document.createElement("div");
    head.className = "ab-head";
    head.appendChild(document.createTextNode("設問 " + (aIdx + 1) + "（id: " + (a.id || "") + "）"));

    var btnUp = document.createElement("button");
    btnUp.type = "button"; btnUp.className = "secondary"; btnUp.textContent = "↑";
    btnUp.disabled = aIdx === 0;
    btnUp.addEventListener("click", function () { moveAnswer(sec, aIdx, -1); });

    var btnDown = document.createElement("button");
    btnDown.type = "button"; btnDown.className = "secondary"; btnDown.textContent = "↓";
    btnDown.disabled = aIdx === sec.answers.length - 1;
    btnDown.addEventListener("click", function () { moveAnswer(sec, aIdx, 1); });

    var btnDel = document.createElement("button");
    btnDel.type = "button"; btnDel.className = "danger"; btnDel.textContent = "削除";
    btnDel.addEventListener("click", function () {
      if (confirm("設問「" + (a.label || a.id) + "」を削除しますか？")) {
        sec.answers.splice(aIdx, 1);
        if (drawpads[a.id]) delete drawpads[a.id];
        renderAll();
      }
    });

    head.appendChild(btnUp);
    head.appendChild(btnDown);
    head.appendChild(btnDel);
    box.appendChild(head);

    // 重複IDチェック表示
    var dups = checkDuplicateIds_();
    if (a.id && dups.indexOf(a.id) !== -1) {
      var warn = document.createElement("div");
      warn.className = "warn";
      warn.textContent = "この id（" + a.id + "）は他の設問と重複しています。qIdは試験内で一意にしてください。";
      box.appendChild(warn);
    }

    var grid = document.createElement("div");
    grid.className = "grid2";
    grid.appendChild(fieldInput_("id（qId）", a.id || "", function (v) {
      a.id = v.trim();
      renderAll();
    }));
    grid.appendChild(fieldInput_("label（例: (1)）", a.label || "", function (v) { a.label = v; }));
    box.appendChild(grid);

    var grid2 = document.createElement("div");
    grid2.className = "grid2";
    grid2.appendChild(fieldNumber_("配点（points）", a.points, function (v) { a.points = v; refreshPointsSummary(); }));

    var typeField = document.createElement("label");
    typeField.className = "field";
    var typeSpan = document.createElement("span"); typeSpan.textContent = "type（設問種別）";
    var typeSel = document.createElement("select");
    ["text", "code", "draw", "choice"].forEach(function (t) {
      var o = document.createElement("option");
      o.value = t;
      o.textContent = { text: "text（記述）", code: "code（プログラム）", draw: "draw（作図）", choice: "choice（選択）" }[t];
      if (a.type === t) o.selected = true;
      typeSel.appendChild(o);
    });
    typeSel.addEventListener("change", function () {
      a.type = typeSel.value;
      // type別デフォルト属性の付与
      if (a.type === "text" && a.rows == null) a.rows = 3;
      if (a.type === "code" && !a.lang) a.lang = CODE_LANGS[0].value;
      if (a.type === "draw") { if (a.height == null) a.height = 420; if (!a.template) a.template = []; }
      if (a.type === "choice") { if (!a.choices) a.choices = []; if (a.multiple == null) a.multiple = false; if (a.shuffle == null) a.shuffle = true; }
      renderAll();
    });
    typeField.appendChild(typeSpan);
    typeField.appendChild(typeSel);
    grid2.appendChild(typeField);
    box.appendChild(grid2);

    // type別編集UI
    box.appendChild(buildTypeSpecificEditor(a));

    return box;
  }

  function moveAnswer(sec, idx, dir) {
    var newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= sec.answers.length) return;
    var tmp = sec.answers[idx];
    sec.answers[idx] = sec.answers[newIdx];
    sec.answers[newIdx] = tmp;
    renderAll();
  }

  function buildTypeSpecificEditor(a) {
    var wrap = document.createElement("div");

    if (a.type === "text") {
      wrap.appendChild(fieldNumber_("行数（rows）", a.rows != null ? a.rows : 3, function (v) { a.rows = v; }));
    } else if (a.type === "code") {
      var field = document.createElement("label");
      field.className = "field";
      var span = document.createElement("span"); span.textContent = "言語（lang）";
      var sel = document.createElement("select");
      CODE_LANGS.forEach(function (l) {
        var o = document.createElement("option");
        o.value = l.value; o.textContent = l.label;
        if ((a.lang || CODE_LANGS[0].value) === l.value) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { a.lang = sel.value; });
      field.appendChild(span); field.appendChild(sel);
      wrap.appendChild(field);
    } else if (a.type === "draw") {
      wrap.appendChild(fieldNumber_("高さ（height）", a.height != null ? a.height : 420, function (v) {
        a.height = v;
        if (drawpads[a.id]) drawpads[a.id].height = v;
      }));
      wrap.appendChild(buildDrawTemplateEditor(a));
    } else if (a.type === "choice") {
      wrap.appendChild(buildChoiceEditor(a));
    }

    return wrap;
  }

  // ---- draw テンプレート編集（FR-B08。DrawPadを設置し教員が下絵を作図） ----
  function buildDrawTemplateEditor(a) {
    var wrap = document.createElement("div");
    var hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "下絵を作図し、「この図をテンプレートとして保存」を押すと answers[].template に反映されます（保存を押さないと反映されません）。";
    wrap.appendChild(hint);

    var host = document.createElement("div");
    wrap.appendChild(host);

    if (window.DrawPad) {
      // 既存インスタンスがあれば作り直す（renderAllのたびにDOMは再構築されるため）
      var pad = new DrawPad(host, { height: a.height || 420, template: a.template || [] });
      drawpads[a.id] = pad;
      // DOM追加直後はサイズ0のため明示的にresize/render（exam.jsのbuildExamと同様の手当て）
      setTimeout(function () { pad.resize(); pad.render(); }, 0);
    } else {
      var err = document.createElement("div");
      err.className = "error-box";
      err.textContent = "DrawPad（../exam/drawing.js）の読み込みに失敗しています。";
      wrap.appendChild(err);
    }

    var btnCommit = document.createElement("button");
    btnCommit.type = "button";
    btnCommit.className = "secondary";
    btnCommit.textContent = "この図をテンプレートとして保存";
    btnCommit.addEventListener("click", function () {
      if (drawpads[a.id]) {
        a.template = drawpads[a.id].toJSON();
        showSaveMsg("設問「" + (a.label || a.id) + "」のテンプレートを反映しました（試験全体の保存はまだです）。", false);
      }
    });
    wrap.appendChild(btnCommit);

    return wrap;
  }

  // ---- choice編集（choices配列・multiple・shuffle） ----
  function buildChoiceEditor(a) {
    var wrap = document.createElement("div");
    if (!Array.isArray(a.choices)) a.choices = [];

    var flags = document.createElement("div");
    flags.className = "grid2";
    flags.appendChild(checkboxField_("複数選択可（multiple）", !!a.multiple, function (v) { a.multiple = v; }));
    flags.appendChild(checkboxField_("シャッフルする（shuffle）", a.shuffle !== false, function (v) { a.shuffle = v; }));
    wrap.appendChild(flags);

    var listHost = document.createElement("div");
    a.choices.forEach(function (c, cIdx) {
      var row = document.createElement("div");
      row.className = "card-row";
      row.style.alignItems = "flex-start";

      var idInput = document.createElement("input");
      idInput.type = "text"; idInput.value = c.id || ""; idInput.placeholder = "choice id";
      idInput.style.maxWidth = "120px";
      idInput.addEventListener("input", function () { c.id = idInput.value.trim(); });

      var textInput = document.createElement("textarea");
      textInput.rows = 2; textInput.value = c.text || ""; textInput.placeholder = "選択肢の文言";
      textInput.style.flex = "1";
      textInput.addEventListener("input", function () { c.text = textInput.value; });

      var btnDel = document.createElement("button");
      btnDel.type = "button"; btnDel.className = "danger"; btnDel.textContent = "削除";
      btnDel.addEventListener("click", function () {
        a.choices.splice(cIdx, 1);
        renderAll();
      });

      row.appendChild(idInput);
      row.appendChild(textInput);
      row.appendChild(btnDel);
      listHost.appendChild(row);
    });
    wrap.appendChild(listHost);

    var btnAdd = document.createElement("button");
    btnAdd.type = "button"; btnAdd.className = "secondary";
    btnAdd.textContent = "＋ 選択肢を追加";
    btnAdd.addEventListener("click", function () {
      a.choices.push({ id: "c" + (a.choices.length + 1), text: "" });
      renderAll();
    });
    wrap.appendChild(btnAdd);

    return wrap;
  }

  // ===== 汎用フィールドビルダー =====
  function fieldInput_(labelText, value, onChange) {
    var field = document.createElement("label");
    field.className = "field";
    var span = document.createElement("span"); span.textContent = labelText;
    var input = document.createElement("input");
    input.type = "text"; input.value = value;
    input.addEventListener("input", function () { onChange(input.value); });
    field.appendChild(span); field.appendChild(input);
    return field;
  }
  function fieldNumber_(labelText, value, onChange) {
    var field = document.createElement("label");
    field.className = "field";
    var span = document.createElement("span"); span.textContent = labelText;
    var input = document.createElement("input");
    input.type = "number"; input.value = (value != null ? value : 0);
    input.addEventListener("input", function () { onChange(parseFloat(input.value) || 0); });
    field.appendChild(span); field.appendChild(input);
    return field;
  }
  function fieldTextarea_(labelText, value, rows, onChange) {
    var field = document.createElement("label");
    field.className = "field";
    var span = document.createElement("span"); span.textContent = labelText;
    var ta = document.createElement("textarea");
    ta.rows = rows || 3; ta.value = value || "";
    ta.addEventListener("input", function () { onChange(ta.value); });
    field.appendChild(span); field.appendChild(ta);
    return field;
  }
  function checkboxField_(labelText, checked, onChange) {
    var field = document.createElement("label");
    field.className = "field";
    field.style.display = "flex"; field.style.alignItems = "center"; field.style.gap = "8px";
    var input = document.createElement("input");
    input.type = "checkbox"; input.checked = !!checked; input.style.width = "auto";
    input.addEventListener("change", function () { onChange(input.checked); });
    var span = document.createElement("span"); span.textContent = labelText; span.style.marginBottom = "0";
    field.appendChild(input); field.appendChild(span);
    return field;
  }
  function materialToggle_(labelText, checked, onToggle) {
    return checkboxField_(labelText, checked, onToggle);
  }

  // 画像素材エディタ: ファイルを選んでBase64 data URIに変換しsec.image.srcへ格納する。
  // URL直接入力も引き続き可能。画像は試験JSONに埋め込まれるため過大サイズを警告する。
  var IMAGE_MAX_BYTES = 700 * 1024; // data URI化前の目安上限（約700KB）
  function buildImageEditor_(image) {
    var box = document.createElement("div");

    // プレビュー
    var preview = document.createElement("img");
    preview.style.maxWidth = "100%";
    preview.style.maxHeight = "220px";
    preview.style.display = image.src ? "block" : "none";
    preview.style.margin = "6px 0";
    preview.style.border = "1px solid var(--line)";
    preview.style.borderRadius = "6px";
    preview.src = image.src || "";

    // ファイル選択（アップロード→Base64）
    var upField = document.createElement("label");
    upField.className = "field";
    var upSpan = document.createElement("span");
    upSpan.textContent = "画像ファイルを選択（アップロード）";
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.width = "auto";
    var fileMsg = document.createElement("div");
    fileMsg.style.fontSize = "12px";
    fileMsg.style.marginTop = "4px";

    // URL直接入力（従来方式も残す）
    var urlField = fieldInput_("または画像URLを直接入力（src）", image.src && image.src.indexOf("data:") === 0 ? "" : (image.src || ""), function (v) {
      image.src = v;
      preview.src = v;
      preview.style.display = v ? "block" : "none";
    });

    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > IMAGE_MAX_BYTES) {
        fileMsg.style.color = "var(--red, #c0261e)";
        fileMsg.textContent = "画像が大きすぎます（" + Math.round(file.size / 1024) + "KB）。" +
          Math.round(IMAGE_MAX_BYTES / 1024) + "KB以下に縮小してから選び直してください（試験データに埋め込むため）。";
        fileInput.value = "";
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        image.src = String(reader.result || "");
        preview.src = image.src;
        preview.style.display = "block";
        fileMsg.style.color = "var(--green, #127a3e)";
        fileMsg.textContent = "画像を読み込みました（" + Math.round(file.size / 1024) + "KB）。保存すると試験に埋め込まれます。";
        var urlInput = urlField.querySelector("input");
        if (urlInput) urlInput.value = "";
      };
      reader.onerror = function () {
        fileMsg.style.color = "var(--red, #c0261e)";
        fileMsg.textContent = "画像の読み込みに失敗しました。別のファイルでお試しください。";
      };
      reader.readAsDataURL(file);
    });

    upField.appendChild(upSpan);
    upField.appendChild(fileInput);
    upField.appendChild(fileMsg);

    box.appendChild(upField);
    box.appendChild(preview);
    box.appendChild(urlField);
    box.appendChild(fieldNumber_("最大幅（maxWidth）", image.maxWidth || 480, function (v) { image.maxWidth = v; }));
    return box;
  }

  // ===== 保存時のテンプレート回収 =====
  function collectDrawTemplates_() {
    (exam.sections || []).forEach(function (sec) {
      (sec.answers || []).forEach(function (a) {
        if (a.type === "draw" && drawpads[a.id]) {
          a.template = drawpads[a.id].toJSON();
        }
      });
    });
  }

  function buildExamJson_() {
    readFormIntoModel();
    // a.template は「この図をテンプレートとして保存」ボタン押下時のみ確定する（ヒント文の仕様）。
    // プレビュー・保存・エクスポートでは drawpad の内容を自動反映しない（collectDrawTemplates_を呼ばない）。
    return {
      examId: exam.examId || undefined,
      title: exam.title,
      durationMin: exam.durationMin,
      notes: exam.notes,
      maxViolations: exam.maxViolations,
      sections: exam.sections
    };
  }

  // ===== 保存（admin.saveExam） =====
  function showSaveMsg(text, isError) {
    var box = $("saveMsg");
    box.innerHTML = '<div class="' + (isError ? "error-box" : "hint") + '">' + esc(text) + "</div>";
  }

  function saveExam() {
    var payload = buildExamJson_();
    var dups = checkDuplicateIds_();
    if (dups.length) {
      showSaveMsg("qId（answers[].id）が重複しています: " + dups.join(", ") + " 。保存前に修正してください。", true);
      return;
    }
    if (!payload.title) {
      showSaveMsg("タイトルを入力してください。", true);
      return;
    }
    var body = { exam: payload };
    if (currentExamId) body.examId = currentExamId;

    $("btnSaveExam").disabled = true;
    showSaveMsg("保存中…", false);
    ApiClient.callPost("admin.saveExam", body).then(function (res) {
      $("btnSaveExam").disabled = false;
      if (!res || res.ok !== true) {
        showSaveMsg("保存に失敗しました。", true);
        return;
      }
      currentExamId = res.examId;
      exam.examId = res.examId;
      // 新規作成時はURLにexamIdを反映（実装指示書: 応答{ok:true,examId}でURL更新かリダイレクト）
      var newUrl = location.pathname + "?exam=" + encodeURIComponent(currentExamId);
      history.replaceState(null, "", newUrl);
      writeModelIntoForm();
      showSaveMsg("保存しました（examId: " + currentExamId + "）。", false);
    }).catch(function (err) {
      $("btnSaveExam").disabled = false;
      showSaveMsg("通信エラー: " + esc((err && err.message) || err), true);
    });
  }

  // ===== 公開設定保存（admin.schedule。published→draft制約チェック） =====
  function showScheduleMsg(text, isError) {
    var box = $("scheduleMsg");
    box.innerHTML = '<div class="' + (isError ? "error-box" : "hint") + '">' + esc(text) + "</div>";
  }

  function saveSchedule() {
    if (!currentExamId) {
      showScheduleMsg("先に試験を保存してexamIdを確定してください。", true);
      return;
    }
    var open = localInputToIso_($("fOpen").value);
    var close = localInputToIso_($("fClose").value);
    var newState = $("fState").value;
    var isDowngradeFromPublished = (scheduleState.state === "published" && newState === "draft");

    function doSave() {
      $("btnSaveSchedule").disabled = true;
      showScheduleMsg("保存中…", false);
      ApiClient.callPost("admin.schedule", { examId: currentExamId, open: open, close: close, state: newState }).then(function (res) {
        $("btnSaveSchedule").disabled = false;
        if (!res || res.ok !== true) {
          showScheduleMsg("公開設定の保存に失敗しました。", true);
          return;
        }
        scheduleState = { open: open, close: close, state: newState };
        showScheduleMsg("公開設定を保存しました。", false);
      }).catch(function (err) {
        $("btnSaveSchedule").disabled = false;
        showScheduleMsg("通信エラー: " + esc((err && err.message) || err), true);
      });
    }

    if (isDowngradeFromPublished) {
      // 内部設計書§5.3 FSM: published→draftは受験開始者ゼロの場合のみ許可
      showScheduleMsg("受験状況を確認中…", false);
      ApiClient.callGet("admin.listSubmissions", { examId: currentExamId }).then(function (res) {
        if (!res || res.ok !== true) {
          showScheduleMsg("受験状況の確認に失敗したため、公開設定を変更できません。", true);
          return;
        }
        var submissions = res.submissions || [];
        if (submissions.length > 0) {
          showScheduleMsg("published→draftへの変更は受験開始者がいるため許可されません。", true);
          return;
        }
        doSave();
      }).catch(function (err) {
        showScheduleMsg("通信エラー: " + esc((err && err.message) || err), true);
      });
    } else {
      doSave();
    }
  }

  // =====================================================================
  //  PreviewRenderer — exam.jsのrenderSection等を複製
  //  出典: exam/exam.js §8 PreviewRenderer参照（renderSection/renderTable/renderImage/
  //  renderWordbank/renderCode/renderAnswer/renderChoiceおよび$/el/escヘルパーを複製）。
  //  監視系ロジック（不正検知・保存・タイマー等）は一切含めない。drawはテンプレート表示のみ。
  //  実装指示書P3-4「モジュール共有機構を作らない。コメントで出典明記」方針に従う。
  //
  //  drawing.jsのDrawPadはdocument.createElement等クロージャ定義時のグローバルを直接参照する
  //  ため、DrawPadを含むレンダリングはiframe自身の<script>としてiframe内で実行する
  //  （親windowのdocumentとiframeのdocumentを混在させない）。そのためPreviewRenderer本体は
  //  文字列化してiframeのsrcdoc内<script>に埋め込み、examJSONはwindow.name経由で受け渡す。
  // =====================================================================

  // iframe内で実行するPreviewRenderer本体（文字列化して埋め込むため独立関数として定義）
  function previewRendererSource_() {
    // ---- ここから exam.js の renderSection 等の複製（出典: exam/exam.js §8） ----
    var $ = function (sel, p) { return (p || document).querySelector(sel); };
    var el = function (tag, cls, html) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html != null) e.innerHTML = html;
      return e;
    };
    var esc = function (s) {
      return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    };

    function renderSection(sec) {
      var s = el("section", "section");
      var head = el("div", "head");
      head.appendChild(el("span", "qno", esc(sec.number)));
      if (sec.points != null) head.appendChild(el("span", "pts", "（" + sec.points + "点）"));
      s.appendChild(head);

      if (sec.instruction) s.appendChild(el("p", "instr", esc(sec.instruction)));
      if (sec.summary) s.appendChild(el("div", "summary", esc(sec.summary)));
      if (sec.explain) s.appendChild(el("div", "explain", esc(sec.explain)));

      if (sec.table) s.appendChild(renderTable(sec.table, "qtab"));
      if (sec.image) s.appendChild(renderImage(sec.image));
      if (sec.code) { var pre = el("pre", "code"); pre.textContent = sec.code; s.appendChild(pre); }
      if (sec.reviewTable) s.appendChild(renderTable(sec.reviewTable, "review"));
      var hasWordbankGroups = Array.isArray(sec.wordbankGroups) && sec.wordbankGroups.length > 0;
      var hasWordbankWords = Array.isArray(sec.wordbank) && sec.wordbank.length > 0;
      if (hasWordbankGroups || hasWordbankWords) s.appendChild(renderWordbank(sec.wordbank, sec.wordbankGroups));

      (sec.answers || []).forEach(function (a) { s.appendChild(renderAnswer(a)); });
      return s;
    }

    function renderTable(t, cls) {
      var tab = el("table", cls);
      if (t.head) {
        var tr = el("tr");
        t.head.forEach(function (h) { tr.appendChild(el("th", null, esc(h))); });
        tab.appendChild(tr);
      }
      (t.rows || []).forEach(function (r) {
        var tr2 = el("tr");
        r.forEach(function (c) { tr2.appendChild(el("td", null, esc(c))); });
        tab.appendChild(tr2);
      });
      return tab;
    }

    function renderImage(img) {
      var fig = el("div", "qfig");
      var wrap = el("div", "figwrap");
      var im = el("img");
      im.src = img.src; im.alt = img.alt || "";
      if (img.maxWidth) im.style.maxWidth = img.maxWidth + "px";
      wrap.appendChild(im);
      if (img.cropCaption) wrap.appendChild(el("div", "figcover"));
      fig.appendChild(wrap);
      return fig;
    }

    function renderWordbank(words, groups) {
      var w = el("div", "wordbank");
      w.appendChild(el("div", "wbt", "【語群】（未使用・複数回使用可）"));
      if (Array.isArray(groups) && groups.length) {
        groups.forEach(function (g) {
          w.appendChild(el("div", "wbg", g.title));
          var chips = el("div", "chips");
          (g.words || []).forEach(function (x) { chips.appendChild(el("span", "chip", esc(x))); });
          w.appendChild(chips);
        });
      } else {
        var chips2 = el("div", "chips");
        (words || []).forEach(function (x) { chips2.appendChild(el("span", "chip", esc(x))); });
        w.appendChild(chips2);
      }
      return w;
    }

    function renderAnswer(a) {
      var box = el("div", "ans");
      var tagcls = a.type === "draw" ? "tag draw" : a.type === "code" ? "tag code" : a.type === "choice" ? "tag choice" : "tag";
      var tagtxt = a.type === "draw" ? "図形描画" : a.type === "code" ? "プログラム" : a.type === "choice" ? "選択" : "記述";
      var lbl = el("div", "lbl");
      lbl.innerHTML = '<span class="' + tagcls + '">' + tagtxt + "</span><span>" + esc(a.label || "") + "</span>";
      box.appendChild(lbl);

      if (a.type === "draw") {
        var host = el("div");
        box.appendChild(host);
        // プレビューは監視なし・テンプレート表示のみ（編集不可扱い。onChangeは渡さない）
        if (window.DrawPad) {
          var pad = new window.DrawPad(host, { height: a.height || 420, template: a.template || [] });
          setTimeout(function () { pad.resize(); pad.render(); }, 0);
        }
      } else if (a.type === "code") {
        box.appendChild(renderCode(a));
      } else if (a.type === "choice") {
        box.appendChild(renderChoice(a));
      } else {
        var ta = el("textarea", "ansin");
        ta.dataset.id = a.id;
        ta.rows = a.rows || 3;
        if (a.placeholder) ta.placeholder = a.placeholder;
        box.appendChild(ta);
      }
      return box;
    }

    function renderChoice(a) {
      var wrap = el("div", "choicebox");
      wrap.dataset.id = a.id;
      var inputType = a.multiple ? "checkbox" : "radio";
      (a.choices || []).forEach(function (c) {
        var item = el("label", "choice-item");
        var input = document.createElement("input");
        input.type = inputType;
        input.name = a.multiple ? (a.id + "_" + c.id) : a.id;
        input.value = c.id;
        item.appendChild(input);
        item.appendChild(el("span", "choice-label", esc(c.text || "")));
        input.addEventListener("change", function () {
          var groupSel = a.multiple ? null : 'input[name="' + CSS.escape(input.name) + '"]';
          (groupSel ? wrap.querySelectorAll(groupSel) : [input]).forEach(function (inp) {
            inp.closest(".choice-item").classList.toggle("checked", inp.checked);
          });
        });
        wrap.appendChild(item);
      });
      return wrap;
    }

    function renderCode(a) {
      var cb = el("div", "codebox");
      var bar = el("div", "cbar");
      bar.appendChild(el("span", null, "言語："));
      var sel = el("select");
      ["python", "c"].forEach(function (l) {
        var o = el("option"); o.value = l; o.textContent = l === "c" ? "C" : "Python"; sel.appendChild(o);
      });
      bar.appendChild(sel);
      cb.appendChild(bar);
      var ta = el("textarea", "codein");
      ta.dataset.id = a.id;
      ta.dataset.lang = a.lang || "python";
      sel.value = ta.dataset.lang;
      ta.rows = a.rows || 12;
      ta.spellcheck = false;
      ta.placeholder = (a.lang === "c") ? "// ここにCプログラムを記述" : "# ここにPython/Cプログラムを記述";
      sel.addEventListener("change", function () { ta.dataset.lang = sel.value; });
      cb.appendChild(ta);
      return cb;
    }
    // ---- ここまで exam.js の複製部分 ----

    function buildPreviewBody(examJson) {
      var root = el("div", "wrap");
      root.appendChild(el("div", "exam-title", esc(examJson.title || "")));
      if (examJson.notes && examJson.notes.length) {
        var notes = el("div", "notes");
        notes.innerHTML = "<ul>" + examJson.notes.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
        root.appendChild(notes);
      }
      var sectionsRoot = el("div");
      sectionsRoot.id = "sections";
      (examJson.sections || []).forEach(function (sec) { sectionsRoot.appendChild(renderSection(sec)); });
      root.appendChild(sectionsRoot);
      return root;
    }

    // window.name経由で親から渡されたEXAM_JSONを読み取り描画する
    var examJson = {};
    try { examJson = JSON.parse(window.name || "{}"); } catch (e) { examJson = {}; }
    document.getElementById("previewRoot").appendChild(buildPreviewBody(examJson));
  }

  // iframeへの描画（srcdoc方式。exam.cssをそのまま流用してレンダリング崩れを防ぐ）
  function renderPreview() {
    readFormIntoModel();
    var examJson = buildExamJson_();
    var iframe = $("previewFrame");
    iframe.style.display = "block";

    // iframe.name経由でJSONを渡す（srcdocはURL長制限がなく安全にシリアライズできるため
    // window.nameへはiframe読み込み後にpostMessageではなくload前に設定する）
    iframe.onload = function () {
      iframe.contentWindow.name = JSON.stringify(examJson);
      // srcdoc内の<script>はiframe.name確定前に実行されるため、読み込み後に明示的に再実行する
      var doc = iframe.contentDocument;
      var s = doc.createElement("script");
      s.textContent = "(" + previewRendererSource_.toString() + ")();";
      doc.body.appendChild(s);
    };
    iframe.srcdoc =
      "<!DOCTYPE html><html lang=\"ja\"><head><meta charset=\"utf-8\">" +
      "<link rel=\"stylesheet\" href=\"../exam/exam.css\">" +
      "<script src=\"../exam/drawing.js\"><\/script>" +
      "</head><body><div id=\"previewRoot\"></div></body></html>";
  }

  // ===== JSONエクスポート/インポート（FR-B06） =====
  function exportJson() {
    readFormIntoModel();
    var payload = buildExamJson_();
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = (payload.examId || "exam") + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // 簡易スキーマ検証（実装指示書: sectionsが配列であること、各answers[].idが存在すること程度）
  function validateImportedJson_(json) {
    if (!json || typeof json !== "object") return "JSONの形式が不正です。";
    if (!Array.isArray(json.sections)) return "sectionsが配列ではありません。";
    for (var i = 0; i < json.sections.length; i++) {
      var sec = json.sections[i];
      var answers = sec.answers || [];
      for (var j = 0; j < answers.length; j++) {
        if (!answers[j] || !answers[j].id) {
          return "大問" + (i + 1) + "の設問" + (j + 1) + "にidがありません。";
        }
      }
    }
    return "";
  }

  function importJsonFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var json;
      try {
        json = JSON.parse(reader.result);
      } catch (e) {
        showSaveMsg("JSONの解析に失敗しました。", true);
        return;
      }
      var errMsg = validateImportedJson_(json);
      if (errMsg) {
        showSaveMsg("インポートを中止しました: " + errMsg, true);
        return;
      }
      // examIdはURL/現在編集中のものを優先し、インポートJSON内のexamIdでは上書きしない
      applyExamJson(Object.assign({}, json, { examId: exam.examId }));
      renderAll();
      showSaveMsg("JSONをインポートしました。内容を確認のうえ保存してください。", false);
    };
    reader.readAsText(file);
  }

  // ===== 静的イベント紐付け =====
  function bindStaticEvents() {
    $("btnAddSection").addEventListener("click", function () {
      exam.sections.push({ number: "大問" + (exam.sections.length + 1), points: 0, instruction: "", answers: [] });
      renderAll();
    });

    $("fTitle").addEventListener("input", readFormIntoModel);
    $("fDuration").addEventListener("input", readFormIntoModel);
    $("fMaxViolations").addEventListener("input", readFormIntoModel);
    $("fNotes").addEventListener("input", readFormIntoModel);

    $("btnSaveExam").addEventListener("click", saveExam);
    $("btnSaveSchedule").addEventListener("click", saveSchedule);
    $("btnPreview").addEventListener("click", renderPreview);
    $("btnExport").addEventListener("click", exportJson);
    $("btnImportTrigger").addEventListener("click", function () { $("fileImport").click(); });
    $("fileImport").addEventListener("change", function () {
      var f = $("fileImport").files[0];
      if (f) importJsonFile(f);
      $("fileImport").value = "";
    });
  }

  init();
})();
