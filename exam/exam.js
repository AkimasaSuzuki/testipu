/* =====================================================================
 *  exam.js — ExamForge 受験ページ本体ロジック
 *  継承元: ソフトウェア工学/github.io/exam/exam.js（1001行）
 *  実装指示書§8 SoftExpExam移植マップ・内部設計書§3.1 擬似クラス対応。
 *  責務コメントで ExamSession / IntegrityMonitor / ExamTimer /
 *  AutoSubmitScheduler / AnswerCollector / SubmissionClient /
 *  EncryptedFallback / ExamRenderer に対応付ける（物理的にはIIFE内関数群。
 *  §3.1冒頭注記「一括書き直し禁止」に従い、そのまま区分はロジック不変で移植）。
 *
 *  ・Chrome 限定（他ブラウザは出題しない）
 *  ・全画面（最前面）で受験／背面化を検知すると強制終了(window.close)
 *  ・強制終了3回で不正とみなし、以降は出題しない
 *  ・記述/図形描画/プログラム/選択式 の解答欄を動的生成（選択式はFR-C04で新規）
 *  ・解答は教員専用領域(GAS)へ保存。学生端末には残さない（既定）
 *  ・提出確認はページ内モーダル（監視を止めないため確認中の不正も検知）
 *  ・受験者(sid/name)はGoogleログイン(idToken)からGAS側が確定する（FR-C12/C13）
 *
 *  ▼ 不正対策（OS非依存・毎秒の常時監視 watchdog ＋ イベント検知の二重化）
 *  ・背面化/タブ切替/最小化      : visibilitychange + blur + hasFocus() 監視
 *  ・全画面解除(Esc含む)         : fullscreenchange + watchdog
 *  ・二分割画面/スナップ/縮小    : resize + watchdog（画面サイズとの比較）
 *  ・複数ディスプレイ(拡張画面)  : screen.isExtended（開始時ブロック＋試験中検知）
 *  ・再読み込み/URL移動/閉じる   : pagehide で不正カウント＋sendBeaconでサーバー記録
 *  ・ショートカット(印刷/保存/検索/ソース/開発ツール等) : keydown遮断
 *  ・Esc / Ctrl+T / Ctrl+N 等のブラウザ予約キー : 全画面中は Keyboard Lock API で捕捉
 *  ・問題文コピー/外部クリップボード貼り付け/右クリック/ドラッグ/印刷 : 遮断
 *  ※ ページから遮断できない操作（OSのキーで強行 等）は、実行されると必ず
 *    背面化・全画面解除・縮小のいずれかとして検知され、不正カウントが進む設計。
 *  ※ Siri等の音声アシスタント・別端末の使用はWeb技術では検知不能（試験監督で対応）。
 * ===================================================================== */
