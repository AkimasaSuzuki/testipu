/* =====================================================================
 *  setup/wizard.js — ExamForge セットアップウィザード制御
 *
 *  実装指示書§4 P4・§5 P4-1、内部設計書§4.10（UC-07シーケンス）・§7.3（setupInit）、
 *  外部設計書§7.5（展開フロー）・R-07（PAT非保存）、導入手順書v1.2§4.5・§5・§6 を
 *  実装根拠とする。
 *
 *  責務:
 *   ①GitHub PAT・リポジトリ名・配置先サブディレクトリの入力受付
 *     （PATはメモリ変数のみに保持。R-07）
 *   ②GitHub REST API: 事前作成済みリポジトリの確認→FILE_MANIFEST全ファイルの
 *     コミット（サブディレクトリ配下）→Pages有効化
 *   ③gas_bundle.txt を DIST_ORIGIN から fetch しテキストエリアへ表示・コピー支援
 *   ④GAS デプロイURL貼り戻し→GET action=admin.setupInit（clientId/domain付与。疑義G-5）
 *   ⑤submitToken/adminToken受領→config.js生成→GitHub Contents APIへ書込（sha取得→PUT）
 *   ⑥ping接続テスト→受験URL・教員URL・ADMIN_TOKENを画面表示（画面表示のみ・保存しない）
 *
 *  このファイルが通信してよい外部オリジンは api.github.com と DIST_ORIGIN と
 *  GASデプロイURL（script.google.com配下）のみ（実装指示書冒頭
 *  「GitHub APIはウィザード実行時のみ使用」）。
 *
 *  DIST_ORIGINについて: このウィザードは file:// で開くと配布ファイルの取得と
 *  GitHub APIへの通信の両方が主要ブラウザのCORS制限で失敗する（Failed to fetch）。
 *  そのため教員は本ウィザードを file:// では開かず、開発者が常時公開している
 *  https://asuzuki-svg.github.io/examforge/setup/ を直接開いて使う運用とし、
 *  配布ファイルは自オリジン相対ではなく DIST_ORIGIN から取得する（導入手順書§5）。
 * ===================================================================== */
(function () {
  "use strict";

  var GITHUB_API = "https://api.github.com";
  var DIST_ORIGIN = "https://asuzuki-svg.github.io/examforge";

  // ===== FILE_MANIFEST: examforge/ 配下の配布対象ファイル相対パス一覧（§4 P4-1） =====
  // GAS原本ディレクトリのソース(*.gs)は配布対象に含めない。setup/gas_bundle.txt のみ配布対象に含む。
  // setup/ 自身のオリジンから fetch して GitHub へ転送する。
  var FILE_MANIFEST = [
    "index.html",
    "exam/paper.html",
    "exam/exam.js",
    "exam/googleAuth.js",
    "exam/drawing.js",
    "exam/exam.css",
    "exam/config.js",
    "exam/manual.html",
    "admin/index.html",
    "admin/apiClient.js",
    "admin/admin.css",
    "admin/dashboard.html",
    "admin/dashboard.js",
    "admin/examEditor.html",
    "admin/examEditor.js",
    "admin/keyEditor.html",
    "admin/keyEditor.js",
    "admin/monitorView.html",
    "admin/monitorView.js",
    "admin/gradingView.html",
    "admin/gradingView.js",
    "admin/reportView.html",
    "admin/reportView.js",
    "admin/decrypt.html",
    "setup/index.html",
    "setup/wizard.js",
    "setup/gas_bundle.txt"
  ];

  // ===== 状態（メモリのみ。PAT・ADMIN_TOKENをlocalStorage/sessionStorageへ書かない。R-07） =====
  var state = {
    ghUser: "",
    ghPat: "",
    ghRepo: "",
    ghSubdir: "", // 配置先サブディレクトリ（空なら直下）。既存の <user>.github.io 等に相乗り展開する場合に使う
    gasUrl: "",
    oauthClientId: "",
    allowedDomain: "soka-u.jp",
    submitToken: "",
    adminToken: "",
    spreadsheetUrl: ""
  };

  // サブディレクトリ配下に配置する際のパスを組み立てる（末尾スラッシュ・先頭スラッシュを正規化）
  function joinRepoPath(subdir, relPath) {
    var s = String(subdir || "").replace(/^\/+|\/+$/g, "");
    return s ? (s + "/" + relPath) : relPath;
  }

  // 公開後の受験開始URLのルート（末尾スラッシュ付き）を組み立てる
  function siteRootUrl() {
    var s = String(state.ghSubdir || "").replace(/^\/+|\/+$/g, "");
    return "https://" + state.ghUser + ".github.io/" + state.ghRepo + "/" + (s ? (s + "/") : "");
  }

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[<>&]/g, function (c) {
      return c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;";
    });
  }

  function showBox(el, cls, text) {
    el.innerHTML = '<div class="' + cls + '">' + esc(text) + "</div>";
  }

  function appendLog(el, text, cls) {
    el.style.display = "block";
    var line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function setStepActive(n) {
    for (var i = 1; i <= 5; i++) {
      var tab = $("stepTab" + i);
      tab.classList.remove("active", "done");
      if (i < n) tab.classList.add("done");
      if (i === n) tab.classList.add("active");
    }
  }

  function showPanel(n) {
    for (var i = 1; i <= 5; i++) {
      $("panel" + i).style.display = (i === n) ? "block" : "none";
    }
    setStepActive(n);
  }

  // ===== GitHub REST API ヘルパ =====
  // 認証ヘッダ: Fine-grained PAT は "Authorization: Bearer <token>" 形式（GitHub REST API公式仕様）。
  function ghHeaders(extra) {
    var h = {
      "Authorization": "Bearer " + state.ghPat,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (extra) {
      for (var k in extra) h[k] = extra[k];
    }
    return h;
  }

  function ghRequest(method, path, bodyObj) {
    var opts = { method: method, headers: ghHeaders(bodyObj ? { "Content-Type": "application/json" } : {}) };
    if (bodyObj !== undefined) opts.body = JSON.stringify(bodyObj);
    return fetch(GITHUB_API + path, opts).then(function (r) {
      // 403時、GitHubは X-Accepted-GitHub-Permissions ヘッダーで不足している権限を返す。
      // エラーメッセージに含めることで、教員がPAT再発行時にどのPermissionを直せばよいか分かる。
      var acceptedPerms = r.headers.get("x-accepted-github-permissions");
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { status: r.status, ok: r.ok, data: data, acceptedPerms: acceptedPerms };
      });
    });
  }

  // GET /repos/{owner}/{repo}: リポジトリの存在確認（GitHub REST API公式仕様）
  function getRepo(owner, repo) {
    return ghRequest("GET", "/repos/" + owner + "/" + repo).then(function (res) {
      return res.ok ? res.data : null;
    });
  }

  // リポジトリの存在確認のみを行う（作成はしない）。
  //
  // Fine-grained PATは「Only select repositories」で対象リポジトリを選ぶ方式のため、
  // 原理上まだ存在しないリポジトリへ権限を付与できず、POST /user/repos（新規作成）を
  // 呼ぶと名前重複の判定（422）に至る前に 403 Resource not accessible で拒否される。
  // そのため本ウィザードはリポジトリの新規作成を行わず、教員に導入手順書§3の手順で
  // 事前にGitHub画面上で空リポジトリを作成してもらい、PATはそのリポジトリを対象に
  // 発行してもらう運用に統一する（新規展開・既存リポジトリへの相乗り展開のどちらも
  // 同じ「既存リポジトリを確認して使う」経路を通る）。
  function createRepo() {
    return getRepo(state.ghUser, state.ghRepo).then(function (existing) {
      if (!existing) {
        throw new Error(
          "リポジトリ「" + state.ghRepo + "」が見つかりません（またはPATに権限がありません）。" +
          "先にGitHubの画面でこのリポジトリを作成し、PAT発行時の「Repository access」でこの" +
          "リポジトリを選択してから、もう一度お試しください（導入手順書§3参照）。"
        );
      }
      return existing;
    });
  }

  // Base64エンコード（UTF-8対応）。btoaはLatin1のみのため変換する。
  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  // PUT /repos/{owner}/{repo}/contents/{path}: ファイルコミット（GitHub Contents API公式仕様）。
  // 既存ファイル更新にはsha取得が必要。新規作成時はshaを省略する。
  function putFile(owner, repo, path, content, message) {
    var getUrl = "/repos/" + owner + "/" + repo + "/contents/" + path;
    return ghRequest("GET", getUrl).then(function (getRes) {
      var body = {
        message: message || ("ExamForge setup: add " + path),
        content: utf8ToBase64(content),
        branch: "main"
      };
      if (getRes.ok && getRes.data && getRes.data.sha) {
        body.sha = getRes.data.sha; // 既存ファイル更新時のみ付与
      }
      return ghRequest("PUT", getUrl, body).then(function (putRes) {
        if (!putRes.ok) {
          throw new Error("ファイル配置に失敗しました（" + path + " / " + putRes.status + "）: " + (putRes.data && putRes.data.message || ""));
        }
        return putRes.data;
      });
    });
  }

  // GET /repos/{owner}/{repo}/pages: 現在のPages設定を取得（未有効化なら404）
  function getPages(owner, repo) {
    return ghRequest("GET", "/repos/" + owner + "/" + repo + "/pages").then(function (res) {
      return res.ok ? res.data : null;
    });
  }

  // POST /repos/{owner}/{repo}/pages: GitHub Pages有効化（branch: main, path: /）
  //
  // 403 Resource not accessible が起きうる注意点: PATのPermissionsで「Pages: Read and write」
  // が付与されていないケースのほか、<user>.github.io という名前のリポジトリ（ユーザーサイト）は
  // 通常のプロジェクトサイトと有効化の扱いが異なる場合がある。まず現在のPages設定を確認し、
  // 既に有効化済みならAPI呼び出し自体を行わずスキップする（無用な403を避ける）。
  function enablePages(owner, repo) {
    return getPages(owner, repo).then(function (existing) {
      if (existing) {
        return existing;
      }
      return ghRequest("POST", "/repos/" + owner + "/" + repo + "/pages", {
        source: { branch: "main", path: "/" }
      }).then(function (res) {
        // 既に有効化済み（409）はエラー扱いにしない
        if (!res.ok && res.status !== 409) {
          var permHint = res.acceptedPerms ? "（必要な権限: " + res.acceptedPerms + "）" : "";
          throw new Error(
            "GitHub Pages有効化に失敗しました（" + res.status + "）: " + (res.data && res.data.message || "") + permHint +
            " ／ 主な原因: ①PAT発行時のPermissionsで「Pages: Read and write」が付与されていない。" +
            "②リポジトリがPrivateのまま（無料アカウントはPrivateリポジトリでPagesを有効化できない。" +
            "GitHub Educationの認証を受けていればPrivateのままでも有効化できるので、導入手順書§3.5を参照）。" +
            "既にリポジトリのSettings→Pagesで手動で有効化している場合は、このエラーが出てもファイル配置自体は完了しているため、そのまま次のステップに進んで構いません。"
          );
        }
        return res.data;
      });
    });
  }

  // 開発者公開先（DIST_ORIGIN）から配布対象ファイルを取得する（FILE_MANIFEST）。
  // relPath は examforge ルート相対。
  function fetchLocalFile(relPath) {
    return fetch(DIST_ORIGIN + "/" + relPath).then(function (r) {
      if (!r.ok) throw new Error("配布ファイルの読込に失敗しました: " + relPath);
      return r.text();
    });
  }

  // ===== ステップ1→2: リポジトリ確認（事前作成済み前提）→ファイル配置→Pages有効化 =====
  function runDeploy() {
    var log = $("deployLog");
    log.textContent = "";
    appendLog(log, "リポジトリを確認しています…");
    return createRepo()
      .then(function () {
        appendLog(log, "リポジトリ「" + state.ghRepo + "」を確認しました。", "ok");
        if (state.ghSubdir) {
          appendLog(log, "配置先: /" + state.ghSubdir + "/ 配下（既存ファイルとは別ディレクトリのため上書きしません）。", "ok");
        } else {
          appendLog(log, "配置先サブディレクトリが未指定のため、リポジトリ直下に配置します。既存ファイルと同名の場合は上書きされます。", "err");
        }
        appendLog(log, "静的ファイル一式を配置しています（" + FILE_MANIFEST.length + "件）…");
        // 逐次配置（GitHub APIのレート制限・シート順序性への配慮。実装指示書は一括配置の手法まで指定せず）
        var chain = Promise.resolve();
        FILE_MANIFEST.forEach(function (relPath) {
          chain = chain.then(function () {
            var destPath = joinRepoPath(state.ghSubdir, relPath);
            return fetchLocalFile(relPath).then(function (content) {
              return putFile(state.ghUser, state.ghRepo, destPath, content, "ExamForge setup: add " + destPath);
            }).then(function () {
              appendLog(log, "  配置完了: " + destPath, "ok");
            });
          });
        });
        return chain;
      })
      .then(function () {
        appendLog(log, "GitHub Pagesを有効化しています…");
        return enablePages(state.ghUser, state.ghRepo);
      })
      .then(function () {
        appendLog(log, "GitHub Pagesを有効化しました。反映まで数十秒〜数分かかる場合があります。", "ok");
        $("btnStep2Next").disabled = false;
      })
      .catch(function (err) {
        appendLog(log, "エラー: " + err.message, "err");
        throw err;
      });
  }

  // ===== ステップ3: gas_bundle.txt の表示 =====
  function loadBundleText() {
    return fetchLocalFile("setup/gas_bundle.txt").then(function (text) {
      $("bundleText").value = text;
    }).catch(function (err) {
      showBox($("msg3"), "error-box", "gas_bundle.txtの読込に失敗しました: " + err.message);
    });
  }

  // ===== ステップ4: setupInit呼出＋config.js書込＋ping接続テスト =====
  function buildConfigJsContent() {
    // exam/config.js 契約（実装指示書§7.7）のキーをそのまま踏襲。ADMIN_TOKENは絶対に書かない。
    var lines = [];
    lines.push("/* =====================================================================");
    lines.push(" *  exam/config.js — ExamForge 受験アプリ設定（setup wizardが自動生成）");
    lines.push(" *  管理トークンは本ファイルに絶対に含めない（FR-F02）。");
    lines.push(" * ===================================================================== */");
    lines.push("window.EXAM_CONFIG = {");
    lines.push("  GAS_ENDPOINT: " + JSON.stringify(state.gasUrl) + ",");
    lines.push("  SUBMIT_TOKEN: " + JSON.stringify(state.submitToken) + ",");
    lines.push("  GOOGLE_OAUTH_CLIENT_ID: " + JSON.stringify(state.oauthClientId) + ",");
    lines.push("  ALLOWED_EMAIL_DOMAIN: " + JSON.stringify(state.allowedDomain) + ",");
    lines.push("  KEEP_LOCAL_DOWNLOAD: false,");
    lines.push("  ANSWER_PUBKEY: null,");
    lines.push("  MAX_VIOLATIONS: 3,");
    lines.push("  TIMEOUT_JITTER_MS: 10000");
    lines.push("};");
    lines.push("");
    return lines.join("\n");
  }

  function qs(params) {
    var parts = [];
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      if (params[k] === undefined || params[k] === null || params[k] === "") continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    return parts.join("&");
  }

  // GASへの疎通はfetchのみで試み、失敗時はJSONPへフォールバックする（実装指示書A-3の方式踏襲）。
  function gasGet(action, params) {
    var url = state.gasUrl + "?" + qs(Object.assign({ action: action }, params || {}));
    return fetch(url, { method: "GET" }).then(function (r) { return r.json(); })
      .catch(function () { return gasJsonp(url); });
  }

  function gasJsonp(baseUrl) {
    return new Promise(function (resolve, reject) {
      var cb = "efSetupCb_" + Math.random().toString(36).slice(2);
      var s = document.createElement("script");
      var timer = setTimeout(function () { cleanup(); reject(new Error("timeout")); }, 15000);
      function cleanup() {
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
        clearTimeout(timer);
      }
      window[cb] = function (data) { cleanup(); resolve(data); };
      s.onerror = function () { cleanup(); reject(new Error("script error")); };
      s.src = baseUrl + "&callback=" + cb + "&t=" + Date.now();
      document.head.appendChild(s);
    });
  }

  function runInitAndConnect() {
    var log = $("initLog");
    log.textContent = "";
    appendLog(log, "GASを初期化しています（admin.setupInit）…");
    return gasGet("admin.setupInit", { clientId: state.oauthClientId, domain: state.allowedDomain })
      .then(function (res) {
        if (!res || res.ok !== true) {
          throw new Error("setupInitに失敗しました: " + (res && (res.error || res.message) || "不明なエラー"));
        }
        state.submitToken = res.submitToken;
        state.adminToken = res.adminToken;
        state.spreadsheetUrl = res.spreadsheetUrl;
        appendLog(log, "初期化に成功しました。", "ok");

        appendLog(log, "config.jsを生成しリポジトリへ書き込んでいます…");
        var configContent = buildConfigJsContent();
        var configPath = joinRepoPath(state.ghSubdir, "exam/config.js");
        return putFile(state.ghUser, state.ghRepo, configPath, configContent, "ExamForge setup: write config.js");
      })
      .then(function () {
        appendLog(log, "config.jsの書き込みに成功しました。", "ok");
        appendLog(log, "接続テスト（ping）を実行しています…");
        return gasGet("ping", {});
      })
      .then(function (pingRes) {
        if (!pingRes || pingRes.ok !== true) {
          throw new Error("接続テスト（ping）に失敗しました。");
        }
        appendLog(log, "接続テストに成功しました（version " + pingRes.version + "）。", "ok");
      });
  }

  // ===== 画面遷移・イベント =====
  function init() {
    showPanel(1);
    loadBundleText();

    $("btnStep1Next").addEventListener("click", function () {
      state.ghUser = $("ghUser").value.trim();
      state.ghPat = $("ghPat").value.trim();
      state.ghRepo = $("ghRepo").value.trim();
      state.ghSubdir = $("ghSubdir").value.trim().replace(/^\/+|\/+$/g, "");
      if (!state.ghUser || !state.ghPat || !state.ghRepo) {
        showBox($("msg1"), "error-box", "GitHubユーザー名・PAT・リポジトリ名を全て入力してください。");
        return;
      }
      // ルート直下が即Web公開される github.io 系リポジトリ（<user>.github.io や github.io 単体）は、
      // サブディレクトリ未指定だと既存ホームページの index.html を上書きしてしまうため、
      // 配置先サブディレクトリを必須にする。
      if (/(^|\.)github\.io$/i.test(state.ghRepo) && !state.ghSubdir) {
        showBox($("msg1"), "error-box",
          "「" + state.ghRepo + "」はホームページ用リポジトリ（ルート直下がそのままWeb公開される）です。" +
          "既存のホームページを上書きしないよう、配置先サブディレクトリ（例: prog-py-exam）を必ず入力してください。");
        return;
      }
      $("msg1").innerHTML = "";
      $("btnStep1Next").disabled = true;
      showPanel(2);
      runDeploy()
        .then(function () {
          $("btnStep1Next").disabled = false;
        })
        .catch(function () {
          // エラーはdeployLogに表示済み。ステップ1へ戻って入力を直し再試行できるようにする。
          $("btnStep1Next").disabled = false;
        });
    });

    $("btnStep2Back").addEventListener("click", function () {
      showPanel(1);
    });

    $("btnStep2Next").addEventListener("click", function () {
      showPanel(3);
    });

    $("btnCopyBundle").addEventListener("click", function () {
      var ta = $("bundleText");
      ta.select();
      try {
        document.execCommand("copy");
        showBox($("msg3"), "ok-box", "コピーしました。script.google.comのエディタに貼り付けてください。");
      } catch (e) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(ta.value);
          showBox($("msg3"), "ok-box", "コピーしました。script.google.comのエディタに貼り付けてください。");
        } else {
          showBox($("msg3"), "error-box", "自動コピーに失敗しました。テキストエリアを選択して手動でコピーしてください。");
        }
      }
    });

    $("btnStep3Next").addEventListener("click", function () {
      showPanel(4);
    });

    $("btnStep4Back").addEventListener("click", function () {
      showPanel(3);
    });

    $("btnStep4Next").addEventListener("click", function () {
      state.gasUrl = $("gasUrl").value.trim();
      state.oauthClientId = $("oauthClientId").value.trim();
      state.allowedDomain = $("allowedDomain").value.trim() || "soka-u.jp";
      if (!state.gasUrl || !state.oauthClientId) {
        showBox($("msg4"), "error-box", "GASデプロイURLとOAuthクライアントIDを入力してください。");
        return;
      }
      $("msg4").innerHTML = "";
      $("btnStep4Next").disabled = true;
      runInitAndConnect()
        .then(function () {
          $("adminTokenValue").textContent = state.adminToken;
          $("adminTokenBox").style.display = "block";
          var root = siteRootUrl();
          var examUrl = root + "?exam=<examId>";
          var adminUrl = root + "admin/";
          $("linkExam").textContent = examUrl;
          $("linkExam").href = root;
          $("linkAdmin").textContent = adminUrl;
          $("linkAdmin").href = adminUrl;
          $("linkSheet").textContent = state.spreadsheetUrl;
          $("linkSheet").href = state.spreadsheetUrl;
          showPanel(5);
        })
        .catch(function (err) {
          showBox($("msg4"), "error-box", err.message || String(err));
          $("btnStep4Next").disabled = false;
        });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