(function () {
  "use strict";

  /* ---------- サーバー保存設定（exam/config.js で上書き）--------- 内部設計書§9.1 */
  const CFG = (typeof window !== "undefined" && window.EXAM_CONFIG) ? window.EXAM_CONFIG : {};
  const MAX_VIOLATIONS = CFG.MAX_VIOLATIONS || 3;
  // ローカル動作確認モード：localhost / 127.0.0.1 / [::1] で開いた時だけ true。
  // 公開サイト（*.github.io 等）では hostname が一致しないため【絶対に有効化されない】。
  // 本モードでは全画面の強制と背面監視を無効化し、教員が手元で安全に動作確認できるようにする。
  // ただし config 側で FORCE_MONITORING:true を指定した場合は、ローカルでも本番同様の
  // 全画面強制・背面監視を有効化する（local-test で不正防止の挙動を検証するための逃げ道）。
  const FORCE_MONITORING = !!(CFG && CFG.FORCE_MONITORING === true);
  const LOCAL_DEV = !FORCE_MONITORING && /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(location.hostname);
  // 問題データはサーバー(GAS)から取得（公開ソースに置かない）。ローカル開発時のみ window.EXAM を使用。
  let EXAM = (typeof window !== "undefined" && window.EXAM && window.EXAM.sections) ? window.EXAM : null;
  let DURATION_MIN = 90;

  const GAS_ENDPOINT = CFG.GAS_ENDPOINT || "";           // GASウェブアプリURL（実装指示書P2-6-1）
  const SUBMIT_TOKEN = CFG.SUBMIT_TOKEN || "";           // 簡易トークン（SUBMIT_TOKEN。§7.7）
  const KEEP_LOCAL_DOWNLOAD = CFG.KEEP_LOCAL_DOWNLOAD === true; // 既定: 端末に控えを残さない
  const TIMEOUT_JITTER_MS = CFG.TIMEOUT_JITTER_MS || 10000; // 内部設計書§9.1・FR-C11

  /* ---------- 受験者情報（実装指示書P2-6-2）---------- 内部設計書§4.1
   * sid/nameのURLパラメータ・手入力は廃止（FR-C12/C13）。
   * idToken/examIdはindex.htmlがsessionStorageへ書き込んだものを読む（実装指示書A-1）。
   * SID/NAMEはfetchQuestions()応答（GAS確定値）で初めて確定するミュータブル変数。 */
  const ID_TOKEN = (function () { try { return sessionStorage.getItem("ef_idToken") || ""; } catch (e) { return ""; } })();
  const EXAM_ID = (function () { try { return sessionStorage.getItem("ef_examId") || ""; } catch (e) { return ""; } })();
  let SID = "";
  let NAME = "";
  let ROLE = "student";

  // localStorageキー: examforge_種別_examId_sid（複数試験並行対応・FR-F05）。sid確定後に初期化（実装指示書P2-6-3）
  let K = null;
  function initKeys_() {
    const suffix = EXAM_ID + "_" + SID;
    K = {
      v: "examforge_v_" + suffix,      // 強制終了回数（不正カウント・残す）
      a: "examforge_a_" + suffix,      // 解答の一時保存（試験後に消去）
      start: "examforge_start_" + suffix,
      done: "examforge_done_" + suffix, // 提出済み（再受験不可・残す）。サーバー側でも記録
    };
  }

  /* ---------- 状態 ---------- */
  let monitoring = false;
  let examFinished = false;
  let violating = false;
  let jitterWaiting = false; // AutoSubmitScheduler待機中フラグ（FR-C11。内部設計書§3.1 hint）
  const drawpads = {};      // id -> DrawPad
  let saveTimer = null;
  let endTime = 0;
  let tickTimer = null;
  let watchdogTimer = null;   // 毎秒の常時監視（フォーカス・全画面・サイズ・複数画面）
  let everFullscreen = false; // 一度でも全画面に入れたか（入れない環境は再試行を促す）
  let fsFailTicks = 0;        // 全画面に入れていない経過秒数
  let internalClip = null;    // ページ内コピーの内容（外部から用意した答えの貼り付け遮断用）

  /* ---------- 試験スケジュール（サーバー権威・クロック改ざん耐性） ---------- 内部設計書§3.1 ExamSession（そのまま・P2移植マップ§8.1） */
  let openAt = 0, closeAt = 0;      // 開始/終了の絶対時刻(epoch ms)。0=未設定
  let _epoch0 = 0, _perf0 = 0;      // サーバー時刻の同期基準（以後は monotonic で計測）
  function serverNow() { return _epoch0 ? _epoch0 + (performance.now() - _perf0) : Date.now(); }
  function applySchedule(s) {
    if (!s) return;
    if (s.serverNow) { const sv = Date.parse(s.serverNow); if (!isNaN(sv)) { _epoch0 = sv; _perf0 = performance.now(); } }
    const o = s.open ? Date.parse(s.open) : 0;   openAt = isNaN(o) ? 0 : o;
    const c = s.close ? Date.parse(s.close) : 0; closeAt = isNaN(c) ? 0 : c;
  }
  function fmtClock(ts) {
    return new Date(ts).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function fmtRemain(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? h + ":" + p(m) + ":" + p(ss) : p(m) + ":" + p(ss);
  }

  /* ---------- ユーティリティ（§8.1 そのまま） ---------- */
  const $ = (sel, p) => (p || document).querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function getViolations() { return parseInt(localStorage.getItem(K.v) || "0", 10) || 0; }
  function incViolations() { const n = getViolations() + 1; localStorage.setItem(K.v, String(n)); return n; }
  // 解答・問題を端末に残さない（不正カウントK.vは残す）
  function purgeLocal() { try { localStorage.removeItem(K.a); localStorage.removeItem(K.start); } catch (e) {} }

  /* ---------- ブラウザ判定（Chrome限定）（§8.1 そのまま L107-121） ---------- */
  function isChrome() {
    const ua = navigator.userAgent || "";
    const vendor = navigator.vendor || "";
    const platform = navigator.platform || "";
    const isCh = (/Chrome\//.test(ua) || /CriOS\//.test(ua)) && vendor === "Google Inc.";
    const notOther = !/Edg\/|EdgA\/|OPR\/|OPiOS\/|FxiOS|Firefox|SamsungBrowser|Brave/.test(ua);
    // モバイル/タブレットは不可（スマートフォン・タブレット全般を除外）
    if (/Mobi|Android|iPhone|iPad|Tablet|Mobile/.test(ua)) return false;
    // iPadOS が Mac を報告する場合（タッチ対応）もタブレット扱いで不可
    if (/Mac/.test(platform) && navigator.maxTouchPoints && navigator.maxTouchPoints > 1) return false;
    // OS は Windows または macOS のみ許可
    if (!(/Win/.test(platform) || /Mac/.test(platform))) return false;
    return isCh && notOther;
  }

  /* =====================================================================
   *  画面オーバーレイ（§8.1 そのまま。screenNoStudent→screenLoginRequiredに置換）
   * ===================================================================== */
  function showOverlay(cls, html) {
    let o = $("#overlay");
    if (!o) { o = el("div"); o.id = "overlay"; document.body.appendChild(o); }
    o.className = "overlay " + (cls || "");
    o.innerHTML = '<div class="card">' + html + "</div>";
    o.style.display = "flex";
    return o;
  }
  function hideOverlay() { const o = $("#overlay"); if (o) o.style.display = "none"; }

  function screenChromeOnly() {
    showOverlay("block",
      '<div class="big">🚫</div>' +
      "<h1>Google Chrome で受験してください</h1>" +
      "<p>この試験は <b>Google Chrome</b> でのみ受験できます。</p>" +
      "<p>Chrome を起動し、同じURLを開き直してください。</p>" +
      '<p class="cnt">現在のブラウザでは試験問題は表示されません。</p>');
  }

  // 旧screenNoStudentの置換（FSM§5.1 LOGIN_REQUIRED。実装指示書§8.3新規）
  function screenLoginRequired() {
    showOverlay("warn",
      '<div class="big">🔑</div>' +
      "<h1>ログインが必要です</h1>" +
      "<p>受験開始ページから大学Googleアカウントでログインして開始してください。</p>" +
      '<p class="cnt">このページを直接開くことはできません。</p>');
  }

  function screenBlocked() {
    showOverlay("block",
      '<div class="big">⛔</div>' +
      "<h1>受験できません</h1>" +
      "<p>バックグラウンドへの切り替え（強制終了）が <b>" + MAX_VIOLATIONS +
      "回</b> 検知されました。</p><p>不正行為とみなし、以降は試験問題を表示しません。</p>" +
      "<p>" + esc(NAME) + "（" + esc(SID) + "）</p>" +
      '<p class="cnt">担当教員に申し出てください。</p>');
  }

  function screenLoading() {
    showOverlay("",
      '<div class="big">⏳</div>' +
      "<h1>試験問題を準備しています…</h1>" +
      "<p>サーバーから問題を取得しています。しばらくお待ちください。</p>");
  }

  function screenError(title, sub) {
    showOverlay("block",
      '<div class="big">⚠️</div>' +
      "<h1>" + esc(title) + "</h1>" +
      (sub ? "<p>" + esc(sub) + "</p>" : "") +
      '<p class="cnt">' + esc(NAME) + "（" + esc(SID) + "）</p>");
  }

  function screenStart() {
    const rem = MAX_VIOLATIONS - getViolations();
    showOverlay("",
      "<h1>試験を開始します</h1>" +
      "<p>" + esc(NAME) + " さん（" + esc(SID) + "）</p>" +
      "<ul>" +
      "<li>開始すると<b>全画面（最前面）</b>になります。試験終了まで全画面のままです。</li>" +
      "<li>他のアプリ・タブへの切り替え、<b>全画面解除・画面分割・ウィンドウ縮小・外部ディスプレイ接続・再読み込み・ページ移動</b>を検知すると<b>強制終了</b>します。</li>" +
      "<li>強制終了が <b>" + MAX_VIOLATIONS + "回</b> に達すると受験できなくなります。</li>" +
      "<li>Siri・Copilot等の<b>音声アシスタントやスマートフォン等の別端末の使用も不正行為</b>です（発覚時は同様に扱います）。</li>" +
      "<li>解答は教員サーバーへ提出され、<b>端末には残りません</b>。終了時は<b>「提出して終了」</b>を押してください。</li>" +
      (closeAt
        ? "<li>終了予定時刻：<b>" + fmtClock(closeAt) + "</b>（時刻になると<b>自動的に提出</b>されます）</li>"
        : "<li>試験時間：<b>" + DURATION_MIN + "分</b></li>") +
      "</ul>" +
      '<button class="startbtn" id="startBtn">' + (LOCAL_DEV ? "ローカルテストを開始する" : "全画面で試験を開始する") + "</button>" +
      (LOCAL_DEV
        ? '<p class="cnt">🛠 ローカルテストモード：全画面・背面監視は無効です（公開サイトでは通常動作）。</p>'
        : '<p class="cnt">残り強制終了回数：あと ' + rem + " 回</p>"));
    $("#startBtn").addEventListener("click", startExam);
  }

  // 検知理由コード → 学生・教員向けの表示名（§8.1 そのまま）
  const VIOLATION_LABELS = {
    "hidden": "他のタブ・アプリへの切り替え（背面化）",
    "blur": "ウィンドウのフォーカス喪失（他アプリ操作）",
    "focus-lost": "ウィンドウのフォーカス喪失（他アプリ操作）",
    "exit-fullscreen": "全画面の解除",
    "fullscreen-lost": "全画面の解除",
    "window-resize": "ウィンドウの縮小・画面分割",
    "window-shrunk": "ウィンドウの縮小・画面分割",
    "multi-display": "外部ディスプレイの接続",
    "pagehide": "試験ページからの離脱（再読み込み・移動）",
  };
  function screenViolation(count, reason) {
    monitoring = false;
    const rem = MAX_VIOLATIONS - count;
    const label = VIOLATION_LABELS[reason] || "規定外の画面操作";
    showOverlay("warn",
      '<div class="big">⚠️</div>' +
      "<h1>不正につながる操作を検知しました</h1>" +
      "<p>検知内容：<b>" + esc(label) + "</b>（" + esc(reason || "-") + "）</p>" +
      "<p>試験を強制終了します。</p>" +
      "<p>強制終了：<b>" + count + " / " + MAX_VIOLATIONS + " 回</b></p>" +
      (rem > 0
        ? '<p class="cnt">あと ' + rem + " 回で受験できなくなります。ウィンドウは自動的に閉じます。</p>"
        : '<p class="cnt">上限に達しました。以降は受験できません。</p>'));
  }

  // ページ内の確認モーダル（native confirm を使わない＝ウィンドウblurを起こさず監視を継続）（§8.1 そのまま）
  function showConfirm(message) {
    return new Promise((resolve) => {
      const o = el("div");
      o.id = "confirmModal";
      o.className = "overlay";
      o.style.background = "rgba(13,27,62,.82)";
      o.innerHTML =
        '<div class="card">' +
        '<h1 style="font-size:22px">確認</h1>' +
        '<p style="font-size:16px">' + esc(message) + "</p>" +
        '<div style="margin-top:18px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap">' +
        '<button class="startbtn" id="cfYes" style="background:#1a56db;color:#fff;font-size:16px;padding:12px 26px">はい（提出する）</button>' +
        '<button class="startbtn" id="cfNo" style="background:#6b7480;color:#fff;font-size:16px;padding:12px 26px">いいえ（試験に戻る）</button>' +
        "</div></div>";
      document.body.appendChild(o);
      const done = (val) => { o.remove(); resolve(val); };
      o.querySelector("#cfYes").addEventListener("click", () => done(true));
      o.querySelector("#cfNo").addEventListener("click", () => done(false));
    });
  }

  /* =====================================================================
   *  試験開始 ＆ 監視（§8.1 そのまま L252-277）
   * ===================================================================== */
  function startExam() {
    // 複数ディスプレイ（拡張画面）では開始させない（別画面でのカンニング防止）
    if (!LOCAL_DEV && isMultiDisplay()) { screenMultiDisplay(); return; }
    let st = parseInt(localStorage.getItem(K.start) || "0", 10);
    if (!st) { st = Math.round(serverNow()); localStorage.setItem(K.start, String(st)); }
    // 終了時刻：スケジュール(closeAt)があれば全員その時刻、無ければ「開始＋試験時間」
    endTime = closeAt ? closeAt : (st + DURATION_MIN * 60 * 1000);

    const root = document.documentElement;
    if (!LOCAL_DEV) {                       // ローカル確認時は全画面を強制しない
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) { try { req.call(root); } catch (e) {} }
    }

    hideOverlay();
    document.body.classList.add("exam-active");
    startTimer();

    if (LOCAL_DEV) {
      showLocalDevBanner();               // ローカル確認時は背面監視を行わない（テストを中断させない）
    } else {
      // 開始直後の一瞬のフォーカス揺れを無視してから監視開始（800ms実績値。内部設計書§9.1）
      setTimeout(() => { monitoring = true; }, 800);
      startWatchdog();
    }
  }

  /* ---------- 複数ディスプレイ（拡張画面）検知（§8.1 そのまま） ---------- */
  function isMultiDisplay() {
    try { return window.screen && screen.isExtended === true; } catch (e) { return false; }
  }
  function screenMultiDisplay() {
    showOverlay("warn",
      '<div class="big">🖥️</div>' +
      "<h1>外部ディスプレイが検出されました</h1>" +
      "<p>この試験は<b>1画面のみ</b>で受験できます。</p>" +
      "<p>外部ディスプレイ・プロジェクタ等をすべて取り外してから再開してください。</p>" +
      '<button class="startbtn" id="mdRetry">取り外したので確認する</button>');
    $("#mdRetry").addEventListener("click", () => {
      if (isMultiDisplay()) { screenMultiDisplay(); return; }
      screenStart();
    });
  }

  /* ---------- Keyboard Lock（全画面中は Esc / Ctrl+T / Ctrl+N / Ctrl+W 等を捕捉）（§8.1 そのまま） ---------- */
  function lockKeyboard() {
    try { if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {}); } catch (e) {}
  }
  function unlockKeyboard() {
    try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch (e) {}
  }

  /* ---------- ウィンドウ縮小（二分割・スナップ・リサイズ）検知（§8.1 そのまま） ----------
   *  outerWidth/Height はブラウザズーム(Ctrl + +/-)の影響を受けないため、
   *  拡大表示している学生を誤検知しない。DevTools はフォーカス喪失で検知される。
   *  許容幅80px(横)/130px(縦)は内部設計書§9.1実績値。 */
  function isShrunk() {
    const tolW = 80, tolH = 130;   // OSスケーリング誤差の許容幅
    return (window.outerWidth < screen.width - tolW) || (window.outerHeight < screen.height - tolH);
  }

  /* ---------- 毎秒の常時監視（イベントを取り逃しても必ず検知する保険）（§8.1 そのまま。周期1000ms） ---------- */
  function startWatchdog() {
    if (LOCAL_DEV || watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (!monitoring || examFinished) return;
      if (!document.hasFocus()) return violation("focus-lost");
      if (!document.fullscreenElement) {
        if (everFullscreen) return violation("fullscreen-lost");
        // 一度も全画面に入れていない（許可されない環境）→ 不正ではなく再試行を促す
        if (++fsFailTicks >= 4) { fsFailTicks = 0; monitoring = false; screenFsRetry(); }
        return;
      }
      if (isShrunk()) return violation("window-shrunk");
      if (isMultiDisplay()) return violation("multi-display");
    }, 1000);
  }
  function stopWatchdog() { clearInterval(watchdogTimer); watchdogTimer = null; }

  function screenFsRetry() {
    showOverlay("warn",
      '<div class="big">🖥️</div>' +
      "<h1>全画面に切り替えられませんでした</h1>" +
      "<p>下のボタンを押して全画面で再開してください。全画面にしないと受験できません。</p>" +
      '<button class="startbtn" id="fsRetry">全画面で再開する</button>');
    $("#fsRetry").addEventListener("click", () => {
      hideOverlay();
      const root = document.documentElement;
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) { try { req.call(root); } catch (e) {} }
      setTimeout(() => { monitoring = true; }, 800);
    });
  }

  // ローカル動作確認中であることを示す固定バナー（公開サイトでは表示されない）（§8.1 そのまま）
  function showLocalDevBanner() {
    if ($("#localDevBar")) return;
    const b = el("div");
    b.id = "localDevBar";
    b.textContent = "🛠 ローカルテストモード — 全画面・背面監視は無効です（提出は端末内のみ）。公開サイトでは通常どおり全画面・監視が働きます。";
    b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2000;background:#7a3aed;color:#fff;" +
      "font-size:12.5px;text-align:center;padding:6px 10px;font-weight:700;box-shadow:0 -2px 8px rgba(0,0,0,.2)";
    document.body.appendChild(b);
  }

  /* violation(): 実装指示書P2-6-8・§8.2改変。冒頭にジッター待機中ガードを追加。
   * pagehideのみジッター待機中も違反計上する（FR-C11。内部設計書§3.1 hint「pagehide以外の
   * 離脱系検知を違反としてカウントしない」）。他のロジックは§8.1同様に不変。 */
  function violation(reason) {
    if (jitterWaiting && reason !== "pagehide") return; // FR-C11ジッターガード（新規追加行）
    if (!monitoring || examFinished || violating) return;
    violating = true;
    monitoring = false;
    stopWatchdog();
    unlockKeyboard();
    const count = incViolations();
    screenViolation(count, reason);
    // 不正答案として教員専用領域へ保存してから、ブラウザを強制終了する
    const data = collectAnswers();
    data.draws_png = {};
    Object.keys(drawpads).forEach((id) => { data.draws_png[id] = drawpads[id].toPNG(); });
    data.submittedAt = new Date().toISOString();
    data.reason = reason;
    const payload = buildPayload(data, "violation", buildAnswerSheet(data));
    purgeLocal(); // 端末に解答・問題を残さない（不正カウントは保持）
    let closed = false;
    const closeNow = () => {
      if (closed) return; closed = true;
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
      try { window.close(); } catch (e) {}
      // window.close が効かない場合は、上限ならブロック表示を維持
      setTimeout(() => { if (count >= MAX_VIOLATIONS) screenBlocked(); }, 600);
    };
    sendToServer(payload).then(() => setTimeout(closeNow, 600));
    setTimeout(closeNow, 3000); // 送信が滞っても最大3秒で強制終了
  }

  /* bindMonitors(): §8.1 そのまま（visibilitychange/blur120ms/fullscreenchange/resize250ms/
   * beforeunload/pagehide+sendBeacon）。pagehideハンドラのbuildPayload呼出のみ
   * §8.2の変更（sid/name削除・idToken/examId追加）に自動的に追随する。 */
  function bindMonitors() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) violation("hidden");
    });
    window.addEventListener("blur", () => {
      setTimeout(() => { if (!document.hasFocus()) violation("blur"); }, 120); // blur確定待ち120ms実績値
    });
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement) { everFullscreen = true; fsFailTicks = 0; lockKeyboard(); return; }
      if (monitoring && !examFinished) violation("exit-fullscreen");
    });
    // 二分割画面・スナップ・ウィンドウ縮小の即時検知（watchdog でも毎秒確認）
    window.addEventListener("resize", () => {
      if (!monitoring || examFinished) return;
      setTimeout(() => { if (monitoring && !examFinished && isShrunk()) violation("window-resize"); }, 250);
    });
    // 試験中のページ離脱（再読み込み・URL移動・ウィンドウを閉じる）＝他情報閲覧の抜け道
    // → ブラウザの確認ダイアログで警告し、それでも離脱したら不正1回として端末とサーバーに記録
    window.addEventListener("beforeunload", (e) => {
      if (monitoring && !examFinished && !violating) { e.preventDefault(); e.returnValue = ""; }
    });
    window.addEventListener("pagehide", () => {
      if (!monitoring || examFinished || violating) return;
      const n = incViolations();
      try {
        if (GAS_ENDPOINT && navigator.sendBeacon) {
          const data = collectAnswers();
          data.submittedAt = new Date().toISOString();
          data.reason = "pagehide(n=" + n + ")";
          // 離脱中でも確実に届く sendBeacon で「不正答案」としてサーバーへ記録
          navigator.sendBeacon(GAS_ENDPOINT,
            new Blob([JSON.stringify(buildPayload(data, "violation", ""))], { type: "text/plain;charset=utf-8" }));
        }
      } catch (e) {}
      purgeLocal();
    });
    bindInputGuards();
  }

  /* ---------- キーボード・クリップボード・右クリック対策（§8.1 そのまま）----------
   *  - 印刷/保存/検索/ソース表示/開発ツール/履歴/ダウンロード等のショートカットを遮断
   *  - Ctrl+T 等ページから遮断できないキーは、全画面中は Keyboard Lock が捕捉し、
   *    万一実行されても背面化/全画面解除として不正検知される（二重防御）
   *  - 問題文のコピー禁止。貼り付けは「このページ内でコピーした内容」のみ許可
   *    （事前にクリップボードへ仕込んだ答え・音声入力アプリ経由の持ち込みを遮断）
   *  - 図形描画(DrawPad)内の ⌘/Ctrl+C・V・D は図形操作用なので遮断しない
   */
  function bindInputGuards() {
    const inDrawpad = (t) => !!(t && t.closest && t.closest(".drawpad"));
    const inAnswer = (t) => !!(t && t.matches && t.matches("textarea.ansin,textarea.codein"));

    window.addEventListener("keydown", (e) => {
      if (examFinished) return;
      const k = (e.key || "").toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && inDrawpad(e.target) && ["c", "v", "d", "x"].includes(k)) return; // DrawPadの図形操作
      const blockedFn = ["f1", "f3", "f5", "f6", "f7", "f12"].includes(k);
      const blockedMod = mod && ["p", "s", "f", "g", "u", "o", "j", "h", "e", "k", "l", "r", "t", "n", "w", "d", "b"].includes(k);
      const blockedShift = mod && e.shiftKey && ["i", "j", "c", "o", "p", "n", "t", "w", "delete"].includes(k);
      if (blockedFn || blockedMod || blockedShift) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    document.addEventListener("copy", (e) => {
      if (examFinished) return;
      const t = e.target;
      if (!inAnswer(t)) { e.preventDefault(); return; }   // 問題文・ページのコピー禁止
      internalClip = t.value.substring(t.selectionStart, t.selectionEnd);
    }, true);
    document.addEventListener("cut", (e) => {
      if (examFinished) return;
      const t = e.target;
      if (!inAnswer(t)) { e.preventDefault(); return; }
      internalClip = t.value.substring(t.selectionStart, t.selectionEnd);
    }, true);
    document.addEventListener("paste", (e) => {
      if (examFinished) return;
      let txt = "";
      try { txt = e.clipboardData.getData("text/plain"); } catch (err) {}
      // ページ内でコピーした内容以外（外部から持ち込んだクリップボード）は貼り付け不可
      if (internalClip === null || txt !== internalClip) e.preventDefault();
    }, true);
    document.addEventListener("contextmenu", (e) => { if (!examFinished) e.preventDefault(); }, true);
    document.addEventListener("dragstart", (e) => { if (!examFinished) e.preventDefault(); }, true);
  }

  /* ---------- タイマー ----------
   * 実装指示書P2-6-8: tick()のms<=0時の分岐をAutoSubmitScheduler.scheduleAutoSubmit()に差替え
   * （内部設計書§3.1 hint・§4.4）。他は§8.1同様不変。 */
  function startTimer() {
    const t = $("#timer");
    const tick = () => {
      const ms = endTime - serverNow();
      if (ms <= 0) {                       // 終了時刻到来 → ジッター待機を挟んで自動提出
        t.textContent = "00:00";
        clearInterval(tickTimer);
        AutoSubmitScheduler.scheduleAutoSubmit();
        return;
      }
      t.textContent = fmtRemain(ms);
      if (ms < 5 * 60000) t.style.background = "rgba(220,30,30,.5)";
    };
    tick(); tickTimer = setInterval(tick, 1000);
  }

  /* =====================================================================
   *  AutoSubmitScheduler（実装指示書§8.3新規・内部設計書§3.1/§4.4）
   *  終了時刻到来時、解答を即座に固定してからジッター待機し、待機後に
   *  status="timeout"でfinishExamWithDataを呼ぶ。200名同時のGASクォータ
   *  超過を防ぐための平準化（外部設計書FR-C10/C11・内部設計書§9.3）。
   * ===================================================================== */
  const AutoSubmitScheduler = {
    // uniform(0, TIMEOUT_JITTER_MS) の一様乱数（内部設計書§4.4 computeJitterDelay_ms）
    computeJitterDelay_ms() {
      return Math.random() * TIMEOUT_JITTER_MS;
    },

    scheduleAutoSubmit() {
      jitterWaiting = true; // (a) IntegrityMonitorのpagehide以外の離脱系検知を止める
      // (b) 即座に解答を固定する（以後は変更されない。内部設計書§4.4「AnswerData（以後は変更されない）」）
      const data = collectAnswers();
      data.draws_png = {};
      Object.keys(drawpads).forEach((id) => { data.draws_png[id] = drawpads[id].toPNG(); });

      // (c) 入力欄readonly化＋「終了処理中…」オーバーレイ表示（固定済み解答を保証）
      document.querySelectorAll("textarea.ansin,textarea.codein").forEach((t) => { t.readOnly = true; });
      document.querySelectorAll(".codebox select").forEach((s) => { s.disabled = true; });
      this._showJitterOverlay();

      // (d) ジッター待機
      const delay = this.computeJitterDelay_ms();
      setTimeout(() => { this.onJitterElapsed(data); }, delay);
    },

    _showJitterOverlay() {
      if ($("#jitterWait")) return;
      const o = el("div", "jitter-wait");
      o.id = "jitterWait";
      o.innerHTML = '<div class="card"><div class="spinner"></div><h1>終了処理中…</h1>' +
        "<p>試験時間になりました。解答を提出しています。しばらくお待ちください。</p></div>";
      document.body.appendChild(o);
    },

    // (e) ジッター経過後：待機解除→timeout提出（内部設計書§4.4 onJitterElapsed）
    async onJitterElapsed(data) {
      jitterWaiting = false;
      data.submittedAt = new Date().toISOString();
      data.reason = "";
      await finishExamWithData(data, "timeout");
    },
  };

  /* =====================================================================
   *  解答の保存・復元（試験中の一時保存。提出/不正時に消去）
   * ===================================================================== */
  // collectAnswers(): 実装指示書P2-6-6-7・§8.2改変。sid/name削除、choices収集を追加。
  function collectAnswers() {
    const data = { ts: Date.now(), texts: {}, codes: {}, draws: {}, choices: {} };
    document.querySelectorAll("textarea.ansin").forEach((t) => { data.texts[t.dataset.id] = t.value; });
    document.querySelectorAll("textarea.codein").forEach((t) => {
      data.codes[t.dataset.id] = { lang: t.dataset.lang || "python", code: t.value };
    });
    Object.keys(drawpads).forEach((id) => { data.draws[id] = drawpads[id].toJSON(); });
    // 選択式（FR-C04）：qId毎に選択されたchoice.idの配列
    document.querySelectorAll(".choicebox").forEach((box) => {
      const qId = box.dataset.id;
      const checked = Array.from(box.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked'));
      data.choices[qId] = checked.map((c) => c.value);
    });
    return data;
  }
  function saveAnswers() {
    if (examFinished) return;
    try { localStorage.setItem(K.a, JSON.stringify(collectAnswers())); } catch (e) {}
    const s = $("#saveState"); if (s) { s.textContent = "一時保存 " + new Date().toLocaleTimeString("ja-JP"); }
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveAnswers, 600); }

  // restoreAnswers(): 実装指示書P2-6-7・§8.2改変。choices復元を追加。
  function restoreAnswers() {
    let saved; try { saved = JSON.parse(localStorage.getItem(K.a) || "{}"); } catch (e) { saved = {}; }
    if (!saved) return;
    if (saved.texts) Object.keys(saved.texts).forEach((id) => {
      const t = document.querySelector('textarea.ansin[data-id="' + CSS.escape(id) + '"]');
      if (t) t.value = saved.texts[id];
    });
    if (saved.codes) Object.keys(saved.codes).forEach((id) => {
      const t = document.querySelector('textarea.codein[data-id="' + CSS.escape(id) + '"]');
      if (t) { t.value = saved.codes[id].code || ""; if (saved.codes[id].lang) { t.dataset.lang = saved.codes[id].lang;
        const sel = t.parentElement.querySelector("select"); if (sel) sel.value = saved.codes[id].lang; } }
    });
    if (saved.draws) Object.keys(saved.draws).forEach((id) => {
      if (drawpads[id]) drawpads[id].fromJSON(saved.draws[id]);
    });
    if (saved.choices) Object.keys(saved.choices).forEach((qId) => {
      const ids = saved.choices[qId] || [];
      const box = document.querySelector('.choicebox[data-id="' + CSS.escape(qId) + '"]');
      if (!box) return;
      ids.forEach((cid) => {
        const input = box.querySelector('input[value="' + CSS.escape(cid) + '"]');
        if (input) { input.checked = true; const it = input.closest(".choice-item"); if (it) it.classList.add("checked"); }
      });
    });
  }

  /* =====================================================================
   *  問題の描画（ExamRenderer。§8.1 そのまま部分＋§8.2/§8.3の選択式追加）
   * ===================================================================== */
  function buildExam() {
    document.title = EXAM.title;
    $("#examTitle").textContent = EXAM.title;
    $("#examSub").textContent = EXAM.subtitle || "";
    $("#headWho").textContent = NAME + "（" + SID + "）"; // サーバー確定値（内部設計書§4.1）

    if (EXAM.notes && EXAM.notes.length) {
      const n = $("#notes");
      n.innerHTML = "<ul>" + EXAM.notes.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>";
    }

    const root = $("#sections");
    EXAM.sections.forEach((sec) => root.appendChild(renderSection(sec)));

    // DrawPad はDOM追加後にサイズ確定（生成時は detached で幅0のため）
    Object.keys(drawpads).forEach((id) => { drawpads[id].resize(); drawpads[id].render(); });

    restoreAnswers();

    document.addEventListener("input", (e) => {
      if (e.target.matches("textarea.ansin,textarea.codein")) scheduleSave();
    });
    // 選択式（radio/checkbox）はinputイベントが発火しないブラウザがあるためchangeでも保存（実装指示書P2-6-7）
    document.addEventListener("change", (e) => {
      if (e.target.matches('.choicebox input[type="radio"],.choicebox input[type="checkbox"]')) scheduleSave();
    });
  }

  function renderSection(sec) {
    const s = el("section", "section");
    const head = el("div", "head");
    head.appendChild(el("span", "qno", esc(sec.number)));
    if (sec.points != null) head.appendChild(el("span", "pts", "（" + sec.points + "点）"));
    s.appendChild(head);

    if (sec.instruction) s.appendChild(el("p", "instr", esc(sec.instruction)));
    if (sec.summary) s.appendChild(el("div", "summary", esc(sec.summary)));
    if (sec.explain) s.appendChild(el("div", "explain", esc(sec.explain)));

    if (sec.table) s.appendChild(renderTable(sec.table, "qtab"));
    if (sec.image) s.appendChild(renderImage(sec.image));
    if (sec.code) { const pre = el("pre", "code"); pre.textContent = sec.code; s.appendChild(pre); }
    if (sec.reviewTable) s.appendChild(renderTable(sec.reviewTable, "review"));
    if (sec.wordbankGroups || sec.wordbank) s.appendChild(renderWordbank(sec.wordbank, sec.wordbankGroups));

    (sec.answers || []).forEach((a) => s.appendChild(renderAnswer(a)));
    return s;
  }

  function renderTable(t, cls) {
    const tab = el("table", cls);
    if (t.head) {
      const tr = el("tr");
      t.head.forEach((h) => tr.appendChild(el("th", null, esc(h))));
      tab.appendChild(tr);
    }
    t.rows.forEach((r) => {
      const tr = el("tr");
      r.forEach((c) => tr.appendChild(el("td", null, esc(c))));
      tab.appendChild(tr);
    });
    return tab;
  }

  function renderImage(img) {
    const fig = el("div", "qfig");
    const wrap = el("div", "figwrap");
    const im = el("img");
    im.src = img.src; im.alt = img.alt || "";
    if (img.maxWidth) im.style.maxWidth = img.maxWidth + "px";
    wrap.appendChild(im);
    if (img.cropCaption) wrap.appendChild(el("div", "figcover"));
    fig.appendChild(wrap);
    return fig;
  }

  function renderWordbank(words, groups) {
    const w = el("div", "wordbank");
    w.appendChild(el("div", "wbt", "【語群】（未使用・複数回使用可）"));
    if (Array.isArray(groups) && groups.length) {
      groups.forEach((g) => {
        w.appendChild(el("div", "wbg", g.title));
        const chips = el("div", "chips");
        (g.words || []).forEach((x) => chips.appendChild(el("span", "chip", esc(x))));
        w.appendChild(chips);
      });
    } else {
      const chips = el("div", "chips");
      (words || []).forEach((x) => chips.appendChild(el("span", "chip", esc(x))));
      w.appendChild(chips);
    }
    return w;
  }

  // renderAnswer(): 実装指示書P2-6-7・§8.2改変。type:"choice"分岐を追加（renderChoiceへ）。
  function renderAnswer(a) {
    const box = el("div", "ans");
    const tagcls = a.type === "draw" ? "tag draw" : a.type === "code" ? "tag code" : a.type === "choice" ? "tag choice" : "tag";
    const tagtxt = a.type === "draw" ? "図形描画" : a.type === "code" ? "プログラム" : a.type === "choice" ? "選択" : "記述";
    const lbl = el("div", "lbl");
    lbl.innerHTML = '<span class="' + tagcls + '">' + tagtxt + "</span><span>" + esc(a.label || "") + "</span>";
    box.appendChild(lbl);

    if (a.type === "draw") {
      const host = el("div");
      box.appendChild(host);
      drawpads[a.id] = new DrawPad(host, { height: a.height || 420, template: a.template, onChange: scheduleSave });
    } else if (a.type === "code") {
      box.appendChild(renderCode(a));
    } else if (a.type === "choice") {
      box.appendChild(renderChoice(a));
    } else {
      const ta = el("textarea", "ansin");
      ta.dataset.id = a.id;
      ta.rows = a.rows || 3;
      if (a.placeholder) ta.placeholder = a.placeholder;
      box.appendChild(ta);
    }
    return box;
  }

  /* renderChoice(): 実装指示書§8.3新規・内部設計書§3.1 ExamRenderer.renderChoice（FR-C04/C09）。
   * multiple=falseならradio・trueならcheckbox。name=qId、値=choice.id。
   * シャッフルはGAS側(ExamService.getQuestionsForStudent)で済み、ここではchoices配列の順に描画する。 */
  function renderChoice(a) {
    const wrap = el("div", "choicebox");
    wrap.dataset.id = a.id;
    const inputType = a.multiple ? "checkbox" : "radio";
    (a.choices || []).forEach((c, idx) => {
      const item = el("label", "choice-item");
      const input = document.createElement("input");
      input.type = inputType;
      input.name = a.multiple ? (a.id + "_" + c.id) : a.id; // radioは同名でグループ化。checkboxは個別
      input.value = c.id;
      item.appendChild(input);
      item.appendChild(el("span", "choice-label", esc(c.text || "")));
      input.addEventListener("change", () => {
        // .checkedスタイル反映（同名radioグループは全item再評価、checkboxは自身のみでよい）
        const groupSel = a.multiple ? null : 'input[name="' + CSS.escape(input.name) + '"]';
        (groupSel ? wrap.querySelectorAll(groupSel) : [input]).forEach((inp) => {
          inp.closest(".choice-item").classList.toggle("checked", inp.checked);
        });
      });
      wrap.appendChild(item);
    });
    return wrap;
  }

  function renderCode(a) {
    const cb = el("div", "codebox");
    const bar = el("div", "cbar");
    bar.appendChild(el("span", null, "言語："));
    const sel = el("select");
    ["python", "c"].forEach((l) => {
      const o = el("option"); o.value = l; o.textContent = l === "c" ? "C" : "Python"; sel.appendChild(o);
    });
    bar.appendChild(sel);
    cb.appendChild(bar);
    const ta = el("textarea", "codein");
    ta.dataset.id = a.id;
    ta.dataset.lang = a.lang || "python";
    sel.value = ta.dataset.lang;
    ta.rows = a.rows || 12;
    ta.spellcheck = false;
    ta.placeholder = (a.lang === "c") ? "// ここにCプログラムを記述" : "# ここにPython/Cプログラムを記述";
    sel.addEventListener("change", () => { ta.dataset.lang = sel.value; scheduleSave(); });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") { e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 4;
      }
    });
    cb.appendChild(ta);
    return cb;
  }

  /* =====================================================================
   *  サーバー（教員専用領域）への保存（SubmissionClient）
   * ===================================================================== */
  // buildPayload(): 実装指示書P2-6-6・§7.3 SubmitPayloadDTO。sid/name削除、idToken/examId/choices追加。
  // action:"submit" はGAS側Code.gsのルーティング契約（内部設計書§7.1。POSTはbody.actionで解決）。
  // fetch(sendToServer)・sendBeacon(pagehide)の両経路とも本関数を経由するため、ここで一元付与する。
  function buildPayload(data, status, html) {
    return {
      action: "submit",               // 内部設計書§7.1: 学生系submit。提出種別はstatusで区別
      token: SUBMIT_TOKEN,
      idToken: ID_TOKEN,
      examId: EXAM_ID,
      status: status,                 // "submitted"（提出）/ "violation"（不正）/ "timeout"（自動提出）
      exam: EXAM.title,
      submittedAt: data.submittedAt || new Date().toISOString(),
      durationMin: DURATION_MIN,
      violations: getViolations(),
      reason: data.reason || "",
      texts: data.texts, codes: data.codes, draws: data.draws,
      choices: data.choices || {},
      draws_png: data.draws_png,
      html: html || "",
    };
  }
  // 送信結果: true=送信した / false=失敗 / null=エンドポイント未設定（§8.1 そのまま L686-694）
  function sendToServer(payload) {
    if (!GAS_ENDPOINT) return Promise.resolve(null);
    return fetch(GAS_ENDPOINT, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(() => true).catch(() => false);
  }

  /* ---------- 提出用 解答シート(HTML)（§8.1 そのまま。choice表示追加のみ§8.2） ---------- */
  function buildAnswerSheet(data) {
    let body = "";
    const sheetTable = (t) => {
      let h = "<table class='qt'>";
      if (t.head) h += "<tr>" + t.head.map((x) => "<th>" + esc(x) + "</th>").join("") + "</tr>";
      (t.rows || []).forEach((r) => { h += "<tr>" + r.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>"; });
      return h + "</table>";
    };
    const absUrl = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
    EXAM.sections.forEach((sec) => {
      body += '<section><h2>' + esc(sec.number) + (sec.points != null ? "（" + sec.points + "点）" : "") + "</h2>";
      if (sec.instruction) body += "<p class='ins'>" + esc(sec.instruction) + "</p>";
      // 採点に必要な問題コンテキスト（プログラム本文・表・図・語群）も同梱して自己完結に
      if (sec.summary) body += "<p class='ctx'>" + esc(sec.summary) + "</p>";
      if (sec.explain) body += "<p class='ctx'>" + esc(sec.explain) + "</p>";
      if (sec.table) body += sheetTable(sec.table);
      if (sec.image) body += "<div class='qimg'><img src='" + esc(absUrl(sec.image.src)) + "'></div>";
      if (sec.code) body += "<pre class='qcode'>" + esc(sec.code) + "</pre>";
      if (sec.reviewTable) body += sheetTable(sec.reviewTable);
      if (sec.wordbank) body += "<p class='ctx'><b>【語群】</b> " + sec.wordbank.map(esc).join(" ／ ") + "</p>";
      (sec.answers || []).forEach((a) => {
        body += "<div class='a'><div class='l'>" + esc(a.label || "") + "</div>";
        if (a.type === "draw") {
          const png = data.draws_png[a.id];
          body += png ? "<img src='" + png + "'>" : "<i>（無解答）</i>";
        } else if (a.type === "code") {
          const c = data.codes[a.id] || {};
          body += "<div class='lang'>言語: " + esc(c.lang || "") + "</div><pre>" + esc(c.code || "") + "</pre>";
        } else if (a.type === "choice") {
          // 選択IDと表示テキストを併記（FR-C04。実装指示書P2-6-7）
          const selectedIds = (data.choices && data.choices[a.id]) || [];
          const idToText = {};
          (a.choices || []).forEach((c) => { idToText[c.id] = c.text; });
          if (selectedIds.length) {
            body += "<ul class='choiceans'>" + selectedIds.map((cid) =>
              "<li>" + esc(idToText[cid] != null ? idToText[cid] : cid) + "（" + esc(cid) + "）</li>").join("") + "</ul>";
          } else {
            body += "<i>（無解答）</i>";
          }
        } else {
          body += "<pre class='txt'>" + esc(data.texts[a.id] || "") + "</pre>";
        }
        body += "</div>";
      });
      body += "</section>";
    });
    return "<!DOCTYPE html><html lang='ja'><head><meta charset='utf-8'>" +
      "<title>解答 " + esc(SID) + " " + esc(NAME) + "</title><style>" +
      "body{font-family:'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;max-width:900px;margin:24px auto;padding:0 16px;line-height:1.7;color:#1f2733}" +
      "h1{font-size:22px}h2{border-bottom:2px solid #1a56db;color:#143fa3;margin-top:28px;font-size:18px}" +
      ".meta{background:#eef2fb;padding:10px 14px;border-radius:8px}.ins{color:#555;font-size:13px}" +
      ".a{margin:12px 0}.l{font-weight:600;font-size:14px;margin-bottom:4px}" +
      "pre{white-space:pre-wrap;background:#f6f7f9;border:1px solid #ddd;border-radius:8px;padding:10px 12px;font-family:inherit}" +
      "pre.txt{min-height:1em}.lang{font-size:12px;color:#666}img{max-width:100%;border:1px solid #ccc;border-radius:8px}" +
      ".ctx{background:#f0f4ff;border-left:3px solid #1a56db;padding:8px 12px;border-radius:6px;font-size:13px;margin:8px 0}" +
      "pre.qcode{background:#0f172a;color:#e2e8f0;font-family:Consolas,Menlo,monospace;font-size:12.5px;white-space:pre;overflow:auto}" +
      "table.qt{border-collapse:collapse;margin:8px 0;font-size:12.5px}table.qt th,table.qt td{border:1px solid #bbb;padding:4px 8px;text-align:left;vertical-align:top}table.qt th{background:#eef2fb}.qimg{margin:8px 0}" +
      "ul.choiceans{margin:4px 0;padding-left:20px}" +
      "@media print{h2{break-after:avoid}.a{break-inside:avoid}}</style></head><body>" +
      "<h1>" + esc(EXAM.title) + " — 解答</h1>" +
      "<div class='meta'>学籍番号：" + esc(SID) + "　氏名：" + esc(NAME) +
      "　提出：" + esc(new Date(data.submittedAt).toLocaleString("ja-JP")) + "</div>" +
      body + "</body></html>";
  }

  /* =====================================================================
   *  提出
   *  finishExam(auto): §8.2改変。後段をfinishExamWithData(data,status)に分離し、
   *  手動提出（status="submitted"）とtimeout（AutoSubmitScheduler経由）が
   *  同一経路を通る構造にする（FR-C10「同一の送信・保存確認・暗号化フォールバック処理」）。
   * ===================================================================== */
  async function finishExam(auto) {
    if (examFinished) return;
    // 確認はページ内モーダル（監視は止めない＝確認中の背面化も検知される）
    if (!auto) {
      const ok = await showConfirm("解答を提出して試験を終了します。よろしいですか？");
      if (!ok) return;            // 「いいえ」なら試験継続（監視は継続中）
      if (examFinished || violating) return; // 確認中に不正等が発生した場合は中断
    }
    const data = collectAnswers();
    data.draws_png = {};
    Object.keys(drawpads).forEach((id) => { data.draws_png[id] = drawpads[id].toPNG(); });
    data.submittedAt = new Date().toISOString();
    await finishExamWithData(data, "submitted");
  }

  // finishExamWithData(): 実装指示書P2-6-8新規分離。E-07: 送信失敗時も固定済みdataを使い回す。
  async function finishExamWithData(data, status) {
    if (examFinished) return;
    examFinished = true;
    monitoring = false;
    stopWatchdog();
    unlockKeyboard();
    clearInterval(tickTimer);

    const ss = $("#saveState"); if (ss) ss.textContent = "サーバーへ送信中…";
    await sendToServer(buildPayload(data, status, buildAnswerSheet(data)));
    // no-cors送信は成否を読めないため、サーバーに「保存されたか」を確認(GET)する
    const saved = GAS_ENDPOINT ? await verifySaved() : null;

    let encrypted = false;
    if (saved === false) {
      // 不正防止：端末に平文(HTML/JSON)は残さない。公開鍵が設定されていれば暗号化した控えのみDL。
      // done未設定・解答保持にして、再読み込みでの再提出を可能にする。
      encrypted = await saveEncryptedFallback(data);
    } else {
      if (KEEP_LOCAL_DOWNLOAD) downloadAnswerFiles(data);
      purgeLocal();
      try { localStorage.setItem(K.done, "1"); } catch (e) {} // 保存確認できた時のみ提出済み＝再受験不可
    }

    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
    const jw = $("#jitterWait"); if (jw) jw.remove();
    showDone(data, saved, encrypted);
  }

  // verifySaved(): 実装指示書P2-6-5・§8.2改変。クエリにexamId・idToken（sid削除）。リトライ回数・間隔は不変。
  async function verifySaved() {
    const qs = "action=status&token=" + encodeURIComponent(SUBMIT_TOKEN)
      + "&examId=" + encodeURIComponent(EXAM_ID)
      + "&idToken=" + encodeURIComponent(ID_TOKEN);
    const ask = async () => {
      try {
        const r = await fetch(GAS_ENDPOINT + "?" + qs + "&t=" + Date.now(), { method: "GET" });
        return await r.json();
      } catch (e) {
        try { return await jsonp(GAS_ENDPOINT + "?" + qs); } catch (e2) { return null; }
      }
    };
    for (let i = 0; i < 3; i++) {                        // 提出保存確認リトライ回数3回（内部設計書§9.1実績値）
      const j = await ask();
      if (j && j.ok && j.submitted) return true;
      await new Promise((r) => setTimeout(r, 1500));   // doPost反映待ちで数回リトライ（1500ms実績値）
    }
    return false;
  }

  function showDone(data, sent, encrypted) {
    document.body.classList.remove("exam-active");
    hideOverlay();
    $("#examMain").style.display = "none";
    const v = $("#doneView");
    v.style.display = "block";
    v.querySelector(".name").textContent = NAME + "（" + SID + "）";

    const icon = v.querySelector("#doneIcon");
    const head = v.querySelector("#doneHead");
    const st = v.querySelector("#serverState");
    const msg = v.querySelector("#doneMsg");
    const ok = (sent === true || sent === null);   // null＝サーバー未設定（従来動作）

    if (ok) {
      if (icon) icon.textContent = "✅";
      if (head) head.textContent = "提出が完了しました";
      if (st) { st.textContent = (sent === true) ? "✅ 解答を教員サーバーに保存しました。" : "✅ 提出が完了しました。"; st.style.color = "#0a8a5f"; }
      if (msg) msg.textContent = "お疲れさまでした。このウィンドウは閉じてかまいません。";
    } else {
      if (icon) icon.textContent = "⚠️";
      if (head) head.textContent = "サーバー保存を確認できませんでした";
      if (st) {
        st.innerHTML = encrypted
          ? "暗号化した解答の控えをダウンロードしました。担当教員に提出してください。<br><b>ページを再読み込みすると再提出できます。</b>"
          : "<b>担当教員にすぐ申し出てください。</b><br>ページを再読み込みすると再提出できます。";
        st.style.color = "#c0392b";
      }
      if (msg) msg.textContent = "";
    }

    // 平文(HTML/JSON)の控えDLは「教員が許可（KEEP_LOCAL_DOWNLOAD）」かつ成功時のみ。
    // 保存失敗時は平文を一切出さない（不正防止。必要時は暗号化ファイルのみ）
    const dlBox = v.querySelector("#dlBox");
    const dlH = v.querySelector("#dlHtml"), dlJ = v.querySelector("#dlJson");
    if (KEEP_LOCAL_DOWNLOAD && ok) {
      if (dlBox) dlBox.style.display = "";
      if (dlH) dlH.onclick = () => saveBlob(htmlBlob(data), filename("html"));
      if (dlJ) dlJ.onclick = () => saveBlob(jsonBlob(data), filename("json"));
    } else if (dlBox) {
      dlBox.style.display = "none";
    }
    const cw = v.querySelector("#closeWin");
    if (cw) cw.onclick = () => { try { window.close(); } catch (e) {} };
  }

  // filename(): 実装指示書P2-6-8。プレフィックスexamforge_に変更（新システム名。軽微）。
  function filename(ext) {
    return "examforge_" + (SID || "anon") + "_" + (NAME || "") + "." + ext;
  }
  function jsonBlob(data) { return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); }
  function htmlBlob(data) { return new Blob([buildAnswerSheet(data)], { type: "text/html;charset=utf-8" }); }

  /* ---------- 保存失敗時のフォールバック：公開鍵で暗号化（教員のみ復号可）（§8.1 そのまま） ---------- */
  function _b64(buf) { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  async function encryptForTeacher(obj) {
    const pub = CFG.ANSWER_PUBKEY;   // RSA-OAEP 公開鍵(JWK)。config.js に設定（公開して安全）
    if (!pub || !window.crypto || !crypto.subtle) return null;
    try {
      const rsa = await crypto.subtle.importKey("jwk", pub, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(JSON.stringify(obj));
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aes, plain);
      const rawAes = await crypto.subtle.exportKey("raw", aes);
      const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawAes); // AES鍵をRSAで包む
      return { v: 1, alg: "RSA-OAEP-256+AES-GCM-256", sid: SID, name: NAME, ts: new Date().toISOString(),
        k: _b64(wrapped), iv: _b64(iv), ct: _b64(ct) };
    } catch (e) { return null; }
  }
  async function saveEncryptedFallback(data) {
    const enc = await encryptForTeacher(data);
    if (!enc) return false;   // 鍵未設定/非対応 → 平文は出さない（何もDLしない）
    saveBlob(new Blob([JSON.stringify(enc)], { type: "application/octet-stream" }), filename("enc.json"));
    return true;
  }
  function downloadAnswerFiles(data) {
    saveBlob(htmlBlob(data), filename("html"));
    saveBlob(jsonBlob(data), filename("json"));
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /* =====================================================================
   *  問題の取得（サーバー配信）＆ 起動
   * ===================================================================== */
  // CORSを回避して別オリジン(GAS)からGET取得するための JSONP（§8.1 そのまま。15000msタイムアウト実績値）
  function jsonp(baseUrl) {
    return new Promise((resolve, reject) => {
      const cb = "efExamCb_" + Math.random().toString(36).slice(2);
      const s = document.createElement("script");
      const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 15000);
      function cleanup() { try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s); clearTimeout(timer); }
      window[cb] = (data) => { cleanup(); resolve(data); };
      s.onerror = () => { cleanup(); reject(new Error("script error")); };
      s.src = baseUrl + "&callback=" + cb + "&t=" + Date.now();
      document.head.appendChild(s);
    });
  }
  // fetchQuestions(): 実装指示書P2-6-4・§8.2改変。クエリをaction=questions&token=…&examId=…&idToken=…に変更（sid/name送らない）。
  async function fetchQuestions() {
    const qs = "action=questions"
      + "&token=" + encodeURIComponent(SUBMIT_TOKEN)
      + "&examId=" + encodeURIComponent(EXAM_ID)
      + "&idToken=" + encodeURIComponent(ID_TOKEN);
    try {
      const r = await fetch(GAS_ENDPOINT + "?" + qs + "&t=" + Date.now(), { method: "GET" });
      return await r.json();                       // 成功(ok:false含む)はそのまま返す
    } catch (e) { /* CORS/通信失敗 → JSONP */ }
    return await jsonp(GAS_ENDPOINT + "?" + qs); // 失敗時のみ
  }

  // window.EXAM(ローカル開発)時のスケジュール判定（§8.1 そのまま）
  function scheduleGate() {
    const now = serverNow();
    if (openAt && now < openAt) return "before";
    if (closeAt && now > closeAt) { screenError("試験時間が終了しました。", "終了: " + fmtClock(closeAt)); return "after"; }
    return "ok";
  }

  // loadExam(): 実装指示書P2-6-9・§8.2改変。応答のsid/name/role取り込み・K初期化・phase:"blocked"分岐追加（G-3）。
  // 返り値: "ok" | "before" | "after" | "done" | "blocked" | "fail"
  async function loadExam() {
    if (EXAM && EXAM.sections) {                    // ローカル開発(window.EXAM)
      if (CFG.SCHEDULE) applySchedule(Object.assign({ serverNow: new Date().toISOString() }, CFG.SCHEDULE));
      return scheduleGate();
    }
    if (!GAS_ENDPOINT) { screenError("試験サーバーが設定されていません。", "担当教員に連絡してください。"); return "fail"; }
    if (!ID_TOKEN || !EXAM_ID) { return "login_required"; } // FSM§5.1 LOGIN_REQUIRED
    screenLoading();
    let j;
    try { j = await fetchQuestions(); }
    catch (e) { screenError("問題の取得に失敗しました。", "通信環境・サーバー設定を確認し、ページを開き直してください。"); return "fail"; }
    if (j && j.schedule) applySchedule(j.schedule);
    // サーバー確定のsid/name/roleを取り込む（内部設計書§4.1「確定したsid/nameを画面に表示」）
    if (j && j.ok && j.sid) { SID = j.sid; NAME = j.name || ""; ROLE = j.role || "student"; initKeys_(); }
    if (j && j.ok && j.exam && j.exam.sections) { EXAM = j.exam; return "ok"; }
    if (j && j.phase === "before") return "before";
    if (j && j.phase === "done") return "done";     // 提出済み（サーバー権威）
    if (j && j.phase === "blocked") return "blocked"; // 疑義G-3: サーバー側違反回数が上限到達
    if (j && j.phase === "after") { screenError(j.message || "試験時間が終了しました。", j.detail || ""); return "after"; }
    if (j && j.error === "ERR_ID_TOKEN") { screenLoginRequired(); return "fail"; }
    if (j && j.error === "ERR_AUTH_UNAVAILABLE") { screenError("認証サーバーに接続できません。", "しばらく待ってから再度お試しください。"); return "fail"; }
    screenError(j && j.message ? j.message : "問題を取得できませんでした。", j && j.detail ? j.detail : "");
    return "fail";
  }

  function screenAlreadyDone() {
    showOverlay("",
      '<div class="big">✅</div>' +
      "<h1>この試験は提出済みです</h1>" +
      "<p>" + esc(NAME) + "（" + esc(SID) + "）</p>" +
      "<p>すでに受験・提出が完了しているため、<b>再受験はできません</b>。</p>" +
      '<p class="cnt">確認事項があれば担当教員に申し出てください。</p>');
  }

  // 開始時刻前：カウントダウンして待機し、時刻になったら自動的に開始可能にする（§8.1 そのまま）
  function waitForOpen() {
    const render = () => {
      const ms = openAt - serverNow();
      if (ms <= 0) { clearInterval(t); boot(); return; }   // 開始時刻 → 再取得して開始へ
      showOverlay("",
        '<div class="big">⏳</div>' +
        "<h1>試験開始までお待ちください</h1>" +
        "<p>" + esc(NAME) + " さん（" + esc(SID) + "）</p>" +
        "<p>開始予定：<b>" + fmtClock(openAt) + "</b>" +
        (closeAt ? "　／　終了予定：<b>" + fmtClock(closeAt) + "</b>" : "") + "</p>" +
        '<p class="cnt">開始まで <b style="font-size:24px">' + fmtRemain(ms) + "</b></p>" +
        '<p class="cnt">この画面のままお待ちください。時刻になると自動的に開始できます。</p>');
    };
    render();
    const t = setInterval(render, 1000);
  }

  // boot(): 実装指示書P2-6-9・§8.2改変。順序変更: Chrome判定→idToken/examId存在確認
  // （無ければscreenLoginRequired）→loadExam→サーバー権威のdone/blocked反映＋端末側K.done/K.v判定
  // →buildExam→bindMonitors→screenStart（FSM§5.1 LOGIN_REQUIRED後に各分岐）。
  async function boot() {
    if (!isChrome()) { screenChromeOnly(); return; }
    if (!ID_TOKEN || !EXAM_ID) { screenLoginRequired(); return; } // FSM§5.1: ログイン未済

    const status = await loadExam();             // サーバーから問題＋スケジュール＋sid/name/role取得
    if (status === "login_required") { screenLoginRequired(); return; }
    if (status === "blocked") { screenBlocked(); return; }        // サーバー権威の違反回数上限（G-3）
    if (status === "before") { waitForOpen(); return; }           // 開始前 → カウントダウン待機
    if (status === "done") { screenAlreadyDone(); return; }       // 提出済み（サーバー権威）→ 再受験不可
    if (status !== "ok") return;                                  // after / fail は画面表示済み

    // K確定後（loadExam成功後）に端末側の violations/done 判定を行う（実装指示書P2-6-3）
    if (K && getViolations() >= MAX_VIOLATIONS) { screenBlocked(); return; }
    if (K && localStorage.getItem(K.done) === "1") { screenAlreadyDone(); return; }

    DURATION_MIN = (EXAM && typeof EXAM.durationMin === "number") ? EXAM.durationMin : 90;

    buildExam();
    bindMonitors();
    $("#submitBtn").addEventListener("click", () => finishExam(false));

    screenStart();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
